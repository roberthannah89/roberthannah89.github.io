#!/usr/bin/env python3
"""Scrape all SAC mountain hiking POIs via the suissealpine API.

Paginates the search endpoint using cursor-based pagination, extracts key
fields, converts LV95 coords to WGS84, and writes a JS file that sets
window.SAC_ROUTES for the map page.

Usage:
    python scripts/scrape_sac_pois.py [--output guides/sac-routes.js]

The script calls the public API directly (no auth required).
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

API_BASE = "https://www.suissealpine.sac-cas.ch/api/1/poi/search"
PAGE_SIZE = 100
DISCIPLINE = "mountain_hiking"


def lv95_to_wgs84(e: float, n: float) -> tuple[float, float]:
    y = (e - 2_600_000) / 1_000_000
    x = (n - 1_200_000) / 1_000_000

    lat = (16.9023892
           + 3.238272 * x
           - 0.270978 * y ** 2
           - 0.002528 * x ** 2
           - 0.0447 * y ** 2 * x
           - 0.0140 * x ** 3)

    lon = (2.6779094
           + 4.728982 * y
           + 0.791484 * y * x
           + 0.1306 * y * x ** 2
           - 0.0436 * y ** 3)

    return round(lat * 100 / 36, 5), round(lon * 100 / 36, 5)


def fetch_page(cursor: int | None = None) -> dict:
    url = (
        f"{API_BASE}?lang=en&output_lang=en"
        f"&disciplines={DISCIPLINE}"
        f"&hut_type=all"
        f"&mode=per_discipline"
        f"&limit={PAGE_SIZE}"
    )
    if cursor is not None:
        url += f"&cursor={cursor}"
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sac-map-scraper/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError, ConnectionResetError) as exc:
            if attempt < 4:
                wait = 2 ** attempt
                print(f"  Retry {attempt + 1} after error: {exc} (wait {wait}s)", file=sys.stderr)
                time.sleep(wait)
            else:
                raise


def extract_poi(raw: dict) -> dict:
    coords = raw.get("geom", {}).get("coordinates", [0, 0])
    lat, lon = lv95_to_wgs84(coords[0], coords[1])

    routes = []
    for r in raw.get("routes", []):
        routes.append({
            "id": r.get("id"),
            "title": r.get("title", ""),
            "grade": r.get("main_difficulty", ""),
            "gain": r.get("ascent_altitude"),
            "time_up": r.get("ascent_time_max"),
            "time_down": r.get("descent_time_max"),
        })

    return {
        "id": raw["id"],
        "name": raw.get("display_name", ""),
        "alt": raw.get("altitude"),
        "type": raw.get("type", ""),
        "lat": lat,
        "lon": lon,
        "routes": routes,
    }


def main():
    parser = argparse.ArgumentParser(description="Scrape SAC mountain hiking POIs")
    parser.add_argument("--output", default="guides/sac-routes.js",
                        help="Output JS file path (default: guides/sac-routes.js)")
    args = parser.parse_args()

    checkpoint = args.output + ".partial.json"
    pois = []
    seen = set()
    cursor = None

    if os.path.exists(checkpoint):
        with open(checkpoint) as f:
            saved = json.load(f)
            pois = saved["pois"]
            seen = set(saved["seen"])
            cursor = saved.get("cursor")
        print(f"Resumed from checkpoint: {len(pois)} POIs, cursor={cursor}", file=sys.stderr)

    def save_checkpoint():
        with open(checkpoint, "w") as f:
            json.dump({"pois": pois, "seen": list(seen), "cursor": cursor}, f)

    page = 0
    while True:
        print(f"  page {page}: {len(pois)} POIs so far (cursor={cursor})", file=sys.stderr)
        data = fetch_page(cursor)
        results = data.get("results", [])
        if not results:
            break

        for raw in results:
            if raw["id"] in seen:
                continue
            seen.add(raw["id"])
            pois.append(extract_poi(raw))

        cursor = data.get("cursor")
        save_checkpoint()

        if len(results) < PAGE_SIZE or cursor is None:
            break
        page += 1
        time.sleep(0.5)

    print(f"Scraped {len(pois)} POIs with "
          f"{sum(len(p['routes']) for p in pois)} routes", file=sys.stderr)

    js_content = "window.SAC_ROUTES = " + json.dumps(pois, separators=(",", ":")) + ";\n"

    with open(args.output, "w") as f:
        f.write(js_content)
    print(f"Wrote {args.output}", file=sys.stderr)

    if os.path.exists(checkpoint):
        os.remove(checkpoint)


if __name__ == "__main__":
    main()
