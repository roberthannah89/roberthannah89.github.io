"""Prototype: fetch named peaks near the Zindlenspitz route from OpenStreetMap.

One-off exploration for a peaks-on-3D-map demo. Not part of the production pipeline.

    ~/venvs/dev/bin/python scripts/prototype/fetch_route_peaks.py

Steps:
  1. Parse the Zindlenspitz GPX bounding box.
  2. Expand by ~10 km on all sides.
  3. Query Overpass for OSM `natural=peak` nodes with a `name` tag in that bbox.
  4. Compute distance from the route line for each peak (min great-circle
     distance to any track point — good enough at 10 km scale).
  5. Filter to peaks within 10 km of the track.
  6. Write routes/zindlenspitz/proto-peaks.json with a list of
     {name, ele, lat, lon, prominence, wikidata, wikipedia, dist_km}
     sorted by elevation descending.
"""
from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HIKES_ROOT = SCRIPT_DIR.parent.parent
ROUTE_DIR = HIKES_ROOT / "routes" / "zindlenspitz"
GPX_PATH = ROUTE_DIR / "zindlenspitz.gpx"
OUT_JSON = ROUTE_DIR / "proto-peaks.json"
CACHE_PATH = Path("/tmp/zindlenspitz-osm-peaks.overpass.json")

BUFFER_KM = 10.0
EARTH_RADIUS_KM = 6371.0088


def parse_gpx_points(gpx_path: Path) -> list[tuple[float, float]]:
    tree = ET.parse(gpx_path)
    root = tree.getroot()
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    pts: list[tuple[float, float]] = []
    for trkpt in root.iterfind(".//g:trkpt", ns):
        lat = float(trkpt.attrib["lat"])
        lon = float(trkpt.attrib["lon"])
        pts.append((lat, lon))
    return pts


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


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def min_distance_to_track_km(peak: tuple[float, float], track: list[tuple[float, float]]) -> float:
    # Coarse point-to-point min. Fine at 10 km scale — the track has thousands
    # of points, so consecutive segments are <10 m apart.
    return min(haversine_km(peak, p) for p in track)


def fetch_overpass(bbox_expanded: tuple[float, float, float, float]) -> dict:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    lat_min, lon_min, lat_max, lon_max = bbox_expanded
    query = f"""
[out:json][timeout:60];
(
  node["natural"="peak"]["name"]({lat_min:.5f},{lon_min:.5f},{lat_max:.5f},{lon_max:.5f});
);
out body;
""".strip()
    url = "https://overpass-api.de/api/interpreter"
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "hikes-peaks-proto/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        payload = json.load(r)
    CACHE_PATH.write_text(json.dumps(payload))
    return payload


def main() -> int:
    track = parse_gpx_points(GPX_PATH)
    if not track:
        print("no track points", flush=True)
        return 1
    b = bbox(track)
    b_ext = expand_bbox_km(b, BUFFER_KM)
    print(f"track bbox: {b}", flush=True)
    print(f"expanded ({BUFFER_KM} km): {b_ext}", flush=True)

    payload = fetch_overpass(b_ext)
    raw = payload.get("elements", [])
    print(f"overpass returned {len(raw)} peak nodes", flush=True)

    peaks: list[dict] = []
    for el in raw:
        tags = el.get("tags", {}) or {}
        name = tags.get("name")
        if not name:
            continue
        lat, lon = el.get("lat"), el.get("lon")
        if lat is None or lon is None:
            continue
        ele_str = tags.get("ele")
        try:
            ele = float(ele_str) if ele_str is not None else None
        except ValueError:
            ele = None
        dist_km = min_distance_to_track_km((lat, lon), track)
        if dist_km > BUFFER_KM:
            continue
        prom_str = tags.get("prominence")
        try:
            prominence = float(prom_str) if prom_str is not None else None
        except ValueError:
            prominence = None
        peaks.append({
            "name": name,
            "ele": ele,
            "lat": lat,
            "lon": lon,
            "prominence": prominence,
            "wikidata": tags.get("wikidata"),
            "wikipedia": tags.get("wikipedia"),
            "dist_km": round(dist_km, 2),
        })

    peaks.sort(key=lambda p: (-(p["ele"] or 0), p["name"]))
    OUT_JSON.write_text(json.dumps({"peaks": peaks, "count": len(peaks), "buffer_km": BUFFER_KM}, indent=2))
    print(f"wrote {len(peaks)} peaks to {OUT_JSON.relative_to(HIKES_ROOT)}", flush=True)

    with_ele = sum(1 for p in peaks if p["ele"] is not None)
    with_prom = sum(1 for p in peaks if p["prominence"] is not None)
    with_wd = sum(1 for p in peaks if p["wikidata"])
    print(f"  with elevation: {with_ele}", flush=True)
    print(f"  with prominence tag: {with_prom}", flush=True)
    print(f"  with wikidata link: {with_wd}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
