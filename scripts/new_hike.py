"""
Scaffold a new hike directory and pre-filled data.json file.

Usage
-----
    python scripts/new_hike.py \
        --slug augstmatthorn \\
        --name "Augstmatthorn" \\
        --region "Bernese Oberland" \\
        --canton "Bern" \\
        --grade T3 \\
        --elev 1737 \\
        --trailhead "Habkern" \\
        [--peak-lat 46.72] \\
        [--peak-lon 7.88] \\
        [--trailhead-lat 46.73] \\
        [--trailhead-lon 7.86]

Creates ``pages/hikes/routes/<slug>/<slug>.data.json`` under the website repo root,
pre-filled with CLI values and TODO placeholders for everything else.
"""

from __future__ import annotations

###########################################################################################################################################################################################################
# Imports
###########################################################################################################################################################################################################

import argparse
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

###########################################################################################################################################################################################################
# Public API
###########################################################################################################################################################################################################

__all__ = ["build_template", "scaffold_hike"]

###########################################################################################################################################################################################################
# Helpers
###########################################################################################################################################################################################################

def _find_todo_fields(data: object, prefix: str = "") -> list[str]:
    """Recursively collect JSON paths whose string value contains 'TODO'.

    Parameters
    ----------
    data : object
        A JSON-decoded Python object (dict, list, str, int, float, bool, None).
    prefix : str, optional
        Dot-path prefix accumulated during recursion.

    Returns
    -------
    list[str]
        Sorted list of dot-path strings for all TODO fields.
    """
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
) -> dict:
    """Build the pre-filled data.json template dict.

    Parameters
    ----------
    slug : str
        URL-safe identifier for the hike, e.g. ``"augstmatthorn"``.
    name : str
        Human-readable peak/hike name, e.g. ``"Augstmatthorn"``.
    region : str
        Swiss region, e.g. ``"Bernese Oberland"``.
    canton : str
        Swiss canton, e.g. ``"Bern"``.
    grade : str
        SAC trail grade, e.g. ``"T3"``.
    elev : int
        Summit elevation in metres.
    trailhead : str
        Trailhead place name, e.g. ``"Habkern"``.
    peak_lat : float
        Latitude of the summit (0.0 if unknown).
    peak_lon : float
        Longitude of the summit (0.0 if unknown).
    trailhead_lat : float
        Latitude of the trailhead (0.0 if unknown).
    trailhead_lon : float
        Longitude of the trailhead (0.0 if unknown).

    Returns
    -------
    dict
        A fully populated template dict ready for ``json.dumps``.

    Notes
    -----
    Lapse-rate temperature drop assumes a valley reference elevation of 600 m
    and a standard environmental lapse rate of 6 °C / 1000 m.
    """
    today = date.today()
    today_str = today.isoformat()
    year = today.year

    grade_lower = grade.lower()

    valley_elev = 600  # metres — assumed reference elevation
    temp_drop = round((elev - valley_elev) * 6 / 1000, 1)

    return {
        "slug": slug,
        "page": {
            "title": f"{name} ({elev} m) — Hike Plan",
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
            "distance": "TODO: e.g. 8.4 km",
            "gain": "TODO: e.g. 850 m",
            "time": "TODO: e.g. 5–6 h",
            "pill_class": grade_lower,
        },
        "trailhead": {
            "name": trailhead,
            "elev": 0,
            "lat": trailhead_lat,
            "lon": trailhead_lon,
            "transit_dest": f"{trailhead}, Switzerland",
        },
        "hero": {
            "image_url": "TODO: Wikimedia Special:FilePath URL at width=1600",
            "subtitle_html": (
                f"TODO: e.g. {trailhead} → {name}"
                f' — <span class="pill {grade_lower}">SAC {grade}</span>'
                " · ~850 m gain · ~8.4 km · ~5h round-trip"
            ),
            "grade": grade,
        },
        "intro_html": "TODO: <p>2–3 sentences about the route character and highlights.</p>",
        "quick_facts": [
            ["Summit elevation", f"<strong>{elev} m</strong>"],
            ["SAC grade", f'<span class="pill {grade_lower}">{grade}</span>'],
            ["Trailhead", trailhead],
            ["Distance", "TODO: km round-trip"],
            ["Total ascent", "TODO: m"],
        ],
        "photos": [
            {
                "url": "TODO: Wikimedia width=600 URL",
                "lightbox_url": "TODO: Wikimedia width=1600 URL",
                "alt": "TODO: description",
                "caption_html": "TODO: caption",
            }
        ],
        "waypoints": [],
        "routes_subtitle": "",
        "routes": [
            {
                "title_html": "TODO: route name",
                "grade": grade,
                "pill_class": grade_lower,
                "bullets_html": [
                    "TODO: <li>Step 1: description.</li>",
                    "TODO: <li>Step 2: description.</li>",
                ],
                "source": "TODO: e.g. OSM hiking network or SAC Route Portal",
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
                "footer_html": "",
            }
        ],
        "weather": {
            "lapse_rate": {
                "valley_ref": "TODO: nearest valley station and elevation, e.g. Interlaken (570 m)",
                "summit_above_ref_m": elev - valley_elev,
                "temp_drop_c": temp_drop,
                "example_html": "TODO: e.g. <strong>22 °C at Interlaken → ~9 °C at summit</strong>",
            },
            "sources_html": [
                '<a href="https://www.meteoswiss.admin.ch/">MeteoSwiss</a> — official Swiss forecast',
                '<a href="https://www.meteoblue.com/">Meteoblue</a> — hourly wind/precip',
            ],
            "season_html": "TODO: e.g. <strong>July–September</strong> is best; avoid after fresh snow.",
        },
        "webcams": [
            {
                "url": "TODO: https://www.foto-webcam.eu/webcam/<nearest-cam>/current/1200.jpg",
                "label": "TODO: camera name",
                "fallback": False,
            }
        ],
        "elev_chart_attrib_html": "",
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
                        "TODO: <li>Key observation 1.</li>",
                        "TODO: <li>Key observation 2.</li>",
                    ],
                }
            ],
        },
        "gear": [
            {
                "title": "Essential",
                "items_html": [
                    "<li>Hiking poles</li>",
                    "<li>Sun protection (cream + glasses + hat)</li>",
                    "<li>2 L water</li>",
                    "<li>Emergency snacks</li>",
                ],
            }
        ],
        "safety_html": [
            f"TODO: main hazard — e.g. <strong>Exposure</strong>: ... ",
            "Turn back if thunderstorms develop — lightning risk above treeline is extreme.",
        ],
        "resources_html": [
            f'<a href="TODO: SAC route URL">SAC Route Portal — {name}</a>',
            '<a href="https://www.meteoswiss.admin.ch/">MeteoSwiss</a>',
            '<a href="TODO: SwissTopo map URL">SwissTopo map</a>',
        ],
        "disclaimer_html": (
            "This page is an informal hike plan, not professional mountain-safety advice. "
            "Conditions change rapidly. Always check MeteoSwiss and SAC before setting out."
        ),
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
    via: list[str] | None = None,
    no_gpx: bool = False,
) -> None:
    """Create the hike directory and write a pre-filled data.json.

    Parameters
    ----------
    slug : str
        URL-safe hike identifier.
    name : str
        Human-readable peak/hike name.
    region : str
        Swiss region name.
    canton : str
        Swiss canton name.
    grade : str
        SAC trail grade (e.g. ``"T3"``).
    elev : int
        Summit elevation in metres.
    trailhead : str
        Trailhead place name.
    peak_lat : float
        Summit latitude (0.0 if unknown).
    peak_lon : float
        Summit longitude (0.0 if unknown).
    trailhead_lat : float
        Trailhead latitude (0.0 if unknown).
    trailhead_lon : float
        Trailhead longitude (0.0 if unknown).
    via : list[str], optional
        Intermediate waypoint names passed to ``build_hike_gpx.py`` (only used
        when GPX auto-build is triggered).
    no_gpx : bool, optional
        If ``True``, skip auto-running ``build_hike_gpx.py`` even when all four
        coordinates are known.

    Raises
    ------
    SystemExit
        If ``pages/hikes/routes/<slug>/<slug>.data.json`` already exists.
    """
    # Repo root is 2 levels up from this script (scripts/new_hike.py)
    repo_root = Path(__file__).resolve().parent.parent
    hike_dir = repo_root / "pages" / "hikes" / "routes" / slug
    out_path = hike_dir / f"{slug}.data.json"

    if out_path.exists():
        print(f"ERROR: {out_path} already exists. Aborting.", file=sys.stderr)
        sys.exit(1)

    hike_dir.mkdir(parents=True, exist_ok=True)

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
    )

    out_path.write_text(json.dumps(template, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # Collect TODO fields
    todos = _find_todo_fields(template)

    print(f"\n✓ Created: {out_path}\n")
    print("TODO fields to fill in:")
    for field in todos:
        print(f"  \u2022 {field}")

    # Auto-trigger GPX build when all four coordinates are provided.
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
        print(f"\n[GPX] Auto-building route (bbox auto-computed from coordinates)...")
        result = subprocess.run(cmd)
        if result.returncode == 0:
            print(f"\n\u2713 GPX written to hikes/{slug}/{slug}.gpx")
        else:
            print(f"\nWARNING: GPX generation failed (exit {result.returncode}).", file=sys.stderr)
            print(f"  Re-run manually:", file=sys.stderr)
            print(f"  python scripts/build_hike_gpx.py \\", file=sys.stderr)
            print(f"      --slug {slug} --peak \"{name}\" --trailhead \"{trailhead}\" \\", file=sys.stderr)
            print(f"      --bbox s,w,n,e --out-dir pages/hikes/routes/{slug}/", file=sys.stderr)
    elif not no_gpx and not coords_known:
        print(f"\n[GPX] Skipped — pass --peak-lat/--peak-lon/--trailhead-lat/--trailhead-lon to auto-build.")

    print(
        f"\nTo render (probe mode):\n"
        f"  cd /opt/code/website && python scripts/render_hike.py"
        f" --slug {slug} --probe\n"
    )


###########################################################################################################################################################################################################
# CLI entry point
###########################################################################################################################################################################################################

def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns
    -------
    argparse.Namespace
        Parsed argument namespace.
    """
    parser = argparse.ArgumentParser(
        description="Scaffold a new hike directory and pre-filled data.json.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--slug", required=True, help="URL-safe hike identifier, e.g. augstmatthorn")
    parser.add_argument("--name", required=True, help='Human-readable name, e.g. "Augstmatthorn"')
    parser.add_argument("--region", required=True, help='Swiss region, e.g. "Bernese Oberland"')
    parser.add_argument("--canton", required=True, help='Swiss canton, e.g. "Bern"')
    parser.add_argument("--grade", required=True, help="SAC trail grade, e.g. T3")
    parser.add_argument("--elev", required=True, type=int, help="Summit elevation in metres")
    parser.add_argument("--trailhead", required=True, help='Trailhead place name, e.g. "Habkern"')
    parser.add_argument("--peak-lat", type=float, default=0.0, help="Summit latitude (default: 0.0)")
    parser.add_argument("--peak-lon", type=float, default=0.0, help="Summit longitude (default: 0.0)")
    parser.add_argument("--trailhead-lat", type=float, default=0.0, help="Trailhead latitude (default: 0.0)")
    parser.add_argument("--trailhead-lon", type=float, default=0.0, help="Trailhead longitude (default: 0.0)")
    parser.add_argument("--via", action="append", default=[],
                        help="Intermediate waypoint name for GPX routing (repeat for multiple). "
                             "Only used when all four coordinates are given.")
    parser.add_argument("--no-gpx", action="store_true",
                        help="Skip auto-running build_hike_gpx.py even when coordinates are known.")
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    scaffold_hike(
        slug=args.slug,
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
        via=args.via,
        no_gpx=args.no_gpx,
    )
