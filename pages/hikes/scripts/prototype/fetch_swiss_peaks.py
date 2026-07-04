"""Prototype: fetch every named peak in Switzerland from OpenStreetMap.

One-off exploration for a 3D-map peaks demo. Not part of the production pipeline.

    ~/venvs/dev/bin/python scripts/prototype/fetch_swiss_peaks.py

Queries Overpass for `natural=peak` nodes with a `name` inside the Swiss
country area (ISO 3166-1 = CH). Writes routes/zindlenspitz/proto-swiss-peaks.js
as a JS module setting window.SWISS_PEAKS = {peaks: [...], count: N}.

Uses a full country query — expect ~10k features and a slow Overpass response
(90–180 s). Result is cached at /tmp/swiss-peaks.overpass.json so re-runs are
instant while iterating on the client code.
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HIKES_ROOT = SCRIPT_DIR.parent.parent
ROUTE_DIR = HIKES_ROOT / "routes" / "zindlenspitz"
OUT_JS = ROUTE_DIR / "proto-swiss-peaks.js"
CACHE_PATH = Path("/tmp/swiss-peaks.overpass.json")


def fetch_overpass() -> dict:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    # `area["ISO3166-1"="CH"]` picks the Swiss admin boundary from OSM's
    # relation index and materialises it as a search area for the node query.
    query = """
[out:json][timeout:240];
area["ISO3166-1"="CH"][admin_level=2]->.ch;
(
  node["natural"="peak"]["name"](area.ch);
);
out body;
""".strip()
    url = "https://overpass-api.de/api/interpreter"
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "hikes-peaks-proto/1.0"})
    print("querying Overpass — this can take 1-3 minutes …", flush=True)
    with urllib.request.urlopen(req, timeout=300) as r:
        payload = json.load(r)
    CACHE_PATH.write_text(json.dumps(payload))
    return payload


def main() -> int:
    payload = fetch_overpass()
    elements = payload.get("elements", [])
    print(f"overpass returned {len(elements)} peak nodes", flush=True)

    peaks: list[dict] = []
    for el in elements:
        tags = el.get("tags", {}) or {}
        name = tags.get("name")
        if not name:
            continue
        lat, lon = el.get("lat"), el.get("lon")
        if lat is None or lon is None:
            continue
        ele_str = tags.get("ele")
        try:
            ele = float(ele_str) if ele_str is not None else None
        except ValueError:
            ele = None
        # Skip OSM "P.2860"-style spot elevations — not real names.
        if name and (name.startswith("P.") or name.startswith("P ")):
            continue
        peaks.append({
            "n": name,               # short keys keep the JS payload small
            "e": ele,
            "y": round(lat, 5),
            "x": round(lon, 5),
            "w": 1 if tags.get("wikidata") else 0,
        })

    peaks.sort(key=lambda p: (-(p["e"] or 0), p["n"]))

    # Emit a compact JS module so file:// pages can load via <script>.
    body = json.dumps({"peaks": peaks, "count": len(peaks)}, ensure_ascii=False, separators=(",", ":"))
    OUT_JS.write_text("window.SWISS_PEAKS = " + body + ";\n")
    print(f"wrote {len(peaks)} peaks to {OUT_JS.relative_to(HIKES_ROOT)}", flush=True)

    with_ele = sum(1 for p in peaks if p["e"] is not None)
    with_wd = sum(1 for p in peaks if p["w"])
    kb = OUT_JS.stat().st_size / 1024
    print(f"  with elevation: {with_ele}", flush=True)
    print(f"  with wikidata:  {with_wd}", flush=True)
    print(f"  js file size:   {kb:.1f} KB", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
