"""Prototype: color the Zindlenspitz elevation profile by swissTLM3D Wanderwegart.

One-off exploration — not part of the production pipeline. Run with the dev venv:

    ~/venvs/dev/bin/python scripts/prototype/swisstlm_wanderwege_segment.py

It does the following:
  1. Parse the Zindlenspitz GPX (lat, lon, ele).
  2. Download the full national `swissTLM3D Wanderwege` GeoPackage (~190 MB
     zipped) once via the geo.admin.ch STAC endpoint, cache it under
     /tmp/swisstlm-wanderwege/, and bbox-clip the trail features around the
     hike (+500 m buffer). The clipped subset is written to
     /tmp/swisstlm-wanderwege/zindlenspitz-bbox.gpkg for reproducibility.
  3. Reproject GPX points to EPSG:2056 (LV95) — the dataset's native CRS.
  4. For each GPX point, snap to the nearest trail line segment within a
     15 m tolerance (falling back to 30 m). Label the point with the matched
     segment's `wanderwege` attribute (Wanderweg / Bergwanderweg /
     Alpinwanderweg), or `None` if no trail within tolerance.
  5. Majority-filter the label sequence (window=7) and collapse to runs.
  6. Write two outputs into routes/zindlenspitz/:
       - proto-swisstlm-wanderwege.json (segments + stats)
       - proto-swisstlm-wanderwege.html (standalone SVG profile + Leaflet map,
         file://-safe; CDN Leaflet allowed but no other external assets).

Wanderwegart -> approximate SAC T-grade mapping (rough, per official guidance):

  - Wanderweg       (yellow signage) → T1
  - Bergwanderweg   (white-red-white) → T2/T3
  - Alpinwanderweg  (white-blue-white) → T4+
  - andere/unknown  (off-network or unmatched) → ?
"""
from __future__ import annotations

import bisect
import json
import math
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path

# Repo paths (script lives in scripts/prototype/, so go up twice).
SCRIPT_DIR = Path(__file__).resolve().parent
HIKES_ROOT = SCRIPT_DIR.parent.parent
ROUTE_DIR = HIKES_ROOT / "routes" / "zindlenspitz"
GPX_PATH = ROUTE_DIR / "zindlenspitz.gpx"
DATA_PATH = ROUTE_DIR / "zindlenspitz.data.json"
OUT_JSON = ROUTE_DIR / "proto-swisstlm-wanderwege.json"
OUT_HTML = HIKES_ROOT / "docs" / "prototypes" / "sac-grade-swisstopo.html"

CACHE_DIR = Path("/tmp/swisstlm-wanderwege")
SRC_ZIP = CACHE_DIR / "swisstlm3d-wanderwege.gpkg.zip"
SRC_GPKG = CACHE_DIR / "SWISSTLM3D_WANDERWEGE.gpkg"
CLIPPED_GPKG = CACHE_DIR / "zindlenspitz-bbox.gpkg"

STAC_DOWNLOAD_URL = (
    "https://data.geo.admin.ch/ch.swisstopo.swisstlm3d-wanderwege/"
    "swisstlm3d-wanderwege/swisstlm3d-wanderwege_2056_5728.gpkg.zip"
)
SRC_LAYER = "tlm_strassen_strasse"  # the only layer in the GeoPackage

GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}

# Approximate T-grade mapping (Swiss signage colors are reflected in the
# elevation-profile palette below).
WANDERWEGART_TO_T = {
    "Wanderweg": "T1",
    "Bergwanderweg": "T2/T3",
    "Alpinwanderweg": "T4+",
}

# Swiss-signage-aligned palette for elevation profile + map polylines.
ART_PALETTE = {
    "Wanderweg": "#f3c623",       # yellow
    "Bergwanderweg": "#d62828",   # red
    "Alpinwanderweg": "#1d4ed8",  # blue
    "andere": "#888888",          # grey for unmatched / off-network
}

EARTH_RADIUS_M = 6_371_000.0  # mirrors scripts/config.py:EARTH_RADIUS_M
BBOX_PAD_M = 500.0
MATCH_TOL_M_PRIMARY = 15.0
MATCH_TOL_M_FALLBACK = 30.0
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


# -------- Dataset fetch + clip --------
def ensure_source_gpkg() -> None:
    """Download the full Wanderwege GeoPackage once and cache it."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if SRC_GPKG.exists():
        print(f"[cache hit] {SRC_GPKG}")
        return
    if not SRC_ZIP.exists():
        print(f"[download] {STAC_DOWNLOAD_URL}")
        with urllib.request.urlopen(STAC_DOWNLOAD_URL, timeout=300) as resp:  # noqa: S310
            SRC_ZIP.write_bytes(resp.read())
        print(f"[cached] {SRC_ZIP} ({SRC_ZIP.stat().st_size / 1e6:.1f} MB)")
    print(f"[unzip] -> {CACHE_DIR}")
    with zipfile.ZipFile(SRC_ZIP) as zf:
        zf.extractall(CACHE_DIR)
    assert SRC_GPKG.exists(), f"expected {SRC_GPKG} after unzip"


def clip_to_bbox_lv95(bbox_lv95: tuple[float, float, float, float]):
    """Clip the source layer to a LV95 bbox and write the result for repro.

    Returns the GeoDataFrame of clipped features (in EPSG:2056).
    """
    import geopandas as gpd  # local import — only needed at runtime
    from shapely.geometry import box

    minx, miny, maxx, maxy = bbox_lv95
    print(f"[clip] LV95 bbox=({minx:.0f},{miny:.0f},{maxx:.0f},{maxy:.0f})")
    # pyogrio supports bbox filtering at read time — far faster than reading all 400k rows.
    gdf = gpd.read_file(SRC_GPKG, layer=SRC_LAYER, bbox=(minx, miny, maxx, maxy))
    print(f"[clip] read {len(gdf)} features in bbox")
    # Tighten with intersect against the bbox polygon (read_file with bbox returns
    # any feature that touches the bbox envelope; intersect for cleaner extract).
    bbox_geom = box(minx, miny, maxx, maxy)
    gdf = gdf[gdf.intersects(bbox_geom)].copy()
    # Drop rows where the wanderwege attribute is null/empty.
    gdf = gdf[gdf["wanderwege"].notna() & (gdf["wanderwege"] != "")].copy()
    print(f"[clip] {len(gdf)} features with non-null wanderwege")
    try:
        gdf.to_file(CLIPPED_GPKG, driver="GPKG", layer="wanderwege_clip")
        print(f"[wrote] {CLIPPED_GPKG}")
    except Exception as ex:  # noqa: BLE001
        print(f"[warn] could not write clipped GPKG: {ex}")
    return gdf


# -------- Snapping in LV95 --------
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


def iter_line_coords(geom) -> list[list[tuple[float, float]]]:
    """Yield 2-D coord sequences for LineString / MultiLineString (3-D allowed)."""
    if geom is None or geom.is_empty:
        return []
    gtype = geom.geom_type
    if gtype == "LineString":
        return [[(x, y) for x, y, *_ in geom.coords]]
    if gtype == "MultiLineString":
        return [[(x, y) for x, y, *_ in g.coords] for g in geom.geoms]
    return []


def snap_points(gpx_xy: list[tuple[float, float]],
                trail_segments: list[tuple[str, list[tuple[float, float]]]]):
    """For each (E,N) point, find nearest trail; return (labels, distances)."""
    labels: list[str | None] = []
    distances: list[float] = []
    tol = MATCH_TOL_M_FALLBACK
    for px, py in gpx_xy:
        best_d = float("inf")
        best_label: str | None = None
        for art, coords in trail_segments:
            for (ax, ay), (bx, by) in zip(coords, coords[1:]):
                # Quick AABB reject in LV95 metres.
                if max(ax, bx) < px - tol: continue
                if min(ax, bx) > px + tol: continue
                if max(ay, by) < py - tol: continue
                if min(ay, by) > py + tol: continue
                d = point_to_segment_dist(px, py, ax, ay, bx, by)
                if d < best_d:
                    best_d = d
                    best_label = art
        if best_d <= MATCH_TOL_M_PRIMARY:
            labels.append(best_label)
        elif best_d <= MATCH_TOL_M_FALLBACK:
            labels.append(best_label)
        else:
            labels.append(None)
        distances.append(best_d if best_label is not None else float("inf"))
    return labels, distances


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


def collapse_runs(labels: list[str | None], cum_m: list[float]) -> list[dict]:
    """Collapse consecutive same-label points into segments along the route."""
    if not labels:
        return []
    runs: list[dict] = []
    start_i = 0
    norm = lambda lab: lab if lab is not None else "andere"  # noqa: E731
    for i in range(1, len(labels) + 1):
        if i == len(labels) or norm(labels[i]) != norm(labels[start_i]):
            art = norm(labels[start_i])
            runs.append({
                "start_m": cum_m[start_i],
                "end_m": cum_m[i - 1],
                "wanderwegart": art,
                "t_grade_approx": WANDERWEGART_TO_T.get(art, "?"),
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


# -------- HTML output --------
def render_html(pts: list[tuple[float, float, float]],
                cum_m: list[float],
                labels: list[str | None],
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
    # runs have already been folded in there). Re-collapsing `labels` directly
    # would re-introduce flicker as 1–2-point segments that the gap-eater
    # silently drops, leaving white seams near grade transitions.
    seg_boundaries: list[tuple[int, int, str]] = []
    last_n = len(cum_m) - 1
    for seg in segments:
        start_i = bisect.bisect_left(cum_m, seg["start_m"])
        end_i = bisect.bisect_right(cum_m, seg["end_m"]) - 1
        start_i = max(0, min(start_i, last_n))
        end_i = max(start_i, min(end_i, last_n))
        seg_boundaries.append((start_i, end_i, seg["wanderwegart"]))

    # Extend each segment by one point into the next so consecutive polylines
    # share a boundary pixel — otherwise a sub-pixel gap shows as a thin white
    # seam between adjacent runs.
    profile_paths: list[str] = []
    for k, (start_i, end_i, art) in enumerate(seg_boundaries):
        draw_end = end_i
        if k + 1 < len(seg_boundaries):
            draw_end = max(end_i, seg_boundaries[k + 1][0])
        if draw_end <= start_i:
            continue
        color = ART_PALETTE.get(art, ART_PALETTE["andere"])
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

    # Drive map labels from merged segments so the map agrees with the profile
    # and table; raw `labels` would re-introduce sub-MIN_RUN_M flicker.
    merged_labels = ["andere"] * len(pts)
    for start_i, end_i, art in seg_boundaries:
        for i in range(start_i, end_i + 1):
            merged_labels[i] = art
    map_pts_js = json.dumps([
        {"lat": round(p[0], 6), "lon": round(p[1], 6), "a": merged_labels[i]}
        for i, p in enumerate(pts)
    ])

    legend_order = ["Wanderweg", "Bergwanderweg", "Alpinwanderweg", "andere"]
    legend_html = "".join(
        f'<span class="lg"><i style="background:{ART_PALETTE[a]}"></i>'
        f'{a} <em style="color:#888">({WANDERWEGART_TO_T.get(a, "?")})</em></span>'
        for a in legend_order
    )

    segments_table_rows = "".join(
        f'<tr><td>{i + 1}</td><td>{s["start_m"]/1000:.2f}</td>'
        f'<td>{s["end_m"]/1000:.2f}</td><td>{s["length_m"]/1000:.2f}</td>'
        f'<td style="color:{ART_PALETTE.get(s["wanderwegart"], "#888")};font-weight:600">'
        f'{s["wanderwegart"]}</td><td>{s["t_grade_approx"]}</td>'
        f'<td>{s["coverage_pct"]}%</td></tr>'
        for i, s in enumerate(segments)
    )

    dist_pct = stats.get("wanderwegart_distribution_pct_by_length", {})
    dist_html = ", ".join(f"{k}: <b>{v}%</b>" for k, v in dist_pct.items()) or "—"

    stats_html = (
        f'<li>Overall SAC grade (from data.json): <b>{overall_grade}</b></li>'
        f'<li>GPX points: <b>{stats["n_points"]}</b> '
        f'(matched <b>{stats["matched_pct"]}%</b>, '
        f'untagged <b>{stats["untagged_pct"]}%</b>)</li>'
        f'<li>Wanderwege features fetched (bbox-clipped): <b>{stats["fetched_features"]}</b></li>'
        f'<li>Distribution along route by length: {dist_html}</li>'
        f'<li>Total length: <b>{d_max/1000:.2f} km</b>; '
        f'elev range <b>{int(e_min)}–{int(e_max)} m</b></li>'
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Prototype — swissTLM3D Wanderwegart segmentation (Zindlenspitz)</title>
<meta name="proto-title" content="SAC T-grade segments (swisstopo)">
<meta name="proto-icon" content="&#x26F0;&#xFE0F;">
<meta name="proto-desc" content="Per-segment Wanderweg/Bergwanderweg/Alpinwanderweg from swissTLM3D — authoritative but 3-class only">
<meta name="proto-source" content="swisstopo (swissTLM3D Wanderwege)">
<meta name="proto-order" content="104">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  body {{ font-family: system-ui, sans-serif; max-width: 1280px; margin: 24px auto;
          padding: 0 16px; color: #222; }}
  h1 {{ font-size: 20px; }}
  h2 {{ font-size: 15px; margin-top: 28px; }}
  .legend {{ display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 18px; }}
  .lg {{ display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }}
  .lg i {{ width: 14px; height: 14px; border-radius: 3px; display: inline-block;
          border: 1px solid rgba(0,0,0,.15); }}
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
<h1>Zindlenspitz — elevation profile colored by swissTLM3D <code>Wanderwegart</code></h1>
<p style="color:#666;font-size:13px">
  Prototype only. Each GPX point is snapped to the nearest swisstopo
  <a href="https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d"
     target="_blank" rel="noopener">swissTLM3D Wanderwege</a> trail within
  15–30 m and labelled with that trail's <code>wanderwege</code> attribute.
  Smoothed with a {SMOOTH_WINDOW}-point majority filter.
  Colors match Swiss signage: yellow = Wanderweg, red = Bergwanderweg,
  blue = Alpinwanderweg, grey = unmatched / off-network.
</p>
<div class="legend">{legend_html}</div>
<ul class="stats">{stats_html}</ul>

<h2>Elevation profile (color = Wanderwegart)</h2>
{profile_svg}

<h2 style="margin-top:24px">Map</h2>
<div class="row">
  <div id="map"></div>
  <div>
    <h2 style="margin-top:0">Segments along the route</h2>
    <table>
      <thead><tr><th>#</th><th>start km</th><th>end km</th><th>len km</th>
        <th>Wanderwegart</th><th>~T</th><th>% of route</th></tr></thead>
      <tbody>{segments_table_rows}</tbody>
    </table>
  </div>
</div>

<script>
const PTS = {map_pts_js};
const PALETTE = {json.dumps(ART_PALETTE)};
const map = L.map('map');
L.tileLayer(
  'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{{z}}/{{x}}/{{y}}.jpeg',
  {{ attribution: '&copy; swisstopo', maxZoom: 18 }}
).addTo(map);

let curArt = null;
let curLine = [];
const allLatLngs = [];
function flush() {{
  if (curLine.length < 2 || curArt === null) return;
  L.polyline(curLine, {{ color: PALETTE[curArt] || PALETTE.andere,
                       weight: 5, opacity: 0.9 }}).addTo(map);
}}
for (const p of PTS) {{
  const ll = [p.lat, p.lon];
  allLatLngs.push(ll);
  if (p.a !== curArt) {{
    if (curLine.length >= 1) {{
      curLine.push(ll);
      flush();
    }}
    curArt = p.a;
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

    # bbox in WGS84.
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    s, n = min(lats), max(lats)
    w, e = min(lons), max(lons)

    # Lazy import pyproj/geopandas so the script can at least show GPX-only
    # errors before pulling heavy geo deps.
    import pyproj
    transformer = pyproj.Transformer.from_crs(4326, 2056, always_xy=True)

    # Project corners + GPX points to LV95.
    gpx_lv95 = [transformer.transform(lon, lat) for lat, lon, _ in pts]
    corners = [transformer.transform(lon, lat) for lat in (s, n) for lon in (w, e)]
    minx = min(c[0] for c in corners) - BBOX_PAD_M
    maxx = max(c[0] for c in corners) + BBOX_PAD_M
    miny = min(c[1] for c in corners) - BBOX_PAD_M
    maxy = max(c[1] for c in corners) + BBOX_PAD_M

    ensure_source_gpkg()
    gdf = clip_to_bbox_lv95((minx, miny, maxx, maxy))
    if len(gdf) == 0:
        print("[error] no Wanderwege features in bbox", file=sys.stderr)
        return 1

    # Build trail segments [(wanderwegart, [(x,y), ...]), ...].
    trail_segments: list[tuple[str, list[tuple[float, float]]]] = []
    for _, row in gdf.iterrows():
        art = row.get("wanderwege")
        if not art:
            continue
        for coords in iter_line_coords(row.geometry):
            if len(coords) >= 2:
                trail_segments.append((art, coords))
    print(f"[info] {len(trail_segments)} usable trail line segments after split")

    labels, distances = snap_points(gpx_lv95, trail_segments)
    matched_raw = sum(1 for label in labels if label is not None)
    print(f"[info] raw matched: {matched_raw}/{len(labels)} "
          f"({100 * matched_raw / len(labels):.1f}%)")

    labels_s = majority_smooth(labels, SMOOTH_WINDOW)
    matched_s = sum(1 for label in labels_s if label is not None)
    cum_m = cumulative_distance(pts)
    segments = collapse_runs(labels_s, cum_m)

    matched_pct = round(100 * matched_s / len(labels_s), 1)
    untagged_pct = round(100 * (len(labels_s) - matched_s) / len(labels_s), 1)

    # Distribution along the route by length (post-smoothing, post-collapse).
    dist_by_art: dict[str, float] = {}
    for seg in segments:
        dist_by_art[seg["wanderwegart"]] = dist_by_art.get(seg["wanderwegart"], 0.0) \
            + (seg["end_m"] - seg["start_m"])
    total_m = cum_m[-1]
    dist_pct = {a: round(100 * m / total_m, 1)
                for a, m in sorted(dist_by_art.items())}

    stats = {
        "n_points": len(pts),
        "matched_pct": matched_pct,
        "untagged_pct": untagged_pct,
        "fetched_features": int(len(gdf)),
        "wanderwegart_distribution_pct_by_length": dist_pct,
    }

    out = {
        "method": "swisstlm3d-wanderwegart",
        "overall_t_grade": overall_grade,
        "segments": segments,
        "stats": stats,
    }
    OUT_JSON.write_text(json.dumps(out, indent=2))
    print(f"[wrote] {OUT_JSON}")

    html = render_html(pts, cum_m, labels_s, segments, overall_grade, stats)
    OUT_HTML.write_text(html)
    print(f"[wrote] {OUT_HTML}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
