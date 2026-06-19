"""Check for distance gaps between consecutive GPX segments.

Diagnostic tool — run after SAC GPX extraction to verify track connectivity.

Usage:
    python scripts/check_gpx_gaps.py routes/<slug>/<slug>.gpx [threshold_m]
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import gpxpy


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return distance in metres between two WGS84 points."""
    R = 6_371_000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def check_gaps(gpx_path: Path, threshold_m: float = 100) -> None:
    """Print segment connectivity report to stdout."""
    with gpx_path.open(encoding="utf-8") as f:
        gpx = gpxpy.parse(f)

    for track in gpx.tracks:
        segs = track.segments
        print(f"Track: {track.name or '(unnamed)'}, {len(segs)} segment(s)")
        for i, seg in enumerate(segs):
            p0, p1 = seg.points[0], seg.points[-1]
            print(f"  Seg {i}: {len(seg.points)} pts, "
                  f"start=({p0.latitude:.5f}, {p0.longitude:.5f}), "
                  f"end=({p1.latitude:.5f}, {p1.longitude:.5f})")
            if i > 0:
                prev_end = segs[i - 1].points[-1]
                gap = haversine(prev_end.latitude, prev_end.longitude,
                                p0.latitude, p0.longitude)
                flag = " *** GAP ***" if gap > threshold_m else ""
                print(f"    Gap from seg {i-1} end → seg {i} start: {gap:.0f} m{flag}")


if __name__ == "__main__":
    check_gaps(Path(sys.argv[1]), threshold_m=float(sys.argv[2]) if len(sys.argv) > 2 else 100)
