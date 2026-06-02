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

from fetch_sac_route_v2 import (
    _features_for_route, _fetch_layer, _load_peak_coords,
    _peak_id_from_url, _route_id_from_url, _wgs84_to_lv95,
    _build_gpx, BBOX_PADDING_M,
)
from new_hike import enrich_gpx_elevation, parse_gpx, scaffold_hike
from scrape_sac_route_page import fetch_html, scrape, patch_data_json
from fetch_sac_route import _load_cookie

REPO_ROOT = Path(__file__).resolve().parent.parent


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
    p.add_argument("--url", required=True, help="SAC route page URL")
    p.add_argument("--slug", required=True, help="Folder slug under routes/")
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
    p.add_argument("--include-dashed", action="store_true",
                   help="Include style=dashed features in the GPX.")
    p.add_argument("--no-elevation", action="store_true")
    p.add_argument("--no-scrape", action="store_true",
                   help="Skip the HTML metadata scrape (offline mode).")
    p.add_argument("--no-render", action="store_true")
    p.add_argument("--cookie-file", type=Path)
    p.add_argument("--cookie-env", default="SAC_COOKIE")
    args = p.parse_args(argv)

    slug = args.slug
    out_dir = REPO_ROOT / "routes" / slug
    data_path = out_dir / f"{slug}.data.json"
    gpx_path = out_dir / f"{slug}.gpx"

    # Step 1: GPX from the layer API
    route_id = _route_id_from_url(args.url)
    peak_id = _peak_id_from_url(args.url)
    lat, lon = _load_peak_coords(peak_id)
    cx, cy = _wgs84_to_lv95(lat, lon)
    bbox = (cx - args.bbox_padding, cy - args.bbox_padding,
            cx + args.bbox_padding, cy + args.bbox_padding)
    print(f"[1/5] Fetching layer API for route_id={route_id} (peak_id={peak_id})")
    layer = _fetch_layer(bbox)
    features = _features_for_route(layer, route_id, include_dashed=args.include_dashed)
    if not features:
        sys.exit("ERROR: no features matched in the bbox — try --bbox-padding bigger.")
    print(f"      {len(features)} features matched (excl. alternatives, "
          f"{'incl. dashed' if args.include_dashed else 'excl. dashed'})")
    # Save raw layer for reproducibility
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"sac-layer-{route_id}.json").write_text(
        json.dumps(layer, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    _build_gpx(features, slug, slug, out_dir, stitch=args.stitch)

    # Step 2: SwissTopo elevation enrichment
    if not args.no_elevation:
        print(f"[2/5] Enriching GPX with SwissTopo elevation")
        enrich_gpx_elevation(gpx_path)
    else:
        print(f"[2/5] Skipping elevation enrichment (--no-elevation)")

    # Step 3: HTML scrape (must happen before scaffold so we can pass scraped trailhead/grade)
    scraped = None
    if not args.no_scrape:
        print(f"[3/5] Fetching authenticated HTML and scraping metadata")
        cookie = _load_cookie(args.cookie_env, args.cookie_file)
        html = fetch_html(args.url, cookie)
        scraped = scrape(html)
        print(f"      title:      {scraped.title[:80] if scraped.title else '?'}")
        print(f"      difficulty: {scraped.difficulty}")
        print(f"      departure:  {scraped.departure_name} ({scraped.departure_elev_m} m)")
        print(f"      photos:     {len(scraped.photos)}")
    else:
        print(f"[3/5] Skipping HTML scrape (--no-scrape)")

    # Step 4: Scaffold data.json (skip if exists)
    if not data_path.exists():
        print(f"[4/5] Scaffolding {data_path.name}")
        trailhead = args.trailhead or (scraped.departure_name if scraped else "TODO")
        grade = args.grade or (scraped.difficulty if scraped else "T3")
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

    # Step 5: Patch with scraped data
    if scraped:
        print(f"[5/5] Patching {data_path.name} with scraped metadata")
        changed = patch_data_json(data_path, scraped, replace_todo_only=True)
        print(f"      patched {len(changed)} field(s): {', '.join(changed) if changed else '(none)'}")

    # Final: render
    if not args.no_render:
        print(f"\n[render] make render")
        subprocess.run(["make", "render"], cwd=str(REPO_ROOT), check=False)
    else:
        print(f"\n[render] skipped — run `make render` when ready")

    print(f"\nDone: routes/{slug}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
