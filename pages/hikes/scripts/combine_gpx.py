#!/usr/bin/env python3
"""Combine two GPX tracks end-to-end, optionally reversing the second."""

import argparse
import gpxpy

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpx1", required=True, help="First GPX file (start of combined track)")
    parser.add_argument("--gpx2", required=True, help="Second GPX file (appended to first)")
    parser.add_argument("--reverse2", action="store_true", help="Reverse the second track before appending")
    parser.add_argument("--output", required=True, help="Output GPX file")
    parser.add_argument("--name", help="Track name for the combined GPX")
    args = parser.parse_args()

    with open(args.gpx1) as f:
        gpx1 = gpxpy.parse(f)
    with open(args.gpx2) as f:
        gpx2 = gpxpy.parse(f)

    points1 = []
    for trk in gpx1.tracks:
        for seg in trk.segments:
            points1.extend(seg.points)

    points2 = []
    for trk in gpx2.tracks:
        for seg in trk.segments:
            points2.extend(seg.points)

    if args.reverse2:
        points2.reverse()

    combined = gpxpy.gpx.GPX()
    trk = gpxpy.gpx.GPXTrack(name=args.name or "Combined track")
    seg = gpxpy.gpx.GPXTrackSegment()
    seg.points = points1 + points2
    trk.segments.append(seg)
    combined.tracks.append(trk)

    wpts1 = list(gpx1.waypoints)
    wpts2 = list(gpx2.waypoints)
    if args.reverse2:
        wpts2.reverse()
    seen = set()
    for w in wpts1 + wpts2:
        key = w.name
        if key not in seen:
            combined.waypoints.append(w)
            seen.add(key)

    with open(args.output, "w") as f:
        f.write(combined.to_xml())
    print(f"Combined: {len(points1)} + {len(points2)} = {len(points1) + len(points2)} points")
    print(f"Waypoints: {len(combined.waypoints)}")
    print(f"Written: {args.output}")

if __name__ == "__main__":
    main()
