"""Fetch every named `natural=peak` node in Switzerland from OpenStreetMap.

Base identity layer for the Peak Database. Result cached at
`docs/prototypes/3d-trails/overpass-peaks.json` — safe to delete + refetch.

Usage:
    python3 scripts/fetch_osm_peaks.py           # use cache when present
    python3 scripts/fetch_osm_peaks.py --refresh # force refetch (~90s)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import requests

import config

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_CACHE = REPO_ROOT / "docs" / "prototypes" / "3d-trails" / "overpass-peaks.json"

OVERPASS_QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="CH"][admin_level=2]->.ch;
(
  node["natural"="peak"]["name"](area.ch);
);
out body;
""".strip()


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="ignore cache")
    args = parser.parse_args()

    if OUT_CACHE.exists() and not args.refresh:
        log(f"cache hit → {OUT_CACHE.relative_to(REPO_ROOT)}")
        return

    log("Fetching Overpass (this can take 30-90s)…")
    OUT_CACHE.parent.mkdir(parents=True, exist_ok=True)
    resp = requests.post(
        config.OVERPASS_ENDPOINT,
        data={"data": OVERPASS_QUERY},
        headers={
            "User-Agent": "hikes.robert.blog fetch_osm_peaks.py "
                          "(contact: github.com/roberthannah89)",
            "Accept": "application/json",
        },
        timeout=240,
    )
    resp.raise_for_status()
    data = resp.json()
    with OUT_CACHE.open("w") as f:
        json.dump(data, f, indent=1)
    log(f"      → {len(data['elements'])} peaks, "
        f"cached at {OUT_CACHE.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
