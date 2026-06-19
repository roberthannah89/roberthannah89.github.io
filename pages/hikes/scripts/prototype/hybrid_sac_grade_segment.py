"""Prototype: hybrid T-grade segmentation for Zindlenspitz.

OSM `sac_scale` is used as the primary, precise T1..T6 label. Where OSM is
silent, swissTLM3D `Wanderwegart` fills in coarse buckets (T1 / T2-T3 / T4+).
Where both are silent, the point stays "unknown".

One-off exploration — not part of the production pipeline. Run with the dev venv:

    ~/venvs/dev/bin/python scripts/prototype/hybrid_sac_grade_segment.py

This script REUSES the caches paid for by the two single-source prototypes:
  - /tmp/zindlenspitz-osm-sac.overpass.json   (OSM ways with sac_scale=*)
  - /tmp/swisstlm-wanderwege/SWISSTLM3D_WANDERWEGE.gpkg (full national dataset)

It will NOT redownload either if both caches are present.

Outputs:
  - routes/zindlenspitz/proto-hybrid-sac.json   (segments + stats; per-segment
    source = "osm" | "swisstopo" | "none")
  - docs/prototypes/sac-grade-hybrid.html       (standalone, file://-safe)
"""
from __future__ import annotations

import bisect
import json
import math
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path

# Repo paths.
SCRIPT_DIR = Path(__file__).resolve().parent
HIKES_ROOT = SCRIPT_DIR.parent.parent
ROUTE_DIR = HIKES_ROOT / "routes" / "zindlenspitz"
GPX_PATH = ROUTE_DIR / "zindlenspitz.gpx"
DATA_PATH = ROUTE_DIR / "zindlenspitz.data.json"
OUT_JSON = ROUTE_DIR / "proto-hybrid-sac.json"
OUT_HTML = HIKES_ROOT / "docs" / "prototypes" / "sac-grade-hybrid.html"

# OSM cache (shared with osm_sac_scale_segment.py).
OSM_CACHE_PATH = Path("/tmp/zindlenspitz-osm-sac.overpass.json")
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# swissTLM3D cache (shared with swisstlm_wanderwege_segment.py).
TLM_CACHE_DIR = Path("/tmp/swisstlm-wanderwege")
TLM_SRC_ZIP = TLM_CACHE_DIR / "swisstlm3d-wanderwege.gpkg.zip"
TLM_SRC_GPKG = TLM_CACHE_DIR / "SWISSTLM3D_WANDERWEGE.gpkg"
TLM_CLIPPED_GPKG = TLM_CACHE_DIR / "zindlenspitz-bbox.gpkg"
TLM_STAC_URL = (
    "https://data.geo.admin.ch/ch.swisstopo.swisstlm3d-wanderwege/"
    "swisstlm3d-wanderwege/swisstlm3d-wanderwege_2056_5728.gpkg.zip"
)
TLM_LAYER = "tlm_strassen_strasse"

GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}

# OSM sac_scale -> precise T-grade.
SAC_SCALE_TO_T = {
    "hiking": "T1",
    "mountain_hiking": "T2",
    "demanding_mountain_hiking": "T3",
    "alpine_hiking": "T4",
    "demanding_alpine_hiking": "T5",
    "difficult_alpine_hiking": "T6",
}

# swissTLM3D Wanderwegart -> coarse bucket. Wanderweg=T1 collapses cleanly onto
# the OSM T1 label (no extra row in the legend); the other two are distinct
# coarse buckets that need their own legend entries.
WANDERWEGART_TO_HYBRID = {
    "Wanderweg": "T1",
    "Bergwanderweg": "T2/T3",
    "Alpinwanderweg": "T4+",
}

# Palette: OSM-precise T1..T6 use the OSM script's colors. The two coarse
# swissTLM3D buckets use desaturated/muted intermediate hues that hint at their
# imprecision.
T_PALETTE = {
    "T1": "#1a9850",
    "T2": "#91cf60",
    "T3": "#fee08b",
    "T4": "#fc8d59",
    "T5": "#d73027",
    "T6": "#7a0177",
    # swisstopo-derived coarse buckets (muted to flag imprecision):
    "T2/T3": "#b8c46a",   # muted olive between T2 (light green) and T3 (yellow)
    "T4+":   "#c97a6a",   # desaturated terra-cotta between T4 (orange) and T5 (red)
    "unknown": "#888888",
}

# Mark which legend keys come from the coarse swissTLM3D fallback so the legend
# can render a small "swissTLM3D" tag/border on them.
COARSE_FROM_TLM = {"T2/T3", "T4+"}

EARTH_RADIUS_M = 6_371_000.0
BBOX_PAD_M = 500.0

# Snap tolerances — mirror each parent prototype's choice.
OSM_TOL_PRIMARY = 25.0
OSM_TOL_FALLBACK = 50.0
TLM_TOL_PRIMARY = 15.0
TLM_TOL_FALLBACK = 30.0

SMOOTH_WINDOW = 7   # odd; majority filter window over per-point labels
MIN_RUN_M = 50.0    # collapse runs shorter than this into the neighbour


# -------- GPX --------
def parse_gpx(path: Path) -> list[tuple[float, float, float]]:
    """Return a flat list of (lat, lon, ele) trkpts across all segments."""
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


# -------- Local equirectangular projection (for the OSM snap pass) --------
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
    """Planar distance from (px,py) to segment (ax,ay)-(bx,by)."""
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)


# -------- OSM data --------
def osm_load_or_query(bbox_wgs84: tuple[float, float, float, float]) -> dict:
    """bbox = (south, west, north, east). Returns parsed Overpass JSON."""
    if OSM_CACHE_PATH.exists():
        print(f"[osm cache hit] {OSM_CACHE_PATH}")
        return json.loads(OSM_CACHE_PATH.read_text())
    south, west, north, east = bbox_wgs84
    q = (
        "[out:json][timeout:60];\n"
        f"way[\"sac_scale\"]({south},{west},{north},{east});\n"
        "out tags geom;"
    )
    print(f"[overpass] querying bbox=({south:.4f},{west:.4f},{north:.4f},{east:.4f})")
    data = urllib.parse.urlencode({"data": q}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data,
                                 headers={"User-Agent": "zindlenspitz-prototype/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:  # noqa: S310
        payload = json.loads(resp.read())
    OSM_CACHE_PATH.write_text(json.dumps(payload))
    return payload


def snap_points_osm(gpx_pts: list[tuple[float, float, float]],
                    ways: list[dict],
                    lat0: float, lon0: float) -> list[str | None]:
    """Per GPX point, return the OSM-derived T-grade or None."""
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
        if best_d <= OSM_TOL_PRIMARY:
            labels.append(best_t)
        elif best_d <= OSM_TOL_FALLBACK:
            labels.append(best_t)
        else:
            labels.append(None)
    return labels


# -------- swissTLM3D data --------
def tlm_ensure_source_gpkg() -> None:
    """Download the full Wanderwege GeoPackage once and cache it."""
    TLM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if TLM_SRC_GPKG.exists():
        print(f"[tlm cache hit] {TLM_SRC_GPKG}")
        return
    if not TLM_SRC_ZIP.exists():
        print(f"[tlm download] {TLM_STAC_URL}")
        with urllib.request.urlopen(TLM_STAC_URL, timeout=300) as resp:  # noqa: S310
            TLM_SRC_ZIP.write_bytes(resp.read())
    print(f"[tlm unzip] -> {TLM_CACHE_DIR}")
    with zipfile.ZipFile(TLM_SRC_ZIP) as zf:
        zf.extractall(TLM_CACHE_DIR)


def tlm_clip(bbox_lv95: tuple[float, float, float, float]):
    """Clip the source layer to a LV95 bbox; return GeoDataFrame of features."""
    import geopandas as gpd  # local import — only needed at runtime
    from shapely.geometry import box

    minx, miny, maxx, maxy = bbox_lv95
    print(f"[tlm clip] LV95 bbox=({minx:.0f},{miny:.0f},{maxx:.0f},{maxy:.0f})")
    gdf = gpd.read_file(TLM_SRC_GPKG, layer=TLM_LAYER, bbox=(minx, miny, maxx, maxy))
    bbox_geom = box(minx, miny, maxx, maxy)
    gdf = gdf[gdf.intersects(bbox_geom)].copy()
    gdf = gdf[gdf["wanderwege"].notna() & (gdf["wanderwege"] != "")].copy()
    print(f"[tlm clip] {len(gdf)} features with non-null wanderwege")
    return gdf


def iter_line_coords(geom) -> list[list[tuple[float, float]]]:
    """2-D coord sequences for LineString / MultiLineString (3-D allowed)."""
    if geom is None or geom.is_empty:
        return []
    gtype = geom.geom_type
    if gtype == "LineString":
        return [[(x, y) for x, y, *_ in geom.coords]]
    if gtype == "MultiLineString":
        return [[(x, y) for x, y, *_ in g.coords] for g in geom.geoms]
    return []


def snap_points_tlm(gpx_xy: list[tuple[float, float]],
                    trail_segments: list[tuple[str, list[tuple[float, float]]]]
                    ) -> list[str | None]:
    """Per (E,N) point, return the hybrid coarse label or None.

    Maps Wanderwegart -> hybrid bucket via WANDERWEGART_TO_HYBRID so the
    output labels live in the same namespace as the OSM ones.
    """
    labels: list[str | None] = []
    tol = TLM_TOL_FALLBACK
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
        if best_art is None or best_d > TLM_TOL_FALLBACK:
            labels.append(None)
            continue
        labels.append(WANDERWEGART_TO_HYBRID.get(best_art))  # may be None
    return labels


# -------- Smoothing + runs --------
def majority_smooth(labels: list[str | None], win: int = SMOOTH_WINDOW) -> list[str | None]:
    n = len(labels)
    half = win // 2
    out: list[str | None] = []
    for i in range(n):
        window = [labels[j] for j in range(max(0, i - half), min(n, i + half + 1))
                  if labels[j] is not None]
        if not window:
            out.append(None)
            continue
        out.append(Counter(window).most_common(1)[0][0])
    return out


def majority_smooth_paired(labels: list[str | None],
                           sources: list[str],
                           win: int = SMOOTH_WINDOW
                           ) -> tuple[list[str | None], list[str]]:
    """Smooth labels with majority; pick the dominant source per window for the
    winning label (so the per-point source still reflects the smoothed label).
    """
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
        winning_src = Counter(winning_sources).most_common(1)[0][0]
        out_labels.append(winning_label)
        out_sources.append(winning_src)
    return out_labels, out_sources


def collapse_runs(labels: list[str | None],
                  sources: list[str],
                  cum_m: list[float]) -> list[dict]:
    """Collapse consecutive same-label runs into segments along the route.

    Source for the run is the most common per-point source among matched
    points; runs of `unknown` get source="none".
    """
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
            if seg_sources:
                seg_source = Counter(seg_sources).most_common(1)[0][0]
            else:
                seg_source = "none"
            runs.append({
                "start_m": cum_m[start_i],
                "end_m": cum_m[i - 1],
                "t_grade": seg_label,
                "source": seg_source,
                "n_points": i - start_i,
            })
            start_i = i
    # Merge sub-MIN_RUN_M runs into the previous run; keep previous run's
    # label and source.
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


# -------- HTML output --------
def render_html(pts: list[tuple[float, float, float]],
                cum_m: list[float],
                segments: list[dict],
                overall_grade: str,
                stats: dict) -> str:
    W, H = 1200, 320
    PAD_L, PAD_R, PAD_T, PAD_B = 60, 20, 20, 40
    inner_w = W - PAD_L - PAD_R
    inner_h = H - PAD_T - PAD_B
    elevs = [p[2] for p in pts]
    e_min, e_max = min(elevs), max(elevs)
    d_max = cum_m[-1] if cum_m else 1.0

    def sx(d: float) -> float:
        return PAD_L + (d / d_max) * inner_w

    def sy(e: float) -> float:
        return PAD_T + (1 - (e - e_min) / (e_max - e_min)) * inner_h

    # Drive segment boundaries from the MERGED `segments` list (sub-MIN_RUN_M
    # runs already folded in). Re-collapsing raw labels here would reintroduce
    # the white-seam bug at grade transitions.
    seg_boundaries: list[tuple[int, int, str, str]] = []
    last_n = len(cum_m) - 1
    for seg in segments:
        start_i = bisect.bisect_left(cum_m, seg["start_m"])
        end_i = bisect.bisect_right(cum_m, seg["end_m"]) - 1
        start_i = max(0, min(start_i, last_n))
        end_i = max(start_i, min(end_i, last_n))
        seg_boundaries.append((start_i, end_i, seg["t_grade"], seg["source"]))

    # Build a colored polyline + polygon per segment. Extend each segment's
    # drawn range by one point into the next segment so consecutive polylines
    # share a boundary pixel (otherwise a sub-pixel gap shows as a thin white
    # seam between adjacent runs).
    profile_paths: list[str] = []
    for k, (start_i, end_i, grade, _src) in enumerate(seg_boundaries):
        draw_end = end_i
        if k + 1 < len(seg_boundaries):
            draw_end = max(end_i, seg_boundaries[k + 1][0])
        if draw_end <= start_i:
            continue
        color = T_PALETTE.get(grade, T_PALETTE["unknown"])
        area_pts = []
        for i in range(start_i, draw_end + 1):
            area_pts.append(f"{sx(cum_m[i]):.1f},{sy(elevs[i]):.1f}")
        area_pts.append(f"{sx(cum_m[draw_end]):.1f},{PAD_T + inner_h:.1f}")
        area_pts.append(f"{sx(cum_m[start_i]):.1f},{PAD_T + inner_h:.1f}")
        profile_paths.append(
            f'<polygon points="{" ".join(area_pts)}" fill="{color}" '
            f'fill-opacity="0.55" stroke="none"/>'
        )
        line_pts = " ".join(
            f"{sx(cum_m[i]):.1f},{sy(elevs[i]):.1f}" for i in range(start_i, draw_end + 1)
        )
        profile_paths.append(
            f'<polyline points="{line_pts}" fill="none" stroke="{color}" '
            f'stroke-width="2"/>'
        )

    axes = [
        f'<line x1="{PAD_L}" y1="{PAD_T}" x2="{PAD_L}" y2="{PAD_T + inner_h}" '
        f'stroke="#444" stroke-width="1"/>',
        f'<line x1="{PAD_L}" y1="{PAD_T + inner_h}" x2="{PAD_L + inner_w}" '
        f'y2="{PAD_T + inner_h}" stroke="#444" stroke-width="1"/>',
    ]
    e_lo = math.floor(e_min / 200) * 200
    e_hi = math.ceil(e_max / 200) * 200
    e_t = e_lo
    while e_t <= e_hi:
        if e_min <= e_t <= e_max:
            y = sy(e_t)
            axes.append(
                f'<line x1="{PAD_L - 4}" y1="{y:.1f}" x2="{PAD_L}" y2="{y:.1f}" '
                f'stroke="#444" stroke-width="1"/>'
            )
            axes.append(
                f'<text x="{PAD_L - 8}" y="{y + 4:.1f}" text-anchor="end" '
                f'font-size="11" fill="#666">{int(e_t)}</text>'
            )
        e_t += 200
    d_t = 0
    while d_t <= d_max:
        x = sx(d_t)
        axes.append(
            f'<line x1="{x:.1f}" y1="{PAD_T + inner_h}" x2="{x:.1f}" '
            f'y2="{PAD_T + inner_h + 4}" stroke="#444" stroke-width="1"/>'
        )
        axes.append(
            f'<text x="{x:.1f}" y="{PAD_T + inner_h + 18}" text-anchor="middle" '
            f'font-size="11" fill="#666">{d_t // 1000}</text>'
        )
        d_t += 1000

    profile_svg = (
        f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" '
        f'style="width:100%;height:auto;background:#fafafa;border:1px solid #ddd">'
        + "".join(profile_paths)
        + "".join(axes)
        + f'<text x="{PAD_L}" y="{H - 8}" font-size="11" fill="#666">distance (km)</text>'
        + f'<text x="14" y="{PAD_T + 12}" font-size="11" fill="#666">elev (m)</text>'
        + "</svg>"
    )

    # Build a merged labels array for the Leaflet map so map and profile agree.
    # Sentinel = None so we distinguish "no segment assigned this index"
    # (a bisect-rounding gap between adjacent segments) from a legitimate
    # "unknown" run. Only the former gets filled from neighbours.
    merged_labels: list[str | None] = [None] * len(pts)
    for start_i, end_i, grade, _src in seg_boundaries:
        for i in range(start_i, end_i + 1):
            merged_labels[i] = grade
    last = None
    for i in range(len(merged_labels)):
        if merged_labels[i] is None and last is not None:
            merged_labels[i] = last
        elif merged_labels[i] is not None:
            last = merged_labels[i]
    nxt = None
    for i in range(len(merged_labels) - 1, -1, -1):
        if merged_labels[i] is None and nxt is not None:
            merged_labels[i] = nxt
        elif merged_labels[i] is not None:
            nxt = merged_labels[i]
    final_labels = [g if g is not None else "unknown" for g in merged_labels]
    map_pts_js = json.dumps([
        {"lat": round(p[0], 6), "lon": round(p[1], 6), "t": final_labels[i]}
        for i, p in enumerate(pts)
    ])

    # Legend — distinguish OSM-precise vs swissTLM3D-coarse with a small tag.
    legend_order = ["T1", "T2", "T3", "T4", "T5", "T6", "T2/T3", "T4+", "unknown"]
    def legend_entry(g: str) -> str:
        tag = ""
        border = ""
        if g in COARSE_FROM_TLM:
            tag = '<em class="src-tag">swissTLM3D</em>'
            border = "border:1px dashed rgba(0,0,0,.4);"
        return (f'<span class="lg"><i style="background:{T_PALETTE[g]};{border}"></i>'
                f'{g}{tag}</span>')
    legend_html = "".join(legend_entry(g) for g in legend_order)

    # Segment table — include source column with a small tag.
    def src_badge(src: str) -> str:
        if src == "osm":
            return '<span class="src osm">OSM</span>'
        if src == "swisstopo":
            return '<span class="src tlm">swissTLM3D</span>'
        return '<span class="src none">—</span>'

    segments_table_rows = "".join(
        f'<tr><td>{i + 1}</td><td>{s["start_m"]/1000:.2f}</td>'
        f'<td>{s["end_m"]/1000:.2f}</td><td>{s["length_m"]/1000:.2f}</td>'
        f'<td style="color:{T_PALETTE.get(s["t_grade"], "#888")};font-weight:600">'
        f'{s["t_grade"]}</td><td>{src_badge(s["source"])}</td>'
        f'<td>{s["coverage_pct"]}%</td></tr>'
        for i, s in enumerate(segments)
    )

    src_pct = stats.get("source_distribution_pct_by_length", {})
    dist_pct = stats.get("t_grade_distribution_pct_by_length", {})
    src_html = (
        f'OSM-precise <b>{src_pct.get("osm", 0)}%</b>, '
        f'swissTLM3D fallback <b>{src_pct.get("swisstopo", 0)}%</b>, '
        f'unknown <b>{src_pct.get("none", 0)}%</b>'
    )
    dist_html = ", ".join(f'<b>{k}</b> {v}%' for k, v in dist_pct.items()) or "—"

    stats_html = (
        f'<li>Overall SAC grade (from data.json): <b>{overall_grade}</b></li>'
        f'<li>GPX points: <b>{stats["n_points"]}</b></li>'
        f'<li>Coverage by source (length-weighted): {src_html}</li>'
        f'<li>Distribution by T-grade (length-weighted): {dist_html}</li>'
        f'<li>OSM ways fetched: <b>{stats["fetched_ways_osm"]}</b>; '
        f'swissTLM3D features (bbox-clipped): <b>{stats["fetched_features_tlm"]}</b></li>'
        f'<li>Total length: <b>{d_max/1000:.2f} km</b>; '
        f'elev range <b>{int(e_min)}–{int(e_max)} m</b></li>'
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Prototype — Hybrid SAC T-grade segmentation (Zindlenspitz)</title>
<meta name="proto-title" content="SAC T-grade segments (hybrid OSM + swisstopo)">
<meta name="proto-icon" content="&#x1F9ED;">
<meta name="proto-desc" content="OSM sac_scale primary, swissTLM3D Wanderwegart fallback for gaps — best coverage + T1–T6 precision">
<meta name="proto-source" content="OpenStreetMap + swisstopo">
<meta name="proto-order" content="100">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  body {{ font-family: system-ui, sans-serif; max-width: 1280px; margin: 24px auto;
          padding: 0 16px; color: #222; }}
  h1 {{ font-size: 20px; }}
  h2 {{ font-size: 15px; margin-top: 28px; }}
  .legend {{ display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 18px;
             align-items: center; }}
  .lg {{ display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }}
  .lg i {{ width: 14px; height: 14px; border-radius: 3px; display: inline-block; }}
  .src-tag {{ font-size: 10px; color: #888; font-style: normal;
              padding: 1px 4px; border: 1px solid #ccc; border-radius: 3px;
              margin-left: 3px; background: #fafafa; }}
  .src {{ font-size: 11px; padding: 1px 6px; border-radius: 3px;
          display: inline-block; }}
  .src.osm {{ background: #eaf4ea; color: #2a6f2a; border: 1px solid #c5e0c5; }}
  .src.tlm {{ background: #fdecea; color: #8a3a2c; border: 1px solid #f0c6bf;
              border-style: dashed; }}
  .src.none {{ background: #f1f1f1; color: #999; border: 1px solid #ddd; }}
  #map {{ height: 480px; border: 1px solid #ddd; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 13px; }}
  th, td {{ border-bottom: 1px solid #eee; padding: 6px 8px; text-align: left; }}
  th {{ background: #f5f5f5; }}
  ul.stats {{ font-size: 13px; line-height: 1.7; }}
  .row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }}
  @media (max-width: 900px) {{ .row {{ grid-template-columns: 1fr; }} }}
  code {{ background: #f5f5f5; padding: 0 4px; border-radius: 3px; }}
</style>
</head>
<body>
<h1>Zindlenspitz — hybrid T-grade segmentation
    (<a href="https://wiki.openstreetmap.org/wiki/Key:sac_scale"
        target="_blank" rel="noopener">OSM <code>sac_scale</code></a>
     + <a href="https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d"
        target="_blank" rel="noopener">swissTLM3D <code>Wanderwege</code></a>)</h1>
<p style="color:#666;font-size:13px">
  Prototype only. Each GPX point first tries to snap to an OSM way tagged
  <code>sac_scale=*</code> within 25–50 m (precise T1–T6). If that fails, it
  snaps to a swissTLM3D Wanderwege trail within 15–30 m and inherits a coarse
  bucket (Wanderweg→T1, Bergwanderweg→T2/T3, Alpinwanderweg→T4+). Points with no
  match within either tolerance are <code>unknown</code>. Smoothed with a
  {SMOOTH_WINDOW}-point majority filter. Coarse buckets are shown in muted
  colors with a small <em>swissTLM3D</em> tag so it's clear they're less precise
  than the OSM-derived grades.
</p>
<div class="legend">{legend_html}</div>
<ul class="stats">{stats_html}</ul>

<h2>Elevation profile (color = hybrid T-grade)</h2>
{profile_svg}

<h2 style="margin-top:24px">Map</h2>
<div class="row">
  <div id="map"></div>
  <div>
    <h2 style="margin-top:0">Segments along the route</h2>
    <table>
      <thead><tr><th>#</th><th>start km</th><th>end km</th><th>len km</th>
        <th>T-grade</th><th>source</th><th>% of route</th></tr></thead>
      <tbody>{segments_table_rows}</tbody>
    </table>
  </div>
</div>

<script>
const PTS = {map_pts_js};
const PALETTE = {json.dumps(T_PALETTE)};
const map = L.map('map');
L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
  attribution: '&copy; OpenStreetMap | swisstopo (swissTLM3D)', maxZoom: 19
}}).addTo(map);

let curGrade = null;
let curLine = [];
const allLatLngs = [];
function flush() {{
  if (curLine.length < 2 || curGrade === null) return;
  L.polyline(curLine, {{ color: PALETTE[curGrade] || PALETTE.unknown,
                       weight: 5, opacity: 0.9 }}).addTo(map);
}}
for (const p of PTS) {{
  const ll = [p.lat, p.lon];
  allLatLngs.push(ll);
  if (p.t !== curGrade) {{
    if (curLine.length >= 1) {{
      curLine.push(ll);
      flush();
    }}
    curGrade = p.t;
    curLine = [ll];
  }} else {{
    curLine.push(ll);
  }}
}}
flush();
map.fitBounds(L.latLngBounds(allLatLngs).pad(0.05));
</script>
</body>
</html>
"""


# -------- Main --------
def main() -> int:
    if not GPX_PATH.exists():
        print(f"GPX not found: {GPX_PATH}", file=sys.stderr)
        return 1
    if not DATA_PATH.exists():
        print(f"data.json not found: {DATA_PATH}", file=sys.stderr)
        return 1

    data = json.loads(DATA_PATH.read_text())
    overall_grade = (data.get("hero") or {}).get("grade") or "?"
    print(f"[info] overall grade from data.json: {overall_grade}")

    pts = parse_gpx(GPX_PATH)
    print(f"[info] GPX points: {len(pts)}")
    if len(pts) < 2:
        print("Need at least 2 GPX points", file=sys.stderr)
        return 1

    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    s, n = min(lats), max(lats)
    w, e = min(lons), max(lons)

    # WGS84 bbox for Overpass.
    dlat = BBOX_PAD_M / 111_000.0
    dlon = BBOX_PAD_M / (111_000.0 * math.cos(math.radians((s + n) / 2)))
    bbox_wgs = (s - dlat, w - dlon, n + dlat, e + dlon)

    # -------- OSM pass --------
    payload = osm_load_or_query(bbox_wgs)
    ways = [el for el in payload.get("elements", []) if el.get("type") == "way"]
    print(f"[info] {len(ways)} OSM ways with sac_scale=* in bbox")
    lat0, lon0 = (s + n) / 2, (w + e) / 2
    osm_labels = snap_points_osm(pts, ways, lat0, lon0)
    osm_matched = sum(1 for x in osm_labels if x is not None)
    print(f"[info] OSM matched: {osm_matched}/{len(pts)} "
          f"({100 * osm_matched / len(pts):.1f}%)")

    # -------- swissTLM3D pass (only where OSM is silent) --------
    import pyproj
    transformer = pyproj.Transformer.from_crs(4326, 2056, always_xy=True)
    gpx_lv95 = [transformer.transform(lon, lat) for lat, lon, _ in pts]
    corners = [transformer.transform(lon, lat) for lat in (s, n) for lon in (w, e)]
    minx = min(c[0] for c in corners) - BBOX_PAD_M
    maxx = max(c[0] for c in corners) + BBOX_PAD_M
    miny = min(c[1] for c in corners) - BBOX_PAD_M
    maxy = max(c[1] for c in corners) + BBOX_PAD_M

    tlm_ensure_source_gpkg()
    gdf = tlm_clip((minx, miny, maxx, maxy))
    if len(gdf) == 0:
        print("[warn] no Wanderwege features in bbox — hybrid will fall back to OSM only",
              file=sys.stderr)
        tlm_labels: list[str | None] = [None] * len(pts)
        n_features = 0
    else:
        trail_segments: list[tuple[str, list[tuple[float, float]]]] = []
        for _, row in gdf.iterrows():
            art = row.get("wanderwege")
            if not art:
                continue
            for coords in iter_line_coords(row.geometry):
                if len(coords) >= 2:
                    trail_segments.append((art, coords))
        print(f"[info] {len(trail_segments)} usable swissTLM3D trail line segments")
        tlm_labels = snap_points_tlm(gpx_lv95, trail_segments)
        n_features = int(len(gdf))
    tlm_matched = sum(1 for x in tlm_labels if x is not None)
    print(f"[info] swissTLM3D matched: {tlm_matched}/{len(pts)} "
          f"({100 * tlm_matched / len(pts):.1f}%)")

    # -------- Hybrid merge --------
    # Per-point: OSM if available, else swissTLM3D, else None. Track source.
    raw_labels: list[str | None] = []
    raw_sources: list[str] = []
    n_osm = n_tlm = n_none = 0
    overlap_osm_wins = 0
    for o, t in zip(osm_labels, tlm_labels):
        if o is not None:
            raw_labels.append(o)
            raw_sources.append("osm")
            n_osm += 1
            if t is not None:
                overlap_osm_wins += 1  # both sources present → OSM wins
        elif t is not None:
            raw_labels.append(t)
            raw_sources.append("swisstopo")
            n_tlm += 1
        else:
            raw_labels.append(None)
            raw_sources.append("none")
            n_none += 1
    print(f"[info] raw hybrid coverage: osm={n_osm}  swisstopo={n_tlm}  none={n_none}  "
          f"(of which {overlap_osm_wins} OSM points also had a swissTLM3D fallback)")

    # Smooth label + source together so per-point sources stay consistent.
    labels_s, sources_s = majority_smooth_paired(raw_labels, raw_sources, SMOOTH_WINDOW)

    cum_m = cumulative_distance(pts)
    segments = collapse_runs(labels_s, sources_s, cum_m)

    total_m = cum_m[-1]

    # Length-weighted distribution by T-grade.
    dist_by_grade: dict[str, float] = {}
    for seg in segments:
        dist_by_grade[seg["t_grade"]] = dist_by_grade.get(seg["t_grade"], 0.0) \
            + (seg["end_m"] - seg["start_m"])
    dist_pct = {g: round(100 * m / total_m, 1)
                for g, m in sorted(dist_by_grade.items())}

    # Length-weighted distribution by source.
    src_by_grade: dict[str, float] = {"osm": 0.0, "swisstopo": 0.0, "none": 0.0}
    for seg in segments:
        src_by_grade[seg["source"]] = src_by_grade.get(seg["source"], 0.0) \
            + (seg["end_m"] - seg["start_m"])
    src_pct = {k: round(100 * v / total_m, 1) for k, v in src_by_grade.items()}

    # Friendly top-line %s.
    osm_pct = src_pct.get("osm", 0.0)
    swisstopo_pct = src_pct.get("swisstopo", 0.0)
    unknown_pct = src_pct.get("none", 0.0)

    stats = {
        "n_points": len(pts),
        "fetched_ways_osm": len(ways),
        "fetched_features_tlm": n_features,
        "osm_pct": osm_pct,
        "swisstopo_pct": swisstopo_pct,
        "unknown_pct": unknown_pct,
        "raw_point_coverage": {
            "osm": n_osm,
            "swisstopo": n_tlm,
            "none": n_none,
            "osm_also_tlm_overlap": overlap_osm_wins,
        },
        "source_distribution_pct_by_length": src_pct,
        "t_grade_distribution_pct_by_length": dist_pct,
    }

    out = {
        "method": "hybrid-osm-sac+swisstlm3d",
        "overall_t_grade": overall_grade,
        "segments": segments,
        "stats": stats,
    }
    OUT_JSON.write_text(json.dumps(out, indent=2))
    print(f"[wrote] {OUT_JSON}")

    html = render_html(pts, cum_m, segments, overall_grade, stats)
    OUT_HTML.write_text(html)
    print(f"[wrote] {OUT_HTML}")

    print(f"[stats] osm={osm_pct}%  swisstopo={swisstopo_pct}%  "
          f"unknown={unknown_pct}%  distribution: {dist_pct}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
