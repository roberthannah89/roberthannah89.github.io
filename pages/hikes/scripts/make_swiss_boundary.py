#!/usr/bin/env python3
"""Download Switzerland boundary from GADM, simplify, and save as swiss_border.js.

One-shot generator — run again only if the boundary data needs regenerating.
Outputs to both routes/_assets/ and templates/_assets/ so render syncs it.

Usage:
    python scripts/make_swiss_boundary.py
"""

import json
import math
import urllib.request
from pathlib import Path

GADM_URL = "https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_CHE_0.json"
OUTPUT = Path(__file__).resolve().parent.parent / "routes" / "_assets" / "swiss_border.js"
TEMPLATE_OUTPUT = Path(__file__).resolve().parent.parent / "templates" / "_assets" / "swiss_border.js"

def rdp_simplify(coords, epsilon):
    """Ramer-Douglas-Peucker line simplification."""
    if len(coords) < 3:
        return coords

    def point_line_dist(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        if dx == 0 and dy == 0:
            return math.hypot(p[0] - a[0], p[1] - a[1])
        t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))

    dmax, idx = 0, 0
    for i in range(1, len(coords) - 1):
        d = point_line_dist(coords[i], coords[0], coords[-1])
        if d > dmax:
            dmax, idx = d, i

    if dmax > epsilon:
        left = rdp_simplify(coords[: idx + 1], epsilon)
        right = rdp_simplify(coords[idx:], epsilon)
        return left[:-1] + right
    return [coords[0], coords[-1]]


def simplify_ring(ring, epsilon):
    simplified = rdp_simplify(ring, epsilon)
    if simplified[0] != simplified[-1]:
        simplified.append(simplified[0])
    return simplified


def main():
    print(f"Downloading GADM boundary from {GADM_URL} …")
    with urllib.request.urlopen(GADM_URL) as resp:
        data = json.loads(resp.read())

    geom = data["features"][0]["geometry"]
    epsilon = 0.003  # ~300m at Swiss latitudes

    simplified = {"type": "MultiPolygon", "coordinates": []}
    total_before, total_after = 0, 0

    for polygon in geom["coordinates"]:
        new_poly = []
        for ring in polygon:
            total_before += len(ring)
            s = simplify_ring(ring, epsilon)
            if len(s) >= 4:
                s = [[round(c[0], 5), round(c[1], 5)] for c in s]
                new_poly.append(s)
                total_after += len(s)
        if new_poly:
            simplified["coordinates"].append(new_poly)

    geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "Switzerland"},
                "geometry": simplified,
            }
        ],
    }

    js_content = "window.SWISS_BORDER=" + json.dumps(geojson, separators=(",", ":")) + ";"
    for dest in (OUTPUT, TEMPLATE_OUTPUT):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(js_content)

    size_kb = OUTPUT.stat().st_size / 1024
    print(f"Simplified {total_before} → {total_after} points ({size_kb:.1f} KB)")
    print(f"Saved to {OUTPUT} and {TEMPLATE_OUTPUT}")


if __name__ == "__main__":
    main()
