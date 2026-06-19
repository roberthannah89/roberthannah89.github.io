"""Prototype: color the Zindlenspitz elevation profile by OSM `sac_scale`.

One-off exploration — not part of the production pipeline. Run with the dev venv:

    ~/venvs/dev/bin/python scripts/prototype/osm_sac_scale_segment.py

It does the following:
  1. Parse the Zindlenspitz GPX (lat, lon, ele).
  2. Query Overpass for OSM ways with `sac_scale=*` in a 500 m-expanded bbox.
     The raw response is cached at /tmp/zindlenspitz-osm-sac.overpass.json.
  3. For each GPX point, snap to the nearest tagged OSM way segment within a
     25 m tolerance (falling back to 50 m if nothing closer). Label that point
     with the way's `sac_scale` value mapped to T1..T6.
  4. Majority-filter the label sequence (window=7) and collapse to runs.
  5. Write two outputs into routes/zindlenspitz/:
       - proto-osm-sac.json   (segments + stats)
       - proto-osm-sac.html   (standalone SVG profile + Leaflet map, file://-safe)
"""
from __future__ import annotations

import bisect
import json
import math
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

# Repo paths (script lives in scripts/prototype/, so go up twice).
SCRIPT_DIR = Path(__file__).resolve().parent
HIKES_ROOT = SCRIPT_DIR.parent.parent
ROUTE_DIR = HIKES_ROOT / "routes" / "zindlenspitz"
GPX_PATH = ROUTE_DIR / "zindlenspitz.gpx"
DATA_PATH = ROUTE_DIR / "zindlenspitz.data.json"
OUT_JSON = ROUTE_DIR / "proto-osm-sac.json"
OUT_HTML = HIKES_ROOT / "docs" / "prototypes" / "sac-grade-osm.html"
CACHE_PATH = Path("/tmp/zindlenspitz-osm-sac.overpass.json")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}

# OSM sac_scale -> SAC T-grade mapping (per the OSM wiki).
SAC_SCALE_TO_T = {
    "hiking": "T1",
    "mountain_hiking": "T2",
    "demanding_mountain_hiking": "T3",
    "alpine_hiking": "T4",
    "demanding_alpine_hiking": "T5",
    "difficult_alpine_hiking": "T6",
}

T_PALETTE = {
    "T1": "#1a9850",
    "T2": "#91cf60",
    "T3": "#fee08b",
    "T4": "#fc8d59",
    "T5": "#d73027",
    "T6": "#7a0177",
    "unknown": "#888888",
}

EARTH_RADIUS_M = 6_371_000.0
BBOX_PAD_M = 500.0
MATCH_TOL_M_PRIMARY = 25.0
MATCH_TOL_M_FALLBACK = 50.0
SMOOTH_WINDOW = 7  # odd; majority filter window over per-point labels
MIN_RUN_M = 50.0  # collapse runs shorter than this into the neighbour


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


# -------- Overpass --------
def overpass_query(bbox: tuple[float, float, float, float]) -> dict:
    """bbox = (south, west, north, east). Returns the parsed JSON response."""
    if CACHE_PATH.exists():
        print(f"[cache hit] {CACHE_PATH}")
        return json.loads(CACHE_PATH.read_text())

    south, west, north, east = bbox
    # Ways tagged with sac_scale, anywhere in the bbox.
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
    CACHE_PATH.write_text(json.dumps(payload))
    print(f"[overpass] cached -> {CACHE_PATH}")
    return payload


# -------- Local equirectangular projection (sufficient for ~few-km bbox) --------
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


# -------- Snapping --------
def snap_points(gpx_pts: list[tuple[float, float, float]],
                ways: list[dict],
                lat0: float, lon0: float) -> tuple[list[str | None], list[float]]:
    """Per GPX point, return (T-grade label or None, snap distance metres)."""
    proj = make_projector(lat0, lon0)
    # Project ways once.
    way_segments: list[tuple[str, list[tuple[float, float]]]] = []
    for w in ways:
        tag = w.get("tags", {}).get("sac_scale")
        t_grade = SAC_SCALE_TO_T.get(tag)
        if not t_grade or not w.get("geometry"):
            continue
        projected = [proj(g["lat"], g["lon"]) for g in w["geometry"]]
        way_segments.append((t_grade, projected))

    labels: list[str | None] = []
    distances: list[float] = []
    for lat, lon, _ in gpx_pts:
        px, py = proj(lat, lon)
        best_d = float("inf")
        best_t: str | None = None
        for t_grade, geom in way_segments:
            for (ax, ay), (bx, by) in zip(geom, geom[1:]):
                # Quick AABB reject.
                if max(ax, bx) < px - MATCH_TOL_M_FALLBACK: continue
                if min(ax, bx) > px + MATCH_TOL_M_FALLBACK: continue
                if max(ay, by) < py - MATCH_TOL_M_FALLBACK: continue
                if min(ay, by) > py + MATCH_TOL_M_FALLBACK: continue
                d = point_to_segment_dist(px, py, ax, ay, bx, by)
                if d < best_d:
                    best_d = d
                    best_t = t_grade
        if best_d <= MATCH_TOL_M_PRIMARY:
            labels.append(best_t)
        elif best_d <= MATCH_TOL_M_FALLBACK:
            labels.append(best_t)
        else:
            labels.append(None)
        distances.append(best_d if best_t is not None else float("inf"))
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


def cumulative_distance(pts: list[tuple[float, float, float]]) -> list[float]:
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + haversine_m(a[0], a[1], b[0], b[1]))
    return cum


def collapse_runs(labels: list[str | None],
                  cum_m: list[float]) -> list[dict]:
    """Collapse consecutive same-label points into segments along the route."""
    if not labels:
        return []
    runs: list[dict] = []
    start_i = 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or labels[i] != labels[start_i]:
            seg_label = labels[start_i] or "unknown"
            runs.append({
                "start_m": cum_m[start_i],
                "end_m": cum_m[i - 1],
                "t_grade": seg_label,
                "n_points": i - start_i,
            })
            start_i = i
    # Merge runs shorter than MIN_RUN_M into a neighbour.
    merged: list[dict] = []
    for r in runs:
        length = r["end_m"] - r["start_m"]
        if merged and length < MIN_RUN_M:
            # Extend previous, keep its label.
            merged[-1]["end_m"] = r["end_m"]
            merged[-1]["n_points"] += r["n_points"]
        else:
            merged.append(dict(r))
    # Recompute coverage_pct against total length.
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
    # Profile dimensions.
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
    # runs have already been folded into their neighbour there). Re-collapsing
    # `labels` directly would re-introduce those tiny runs as 1–2-point
    # segments that the gap-eater (`end_i <= start_i: continue`) silently drops,
    # leaving visible white holes wherever label flicker happened near grade
    # transitions.
    seg_boundaries: list[tuple[int, int, str]] = []
    last_n = len(cum_m) - 1
    for seg in segments:
        start_i = bisect.bisect_left(cum_m, seg["start_m"])
        end_i = bisect.bisect_right(cum_m, seg["end_m"]) - 1
        start_i = max(0, min(start_i, last_n))
        end_i = max(start_i, min(end_i, last_n))
        seg_boundaries.append((start_i, end_i, seg["t_grade"]))

    # Build a colored polyline + polygon per segment. Extend each segment's
    # drawn range by one point into the next segment so consecutive polylines
    # share a boundary pixel (otherwise a sub-pixel gap shows as a thin white
    # seam between adjacent runs).
    profile_paths: list[str] = []
    for k, (start_i, end_i, grade) in enumerate(seg_boundaries):
        draw_end = end_i
        if k + 1 < len(seg_boundaries):
            draw_end = max(end_i, seg_boundaries[k + 1][0])
        if draw_end <= start_i:
            continue
        color = T_PALETTE.get(grade, T_PALETTE["unknown"])
        # Filled area.
        area_pts = []
        for i in range(start_i, draw_end + 1):
            area_pts.append(f"{sx(cum_m[i]):.1f},{sy(elevs[i]):.1f}")
        area_pts.append(f"{sx(cum_m[draw_end]):.1f},{PAD_T + inner_h:.1f}")
        area_pts.append(f"{sx(cum_m[start_i]):.1f},{PAD_T + inner_h:.1f}")
        profile_paths.append(
            f'<polygon points="{" ".join(area_pts)}" fill="{color}" '
            f'fill-opacity="0.55" stroke="none"/>'
        )
        # Top line.
        line_pts = " ".join(
            f"{sx(cum_m[i]):.1f},{sy(elevs[i]):.1f}" for i in range(start_i, draw_end + 1)
        )
        profile_paths.append(
            f'<polyline points="{line_pts}" fill="none" stroke="{color}" '
            f'stroke-width="2"/>'
        )

    # Axes + ticks.
    axes = [
        f'<line x1="{PAD_L}" y1="{PAD_T}" x2="{PAD_L}" y2="{PAD_T + inner_h}" '
        f'stroke="#444" stroke-width="1"/>',
        f'<line x1="{PAD_L}" y1="{PAD_T + inner_h}" x2="{PAD_L + inner_w}" '
        f'y2="{PAD_T + inner_h}" stroke="#444" stroke-width="1"/>',
    ]
    # Y ticks (every 200 m).
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
    # X ticks (every 1 km).
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

    # Map data: per-point lat,lon,label arrays (compact). Drive labels from the
    # merged segments list so the map agrees with the profile + table; using
    # raw `labels` would re-introduce sub-MIN_RUN_M flicker at grade boundaries.
    merged_labels = ["unknown"] * len(pts)
    for start_i, end_i, grade in seg_boundaries:
        for i in range(start_i, end_i + 1):
            merged_labels[i] = grade
    map_pts_js = json.dumps([
        {"lat": round(p[0], 6), "lon": round(p[1], 6), "t": merged_labels[i]}
        for i, p in enumerate(pts)
    ])

    legend_html = "".join(
        f'<span class="lg"><i style="background:{T_PALETTE[g]}"></i>{g}</span>'
        for g in ["T1", "T2", "T3", "T4", "T5", "T6", "unknown"]
    )

    segments_table_rows = "".join(
        f'<tr><td>{i + 1}</td><td>{s["start_m"]/1000:.2f}</td>'
        f'<td>{s["end_m"]/1000:.2f}</td><td>{s["length_m"]/1000:.2f}</td>'
        f'<td style="color:{T_PALETTE.get(s["t_grade"], "#888")};font-weight:600">'
        f'{s["t_grade"]}</td><td>{s["coverage_pct"]}%</td></tr>'
        for i, s in enumerate(segments)
    )

    stats_html = (
        f'<li>Overall SAC grade (from data.json): <b>{overall_grade}</b></li>'
        f'<li>GPX points: <b>{stats["n_points"]}</b> '
        f'(matched <b>{stats["matched_pct"]}%</b>, '
        f'untagged <b>{stats["untagged_pct"]}%</b>)</li>'
        f'<li>Tagged ways fetched from Overpass: <b>{stats["fetched_ways"]}</b></li>'
        f'<li>Total length: <b>{d_max/1000:.2f} km</b>; '
        f'elev range <b>{int(e_min)}–{int(e_max)} m</b></li>'
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Prototype — OSM sac_scale segmentation (Zindlenspitz)</title>
<meta name="proto-title" content="SAC T-grade segments (OSM)">
<meta name="proto-icon" content="&#x1F97E;">
<meta name="proto-desc" content="Per-segment T1–T6 along a GPX track from OSM sac_scale tags via Overpass">
<meta name="proto-source" content="OpenStreetMap (Overpass API)">
<meta name="proto-order" content="102">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  body {{ font-family: system-ui, sans-serif; max-width: 1280px; margin: 24px auto;
          padding: 0 16px; color: #222; }}
  h1 {{ font-size: 20px; }}
  h2 {{ font-size: 15px; margin-top: 28px; }}
  .legend {{ display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 18px; }}
  .lg {{ display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }}
  .lg i {{ width: 14px; height: 14px; border-radius: 3px; display: inline-block; }}
  #map {{ height: 480px; border: 1px solid #ddd; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 13px; }}
  th, td {{ border-bottom: 1px solid #eee; padding: 6px 8px; text-align: left; }}
  th {{ background: #f5f5f5; }}
  ul.stats {{ font-size: 13px; line-height: 1.7; }}
  .row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }}
  @media (max-width: 900px) {{ .row {{ grid-template-columns: 1fr; }} }}
</style>
</head>
<body>
<h1>Zindlenspitz — elevation profile colored by OSM <code>sac_scale</code></h1>
<p style="color:#666;font-size:13px">
  Prototype only. T-grade per GPX point is inferred by snapping to the nearest
  OSM way tagged <code>sac_scale=*</code> within 25–50 m. Smoothed with a
  {SMOOTH_WINDOW}-point majority filter.
</p>
<div class="legend">{legend_html}</div>
<ul class="stats">{stats_html}</ul>

<h2>Elevation profile (color = inferred T-grade)</h2>
{profile_svg}

<h2 style="margin-top:24px">Map</h2>
<div class="row">
  <div id="map"></div>
  <div>
    <h2 style="margin-top:0">Segments along the route</h2>
    <table>
      <thead><tr><th>#</th><th>start km</th><th>end km</th><th>len km</th>
        <th>T-grade</th><th>% of route</th></tr></thead>
      <tbody>{segments_table_rows}</tbody>
    </table>
  </div>
</div>

<script>
const PTS = {map_pts_js};
const PALETTE = {json.dumps(T_PALETTE)};
const map = L.map('map');
L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
  attribution: '&copy; OpenStreetMap', maxZoom: 19
}}).addTo(map);

// Draw the GPX as colored polyline segments grouped by T-grade.
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
      curLine.push(ll); // bridge to next color
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

    # bbox
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    s, n = min(lats), max(lats)
    w, e = min(lons), max(lons)
    # Expand by ~500 m. 1 deg lat ~= 111 km; 1 deg lon ~= 111 km * cos(lat).
    dlat = BBOX_PAD_M / 111_000.0
    dlon = BBOX_PAD_M / (111_000.0 * math.cos(math.radians((s + n) / 2)))
    bbox = (s - dlat, w - dlon, n + dlat, e + dlon)

    payload = overpass_query(bbox)
    ways = [el for el in payload.get("elements", []) if el.get("type") == "way"]
    print(f"[info] fetched {len(ways)} tagged ways")

    lat0, lon0 = (s + n) / 2, (w + e) / 2
    labels, distances = snap_points(pts, ways, lat0, lon0)
    matched = sum(1 for label in labels if label is not None)
    print(f"[info] raw matched: {matched}/{len(labels)} "
          f"({100 * matched / len(labels):.1f}%)")

    labels_s = majority_smooth(labels, SMOOTH_WINDOW)
    matched_s = sum(1 for label in labels_s if label is not None)
    cum_m = cumulative_distance(pts)
    segments = collapse_runs(labels_s, cum_m)

    matched_pct = round(100 * matched_s / len(labels_s), 1)
    untagged_pct = round(100 * (len(labels_s) - matched_s) / len(labels_s), 1)
    stats = {
        "n_points": len(pts),
        "matched_pct": matched_pct,
        "untagged_pct": untagged_pct,
        "fetched_ways": len(ways),
    }

    # Distribution along the route by length, not point count.
    dist_by_grade: dict[str, float] = {}
    for seg in segments:
        dist_by_grade[seg["t_grade"]] = dist_by_grade.get(seg["t_grade"], 0.0) \
            + (seg["end_m"] - seg["start_m"])
    total_m = cum_m[-1]
    dist_pct = {g: round(100 * m / total_m, 1)
                for g, m in sorted(dist_by_grade.items())}

    out = {
        "method": "osm-sac_scale",
        "overall_t_grade": overall_grade,
        "segments": segments,
        "stats": {**stats, "t_grade_distribution_pct_by_length": dist_pct},
    }
    OUT_JSON.write_text(json.dumps(out, indent=2))
    print(f"[wrote] {OUT_JSON}")

    html = render_html(pts, cum_m, labels_s, segments, overall_grade, stats)
    OUT_HTML.write_text(html)
    print(f"[wrote] {OUT_HTML}")

    print(f"[stats] matched={matched_pct}%  untagged={untagged_pct}%  "
          f"distribution by length: {dist_pct}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
