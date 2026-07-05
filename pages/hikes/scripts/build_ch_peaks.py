"""Build the Peak Viewer dataset: every named peak in Switzerland with canton,
region, prominence (when known), Wikipedia, best SAC route, and nearest hut.

Pipeline:
  1. Overpass — fetch every `natural=peak` node in Switzerland that has a name.
  2. Canton + region — point-in-polygon against guides/cantons.geojson and
     guides/regions.geojson (no external API calls, no rate limits).
  3. SAC join — for each SAC summit in guides/sac-routes.js, find the nearest
     OSM peak within SAC_JOIN_DISTANCE_M metres. If the names fuzzy-match
     (ratio >= SAC_JOIN_NAME_THRESHOLD after normalising diacritics + ü/ue etc.),
     attach the best route (lowest T-grade).
  4. Nearest hut — for each OSM peak, nearest SAC hut (type == 'hut').
  5. Emit docs/prototypes/3d-trails/ch-peaks.js as
        window.CH_PEAKS = [...]
     sorted by elevation descending.

Raw Overpass response is cached at docs/prototypes/3d-trails/overpass-peaks.json
so re-runs are cheap. Pass --refresh to force refetch.

Usage:
  python3 scripts/build_ch_peaks.py           # use cache when present
  python3 scripts/build_ch_peaks.py --refresh # force Overpass refetch
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from difflib import SequenceMatcher
from pathlib import Path

import requests

import config

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "docs" / "prototypes" / "3d-trails"
OVERPASS_CACHE = OUT_DIR / "overpass-peaks.json"
OUTPUT_JS = OUT_DIR / "ch-peaks.js"

CANTONS_GEOJSON = REPO_ROOT / "guides" / "cantons.geojson"
REGIONS_GEOJSON = REPO_ROOT / "guides" / "regions.geojson"
SAC_ROUTES_JS = REPO_ROOT / "guides" / "sac-routes.js"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# 1. Overpass
# ---------------------------------------------------------------------------

OVERPASS_QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="CH"][admin_level=2]->.ch;
(
  node["natural"="peak"]["name"](area.ch);
);
out body;
""".strip()


def fetch_overpass(refresh: bool = False) -> list[dict]:
    if OVERPASS_CACHE.exists() and not refresh:
        log(f"[1/5] Overpass cache hit → {OVERPASS_CACHE.relative_to(REPO_ROOT)}")
        with OVERPASS_CACHE.open() as f:
            return json.load(f)["elements"]

    log("[1/5] Fetching Overpass (this can take 30-90s)…")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    resp = requests.post(
        config.OVERPASS_ENDPOINT,
        data={"data": OVERPASS_QUERY},
        headers={
            "User-Agent": "hikes.robert.blog build_ch_peaks.py (contact: github.com/roberthannah89)",
            "Accept": "application/json",
        },
        timeout=240,
    )
    resp.raise_for_status()
    data = resp.json()
    with OVERPASS_CACHE.open("w") as f:
        json.dump(data, f, indent=1)
    log(f"      → {len(data['elements'])} peaks, cached")
    return data["elements"]


# ---------------------------------------------------------------------------
# 2. Point-in-polygon for canton + region
# ---------------------------------------------------------------------------

def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    """Ray casting against a single ring (list of [lon, lat] pairs)."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def point_in_feature(lon: float, lat: float, feature: dict) -> bool:
    geom = feature["geometry"]
    if geom["type"] == "Polygon":
        polys = [geom["coordinates"]]
    elif geom["type"] == "MultiPolygon":
        polys = geom["coordinates"]
    else:
        return False
    for poly in polys:
        outer = poly[0]
        holes = poly[1:] if len(poly) > 1 else []
        if not point_in_ring(lon, lat, outer):
            continue
        if any(point_in_ring(lon, lat, h) for h in holes):
            continue
        return True
    return False


def bbox_of(feature: dict) -> tuple[float, float, float, float]:
    geom = feature["geometry"]
    xs, ys = [], []
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        for ring in poly:
            for pt in ring:
                xs.append(pt[0])
                ys.append(pt[1])
    return min(xs), min(ys), max(xs), max(ys)


def classify_by_polygon(lon: float, lat: float, features: list[dict], key: str) -> str | None:
    """Return the `properties[key]` of the first feature containing (lon, lat)."""
    for feat, bbox in features:
        min_x, min_y, max_x, max_y = bbox
        if lon < min_x or lon > max_x or lat < min_y or lat > max_y:
            continue
        if point_in_feature(lon, lat, feat):
            return feat["properties"].get(key)
    return None


def load_features(path: Path) -> list[tuple[dict, tuple[float, float, float, float]]]:
    with path.open() as f:
        data = json.load(f)
    return [(feat, bbox_of(feat)) for feat in data["features"]]


# ---------------------------------------------------------------------------
# 3. SAC join
# ---------------------------------------------------------------------------

def load_sac_routes() -> list[dict]:
    text = SAC_ROUTES_JS.read_text()
    prefix = "window.SAC_ROUTES = "
    if not text.startswith(prefix):
        raise SystemExit("sac-routes.js: unexpected header, cannot parse")
    return json.loads(text[len(prefix):].rstrip(";\n"))


_DIACRITIC = str.maketrans({
    "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
    "Ä": "ae", "Ö": "oe", "Ü": "ue",
    "é": "e", "è": "e", "ê": "e", "ë": "e",
    "É": "e", "È": "e", "Ê": "e", "Ë": "e",
    "à": "a", "â": "a", "Á": "a", "À": "a", "Â": "a",
    "ô": "o", "ó": "o", "ò": "o", "Ô": "o",
    "î": "i", "í": "i", "ì": "i",
    "ù": "u", "û": "u", "ú": "u",
    "ç": "c",
    "ñ": "n",
})


def normalise_name(name: str) -> str:
    n = name.translate(_DIACRITIC).lower()
    n = re.sub(r"[^a-z0-9]+", "", n)
    return n


def name_ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, normalise_name(a), normalise_name(b)).ratio()


GRADE_ORDER = {
    "T1": 1, "T1+": 1.5,
    "T2": 2, "T2+": 2.5, "T2-": 1.8,
    "T3": 3, "T3+": 3.5, "T3-": 2.8,
    "T4": 4, "T4+": 4.5, "T4-": 3.8,
    "T5": 5, "T5+": 5.5, "T5-": 4.8,
    "T6": 6, "T6+": 6.5, "T6-": 5.8,
}


def best_route(routes: list[dict]) -> dict | None:
    """Pick the route with the lowest T-grade (easiest access)."""
    scored = [(GRADE_ORDER.get(r.get("grade") or "", 99), r) for r in routes]
    scored.sort(key=lambda t: t[0])
    return scored[0][1] if scored else None


# ---------------------------------------------------------------------------
# 4. Nearest hut
# ---------------------------------------------------------------------------

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = config.EARTH_RADIUS_M / 1000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="force Overpass refetch")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    peaks_raw = fetch_overpass(refresh=args.refresh)

    log("[2/5] Loading cantons + regions…")
    cantons = load_features(CANTONS_GEOJSON)
    regions = load_features(REGIONS_GEOJSON)

    log("[3/5] Loading SAC routes…")
    sac = load_sac_routes()
    sac_summits = [r for r in sac if r.get("type") == "summit"]
    sac_huts = [r for r in sac if r.get("type") == "hut"]
    log(f"      {len(sac_summits)} SAC summits, {len(sac_huts)} SAC huts")

    log("[4/5] Enriching + joining…")
    t0 = time.time()
    peaks: list[dict] = []
    unmatched_sac_summits: list[str] = []
    matched_sac_ids: set[int] = set()
    dropped_spot = 0

    # OSM spot-elevation points ("P.2860", "P 2634", "Pt 2000") are elevation
    # markers, not named peaks. Skip them — they add ~1500 unlabelable dots.
    spot_ele_pat = re.compile(r"^(P|Pt|Pkt)[.\s]\s*\d")

    for i, node in enumerate(peaks_raw):
        if i and i % 1000 == 0:
            log(f"      {i}/{len(peaks_raw)} peaks processed")

        tags = node.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        if spot_ele_pat.match(name):
            dropped_spot += 1
            continue
        lat, lon = node["lat"], node["lon"]

        try:
            ele = float(tags["ele"]) if "ele" in tags else None
        except ValueError:
            ele = None

        canton = classify_by_polygon(lon, lat, cantons, "ak")
        region = classify_by_polygon(lon, lat, regions, "name")

        peak = {
            "id": f"n{node['id']}",
            "name": name,
            "ele": round(ele, 1) if ele is not None else None,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "canton": canton,
            "region": region,
        }
        if "prominence" in tags:
            try:
                peak["prominence"] = int(float(tags["prominence"]))
            except ValueError:
                pass
        if "wikipedia" in tags:
            peak["wikipedia"] = tags["wikipedia"]
        if "wikidata" in tags:
            peak["wikidata"] = tags["wikidata"]

        peaks.append(peak)

    log(f"      {len(peaks)} peaks kept (dropped {dropped_spot} spot-elevation markers, "
        f"{len(peaks_raw) - len(peaks) - dropped_spot} without name)")

    # Build a spatial-ish index for the SAC join (each OSM peak indexed by
    # rounded 0.01-deg cell — ~1 km. SAC join checks the peak's cell + neighbours.)
    peak_by_cell: dict[tuple[int, int], list[dict]] = {}
    for p in peaks:
        cell = (round(p["lat"] * 100), round(p["lon"] * 100))
        peak_by_cell.setdefault(cell, []).append(p)

    def peaks_near(lat: float, lon: float) -> list[dict]:
        c_lat = round(lat * 100)
        c_lon = round(lon * 100)
        out: list[dict] = []
        for dlat in (-1, 0, 1):
            for dlon in (-1, 0, 1):
                out.extend(peak_by_cell.get((c_lat + dlat, c_lon + dlon), []))
        return out

    # SAC summit → OSM peak match
    for s in sac_summits:
        s_name = s.get("name") or ""
        best: tuple[float, dict] | None = None
        for p in peaks_near(s["lat"], s["lon"]):
            d_km = haversine_km(s["lat"], s["lon"], p["lat"], p["lon"])
            if d_km * 1000 > config.SAC_JOIN_DISTANCE_M:
                continue
            if name_ratio(s_name, p["name"]) < config.SAC_JOIN_NAME_THRESHOLD:
                continue
            if best is None or d_km < best[0]:
                best = (d_km, p)
        if best is None:
            unmatched_sac_summits.append(s_name)
            continue
        matched_sac_ids.add(s["id"])
        route = best_route(s.get("routes") or [])
        if route is None:
            continue
        best[1]["sac"] = {
            "route_id": route.get("id"),
            "route_title": route.get("title"),
            "grade": route.get("grade"),
            "time_up": route.get("time_up"),
            "gain": route.get("gain"),
            "sac_summit_id": s["id"],
        }

    log(f"      SAC join: matched {len(matched_sac_ids)}/{len(sac_summits)} summits")
    if unmatched_sac_summits:
        log(f"      unmatched SAC summits (first 20): {unmatched_sac_summits[:20]}")

    # Nearest hut for each peak
    if sac_huts:
        for p in peaks:
            # Coarse pass: bounding-box prune to nearest 50 huts by lat/lon delta,
            # then exact haversine among those. 345 huts total — the prune is
            # optional but keeps this snappy.
            candidates = sorted(
                sac_huts,
                key=lambda h: abs(h["lat"] - p["lat"]) + abs(h["lon"] - p["lon"]),
            )[:20]
            best_h = min(
                candidates,
                key=lambda h: haversine_km(p["lat"], p["lon"], h["lat"], h["lon"]),
            )
            p["nearest_hut"] = {
                "name": best_h["name"],
                "dist_km": round(haversine_km(p["lat"], p["lon"], best_h["lat"], best_h["lon"]), 2),
                "alt": best_h.get("alt"),
            }

    log(f"      enrichment done in {time.time() - t0:.1f}s")

    # Sort by elevation desc (unknown at end)
    peaks.sort(key=lambda p: (p["ele"] is None, -(p["ele"] or 0)))

    log(f"[5/5] Writing {OUTPUT_JS.relative_to(REPO_ROOT)}")
    banner = (
        "// GENERATED FROM overpass-peaks.json by scripts/build_ch_peaks.py — do not edit.\n"
        "// Re-run: python3 scripts/build_ch_peaks.py [--refresh]\n"
    )
    payload = json.dumps(peaks, separators=(",", ":"), ensure_ascii=False)
    OUTPUT_JS.write_text(f"{banner}window.CH_PEAKS = {payload};\n")
    log(f"      {len(peaks)} peaks written ({OUTPUT_JS.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    build()
