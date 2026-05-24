"""
Scaffold a new hike directory and pre-filled data.json file.

Usage
-----
    # Manual mode (all metadata on CLI):
    python scripts/new_hike.py \\
        --slug augstmatthorn --name "Augstmatthorn" \\
        --region "Bernese Oberland" --canton "Bern" \\
        --grade T3 --elev 1737 --trailhead "Habkern"

    # GPX mode (auto-extract coordinates, distance, gain, time):
    python scripts/new_hike.py \\
        --gpx routes/zindlenspitz/zindlenspitz.gpx \\
        --name "Zindlenspitz" --region "Schwyzer Alps" \\
        --canton "Schwyz" --grade T3 --trailhead "Innerthal"

    # GPX mode + elevation enrichment (adds SwissTopo elevation to bare GPX):
    python scripts/new_hike.py \\
        --gpx routes/zindlenspitz/zindlenspitz.gpx \\
        --add-elevation \\
        --name "Zindlenspitz" --region "Schwyzer Alps" \\
        --canton "Schwyz" --grade T3 --trailhead "Innerthal"

When ``--gpx`` is provided, ``--slug`` defaults to the GPX filename stem
and ``--elev`` is derived from the highest track point (if elevation data
exists or ``--add-elevation`` is used).

Creates ``routes/<slug>/<slug>.data.json`` under the website repo root,
pre-filled with CLI values and TODO placeholders for everything else.
"""

from __future__ import annotations

###########################################################################################################################################################################################################
# Imports
###########################################################################################################################################################################################################

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from urllib.request import Request, urlopen

from config import (
    EARTH_RADIUS_M,
    ELEV_SMOOTH_M,
    LOOP_THRESHOLD_M,
    NAISMITH_ASCENT_MH,
    NAISMITH_SPEED_KMH,
)

###########################################################################################################################################################################################################
# Public API
###########################################################################################################################################################################################################

__all__ = ["build_template", "scaffold_hike", "parse_gpx", "enrich_gpx_elevation"]

###########################################################################################################################################################################################################
# Helpers
###########################################################################################################################################################################################################

def _find_todo_fields(data: object, prefix: str = "") -> list[str]:
    """Recursively collect JSON paths whose string value contains 'TODO'."""
    todos: list[str] = []
    if isinstance(data, dict):
        for k, v in data.items():
            child_prefix = f"{prefix}.{k}" if prefix else k
            todos.extend(_find_todo_fields(v, child_prefix))
    elif isinstance(data, list):
        for i, v in enumerate(data):
            todos.extend(_find_todo_fields(v, f"{prefix}[{i}]"))
    elif isinstance(data, str) and "TODO" in data:
        todos.append(prefix)
    return todos


###########################################################################################################################################################################################################
# GPX parsing
###########################################################################################################################################################################################################

GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}
GPX_NS_URI = "http://www.topografix.com/GPX/1/1"


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance between two (lat, lon) points in metres."""
    r = EARTH_RADIUS_M
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def parse_gpx(gpx_path: Path) -> dict:
    """Extract route metadata from a GPX file.

    Returns a dict with keys: track_name, n_points, distance_km, start, end,
    is_loop, has_elevation, and (when elevation exists) ascent_m, descent_m,
    min_ele, max_ele, summit, naismith_hours, waypoints.
    """
    tree = ET.parse(gpx_path)

    name_el = tree.find(".//g:metadata/g:name", GPX_NS)
    track_name = name_el.text.strip() if name_el is not None and name_el.text else ""

    pts: list[tuple[float, float, float | None]] = []
    for tp in tree.findall(".//g:trkpt", GPX_NS):
        ele_el = tp.find("g:ele", GPX_NS)
        ele = float(ele_el.text) if ele_el is not None and ele_el.text else None
        pts.append((float(tp.get("lat")), float(tp.get("lon")), ele))

    if len(pts) < 2:
        sys.exit(f"ERROR: GPX has only {len(pts)} track points -- need at least 2.")

    has_elevation = all(p[2] is not None for p in pts)

    dist = sum(
        _haversine_m((a[0], a[1]), (b[0], b[1]))
        for a, b in zip(pts, pts[1:])
    )

    start, end = pts[0], pts[-1]
    is_loop = _haversine_m((start[0], start[1]), (end[0], end[1])) < LOOP_THRESHOLD_M

    result: dict = {
        "track_name": track_name,
        "n_points": len(pts),
        "distance_km": dist / 1000.0,
        "start": {"lat": start[0], "lon": start[1], "ele": start[2]},
        "end": {"lat": end[0], "lon": end[1], "ele": end[2]},
        "is_loop": is_loop,
        "has_elevation": has_elevation,
    }

    if has_elevation:
        asc = desc = 0.0
        last_ele = pts[0][2]
        for p in pts[1:]:
            d = p[2] - last_ele
            if abs(d) >= ELEV_SMOOTH_M:
                if d > 0:
                    asc += d
                else:
                    desc -= d
                last_ele = p[2]

        summit_pt = max(pts, key=lambda p: p[2])
        elevations = [p[2] for p in pts]

        result.update({
            "ascent_m": asc,
            "descent_m": desc,
            "min_ele": min(elevations),
            "max_ele": max(elevations),
            "summit": {"lat": summit_pt[0], "lon": summit_pt[1], "ele": summit_pt[2]},
            "naismith_hours": dist / 1000.0 / NAISMITH_SPEED_KMH + asc / NAISMITH_ASCENT_MH,
        })

    wpts: list[dict] = []
    for w in tree.findall(".//g:wpt", GPX_NS):
        wn = w.find("g:name", GPX_NS)
        label = wn.text.strip() if wn is not None and wn.text else ""
        we = w.find("g:ele", GPX_NS)
        ele = float(we.text) if we is not None and we.text else None
        wt = w.find("g:type", GPX_NS)
        kind = wt.text.strip() if wt is not None and wt.text else "way"
        wpts.append({"lat": float(w.get("lat")), "lon": float(w.get("lon")),
                      "ele": ele, "label": label, "kind": kind})
    result["waypoints"] = wpts

    return result


def _wgs84_to_lv95(lat: float, lon: float) -> tuple[float, float]:
    """Convert WGS84 (lat, lon) to Swiss LV95 (E, N)."""
    lat_aux = (lat * 3600 - 169028.66) / 10000
    lon_aux = (lon * 3600 - 26782.5) / 10000
    e = (2600072.37
         + 211455.93 * lon_aux
         - 10938.51 * lon_aux * lat_aux
         - 0.36 * lon_aux * lat_aux ** 2
         - 44.54 * lon_aux ** 3)
    n = (1200147.07
         + 308807.95 * lat_aux
         + 3745.25 * lon_aux ** 2
         + 76.63 * lat_aux ** 2
         - 194.56 * lon_aux ** 2 * lat_aux
         + 119.79 * lat_aux ** 3)
    return e, n


def _fetch_swisstopo_ele(lat: float, lon: float) -> float | None:
    """Fetch elevation for a single WGS84 point from the SwissTopo height API."""
    e, n = _wgs84_to_lv95(lat, lon)
    url = f"https://api3.geo.admin.ch/rest/services/height?easting={e:.2f}&northing={n:.2f}&sr=2056"
    try:
        req = Request(url, headers={"User-Agent": "hike-planner/1.0"})
        with urlopen(req, timeout=10) as resp:
            return float(json.loads(resp.read())["height"])
    except Exception:
        return None


def enrich_gpx_elevation(
    gpx_path: Path,
    sample_rate: int = 20,
    max_workers: int = 8,
) -> dict:
    """Add elevation data to a GPX using the SwissTopo height API.

    Samples every ``sample_rate``-th track point, fetches elevations in
    parallel, linearly interpolates for intermediate points, and writes the
    enriched GPX back to ``gpx_path``.

    Returns the parsed GPX data dict (same shape as ``parse_gpx``).
    """
    ET.register_namespace("", GPX_NS_URI)
    tree = ET.parse(gpx_path)
    trkpts = tree.findall(".//g:trkpt", GPX_NS)

    if not trkpts:
        sys.exit("ERROR: GPX has no track points.")

    first_ele = trkpts[0].find("g:ele", GPX_NS)
    if first_ele is not None and first_ele.text:
        print("[elevation] GPX already has elevation data -- skipping enrichment.")
        return parse_gpx(gpx_path)

    coords = [(float(tp.get("lat")), float(tp.get("lon"))) for tp in trkpts]
    n = len(coords)

    indices = list(range(0, n, sample_rate))
    if indices[-1] != n - 1:
        indices.append(n - 1)

    print(f"[elevation] Fetching {len(indices)} elevations from SwissTopo "
          f"({n} points, sample every {sample_rate})...")

    sampled: dict[int, float] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(_fetch_swisstopo_ele, *coords[i]): i for i in indices}
        done = 0
        for fut in as_completed(futs):
            idx = futs[fut]
            ele = fut.result()
            done += 1
            if ele is not None:
                sampled[idx] = ele
            if done % 50 == 0 or done == len(indices):
                print(f"  ... {done}/{len(indices)}")

    if len(sampled) < 2:
        sys.exit("[elevation] Too few elevations fetched -- check network / coordinates.")

    print(f"[elevation] Got {len(sampled)}/{len(indices)} sample elevations.")

    # Linear interpolation between sampled points
    sorted_idx = sorted(sampled.keys())
    all_ele = [0.0] * n

    for i in sampled:
        all_ele[i] = sampled[i]

    for i in range(len(sorted_idx) - 1):
        a, b = sorted_idx[i], sorted_idx[i + 1]
        ea, eb = sampled[a], sampled[b]
        for j in range(a + 1, b):
            t = (j - a) / (b - a)
            all_ele[j] = ea + t * (eb - ea)

    for j in range(0, sorted_idx[0]):
        all_ele[j] = sampled[sorted_idx[0]]
    for j in range(sorted_idx[-1] + 1, n):
        all_ele[j] = sampled[sorted_idx[-1]]

    # Write elevation into GPX track points
    for tp, ele in zip(trkpts, all_ele):
        ele_el = ET.SubElement(tp, f"{{{GPX_NS_URI}}}ele")
        ele_el.text = f"{ele:.1f}"

    metadata = tree.find(f".//{{{GPX_NS_URI}}}metadata")
    if metadata is not None:
        desc = metadata.find(f"{{{GPX_NS_URI}}}desc")
        if desc is None:
            desc = ET.SubElement(metadata, f"{{{GPX_NS_URI}}}desc")
        desc.text = "Elevations from SwissTopo height API (sampled + interpolated)"

    tree.write(str(gpx_path), encoding="unicode", xml_declaration=True)
    print(f"[elevation] Enriched GPX written to {gpx_path}")

    return parse_gpx(gpx_path)


def _format_time(hours: float) -> str:
    """Format a decimal hours value as '~Xh' or '~XhMM'."""
    hh = int(hours)
    mm = int(round((hours - hh) * 60 / 30) * 30)
    if mm == 60:
        hh += 1
        mm = 0
    return f"~{hh}h{mm:02d}" if mm else f"~{hh}h"


###########################################################################################################################################################################################################
# Core logic
###########################################################################################################################################################################################################

def build_template(
    slug: str,
    name: str,
    region: str,
    canton: str,
    grade: str,
    elev: int,
    trailhead: str,
    peak_lat: float,
    peak_lon: float,
    trailhead_lat: float,
    trailhead_lon: float,
    gpx_data: dict | None = None,
) -> dict:
    """Build the pre-filled data.json template dict.

    When ``gpx_data`` (from ``parse_gpx``) is provided, auto-fills distance,
    gain, time estimate, route type, waypoints, and elevation chart attribution.
    """
    today = date.today()
    today_str = today.isoformat()
    year = today.year

    m = re.match(r'[Tt](\d)', grade)
    pill_class = f"t{m.group(1)}" if m else grade.lower()

    g = gpx_data or {}
    has_ele = g.get("has_elevation", False)

    # --- Index card: use GPX stats when available, else TODO ---
    if has_ele:
        ic_distance = f"{g['distance_km']:.1f} km"
        ic_gain = f"{int(round(g['ascent_m']))} m"
        ic_time = _format_time(g["naismith_hours"])
    elif g.get("distance_km"):
        ic_distance = f"{g['distance_km']:.1f} km"
        ic_gain = "TODO: e.g. 850 m"
        ic_time = "TODO: e.g. 5-6 h"
    else:
        ic_distance = "TODO: e.g. 8.4 km"
        ic_gain = "TODO: e.g. 850 m"
        ic_time = "TODO: e.g. 5-6 h"

    ic_route_type = ("loop" if g.get("is_loop") else "out-and-back") if g else "out-and-back"

    # --- Hero subtitle ---
    if has_ele:
        subtitle_html = (
            f"{trailhead} -> {name}"
            f' -- <span class="pill {pill_class}">SAC {grade}</span>'
            f" | ~{int(round(g['ascent_m']))} m gain"
            f" | ~{g['distance_km']:.1f} km"
            f" | {_format_time(g['naismith_hours'])}"
        )
        auto_subtitle = True
    else:
        subtitle_html = (
            f"TODO: e.g. {trailhead} -> {name}"
            f' -- <span class="pill {pill_class}">SAC {grade}</span>'
            " | ~850 m gain | ~8.4 km | ~5h round-trip"
        )
        auto_subtitle = False

    # --- Quick facts ---
    qf: list[list[str]] = [
        ["Summit elevation", f"<strong>{elev} m</strong>"],
        ["SAC grade", f'<span class="pill {pill_class}">{grade}</span>'],
        ["Trailhead", trailhead],
    ]
    if has_ele:
        qf.append(["Distance", f"{g['distance_km']:.1f} km ({ic_route_type})"])
        qf.append(["Total ascent", f"~{int(round(g['ascent_m']))} m"])
        qf.append(["Elevation range", f"{int(g['min_ele'])}-{int(g['max_ele'])} m"])
    else:
        qf.append(["Distance", "TODO: km round-trip"])
        qf.append(["Total ascent", "TODO: m"])

    # --- Waypoints from GPX ---
    waypoints: list[dict] = []
    if g.get("waypoints"):
        for wp in g["waypoints"]:
            ele_str = f" ({int(wp['ele'])} m)" if wp.get("ele") else ""
            label = wp["label"]
            if ele_str and ele_str not in label:
                label = f"{label}{ele_str}"
            waypoints.append({
                "lat": wp["lat"], "lon": wp["lon"],
                "label": label,
                "kind": wp.get("kind", "way"),
            })
    if not waypoints and g:
        start = g.get("start", {})
        trailhead_ele_str = f" ({int(start['ele'])} m)" if start.get("ele") else ""
        waypoints.append({
            "lat": trailhead_lat or start.get("lat", 0.0),
            "lon": trailhead_lon or start.get("lon", 0.0),
            "label": f"{trailhead}{trailhead_ele_str}",
            "kind": "start",
        })
        if has_ele and g.get("summit"):
            s = g["summit"]
            waypoints.append({
                "lat": s["lat"], "lon": s["lon"],
                "label": f"{name} ({int(s['ele'])} m)",
                "kind": "summit",
            })
        else:
            waypoints.append({
                "lat": peak_lat, "lon": peak_lon,
                "label": f"{name} ({elev} m)",
                "kind": "summit",
            })

    elev_attrib = ""
    if has_ele:
        elev_attrib = "Computed from the inlined GPX track (elevations from SwissTopo height API)."

    return {
        "slug": slug,
        "page": {
            "title": f"{name} ({elev} m) -- Hike Plan",
            "generated": today_str,
            "reports_updated": today_str,
            "year": year,
        },
        "peak": {
            "name": name,
            "elev": elev,
            "lat": peak_lat,
            "lon": peak_lon,
        },
        "index_card": {
            "region": region,
            "canton": canton,
            "distance": ic_distance,
            "gain": ic_gain,
            "time": ic_time,
            "route_type": ic_route_type,
        },
        "trailhead": {
            "name": trailhead,
            "elev": int(g["start"]["ele"]) if g.get("start", {}).get("ele") else 0,
            "lat": trailhead_lat,
            "lon": trailhead_lon,
        },
        "hero": {
            "image_url": "TODO",
            "subtitle_html": subtitle_html,
            "grade": grade,
            "auto_subtitle": auto_subtitle,
        },
        "intro_html": "TODO: <p>2-3 sentences about the route character and highlights.</p>",
        "quick_facts": qf,
        "photos": [],
        "waypoints": waypoints,

        "routes": [
            {
                "title_html": "TODO: route name",
                "grade": grade,
                "pill_class": pill_class,
                "bullets_html": [
                    "TODO: Step 1 description.",
                    "TODO: Step 2 description.",
                ],
                "source": "SAC Route Portal" if gpx_data else "TODO: e.g. OSM hiking network or SAC Route Portal",
            }
        ],
        "getting_there": {
            "by_pt_html": "TODO: SBB / PostBus connection description.",
            "by_car_html": "TODO: Driving directions.",
        },
        "day_plans": [
            {
                "title": "Day 1",
                "rows": [
                    ["HH:MM", "TODO: step description"],
                ],

            }
        ],
        "weather": {
            "season_html": "TODO: e.g. <strong>July-September</strong> is best; avoid after fresh snow.",
        },
        "webcams": [
            {
                "url": "TODO: https://www.foto-webcam.eu/webcam/<nearest-cam>/current/1200.jpg",
                "label": "TODO: camera name",
                "fallback": False,
            }
        ],
        "elev_chart_attrib_html": elev_attrib,
        "trip_reports": {
            "hikr_index_url": "TODO: https://www.hikr.org/region/?gid=...",
            "takeaways_html": [
                "TODO: cross-report pattern 1.",
                "TODO: cross-report pattern 2.",
            ],
            "reports": [
                {
                    "url": "TODO: hikr report URL",
                    "title": "TODO: report title",
                    "season": "TODO: e.g. August 2025",
                    "grade": grade,
                    "bullets_html": [
                        "TODO: Key observation 1.",
                        "TODO: Key observation 2.",
                    ],
                }
            ],
        },
        "resources_html": [
            f'<a href="TODO: SAC route URL">SAC Route Portal -- {name}</a>',
            '<a href="TODO: SwissTopo map URL">SwissTopo map</a>',
        ],
    }


def scaffold_hike(
    slug: str,
    name: str,
    region: str,
    canton: str,
    grade: str,
    elev: int,
    trailhead: str,
    peak_lat: float,
    peak_lon: float,
    trailhead_lat: float,
    trailhead_lon: float,
    gpx_path: Path | None = None,
    add_elevation: bool = False,
    via: list[str] | None = None,
    no_gpx: bool = False,
) -> None:
    """Create the hike directory and write a pre-filled data.json.

    When ``gpx_path`` is provided, auto-extracts route metadata (coordinates,
    distance, gain, time) to pre-fill the data file. Use ``add_elevation=True``
    to enrich a bare GPX with SwissTopo elevation before extraction.
    """
    repo_root = Path(__file__).resolve().parent.parent
    hike_dir = repo_root / "routes" / slug
    out_path = hike_dir / f"{slug}.data.json"

    if out_path.exists():
        print(f"ERROR: {out_path} already exists. Aborting.", file=sys.stderr)
        sys.exit(1)

    hike_dir.mkdir(parents=True, exist_ok=True)

    # --- GPX handling ---
    gpx_data: dict | None = None
    if gpx_path is not None:
        if not gpx_path.exists():
            sys.exit(f"ERROR: GPX file not found: {gpx_path}")

        target_gpx = hike_dir / f"{slug}.gpx"
        if gpx_path.resolve() != target_gpx.resolve():
            shutil.copy2(gpx_path, target_gpx)
            print(f"[gpx] Copied -> {target_gpx}")
        else:
            print(f"[gpx] Using {target_gpx}")

        if add_elevation:
            gpx_data = enrich_gpx_elevation(target_gpx)
        else:
            gpx_data = parse_gpx(target_gpx)

        print(f"[gpx] Track: {gpx_data.get('track_name', '?')}")
        print(f"[gpx] Points: {gpx_data['n_points']}, "
              f"distance: {gpx_data['distance_km']:.1f} km, "
              f"loop: {gpx_data['is_loop']}, "
              f"elevation: {'yes' if gpx_data['has_elevation'] else 'no'}")

        if gpx_data["has_elevation"]:
            print(f"[gpx] Ascent: {int(gpx_data['ascent_m'])} m, "
                  f"descent: {int(gpx_data['descent_m'])} m, "
                  f"range: {int(gpx_data['min_ele'])}--{int(gpx_data['max_ele'])} m")
            print(f"[gpx] Naismith time: {_format_time(gpx_data['naismith_hours'])}")
        else:
            print("[gpx] No elevation data. Use --add-elevation to fetch from SwissTopo.")

        # Auto-derive coordinates from GPX when not explicitly provided
        if peak_lat == 0.0 and peak_lon == 0.0 and gpx_data.get("summit"):
            peak_lat = gpx_data["summit"]["lat"]
            peak_lon = gpx_data["summit"]["lon"]
        if trailhead_lat == 0.0 and trailhead_lon == 0.0:
            trailhead_lat = gpx_data["start"]["lat"]
            trailhead_lon = gpx_data["start"]["lon"]

        # Auto-derive elevation from GPX summit
        if elev == 0 and gpx_data.get("max_ele"):
            elev = int(round(gpx_data["max_ele"]))
            print(f"[gpx] Auto-derived summit elevation: {elev} m")

    template = build_template(
        slug=slug,
        name=name,
        region=region,
        canton=canton,
        grade=grade,
        elev=elev,
        trailhead=trailhead,
        peak_lat=peak_lat,
        peak_lon=peak_lon,
        trailhead_lat=trailhead_lat,
        trailhead_lon=trailhead_lon,
        gpx_data=gpx_data,
    )

    out_path.write_text(json.dumps(template, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    todos = _find_todo_fields(template)

    print(f"\nCreated: {out_path}\n")
    if todos:
        print("TODO fields to fill in:")
        for field_name in todos:
            print(f"  - {field_name}")

    # Auto-trigger GPX build when no GPX provided and coordinates are known
    if gpx_path is None:
        coords_known = all(c != 0.0 for c in (peak_lat, peak_lon, trailhead_lat, trailhead_lon))
        if not no_gpx and coords_known:
            gpx_script = Path(__file__).resolve().parent / "build_hike_gpx.py"
            cmd = [
                sys.executable, str(gpx_script),
                "--slug", slug,
                "--peak", name,
                "--trailhead", trailhead,
                "--peak-ll", f"{peak_lat},{peak_lon}",
                "--trailhead-ll", f"{trailhead_lat},{trailhead_lon}",
                "--out-dir", str(hike_dir),
            ]
            for v in (via or []):
                cmd += ["--via", v]
            print("\n[GPX] Auto-building route...")
            result = subprocess.run(cmd)
            if result.returncode == 0:
                print(f"[GPX] Written to routes/{slug}/{slug}.gpx")
            else:
                print(f"WARNING: GPX generation failed (exit {result.returncode}).", file=sys.stderr)
        elif not no_gpx and not coords_known:
            print("\n[GPX] Skipped -- pass --gpx or coordinate flags.")

    print(
        f"\nTo render:\n"
        f"  make render          # all hikes\n"
        f"  make serve           # render + local preview\n"
    )


###########################################################################################################################################################################################################
# CLI entry point
###########################################################################################################################################################################################################

def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Scaffold a new hike directory and pre-filled data.json.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    # GPX mode
    parser.add_argument("--gpx", type=Path, default=None,
                        help="Path to an existing GPX file. Auto-extracts route metadata. "
                             "When provided, --slug defaults to GPX filename stem and "
                             "--elev is derived from the highest track point.")
    parser.add_argument("--add-elevation", action="store_true",
                        help="Enrich a bare GPX with SwissTopo elevation data before extraction.")

    # Identity (--slug and --elev are optional when --gpx is given)
    parser.add_argument("--slug", default=None, help="URL-safe hike identifier, e.g. augstmatthorn")
    parser.add_argument("--name", required=True, help='Human-readable name, e.g. "Augstmatthorn"')
    parser.add_argument("--region", required=True, help='Swiss region, e.g. "Bernese Oberland"')
    parser.add_argument("--canton", required=True, help='Swiss canton, e.g. "Bern"')
    parser.add_argument("--grade", required=True, help="SAC trail grade, e.g. T3")
    parser.add_argument("--elev", type=int, default=0,
                        help="Summit elevation in metres (auto-derived from GPX when --gpx is used)")
    parser.add_argument("--trailhead", required=True, help='Trailhead place name, e.g. "Habkern"')

    # Coordinates (auto-derived from GPX when provided)
    parser.add_argument("--peak-lat", type=float, default=0.0, help="Summit latitude (default: 0.0)")
    parser.add_argument("--peak-lon", type=float, default=0.0, help="Summit longitude (default: 0.0)")
    parser.add_argument("--trailhead-lat", type=float, default=0.0, help="Trailhead latitude (default: 0.0)")
    parser.add_argument("--trailhead-lon", type=float, default=0.0, help="Trailhead longitude (default: 0.0)")

    # GPX build options (manual mode only)
    parser.add_argument("--via", action="append", default=[],
                        help="Intermediate waypoint name for GPX routing (repeat for multiple).")
    parser.add_argument("--no-gpx", action="store_true",
                        help="Skip auto-running build_hike_gpx.py even when coordinates are known.")
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()

    slug = args.slug
    if slug is None:
        if args.gpx is not None:
            slug = args.gpx.stem
        else:
            print("ERROR: --slug is required when --gpx is not provided.", file=sys.stderr)
            sys.exit(1)

    if args.elev == 0 and args.gpx is None:
        print("WARNING: --elev not set and no --gpx to derive it from. Using 0.", file=sys.stderr)

    scaffold_hike(
        slug=slug,
        name=args.name,
        region=args.region,
        canton=args.canton,
        grade=args.grade,
        elev=args.elev,
        trailhead=args.trailhead,
        peak_lat=args.peak_lat,
        peak_lon=args.peak_lon,
        trailhead_lat=args.trailhead_lat,
        trailhead_lon=args.trailhead_lon,
        gpx_path=args.gpx,
        add_elevation=args.add_elevation,
        via=args.via,
        no_gpx=args.no_gpx,
    )
