"""End-to-end SAC route extraction: JSON → GPX → scaffold → photos → metadata → render.

Chains the individual extraction scripts into a single pipeline. Supports
multiple hikes in one invocation, processed in parallel where sensible.

Usage
-----
    # Single hike, full pipeline:
    python scripts/extract_sac_route.py \
        --route rigi-kulm:routes/rigi-kulm/sac-route-907.json \
        --region "Central Switzerland" --canton "Schwyz" \
        --peak-hero rigi-kulm=https://www.sac-cas.ch/processed/... \
        --render

    # Multiple hikes:
    python scripts/extract_sac_route.py \
        --route rigi-kulm:routes/rigi-kulm/sac-route-907.json \
        --route zindlenspitz:routes/zindlenspitz/sac-route-4567.json \
        --render

    # Legacy single-hike form (still works):
    python scripts/extract_sac_route.py \
        --json routes/rigi-kulm/sac-route-907.json --slug rigi-kulm \
        --render
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_sac_gpx import sac_json_to_gpx
from extract_sac_photos import extract_photos
from new_hike import scaffold_hike, parse_gpx

REPO_ROOT = Path(__file__).resolve().parent.parent


def _coords_from_gpx(gpx_path: Path) -> dict:
    """Derive trailhead and peak coordinates from GPX track."""
    import gpxpy
    with open(gpx_path) as f:
        gpx = gpxpy.parse(f)
    first = gpx.tracks[0].segments[0].points[0]
    highest = first
    for trk in gpx.tracks:
        for seg in trk.segments:
            for pt in seg.points:
                if pt.elevation and (not highest.elevation or pt.elevation > highest.elevation):
                    highest = pt
    return {
        "trailhead_lat": round(first.latitude, 4),
        "trailhead_lon": round(first.longitude, 4),
        "trailhead_elev": round(first.elevation) if first.elevation else 0,
        "peak_lat": round(highest.latitude, 4),
        "peak_lon": round(highest.longitude, 4),
    }


def _lookup_canton(lat: float, lon: float) -> str:
    """Look up canton name from coordinates via Swiss federal geodata API."""
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


def _lookup_bioregion(lat: float, lon: float) -> str:
    """Look up biogeographical region via Swiss federal geodata API (BAFU)."""
    url = (
        "https://api3.geo.admin.ch/rest/services/api/MapServer/identify"
        f"?geometryType=esriGeometryPoint&geometry={lon},{lat}"
        "&tolerance=0&layers=all:ch.bafu.biogeographische_regionen"
        "&sr=4326&returnGeometry=false"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        if results:
            attrs = results[0]["attributes"]
            sub = attrs.get("unterregionname_de", "")
            main = attrs.get("regionname_de", "")
            return sub or main
    except Exception as e:
        print(f"  Warning: bioregion lookup failed: {e}", file=sys.stderr)
    return "TODO"


_REGION_DE_TO_EN = {
    "Engadin": "Engadin",
    "Jura und Randen": "Jura",
    "Matterhorn / Dent Blanche / Weisshorn": "Matterhorn / Dent Blanche / Weisshorn",
    "Nordalpen": "Northern Alps",
    "Ostschweiz": "Eastern Switzerland",
    "Südliches Tessin": "Southern Ticino",
    "Vierwaldstättersee / Zentralschweiz": "Central Switzerland",
    "Walliser Alpen 4/5": "Valais Alps",
    "Westliche Zentralalpen": "Western Central Alps",
    "Zentralschweizer Alpen": "Central Swiss Alps",
    "Östliche Zentralalpen": "Eastern Central Alps",
    "Nördliches Tessin": "Northern Ticino",
    "Alpensüdflanke": "Southern Alps",
    "Alpennordflanke": "Northern Alpine Flank",
    "Berner Alpen": "Bernese Alps",
    "Berner Oberland": "Bernese Oberland",
    "Jura": "Jura",
}


def _translate_region(de_name: str) -> str:
    """Translate a German region name to English using a known mapping."""
    return _REGION_DE_TO_EN.get(de_name, de_name)


def _lookup_region(sac: dict, lat: float, lon: float) -> str:
    """Derive region from SAC book title (primary) or biogeographical API (fallback)."""
    book = sac.get("book")
    if book and book.get("title"):
        title = book["title"]
        if not any(kw in title.lower() for kw in ["hütte", "gipfel", "wandern"]):
            return _translate_region(title)
    return _translate_region(_lookup_bioregion(lat, lon))


def _derive_peak_url(route_url: str) -> str:
    """Derive the SAC peak page URL from a route page URL.

    Route: .../vorder-glaernisch-794/mountain-hiking/traverse-...-1369/
    Peak:  .../vorder-glaernisch-794/mountain-hiking/
    """
    return route_url.rstrip("/").rsplit("/", 1)[0] + "/"


def _load_sac_json(json_path: Path) -> dict:
    with open(json_path, encoding="utf-8") as f:
        return json.load(f)


def _extract_metadata(sac: dict) -> dict:
    dest = sac.get("destination_poi", {})
    dep = sac.get("departure_point", {})
    route_info = sac.get("route_info", {}).get("list", [])

    ascent_str = descent_str = ""
    for item in route_info:
        if item.get("label") == "Ascent":
            ascent_str = item.get("value", "")
        elif item.get("label") == "Descent":
            descent_str = item.get("value", "")

    return {
        "title": sac.get("title", ""),
        "difficulty": sac.get("mountain_hiking_difficulty") or sac.get("main_difficulty", ""),
        "days": sac.get("days"),
        "seriousness": sac.get("seriousness"),
        "teaser": sac.get("teaser", ""),
        "ascent_label": ascent_str,
        "descent_label": descent_str,
        "destination_name": dest.get("display_name", ""),
        "destination_altitude": dest.get("altitude"),
        "destination_description": dest.get("description_summer", ""),
        "departure_name": dep.get("display_name", ""),
        "departure_altitude": dep.get("altitude"),
        "transit_stop": dep.get("public_transport_stop", {}),
        "transit_comment": dep.get("public_transport_stop_comment", ""),
    }


def _populate_sac_metadata(data: dict, meta: dict, sac: dict) -> None:
    if meta["teaser"] and "TODO" in data.get("intro_html", ""):
        parts = [meta["teaser"]]
        if meta["destination_description"]:
            parts.append(meta["destination_description"])
        data["intro_html"] = "\n".join(f"<p>{p}</p>" for p in parts if p)

    routes = data.get("routes", [])
    if routes and "TODO" in routes[0].get("title_html", ""):
        routes[0]["title_html"] = f"<strong>{meta['title']}</strong>"

    route_url = ""
    for s in data.get("sources", []):
        if "route" in s.get("name", "").lower():
            route_url = s.get("url", "")
    if routes and route_url:
        routes[0]["source"] = f"SAC Route Portal ({route_url})"

    gt = data.get("getting_there", {})
    transit = meta.get("transit_stop", {})
    comment = meta.get("transit_comment", "")
    if transit and "TODO" in gt.get("by_pt_html", ""):
        transport = transit.get("means_of_transport", "")
        stop = transit.get("name", "")
        parts = []
        if transport and stop:
            parts.append(f"<p><strong>{transport}</strong> to <strong>{stop}</strong>.</p>")
        if comment:
            parts.append(f"<p>{comment}</p>")
        if parts:
            gt["by_pt_html"] = "\n".join(parts)

    segments = sac.get("segments", [])
    if routes and segments and routes[0].get("bullets_html", [""])[0].startswith("TODO"):
        bullets = [seg.get("title", "?") for seg in segments if not seg.get("alternative", False)]
        if bullets:
            routes[0]["bullets_html"] = bullets

    res = data.get("resources_html", [])
    if res and "TODO" in res[0]:
        peak_url = ""
        for s in data.get("sources", []):
            if "peak" in s.get("name", "").lower():
                peak_url = s.get("url", "")
        new_res = []
        if route_url:
            new_res.append(f'<a href="{route_url}">SAC Route Portal — {meta["title"]}</a>')
        new_res.append('<a href="https://www.meteoswiss.admin.ch/">MeteoSwiss</a>')
        if peak_url:
            new_res.append(f'<a href="{peak_url}">SAC Peak Page — {meta["destination_name"]}</a>')
        data["resources_html"] = new_res if new_res else res

    safety = data.get("safety_html", [])
    if safety and "TODO" in safety[0]:
        difficulty = meta.get("difficulty", "")
        seriousness = meta.get("seriousness")
        new_safety = []
        if difficulty:
            new_safety.append(f"<strong>SAC grade {difficulty}</strong> — check conditions before departure.")
        if seriousness and seriousness >= 2:
            new_safety.append("<strong>Serious terrain:</strong> route-finding ability and alpine experience required.")
        new_safety.append("Turn back if thunderstorms develop — lightning risk above treeline is extreme.")
        data["safety_html"] = new_safety


def _write_data(data_path: Path, data: dict) -> None:
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _read_data(data_path: Path) -> dict:
    with open(data_path, encoding="utf-8") as f:
        return json.load(f)


def process_hike(
    slug: str,
    json_path: Path,
    region: str = "TODO",
    canton: str = "TODO",
    peak_hero: str | None = None,
    route_url: str | None = None,
    no_elevation: bool = False,
    no_scaffold: bool = False,
    no_photos: bool = False,
    no_metadata: bool = False,
) -> bool:
    """Process a single hike end-to-end. Returns True on success."""
    data_path = REPO_ROOT / "routes" / slug / f"{slug}.data.json"

    print(f"\n{'='*60}")
    print(f"  {slug}")
    print(f"{'='*60}")

    # Load SAC JSON
    print(f"\n[{slug}] Loading SAC JSON: {json_path}")
    sac = _load_sac_json(json_path)
    meta = _extract_metadata(sac)
    print(f"[{slug}] Route: {meta['title']}")
    print(f"[{slug}] {meta['difficulty']} | {meta['destination_name']} ({meta['destination_altitude']} m) | from {meta['departure_name']} ({meta['departure_altitude']} m)")

    # Step 1: GPX
    print(f"\n[{slug}] Step 1: Extracting GPX")
    gpx_path = sac_json_to_gpx(json_path, slug, add_elevation=not no_elevation)

    # Derive coordinates from GPX
    coords = _coords_from_gpx(gpx_path)
    print(f"[{slug}] Coords from GPX: start={coords['trailhead_lat']},{coords['trailhead_lon']} peak={coords['peak_lat']},{coords['peak_lon']}")

    # Auto-derive canton and region from peak coordinates / SAC data
    if canton == "TODO":
        canton = _lookup_canton(coords["peak_lat"], coords["peak_lon"])
        print(f"[{slug}] Canton (auto): {canton}")
    if region == "TODO":
        region = _lookup_region(sac, coords["peak_lat"], coords["peak_lon"])
        print(f"[{slug}] Region (auto): {region}")

    # Step 2: Scaffold
    if not no_scaffold and not data_path.exists():
        print(f"\n[{slug}] Step 2: Scaffolding data.json")
        grade = meta["difficulty"] or "T3"
        scaffold_hike(
            slug=slug,
            name=meta["destination_name"] or slug,
            region=region,
            canton=canton,
            grade=grade,
            elev=meta["destination_altitude"] or 0,
            trailhead=meta["departure_name"] or "TODO",
            peak_lat=coords["peak_lat"], peak_lon=coords["peak_lon"],
            trailhead_lat=coords["trailhead_lat"], trailhead_lon=coords["trailhead_lon"],
            gpx_path=gpx_path,
            no_gpx=True,
        )

        _write_data(data_path, _read_data(data_path))
    else:
        print(f"\n[{slug}] Step 2: Skipped scaffold ({'exists' if data_path.exists() else '--no-scaffold'})")

    # Backfill computed fields from GPX / geodata
    if data_path.exists():
        data = _read_data(data_path)
        if data.get("peak", {}).get("lat") == 0.0:
            data["peak"]["lat"] = coords["peak_lat"]
            data["peak"]["lon"] = coords["peak_lon"]
        if data.get("trailhead", {}).get("lat") == 0.0:
            data["trailhead"]["lat"] = coords["trailhead_lat"]
            data["trailhead"]["lon"] = coords["trailhead_lon"]
            if not data["trailhead"].get("elev"):
                data["trailhead"]["elev"] = coords["trailhead_elev"]
        if not data.get("waypoints"):
            data["waypoints"] = [
                {"lat": coords["trailhead_lat"], "lon": coords["trailhead_lon"], "label": data["trailhead"]["name"], "kind": "start"},
                {"lat": coords["peak_lat"], "lon": coords["peak_lon"], "label": data["peak"]["name"], "kind": "summit"},
            ]
        ic = data.get("index_card", {})
        if ic.get("region") == "TODO":
            ic["region"] = region
        if ic.get("canton") == "TODO":
            ic["canton"] = canton
        _write_data(data_path, data)

    # Always update sources when --route-url is provided
    if route_url and data_path.exists():
        data = _read_data(data_path)
        peak_url = _derive_peak_url(route_url)
        data["sources"] = [
            {"name": "SAC Route Portal (route)", "url": route_url},
            {"name": "SAC Route Portal (peak)", "url": peak_url},
        ]
        _write_data(data_path, data)
        print(f"[{slug}] Sources: {route_url}")

    # Step 3: Photos
    if not no_photos:
        print(f"\n[{slug}] Step 3: Extracting photos")
        photos = extract_photos(sac, peak_hero)
        if photos:
            copyright_holders = sorted({
                p.get("photo", {}).get("copyright", "?")
                for p in sac.get("photos", [])
            })
            attrib = f"All photos: {', '.join(copyright_holders)} / SAC Route Portal"

            data = _read_data(data_path)
            data["photos"] = photos
            data["photos_attrib_html"] = attrib
            if peak_hero:
                data["hero"]["image_url"] = peak_hero
            _write_data(data_path, data)
            print(f"[{slug}] {len(photos)} photo(s) ({attrib})")
        else:
            print(f"[{slug}] No photos found.")

    # Step 4: Metadata
    if not no_metadata:
        print(f"\n[{slug}] Step 4: Populating metadata")
        data = _read_data(data_path)
        _populate_sac_metadata(data, meta, sac)
        _write_data(data_path, data)
        print(f"[{slug}] Done.")

    print(f"\n[{slug}] Complete: routes/{slug}/")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="End-to-end SAC route extraction pipeline (supports multiple hikes).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # Multi-hike form
    parser.add_argument("--route", action="append", default=[],
                        metavar="SLUG:JSON_PATH",
                        help="Hike to process as slug:json_path (repeat for multiple)")

    # Legacy single-hike form
    parser.add_argument("--json", type=Path, default=None, help="SAC route JSON (single-hike mode)")
    parser.add_argument("--slug", default=None, help="Hike slug (single-hike mode)")

    # Shared options
    parser.add_argument("--region", default="TODO", help="Swiss region (applies to all)")
    parser.add_argument("--canton", default="TODO", help="Swiss canton (applies to all)")
    parser.add_argument("--peak-hero", action="append", default=[],
                        metavar="[SLUG=]URL",
                        help="Peak hero URL, optionally prefixed with slug= for multi-hike")
    parser.add_argument("--route-url", action="append", default=[],
                        metavar="[SLUG=]URL",
                        help="SAC route page URL (for correct source links; SAC slugs have transliterated umlauts)")

    # Pipeline control
    parser.add_argument("--no-scaffold", action="store_true")
    parser.add_argument("--no-photos", action="store_true")
    parser.add_argument("--no-elevation", action="store_true")
    parser.add_argument("--no-metadata", action="store_true")
    parser.add_argument("--render", action="store_true", help="Run make render after extraction")
    parser.add_argument("--parallel", action="store_true",
                        help="Process multiple hikes in parallel (experimental)")
    args = parser.parse_args()

    # Build hike list
    hikes: list[tuple[str, Path]] = []
    for r in args.route:
        if ":" not in r:
            parser.error(f"--route must be slug:json_path, got: {r}")
        slug, json_path = r.split(":", 1)
        hikes.append((slug, Path(json_path)))

    if args.json and args.slug:
        hikes.append((args.slug, args.json))
    elif args.json or args.slug:
        if not hikes:
            parser.error("--json and --slug must be used together")

    if not hikes:
        parser.error("No hikes specified. Use --route SLUG:JSON or --json/--slug.")

    # Parse key=value mappings for peak-hero and route-url
    def _parse_slug_map(values: list[str], label: str) -> dict[str, str]:
        result: dict[str, str] = {}
        for v in values:
            if "=" in v and not v.startswith("http"):
                slug_key, url = v.split("=", 1)
                result[slug_key] = url
            elif len(hikes) == 1:
                result[hikes[0][0]] = v
            else:
                parser.error(f"Ambiguous --{label} for multi-hike. Use SLUG=URL form: {v}")
        return result

    hero_map = _parse_slug_map(args.peak_hero, "peak-hero")
    url_map = _parse_slug_map(args.route_url, "route-url")

    print(f"Processing {len(hikes)} hike(s): {', '.join(s for s, _ in hikes)}")

    if args.parallel and len(hikes) > 1:
        with ProcessPoolExecutor() as ex:
            futures = {
                ex.submit(
                    process_hike,
                    slug=slug,
                    json_path=jp,
                    region=args.region,
                    canton=args.canton,
                    peak_hero=hero_map.get(slug),
                    route_url=url_map.get(slug),
                    no_elevation=args.no_elevation,
                    no_scaffold=args.no_scaffold,
                    no_photos=args.no_photos,
                    no_metadata=args.no_metadata,
                ): slug
                for slug, jp in hikes
            }
            for fut in futures:
                slug = futures[fut]
                try:
                    fut.result()
                except Exception as e:
                    print(f"\n[{slug}] ERROR: {e}", file=sys.stderr)
    else:
        for slug, jp in hikes:
            process_hike(
                slug=slug,
                json_path=jp,
                region=args.region,
                canton=args.canton,
                peak_hero=hero_map.get(slug),
                route_url=url_map.get(slug),
                no_elevation=args.no_elevation,
                no_scaffold=args.no_scaffold,
                no_photos=args.no_photos,
                no_metadata=args.no_metadata,
            )

    if args.render:
        print(f"\n{'='*60}")
        print("  Rendering all hikes")
        print(f"{'='*60}\n")
        subprocess.run(["make", "render"], cwd=str(REPO_ROOT))


if __name__ == "__main__":
    main()
