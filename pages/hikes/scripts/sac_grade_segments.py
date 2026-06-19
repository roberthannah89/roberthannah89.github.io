"""Per-hike SAC T-grade segmentation along a GPX track.

Hybrid source strategy:
  * OSM `sac_scale` is the primary label (precise T1..T6).
  * swissTLM3D `Wanderwegart` fills in coarse buckets (T1 / T2/T3 / T4+)
    where OSM is silent.
  * Where both are silent, the point stays "unknown".

Usage:
    ~/venvs/dev/bin/python scripts/sac_grade_segments.py --slug zindlenspitz
    ~/venvs/dev/bin/python scripts/sac_grade_segments.py --all

Writes `routes/<slug>/sac-grade-segments.json`.

Caches:
  * Per-route OSM Overpass response: `routes/<slug>/osm-sac-ways.json` (raw
    source data — keep alongside the SAC JSON captures for reproducibility).
  * Global swissTLM3D Wanderwege GeoPackage: `/tmp/swisstlm-wanderwege/` (one
    190 MB download shared across all hikes; refresh annually).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HIKES_ROOT = SCRIPT_DIR.parent
ROUTES_DIR = HIKES_ROOT / "routes"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

TLM_CACHE_DIR = Path("/tmp/swisstlm-wanderwege")
TLM_SRC_ZIP = TLM_CACHE_DIR / "swisstlm3d-wanderwege.gpkg.zip"
TLM_SRC_GPKG = TLM_CACHE_DIR / "SWISSTLM3D_WANDERWEGE.gpkg"
TLM_STAC_URL = (
    "https://data.geo.admin.ch/ch.swisstopo.swisstlm3d-wanderwege/"
    "swisstlm3d-wanderwege/swisstlm3d-wanderwege_2056_5728.gpkg.zip"
)
TLM_LAYER = "tlm_strassen_strasse"

GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}

SAC_SCALE_TO_T = {
    "hiking": "T1",
    "mountain_hiking": "T2",
    "demanding_mountain_hiking": "T3",
    "alpine_hiking": "T4",
    "demanding_alpine_hiking": "T5",
    "difficult_alpine_hiking": "T6",
}
WANDERWEGART_TO_HYBRID = {
    "Wanderweg": "T1",
    "Bergwanderweg": "T2/T3",
    "Alpinwanderweg": "T4+",
}

EARTH_RADIUS_M = 6_371_000.0
BBOX_PAD_M = 500.0
OSM_TOL_PRIMARY = 25.0
OSM_TOL_FALLBACK = 50.0
TLM_TOL_FALLBACK = 30.0
SMOOTH_WINDOW = 7
MIN_RUN_M = 50.0


def parse_gpx(path: Path) -> list[tuple[float, float, float]]:
    tree = ET.parse(path)
    pts: list[tuple[float, float, float]] = []
    for tp in tree.findall(".//g:trkpt", GPX_NS):
        ele_el = tp.find("g:ele", GPX_NS)
        ele = float(ele_el.text) if ele_el is not None and ele_el.text else 0.0
        pts.append((float(tp.get("lat") or 0), float(tp.get("lon") or 0), ele))
    return pts


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def cumulative_distance(pts: list[tuple[float, float, float]]) -> list[float]:
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + haversine_m(a[0], a[1], b[0], b[1]))
    return cum


def make_projector(lat0: float, lon0: float):
    cos_lat = math.cos(math.radians(lat0))

    def proj(lat: float, lon: float) -> tuple[float, float]:
        x = math.radians(lon - lon0) * EARTH_RADIUS_M * cos_lat
        y = math.radians(lat - lat0) * EARTH_RADIUS_M
        return x, y

    return proj


def point_to_segment_dist(px: float, py: float,
                          ax: float, ay: float,
                          bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)


def gpx_bbox(pts: list[tuple[float, float, float]]) -> tuple[float, float, float, float]:
    """Return (south, west, north, east) padded by BBOX_PAD_M."""
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    south, north = min(lats), max(lats)
    west, east = min(lons), max(lons)
    lat0 = (south + north) / 2
    d_lat = BBOX_PAD_M / EARTH_RADIUS_M * (180 / math.pi)
    d_lon = d_lat / max(0.01, math.cos(math.radians(lat0)))
    return south - d_lat, west - d_lon, north + d_lat, east + d_lon


def osm_load_or_query(cache_path: Path,
                      bbox_wgs84: tuple[float, float, float, float]) -> dict:
    if cache_path.exists():
        return json.loads(cache_path.read_text())
    south, west, north, east = bbox_wgs84
    q = (
        "[out:json][timeout:60];\n"
        f"way[\"sac_scale\"]({south},{west},{north},{east});\n"
        "out tags geom;"
    )
    print(f"[overpass] querying bbox=({south:.4f},{west:.4f},{north:.4f},{east:.4f})")
    data = urllib.parse.urlencode({"data": q}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data,
                                 headers={"User-Agent": "hikes/sac-grade-segments"})
    # Overpass rate-limits aggressively when querying many hikes in a row.
    # Retry on 429 / 504 with exponential backoff before giving up.
    backoffs = [10, 25, 60, 120]
    for attempt, backoff in enumerate([0, *backoffs]):
        if backoff:
            print(f"[overpass]   retry after {backoff}s (attempt {attempt})")
            time.sleep(backoff)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:  # noqa: S310
                payload = json.loads(resp.read())
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(payload))
            # Small courtesy gap so the NEXT fresh query doesn't slam Overpass.
            time.sleep(3)
            return payload
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503, 504) and attempt < len(backoffs):
                continue
            raise


def snap_points_osm(gpx_pts: list[tuple[float, float, float]],
                    ways: list[dict],
                    lat0: float, lon0: float) -> list[str | None]:
    proj = make_projector(lat0, lon0)
    way_segments: list[tuple[str, list[tuple[float, float]]]] = []
    for w in ways:
        tag = w.get("tags", {}).get("sac_scale")
        t_grade = SAC_SCALE_TO_T.get(tag)
        if not t_grade or not w.get("geometry"):
            continue
        projected = [proj(g["lat"], g["lon"]) for g in w["geometry"]]
        way_segments.append((t_grade, projected))

    labels: list[str | None] = []
    for lat, lon, _ in gpx_pts:
        px, py = proj(lat, lon)
        best_d = float("inf")
        best_t: str | None = None
        for t_grade, geom in way_segments:
            for (ax, ay), (bx, by) in zip(geom, geom[1:]):
                if max(ax, bx) < px - OSM_TOL_FALLBACK: continue
                if min(ax, bx) > px + OSM_TOL_FALLBACK: continue
                if max(ay, by) < py - OSM_TOL_FALLBACK: continue
                if min(ay, by) > py + OSM_TOL_FALLBACK: continue
                d = point_to_segment_dist(px, py, ax, ay, bx, by)
                if d < best_d:
                    best_d = d
                    best_t = t_grade
        labels.append(best_t if best_d <= OSM_TOL_FALLBACK else None)
    return labels


def tlm_ensure_source_gpkg() -> None:
    TLM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if TLM_SRC_GPKG.exists():
        return
    if not TLM_SRC_ZIP.exists():
        print(f"[tlm download] {TLM_STAC_URL}")
        with urllib.request.urlopen(TLM_STAC_URL, timeout=300) as resp:  # noqa: S310
            TLM_SRC_ZIP.write_bytes(resp.read())
    print(f"[tlm unzip] -> {TLM_CACHE_DIR}")
    with zipfile.ZipFile(TLM_SRC_ZIP) as zf:
        zf.extractall(TLM_CACHE_DIR)


def tlm_clip(bbox_wgs84: tuple[float, float, float, float]):
    """Clip the source layer to a WGS-84 bbox; return list of (Wanderwegart,
    list of (E,N) LV95 vertices)."""
    import geopandas as gpd
    import pyproj
    from shapely.geometry import box

    transformer = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
    south, west, north, east = bbox_wgs84
    sw = transformer.transform(west, south)
    ne = transformer.transform(east, north)
    minx, miny = min(sw[0], ne[0]), min(sw[1], ne[1])
    maxx, maxy = max(sw[0], ne[0]), max(sw[1], ne[1])
    gdf = gpd.read_file(TLM_SRC_GPKG, layer=TLM_LAYER,
                        bbox=(minx, miny, maxx, maxy))
    bbox_geom = box(minx, miny, maxx, maxy)
    gdf = gdf[gdf.intersects(bbox_geom)].copy()
    gdf = gdf[gdf["wanderwege"].notna() & (gdf["wanderwege"] != "")].copy()

    trail_segments: list[tuple[str, list[tuple[float, float]]]] = []
    for _, row in gdf.iterrows():
        art = str(row["wanderwege"])
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        gtype = geom.geom_type
        if gtype == "LineString":
            coords = [(x, y) for x, y, *_ in geom.coords]
            trail_segments.append((art, coords))
        elif gtype == "MultiLineString":
            for g in geom.geoms:
                coords = [(x, y) for x, y, *_ in g.coords]
                trail_segments.append((art, coords))
    return trail_segments, (minx, miny, maxx, maxy)


def project_gpx_to_lv95(gpx_pts: list[tuple[float, float, float]]
                        ) -> list[tuple[float, float]]:
    import pyproj
    transformer = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
    out = []
    for lat, lon, _ in gpx_pts:
        x, y = transformer.transform(lon, lat)
        out.append((x, y))
    return out


def snap_points_tlm(gpx_xy: list[tuple[float, float]],
                    trail_segments: list[tuple[str, list[tuple[float, float]]]]
                    ) -> list[str | None]:
    tol = TLM_TOL_FALLBACK
    labels: list[str | None] = []
    for px, py in gpx_xy:
        best_d = float("inf")
        best_art: str | None = None
        for art, coords in trail_segments:
            for (ax, ay), (bx, by) in zip(coords, coords[1:]):
                if max(ax, bx) < px - tol: continue
                if min(ax, bx) > px + tol: continue
                if max(ay, by) < py - tol: continue
                if min(ay, by) > py + tol: continue
                d = point_to_segment_dist(px, py, ax, ay, bx, by)
                if d < best_d:
                    best_d = d
                    best_art = art
        if best_art is None or best_d > tol:
            labels.append(None)
        else:
            labels.append(WANDERWEGART_TO_HYBRID.get(best_art))
    return labels


def majority_smooth_paired(labels: list[str | None],
                           sources: list[str],
                           win: int = SMOOTH_WINDOW
                           ) -> tuple[list[str | None], list[str]]:
    n = len(labels)
    half = win // 2
    out_labels: list[str | None] = []
    out_sources: list[str] = []
    for i in range(n):
        idxs = range(max(0, i - half), min(n, i + half + 1))
        window = [(labels[j], sources[j]) for j in idxs if labels[j] is not None]
        if not window:
            out_labels.append(None)
            out_sources.append("none")
            continue
        winning_label = Counter(lab for lab, _ in window).most_common(1)[0][0]
        winning_sources = [src for lab, src in window if lab == winning_label]
        out_labels.append(winning_label)
        out_sources.append(Counter(winning_sources).most_common(1)[0][0])
    return out_labels, out_sources


def collapse_runs(labels: list[str | None],
                  sources: list[str],
                  cum_m: list[float]) -> list[dict]:
    if not labels:
        return []
    norm = lambda lab: lab if lab is not None else "unknown"  # noqa: E731
    runs: list[dict] = []
    start_i = 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or norm(labels[i]) != norm(labels[start_i]):
            seg_label = norm(labels[start_i])
            seg_sources = [sources[j] for j in range(start_i, i)
                           if labels[j] is not None]
            seg_source = (Counter(seg_sources).most_common(1)[0][0]
                          if seg_sources else "none")
            runs.append({
                "start_m": cum_m[start_i],
                "end_m": cum_m[i - 1],
                "t_grade": seg_label,
                "source": seg_source,
                "n_points": i - start_i,
            })
            start_i = i
    merged: list[dict] = []
    for r in runs:
        length = r["end_m"] - r["start_m"]
        if merged and length < MIN_RUN_M:
            merged[-1]["end_m"] = r["end_m"]
            merged[-1]["n_points"] += r["n_points"]
        else:
            merged.append(dict(r))
    total = cum_m[-1] if cum_m else 0.0
    for m in merged:
        seg_len = m["end_m"] - m["start_m"]
        m["coverage_pct"] = round((seg_len / total) * 100.0, 2) if total else 0.0
        m["length_m"] = round(seg_len, 1)
        m["start_m"] = round(m["start_m"], 1)
        m["end_m"] = round(m["end_m"], 1)
    return merged


def compute_for_slug(slug: str) -> dict:
    route_dir = ROUTES_DIR / slug
    gpx_path = route_dir / f"{slug}.gpx"
    if not gpx_path.exists():
        raise FileNotFoundError(f"missing GPX: {gpx_path}")
    osm_cache = route_dir / "osm-sac-ways.json"
    out_json = route_dir / "sac-grade-segments.json"

    print(f"[{slug}] parsing GPX")
    pts = parse_gpx(gpx_path)
    if len(pts) < 2:
        raise RuntimeError(f"{slug}: GPX has fewer than 2 points")
    cum_m = cumulative_distance(pts)
    bbox = gpx_bbox(pts)
    lat0 = sum(p[0] for p in pts) / len(pts)
    lon0 = sum(p[1] for p in pts) / len(pts)

    print(f"[{slug}] OSM snap")
    osm_payload = osm_load_or_query(osm_cache, bbox)
    ways = osm_payload.get("elements") or []
    osm_labels = snap_points_osm(pts, ways, lat0, lon0)
    osm_matched = sum(1 for label in osm_labels if label is not None)
    print(f"[{slug}]   OSM matched {osm_matched}/{len(pts)} "
          f"({osm_matched/len(pts):.0%}); fetched {len(ways)} ways")

    needs_tlm = any(label is None for label in osm_labels)
    tlm_labels: list[str | None] = [None] * len(pts)
    if needs_tlm:
        print(f"[{slug}] swissTLM3D fallback for unlabelled points")
        tlm_ensure_source_gpkg()
        trail_segments, _ = tlm_clip(bbox)
        gpx_xy = project_gpx_to_lv95(pts)
        tlm_labels = snap_points_tlm(gpx_xy, trail_segments)
        tlm_filled = sum(1 for i, label in enumerate(tlm_labels)
                         if osm_labels[i] is None and label is not None)
        print(f"[{slug}]   swissTLM3D filled {tlm_filled} points "
              f"({tlm_filled/len(pts):.0%}); {len(trail_segments)} trail segments")

    raw_labels: list[str | None] = []
    raw_sources: list[str] = []
    for i in range(len(pts)):
        if osm_labels[i] is not None:
            raw_labels.append(osm_labels[i])
            raw_sources.append("osm")
        elif tlm_labels[i] is not None:
            raw_labels.append(tlm_labels[i])
            raw_sources.append("swisstopo")
        else:
            raw_labels.append(None)
            raw_sources.append("none")

    sm_labels, sm_sources = majority_smooth_paired(raw_labels, raw_sources)
    segments = collapse_runs(sm_labels, sm_sources, cum_m)

    total = cum_m[-1] if cum_m else 0.0
    osm_len = sum(s["length_m"] for s in segments if s["source"] == "osm")
    tlm_len = sum(s["length_m"] for s in segments if s["source"] == "swisstopo")
    unk_len = sum(s["length_m"] for s in segments if s["t_grade"] == "unknown")
    stats = {
        "total_m": round(total, 1),
        "n_points": len(pts),
        "osm_pct": round(osm_len / total * 100, 1) if total else 0.0,
        "swisstopo_pct": round(tlm_len / total * 100, 1) if total else 0.0,
        "unknown_pct": round(unk_len / total * 100, 1) if total else 0.0,
    }

    out_data = {
        "slug": slug,
        "method": "hybrid-osm-primary-swisstlm3d-fallback",
        "segments": segments,
        "stats": stats,
    }
    out_json.write_text(json.dumps(out_data, indent=2))
    print(f"[{slug}] wrote {out_json} ({len(segments)} segments, "
          f"osm={stats['osm_pct']}% tlm={stats['swisstopo_pct']}% "
          f"unknown={stats['unknown_pct']}%)")
    return out_data


def all_slugs() -> list[str]:
    return sorted(d.name for d in ROUTES_DIR.iterdir()
                  if d.is_dir() and (d / f"{d.name}.gpx").exists())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--slug", help="Process a single hike by slug")
    g.add_argument("--all", action="store_true", help="Process every hike under routes/")
    ap.add_argument("--skip-existing", action="store_true",
                    help="With --all, skip hikes that already have sac-grade-segments.json")
    args = ap.parse_args()

    slugs = [args.slug] if args.slug else all_slugs()
    failed: list[str] = []
    for slug in slugs:
        if args.skip_existing and (ROUTES_DIR / slug / "sac-grade-segments.json").exists():
            continue
        try:
            compute_for_slug(slug)
        except Exception as e:  # noqa: BLE001
            print(f"[{slug}] FAILED: {e}", file=sys.stderr)
            failed.append(slug)
    if failed:
        print(f"\n{len(failed)} failures: {failed}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
