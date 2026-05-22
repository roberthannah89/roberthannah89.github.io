"""
Extract a GPX track from a SAC route portal JSON response.

Usage
-----
    # After fetching the route JSON via Playwright (see docs/workflows/GPX-EXTRACTION.md):
    python scripts/extract_sac_gpx.py --json sac-route-4347.json --slug risetestock

    # With elevation enrichment from SwissTopo:
    python scripts/extract_sac_gpx.py --json sac-route-4347.json --slug risetestock --add-elevation

Reads the JSON saved from the SAC ``?type=1567765346410`` endpoint,
converts LV95 coordinates to WGS84, and writes a GPX file to
``routes/<slug>/<slug>.gpx``.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import gpxpy
    import gpxpy.gpx
except ImportError:
    sys.exit("ERROR: gpxpy is required.  pip install gpxpy")

__all__ = ["sac_json_to_gpx"]

_GAP_THRESHOLD_M = 200  # LV95 is in metres; segments closer than this are "connected"


def _lv95_to_wgs84(e: float, n: float) -> tuple[float, float]:
    """Convert Swiss LV95 (EPSG:2056) to WGS84 (lat, lon)."""
    y_aux = (e - 2_600_000) / 1_000_000
    x_aux = (n - 1_200_000) / 1_000_000
    lon = (2.6779094
           + 4.728982 * y_aux
           + 0.791484 * y_aux * x_aux
           + 0.1306 * y_aux * x_aux * x_aux
           - 0.0436 * y_aux * y_aux * y_aux)
    lat = (16.9023892
           + 3.238272 * x_aux
           - 0.270978 * y_aux * y_aux
           - 0.002528 * x_aux * x_aux
           - 0.0447 * y_aux * y_aux * x_aux
           - 0.0140 * x_aux * x_aux * x_aux)
    return lat * 100 / 36, lon * 100 / 36


def _lv95_dist(a: list, b: list) -> float:
    """Euclidean distance between two LV95 [e, n] coordinates (metres)."""
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _stitch_segments(raw: list[tuple[str, list]]) -> list[tuple[str, list]]:
    """Reorder/reverse/retrace segments to form a connected track.

    SAC routes can contain out-and-back spurs (e.g. summit detours) and
    segments whose geometry is stored in reverse.  This function stitches
    them into a continuous line by choosing, for each transition, the best
    of four options: forward, reverse next, retrace previous + forward,
    or retrace previous + reverse next.

    Operates on LV95 coordinates before WGS84 conversion.
    """
    if len(raw) <= 1:
        return list(raw)

    placed: list[tuple[str, list]] = [raw[0]]

    for i in range(1, len(raw)):
        title, coords = raw[i]
        _, prev_coords = placed[-1]

        prev_end = prev_coords[-1]
        prev_start = prev_coords[0]
        next_start = coords[0]
        next_end = coords[-1]

        d_fwd = _lv95_dist(prev_end, next_start)
        d_rev = _lv95_dist(prev_end, next_end)
        d_ret_fwd = _lv95_dist(prev_start, next_start)
        d_ret_rev = _lv95_dist(prev_start, next_end)

        best = min(d_fwd, d_rev, d_ret_fwd, d_ret_rev)

        if best == d_fwd:
            placed.append((title, coords))
            if d_fwd > _GAP_THRESHOLD_M:
                print(f"[sac-gpx] WARNING: {d_fwd:.0f}m gap before '{title}'")
        elif best == d_rev:
            placed.append((title, list(reversed(coords))))
            print(f"[sac-gpx] Reversed '{title}' to connect ({d_rev:.0f}m)")
        elif best == d_ret_fwd:
            prev_title = placed[-1][0]
            placed.append((f"{prev_title} (retrace)", list(reversed(prev_coords))))
            placed.append((title, coords))
            print(f"[sac-gpx] Retraced '{prev_title}' then '{title}' forward ({d_ret_fwd:.0f}m)")
        else:
            prev_title = placed[-1][0]
            placed.append((f"{prev_title} (retrace)", list(reversed(prev_coords))))
            placed.append((title, list(reversed(coords))))
            print(f"[sac-gpx] Retraced '{prev_title}' then reversed '{title}' ({d_ret_rev:.0f}m)")

    return placed


def _extract_waypoints(data: dict) -> list[gpxpy.gpx.GPXWaypoint]:
    """Extract named waypoints from the SAC JSON (departure, destination, via-points).

    Returns GPX waypoints with WGS84 coordinates and elevations.
    """
    wpts: list[gpxpy.gpx.GPXWaypoint] = []

    # Departure point
    dep = data.get("departure_point")
    if dep and dep.get("geom"):
        coords = dep["geom"]["coordinates"]
        lat, lon = _lv95_to_wgs84(coords[0], coords[1])
        wpt = gpxpy.gpx.GPXWaypoint(lat, lon, elevation=dep.get("altitude"))
        wpt.name = dep.get("display_name", "Start")
        wpt.type = "start"
        wpts.append(wpt)

    # Intermediate waypoints (via summits, passes, etc.)
    for wp in data.get("waypoints", []):
        ref = wp.get("reference_poi", {})
        geom = ref.get("geom")
        if not geom:
            continue
        coords = geom["coordinates"]
        lat, lon = _lv95_to_wgs84(coords[0], coords[1])
        wpt = gpxpy.gpx.GPXWaypoint(lat, lon, elevation=ref.get("altitude"))
        wpt.name = ref.get("display_name") or wp.get("name", "?")
        wpt.type = ref.get("type", "way")
        wpts.append(wpt)

    # Destination / summit
    dest = data.get("destination_poi")
    if dest and dest.get("geom"):
        coords = dest["geom"]["coordinates"]
        lat, lon = _lv95_to_wgs84(coords[0], coords[1])
        wpt = gpxpy.gpx.GPXWaypoint(lat, lon, elevation=dest.get("altitude"))
        wpt.name = dest.get("display_name", "Destination")
        wpt.type = dest.get("type", "summit")
        wpts.append(wpt)

    return wpts


def sac_json_to_gpx(json_path: Path, slug: str, add_elevation: bool = False) -> Path:
    """Convert SAC route JSON to a GPX file.

    Returns the path to the written GPX file.
    """
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    segments = data.get("segments", [])
    if not segments:
        sys.exit("ERROR: No segments found in JSON — is the session authenticated?")

    title = data.get("title", slug)

    # Collect non-alternative segments with their LV95 coordinates.
    skipped = []
    raw: list[tuple[str, list]] = []
    for seg in segments:
        if seg.get("alternative", False):
            skipped.append(seg.get("title", "?"))
            continue
        geom = seg.get("geom")
        if not geom or not geom.get("coordinates"):
            continue
        raw.append((seg.get("title", "?"), geom["coordinates"]))

    if skipped:
        print(f"[sac-gpx] Skipped {len(skipped)} alternative segment(s): {', '.join(skipped)}")

    if not raw:
        sys.exit("ERROR: No coordinates found in any segment.")

    # Stitch segments into a connected track.
    stitched = _stitch_segments(raw)

    # Build GPX from the stitched, connected segments.
    gpx = gpxpy.gpx.GPX()
    gpx.name = title
    gpx.creator = "extract_sac_gpx.py"

    # Add named waypoints from the SAC JSON.
    wpts = _extract_waypoints(data)
    gpx.waypoints = wpts
    if wpts:
        names = [w.name for w in wpts]
        print(f"[sac-gpx] Extracted {len(wpts)} waypoint(s): {', '.join(names)}")

    track = gpxpy.gpx.GPXTrack(name=title)
    gpx.tracks.append(track)

    total_points = 0
    for seg_title, coords in stitched:
        gpx_seg = gpxpy.gpx.GPXTrackSegment()
        track.segments.append(gpx_seg)
        for coord in coords:
            e, n = coord[0], coord[1]
            lat, lon = _lv95_to_wgs84(e, n)
            gpx_seg.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
            total_points += 1

    repo_root = Path(__file__).resolve().parent.parent
    out_dir = repo_root / "routes" / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{slug}.gpx"

    out_path.write_text(gpx.to_xml(), encoding="utf-8")
    print(f"[sac-gpx] Written {out_path} ({total_points} points, {len(track.segments)} segments)")

    if add_elevation:
        from new_hike import enrich_gpx_elevation
        enrich_gpx_elevation(out_path)

    return out_path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract GPX from SAC route portal JSON.",
    )
    parser.add_argument("--json", type=Path, required=True,
                        help="Path to the SAC route JSON file (from Playwright network capture)")
    parser.add_argument("--slug", required=True,
                        help="Hike slug (determines output path: routes/<slug>/<slug>.gpx)")
    parser.add_argument("--add-elevation", action="store_true",
                        help="Enrich the GPX with SwissTopo elevation data after extraction")
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    sac_json_to_gpx(args.json, args.slug, args.add_elevation)
