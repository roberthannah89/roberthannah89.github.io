"""Project the Peak Database into a per-route "nearby peaks" set.

Given a hike's GPX, filter the Peak Database to peaks within a distance buffer of the
track and emit `routes/<slug>/nearby-peaks.js` (window.ROUTE_PEAKS). Used by
per-route 3D-view prototypes so the "peaks near this hike" ring loads
instantly without touching the multi-MB DB file.

Each record carries the full DB schema, plus a computed `dist_km` field
(closest point on the peak → track line, in kilometres).

Usage:
    python3 scripts/build_route_peaks.py --slug zindlenspitz [--buffer-km 10]

If the Peak Database doesn't exist yet, run `scripts/build_peak_db.py` first.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import config

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_JSON = REPO_ROOT / "guides" / "peaks-db.json"
ROUTES_DIR = REPO_ROOT / "routes"

DEFAULT_BUFFER_KM = 10.0


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def parse_gpx_points(gpx_path: Path) -> list[tuple[float, float]]:
    tree = ET.parse(gpx_path)
    root = tree.getroot()
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    return [
        (float(pt.attrib["lat"]), float(pt.attrib["lon"]))
        for pt in root.iterfind(".//g:trkpt", ns)
    ]


def bbox(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return min(lats), min(lons), max(lats), max(lons)


def expand_bbox_km(b: tuple[float, float, float, float], km: float) -> tuple[float, float, float, float]:
    lat_min, lon_min, lat_max, lon_max = b
    center_lat = (lat_min + lat_max) / 2.0
    dlat = km / 111.32
    dlon = km / (111.32 * math.cos(math.radians(center_lat)))
    return lat_min - dlat, lon_min - dlon, lat_max + dlat, lon_max + dlon


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = config.EARTH_RADIUS_M / 1000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def min_dist_km(peak_lat: float, peak_lon: float, track: list[tuple[float, float]]) -> float:
    # Coarse point-to-point min. Fine at 10 km scale — GPX tracks have
    # thousands of points, so consecutive segments are <10 m apart.
    return min(haversine_km(peak_lat, peak_lon, t[0], t[1]) for t in track)


def build(slug: str, buffer_km: float) -> None:
    if not DB_JSON.exists():
        raise SystemExit(
            f"Peak Database not found at {DB_JSON.relative_to(REPO_ROOT)} — "
            "run `python3 scripts/build_peak_db.py` first"
        )
    route_dir = ROUTES_DIR / slug
    gpx_path = route_dir / f"{slug}.gpx"
    if not gpx_path.exists():
        raise SystemExit(f"GPX not found: {gpx_path.relative_to(REPO_ROOT)}")

    out_js = route_dir / "nearby-peaks.js"

    log(f"[1/3] Parsing GPX ({gpx_path.name})")
    track = parse_gpx_points(gpx_path)
    if not track:
        raise SystemExit("no track points in GPX")
    b_ext = expand_bbox_km(bbox(track), buffer_km)
    lat_min, lon_min, lat_max, lon_max = b_ext

    log(f"[2/3] Filtering DB to peaks within {buffer_km} km of track")
    with DB_JSON.open() as f:
        db = json.load(f)

    nearby: list[dict] = []
    for p in db["peaks"]:
        lat = p["lat"]
        lon = p["lon"]
        if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
            continue
        d = min_dist_km(lat, lon, track)
        if d > buffer_km:
            continue
        rec = dict(p)
        rec["dist_km"] = round(d, 2)
        nearby.append(rec)

    nearby.sort(key=lambda r: (
        -(r.get("ele_wikidata") or r.get("ele") or 0),
        r["name"],
    ))

    log(f"[3/3] Writing {out_js.relative_to(REPO_ROOT)}")
    banner = (
        "// GENERATED FROM guides/peaks-db.json by scripts/build_route_peaks.py — do not edit.\n"
        f"// Re-run: python3 scripts/build_route_peaks.py --slug {slug}\n"
    )
    body = json.dumps(
        {"peaks": nearby, "count": len(nearby), "buffer_km": buffer_km},
        separators=(",", ":"), ensure_ascii=False,
    )
    out_js.write_text(f"{banner}window.ROUTE_PEAKS = {body};\n")
    log(f"      {len(nearby)} peaks · {out_js.stat().st_size / 1024:.0f} KB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slug", required=True, help="hike slug (e.g. zindlenspitz)")
    parser.add_argument("--buffer-km", type=float, default=DEFAULT_BUFFER_KM,
                        help=f"distance buffer around GPX track (default {DEFAULT_BUFFER_KM})")
    args = parser.parse_args()
    build(args.slug, args.buffer_km)


if __name__ == "__main__":
    main()
