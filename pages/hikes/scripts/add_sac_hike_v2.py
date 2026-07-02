"""One-command pipeline for adding a NEW hike post-2026-06.

Chains the three v2 scripts plus elevation enrichment + render:

  1. ``fetch_sac_route_v2.py``      → routes/<slug>/<slug>.gpx
  2. ``new_hike.scaffold_hike``     → routes/<slug>/<slug>.data.json (skeleton)
  3. ``new_hike.enrich_gpx_elevation`` → SwissTopo Z on the GPX
  4. ``scrape_sac_route_page.py``   → patches data.json with HTML metadata
  5. ``render_hike.py``             → routes/<slug>/<slug>.html + track.js

Requires:
  * ``~/.config/sac-hikes/cookie`` populated (step 4 hits the authenticated HTML).
  * Peak entry in ``guides/sac-routes.js`` (for bbox lookup in step 1).

Usage
-----
    python scripts/add_sac_hike_v2.py \\
        --url 'https://www.sac-cas.ch/en/.../<route>/' \\
        --slug <slug> \\
        --grade T3   # optional; if omitted, taken from the scraped page
        --canton 'Glarus' --region 'Eastern Switzerland'   # optional autodetect

Pass ``--no-elevation`` to skip the SwissTopo enrichment (faster, useful when
iterating). Pass ``--no-render`` to leave the rendered HTML out (useful for
inspection before committing).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fetch_sac_route import _load_cookie
from fetch_sac_route_v2 import (
    BBOX_PADDING_M,
    _build_gpx,
    _features_for_route,
    _fetch_layer,
    _load_peak_coords,
    _route_id_from_url,
    _wgs84_to_lv95,
)
from new_hike import enrich_gpx_elevation, orient_gpx_to_trailhead, parse_gpx, scaffold_hike
from scrape_sac_route_page import fetch_html, patch_data_json, scrape

REPO_ROOT = Path(__file__).resolve().parent.parent
ROUTES_DB = REPO_ROOT / "guides" / "sac-routes.js"

# Trailing "-<digits>/" marks a full route URL; peak URLs end with "/mountain-hiking/".
_ROUTE_TRAIL_RE = re.compile(r"-\d+/?$")
_DISCIPLINE = "mountain-hiking"


def _is_route_url(url: str) -> bool:
    path = urllib.parse.urlsplit(url).path
    return bool(_ROUTE_TRAIL_RE.search(path))


def _peak_url_from_route_url(route_url: str) -> str:
    """Strip the trailing route slug to get the peak (`.../mountain-hiking/`) URL."""
    normalized = route_url.rstrip("/") + "/"
    return re.sub(r"[^/]+/$", "", normalized)


def _ensure_sources(data_path: Path, route_url: str, peak_url: str) -> None:
    """Add (route) + (peak) entries to the top-level ``sources`` array.

    ``scrape_sac_route_page`` reads ``sources`` to attach the specific SAC
    route link to ``routes[0].source``, and ``render_hike`` uses it for the
    Route sources cell and the trail-conditions callout. Without this both
    fall back to the generic ``https://www.sac-cas.ch/`` portal.
    """
    data = json.loads(data_path.read_text(encoding="utf-8"))
    existing = list(data.get("sources") or [])
    names = [(s.get("name") or "").lower() for s in existing]
    if not any("route" in n and "peak" not in n for n in names):
        existing.append({"name": "SAC Route Portal (route)", "url": route_url})
    if not any("peak" in n for n in names):
        existing.append({"name": "SAC Route Portal (peak)", "url": peak_url})
    if existing != (data.get("sources") or []):
        data["sources"] = existing
        data_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"      wrote sources: (route) + (peak) into {data_path.name}")


def _peak_id_from_any_url(url: str) -> int:
    """Extract the peak ID from either a peak URL (.../<slug>-<id>/mountain-hiking/)
    or a route URL (.../<slug>-<id>/mountain-hiking/<route-slug>-<route-id>/).

    Walks the path right-to-left and returns the first segment whose stem
    matches ``<slug>-<digits>`` — discipline segments like ``mountain-hiking``
    don't end in digits and are skipped automatically.
    """
    parts = [p for p in urllib.parse.urlsplit(url).path.split("/") if p]
    for p in reversed(parts):
        m = re.search(r"-(\d+)$", p)
        if not m:
            continue
        peak_id = int(m.group(1))
        # If we matched the route segment, keep walking left to find the peak segment.
        if p is parts[-1] and _ROUTE_TRAIL_RE.search(p):
            continue
        return peak_id
    sys.exit(f"ERROR: couldn't extract peak ID from URL: {url}")


def _load_routes_db() -> list[dict]:
    if not ROUTES_DB.exists():
        sys.exit(f"ERROR: routes DB not found at {ROUTES_DB}")
    raw = ROUTES_DB.read_text(encoding="utf-8")
    payload = raw.split("=", 1)[1].strip().rstrip(";").strip()
    return json.loads(payload)


_UMLAUTS = [("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss"),
            ("é", "e"), ("è", "e"), ("ê", "e"), ("à", "a"), ("ô", "o")]


def _slug_from_peak_name(name: str) -> str:
    """Lowercase + hyphenate + transliterate umlauts. Matches existing conventions
    (e.g. routes/federispitz/, routes/uessers-barrhorn/)."""
    s = name.lower()
    for a, b in _UMLAUTS:
        s = s.replace(a, b)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def _resolve_peak_url_to_route_url(peak_url: str, peak_id: int) -> str:
    """Turn a peak URL into a route URL using the routes DB + the public peak listing.

    The DB tells us which route_id(s) exist; the peak page HTML gives us the
    matching URL with its canonical route slug. Errors clearly if multiple
    routes exist (we don't guess between them).
    """
    db = _load_routes_db()
    peak = next((p for p in db if p.get("id") == peak_id), None)
    if peak is None:
        sys.exit(
            f"ERROR: peak {peak_id} not in {ROUTES_DB}. Add an entry with "
            "id, name, alt, type='summit', lat, lon, routes=[{id, title, grade, ...}] "
            "before passing a peak URL to this script."
        )
    routes = peak.get("routes") or []
    if not routes:
        sys.exit(f"ERROR: peak {peak_id} '{peak['name']}' has no routes listed.")
    if len(routes) > 1:
        listing = "\n".join(
            f"  {r['id']}: {r.get('grade','?')} — {r.get('title','')[:80]}"
            for r in routes
        )
        sys.exit(
            f"ERROR: peak {peak_id} '{peak['name']}' has {len(routes)} routes; "
            "pass the full route URL (with the -<route-id>/ suffix) instead.\n"
            f"Routes:\n{listing}"
        )
    route_id = routes[0]["id"]

    # Fetch the peak listing. Authenticated when possible (some routes only
    # show on the listing when SAC knows you're logged in).
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"),
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    }
    try:
        cookie = _load_cookie("SAC_COOKIE", None)
        headers["Cookie"] = cookie
    except SystemExit:
        pass  # no cookie saved → fetch unauth, may still work for free routes
    req = urllib.request.Request(peak_url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        sys.exit(f"ERROR: couldn't fetch peak listing {peak_url}: {e}")

    # Look for any per-language route link ending in -<route_id>/ that includes
    # one of the discipline slugs (mountain-hiking / berg-und-alpinwandern / etc.).
    # Links may be either relative (/en/…) or absolute (https://www.sac-cas.ch/en/…).
    pattern = re.compile(
        rf'(?:https://www\.sac-cas\.ch)?(/(?:en|de|fr|it)/[^"\']*/(?:mountain-hiking|berg-und-alpinwandern|randonnee-en-montagne|escursionismo-alpino)/[^"\']*-{route_id}/)'
    )
    matches = pattern.findall(html)
    if not matches:
        sys.exit(
            f"ERROR: peak page didn't expose a link ending in -{route_id}/. "
            "Pass the full route URL directly."
        )
    # Prefer the English path if any of the matches is /en/.
    href = next((h for h in matches if h.startswith("/en/")), matches[0])
    return f"https://www.sac-cas.ch{href}"


def _lookup_canton(lat: float, lon: float) -> str:
    """Reverse-geocode via the Swiss federal geodata identify API."""
    url = (
        "https://api3.geo.admin.ch/rest/services/api/MapServer/identify"
        f"?geometryType=esriGeometryPoint&geometry={lon},{lat}"
        "&tolerance=0&layers=all:ch.swisstopo.swissboundaries3d-kanton-flaeche.fill"
        "&sr=4326&returnGeometry=false"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        if results:
            return results[0]["attributes"]["name"]
    except Exception as e:
        print(f"  Warning: canton lookup failed: {e}", file=sys.stderr)
    return "TODO"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--url", required=True,
                   help="SAC peak OR route URL. Peak URLs are auto-resolved "
                        "to the route as long as the peak has exactly one route in sac-routes.js.")
    p.add_argument("--slug",
                   help="Folder slug under routes/. Default: derived from the peak name in sac-routes.js.")
    p.add_argument("--region", default="TODO")
    p.add_argument("--canton", default=None,
                   help="Override canton (default: auto-detect from peak coords).")
    p.add_argument("--grade", default=None,
                   help="Override SAC grade (default: scraped from page).")
    p.add_argument("--trailhead", default=None,
                   help="Override trailhead name (default: scraped departure point).")
    p.add_argument("--bbox-padding", type=int, default=BBOX_PADDING_M)
    p.add_argument("--stitch", action="store_true",
                   help="Run the legacy greedy stitcher on the layer features.")
    p.add_argument("--no-dashed", action="store_true",
                   help="Drop style=dashed features (default: keep — they are usually genuine connectors).")
    p.add_argument("--no-elevation", action="store_true")
    p.add_argument("--no-scrape", action="store_true",
                   help="Skip the HTML metadata scrape (offline mode).")
    p.add_argument("--no-render", action="store_true")
    p.add_argument("--cookie-file", type=Path)
    p.add_argument("--cookie-env", default="SAC_COOKIE")
    args = p.parse_args(argv)

    # Accept either peak or route URL; if it's a peak URL, resolve to a route URL.
    peak_id = _peak_id_from_any_url(args.url)
    if _is_route_url(args.url):
        route_url = args.url
    else:
        print(f"[0/5] Resolving peak URL → route URL (peak_id={peak_id})")
        route_url = _resolve_peak_url_to_route_url(args.url, peak_id)
        print(f"      → {route_url}")

    # Derive slug from peak name if the user didn't pass one.
    slug = args.slug
    if not slug:
        db = _load_routes_db()
        peak = next((p for p in db if p.get("id") == peak_id), None)
        if not peak:
            sys.exit(f"ERROR: peak {peak_id} not in {ROUTES_DB} — pass --slug explicitly.")
        slug = _slug_from_peak_name(peak["name"])
        print(f"[0/5] Slug derived from peak name '{peak['name']}' → '{slug}'")

    out_dir = REPO_ROOT / "routes" / slug
    data_path = out_dir / f"{slug}.data.json"
    gpx_path = out_dir / f"{slug}.gpx"

    # Step 1: GPX from the layer API
    route_id = _route_id_from_url(route_url)
    lat, lon = _load_peak_coords(peak_id)
    cx, cy = _wgs84_to_lv95(lat, lon)
    bbox = (cx - args.bbox_padding, cy - args.bbox_padding,
            cx + args.bbox_padding, cy + args.bbox_padding)
    print(f"[1/5] Fetching layer API for route_id={route_id} (peak_id={peak_id})")
    layer = _fetch_layer(bbox)
    features = _features_for_route(layer, route_id, include_dashed=not args.no_dashed)
    if not features:
        sys.exit("ERROR: no features matched in the bbox — try --bbox-padding bigger.")
    print(f"      {len(features)} features matched (excl. alternatives, "
          f"{'excl. dashed' if args.no_dashed else 'incl. dashed'})")
    # Save raw layer for reproducibility
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"sac-layer-{route_id}.json").write_text(
        json.dumps(layer, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    _build_gpx(features, slug, slug, out_dir, stitch=args.stitch)

    # Step 2: SwissTopo elevation enrichment
    if not args.no_elevation:
        print("[2/5] Enriching GPX with SwissTopo elevation")
        enrich_gpx_elevation(gpx_path)
    else:
        print("[2/5] Skipping elevation enrichment (--no-elevation)")

    # Step 3: HTML scrape (must happen before scaffold so we can pass scraped trailhead/grade,
    # and before orient so we can anchor track direction to the scraped departure elevation)
    scraped = None
    if not args.no_scrape:
        print("[3/5] Fetching authenticated HTML and scraping metadata")
        cookie = _load_cookie(args.cookie_env, args.cookie_file)
        html = fetch_html(route_url, cookie)
        scraped = scrape(html)
        print(f"      title:      {scraped.title[:80] if scraped.title else '?'}")
        print(f"      difficulty: {scraped.difficulty}")
        print(f"      departure:  {scraped.departure_name} ({scraped.departure_elev_m} m)")
        print(f"      photos:     {len(scraped.photos)}")
    else:
        print("[3/5] Skipping HTML scrape (--no-scrape)")

    # Orient the GPX so the trailhead endpoint is first. Prefer the trailhead's
    # recorded lat/lon (decisive when one endpoint is clearly nearer), then fall
    # back to the scraped departure elevation, then to a low-end heuristic.
    if not args.no_elevation:
        target_elev = scraped.departure_elev_m if scraped else None
        target_lat = target_lon = None
        if data_path.exists():
            try:
                existing = json.loads(data_path.read_text(encoding="utf-8"))
                th = existing.get("trailhead", {}) or {}
                target_lat = th.get("lat")
                target_lon = th.get("lon")
            except (json.JSONDecodeError, OSError):
                pass
        orient_gpx_to_trailhead(
            gpx_path,
            target_start_elev_m=target_elev,
            target_lat=target_lat,
            target_lon=target_lon,
        )

    # Step 4: Scaffold data.json (skip if exists)
    if not data_path.exists():
        print(f"[4/5] Scaffolding {data_path.name}")
        trailhead = args.trailhead or (scraped.departure_name if scraped else None) or "TODO"
        grade = args.grade or (scraped.difficulty if scraped else None) or "T3"
        canton = args.canton or _lookup_canton(lat, lon)
        # Use GPX start/end for trailhead coords
        gpx_data = parse_gpx(gpx_path)
        scaffold_hike(
            slug=slug,
            name=slug.replace("-", " ").title(),  # placeholder; the page title comes from data
            region=args.region,
            canton=canton,
            grade=grade,
            elev=int(round(gpx_data["max_ele"])) if gpx_data.get("has_elevation") else 0,
            trailhead=trailhead,
            peak_lat=lat, peak_lon=lon,
            trailhead_lat=round(gpx_data["start"]["lat"], 4),
            trailhead_lon=round(gpx_data["start"]["lon"], 4),
            gpx_path=gpx_path,
            no_gpx=True,
        )
    else:
        print(f"[4/5] {data_path.name} already exists — keeping it")

    _ensure_sources(data_path, route_url, _peak_url_from_route_url(route_url))

    # Step 5: Patch with scraped data
    if scraped:
        print(f"[5/5] Patching {data_path.name} with scraped metadata")
        changed = patch_data_json(data_path, scraped, replace_todo_only=True)
        print(f"      patched {len(changed)} field(s): {', '.join(changed) if changed else '(none)'}")

    # Final: render
    if not args.no_render:
        print("\n[render] make render")
        subprocess.run(["make", "render"], cwd=str(REPO_ROOT), check=False)
    else:
        print("\n[render] skipped — run `make render` when ready")

    print(f"\nDone: routes/{slug}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
