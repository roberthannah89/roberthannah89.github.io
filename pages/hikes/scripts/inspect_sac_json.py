"""Inspect the structure of a SAC route portal JSON file.

Prints top-level fields, waypoints, departure/end points, and segment summaries.
Useful for understanding the data before extraction.

Usage:
    python scripts/inspect_sac_json.py sac-route-4567.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def inspect(json_path: Path) -> None:
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    print(f"Route: {data.get('title', '?')}")
    print(f"ID: {data.get('id', '?')}")
    print()

    # Departure / end / destination
    for key in ("departure_point", "end_point", "destination_poi"):
        val = data.get(key)
        if val and isinstance(val, dict):
            print(f"{key}:")
            for k, v in val.items():
                print(f"  {k}: {v!r}")
            print()
        elif val:
            print(f"{key}: {val!r}")
            print()

    # Waypoints
    wps = data.get("waypoints", [])
    print(f"waypoints: {len(wps)} entries")
    for i, w in enumerate(wps):
        print(f"  [{i}]")
        for k, v in w.items():
            print(f"    {k}: {v!r}")
    print()

    # Segments summary
    segs = data.get("segments", [])
    print(f"segments: {len(segs)}")
    for i, s in enumerate(segs):
        coords = s.get("geom", {}).get("coordinates", [])
        alt = s.get("alternative", False)
        flag = " [ALTERNATIVE]" if alt else ""
        print(f"  [{i}] {s.get('title', '?')}{flag} — {len(coords)} pts")
    print()

    # Photos
    photos = data.get("photos", [])
    print(f"photos: {len(photos)}")
    for i, p in enumerate(photos):
        photo = p.get("photo", {})
        thumbs = photo.get("thumbnails", {})
        url = thumbs.get("1200x750") or thumbs.get("1800x1125") or photo.get("url", "?")
        print(f"  [{i}] {p.get('caption', '?')}")
        print(f"      copyright: {photo.get('copyright', '?')}")
        print(f"      url: {url}")
    print()

    # Other potentially useful fields
    for key in ("mountain_hiking_difficulty", "main_difficulty", "route_info",
                "climbing_ascent", "climbing_descent", "days", "seriousness"):
        val = data.get(key)
        if val:
            print(f"{key}: {val!r}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(f"Usage: {sys.argv[0]} <sac-route-JSON>")
    inspect(Path(sys.argv[1]))
