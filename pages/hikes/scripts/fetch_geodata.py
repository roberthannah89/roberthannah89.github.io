"""Fetch and simplify Swiss geodata for the regions guide page.

Downloads canton boundaries (swisstopo swissBOUNDARIES3D) and BAFU
biogeographical region boundaries from the Swiss federal geodata API,
simplifies the geometries for web use, and writes compact GeoJSON files.

Sources
-------
- Cantons: https://api3.geo.admin.ch — layer ch.swisstopo.swissboundaries3d-kanton-flaeche.fill
- Regions: https://api3.geo.admin.ch — layer ch.bafu.biogeographische_regionen

Usage
-----
    python fetch_geodata.py                     # writes to ../guides/
    python fetch_geodata.py --out-dir ../guides  # explicit output dir
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

CANTON_IDENTIFY_URL = (
    "https://api3.geo.admin.ch/rest/services/api/MapServer/identify"
    "?layers=all:ch.swisstopo.swissboundaries3d-kanton-flaeche.fill"
    "&geometry=5.9,45.8,10.5,47.9"
    "&geometryType=esriGeometryEnvelope"
    "&mapExtent=5.9,45.8,10.5,47.9"
    "&imageDisplay=100,100,96"
    "&tolerance=0"
    "&returnGeometry=true&sr=4326&geometryFormat=geojson"
)

REGION_IDENTIFY_URL = (
    "https://api3.geo.admin.ch/rest/services/api/MapServer/identify"
    "?layers=all:ch.bafu.biogeographische_regionen"
    "&geometry=5.9,45.8,10.5,47.9"
    "&geometryType=esriGeometryEnvelope"
    "&mapExtent=5.9,45.8,10.5,47.9"
    "&imageDisplay=100,100,96"
    "&tolerance=0"
    "&returnGeometry=true&sr=4326&geometryFormat=geojson"
)

UNTERREGION_DE_TO_EN = {
    "Jura und Randen": "Jura",
    "Genferseegebiet": "Lake Geneva",
    "Hochrheingebiet": "High Rhine",
    "Westliches Mittelland": "Western Plateau",
    "Östliches Mittelland": "Eastern Plateau",
    "Voralpen": "Pre-Alps",
    "Nordalpen": "Northern Alps",
    "Westliche Zentralalpen": "Western Central Alps",
    "Östliche Zentralalpen": "Eastern Central Alps",
    "Engadin": "Engadin",
    "Südalpen": "Southern Alps",
    "Südliches Tessin": "Southern Ticino",
}

REGION_DE_TO_EN = {
    "Jura": "Jura",
    "Mittelland": "Plateau",
    "Alpennordflanke": "Northern Alpine Flank",
    "Westliche Zentralalpen": "Western Central Alps",
    "Östliche Zentralalpen": "Eastern Central Alps",
    "Alpensüdflanke": "Southern Alpine Flank",
}


def _perpendicular_distance(
    point: tuple[float, float],
    line_start: tuple[float, float],
    line_end: tuple[float, float],
) -> float:
    dx = line_end[0] - line_start[0]
    dy = line_end[1] - line_start[1]
    if dx == 0 and dy == 0:
        return math.hypot(point[0] - line_start[0], point[1] - line_start[1])
    t = ((point[0] - line_start[0]) * dx + (point[1] - line_start[1]) * dy) / (dx * dx + dy * dy)
    t = max(0, min(1, t))
    proj_x = line_start[0] + t * dx
    proj_y = line_start[1] + t * dy
    return math.hypot(point[0] - proj_x, point[1] - proj_y)


def _douglas_peucker(coords: list[list[float]], epsilon: float) -> list[list[float]]:
    if len(coords) <= 2:
        return coords
    stack = [(0, len(coords) - 1)]
    keep = {0, len(coords) - 1}
    while stack:
        start, end = stack.pop()
        max_dist = 0.0
        max_idx = start
        for i in range(start + 1, end):
            d = _perpendicular_distance(
                (coords[i][0], coords[i][1]),
                (coords[start][0], coords[start][1]),
                (coords[end][0], coords[end][1]),
            )
            if d > max_dist:
                max_dist = d
                max_idx = i
        if max_dist > epsilon:
            keep.add(max_idx)
            stack.append((start, max_idx))
            stack.append((max_idx, end))
    return [coords[i] for i in sorted(keep)]


def _round_coords(coords: list[list[float]], precision: int = 4) -> list[list[float]]:
    return [[round(c, precision) for c in pt] for pt in coords]


def _simplify_ring(ring: list[list[float]], epsilon: float, precision: int) -> list[list[float]]:
    simplified = _douglas_peucker(ring, epsilon)
    rounded = _round_coords(simplified, precision)
    # Remove consecutive duplicates
    deduped = [rounded[0]]
    for pt in rounded[1:]:
        if pt != deduped[-1]:
            deduped.append(pt)
    # Ensure ring is closed
    if deduped[0] != deduped[-1]:
        deduped.append(deduped[0])
    return deduped


def _simplify_geometry(
    geometry: dict, epsilon: float = 0.005, precision: int = 4
) -> dict:
    gtype = geometry.get("type", "")
    coords = geometry.get("coordinates", [])

    if gtype == "Polygon":
        return {
            "type": "Polygon",
            "coordinates": [_simplify_ring(ring, epsilon, precision) for ring in coords],
        }
    elif gtype == "MultiPolygon":
        return {
            "type": "MultiPolygon",
            "coordinates": [
                [_simplify_ring(ring, epsilon, precision) for ring in polygon]
                for polygon in coords
            ],
        }
    return geometry


def _centroid(geometry: dict) -> tuple[float, float]:
    """Approximate centroid from the first ring of the geometry."""
    gtype = geometry.get("type", "")
    coords = geometry.get("coordinates", [])
    if gtype == "Polygon" and coords:
        ring = coords[0]
    elif gtype == "MultiPolygon" and coords:
        biggest = max(coords, key=lambda poly: len(poly[0]))
        ring = biggest[0]
    else:
        return 0.0, 0.0
    lons = [pt[0] for pt in ring]
    lats = [pt[1] for pt in ring]
    return sum(lons) / len(lons), sum(lats) / len(lats)


def _fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "fetch_geodata/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_cantons(epsilon: float = 0.003, precision: int = 4) -> dict:
    print("[geodata] Fetching canton boundaries from api3.geo.admin.ch ...")
    data = _fetch_json(CANTON_IDENTIFY_URL)
    features = []
    for r in data.get("results", []):
        attrs = r.get("properties") or r.get("attributes") or {}
        geom = _simplify_geometry(r.get("geometry", {}), epsilon, precision)
        lon, lat = _centroid(geom)
        features.append({
            "type": "Feature",
            "properties": {
                "name": attrs.get("name", ""),
                "ak": attrs.get("ak", ""),
                "label_lat": round(lat, 4),
                "label_lon": round(lon, 4),
            },
            "geometry": geom,
        })
    fc = {"type": "FeatureCollection", "features": features}
    raw_size = len(json.dumps(data))
    out_size = len(json.dumps(fc))
    print(f"[geodata]   {len(features)} cantons, {raw_size/1024:.0f} KB → {out_size/1024:.0f} KB")
    return fc


def fetch_regions(epsilon: float = 0.005, precision: int = 4) -> dict:
    print("[geodata] Fetching BAFU biogeographical regions from api3.geo.admin.ch ...")
    data = _fetch_json(REGION_IDENTIFY_URL)
    features = []
    for r in data.get("results", []):
        attrs = r.get("properties") or r.get("attributes") or {}
        geom = _simplify_geometry(r.get("geometry", {}), epsilon, precision)
        de_name = attrs.get("unterregionname_de", "")
        en_name = UNTERREGION_DE_TO_EN.get(de_name, de_name)
        main_de = attrs.get("regionname_de", "")
        main_en = REGION_DE_TO_EN.get(main_de, main_de)
        lon, lat = _centroid(geom)
        features.append({
            "type": "Feature",
            "properties": {
                "name": en_name,
                "name_de": de_name,
                "group": main_en,
                "group_de": main_de,
                "label_lat": round(lat, 4),
                "label_lon": round(lon, 4),
            },
            "geometry": geom,
        })
    fc = {"type": "FeatureCollection", "features": features}
    raw_size = len(json.dumps(data))
    out_size = len(json.dumps(fc))
    print(f"[geodata]   {len(features)} sub-regions, {raw_size/1024:.0f} KB → {out_size/1024:.0f} KB")
    return fc


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--out-dir", type=Path, default=REPO_ROOT / "guides",
                   help="Output directory for .geojson files")
    args = p.parse_args(argv)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    cantons = fetch_cantons()
    canton_path = args.out_dir / "cantons.geojson"
    canton_path.write_text(json.dumps(cantons, separators=(",", ":")), encoding="utf-8")
    print(f"[geodata] Wrote {canton_path} ({canton_path.stat().st_size / 1024:.0f} KB)")

    regions = fetch_regions()
    region_path = args.out_dir / "regions.geojson"
    region_path.write_text(json.dumps(regions, separators=(",", ":")), encoding="utf-8")
    print(f"[geodata] Wrote {region_path} ({region_path.stat().st_size / 1024:.0f} KB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
