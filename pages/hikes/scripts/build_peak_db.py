"""Build the Peak Database — one canonical record per named Swiss peak.

The Peak Database is the single source of truth for peak information across
the site. Every other peak-carrying file is a projection of the canonical
JSON at `guides/peaks-db.json`:

  - guides/peaks-db.js                     (browser: window.PEAKS = {…})
  - guides/peaks-compact.js                (small marker set for maps)
  - routes/<slug>/nearby-peaks.js          (per-hike proximity slice)
  - docs/prototypes/3d-trails/ch-peaks.js (3d-trails prototype's peak database)

See docs/schemas/PEAK-DATABASE.md for the schema and consumer patterns.

Sources:
  1. OSM Overpass — every `natural=peak` node in Switzerland with a `name`,
     cached at docs/prototypes/3d-trails/overpass-peaks.json. Base identity,
     coordinates, elevation, and cross-reference IDs (wikidata, wikipedia).
  2. guides/cantons.geojson  — point-in-polygon → canton
  3. guides/regions.geojson  — point-in-polygon → hiking region
  4. guides/sac-routes.js    — SAC summit lookup (best route + T-grade) and
                                 nearest SAC hut.
  5. scripts/cache/wikidata-peaks.json  — prominence, isolation, image,
     part-of, first-ascent event, Wikipedia sitelinks. Produced by
     fetch_wikidata_peaks.py.
  6. scripts/cache/wikipedia-peaks.json — one-paragraph summary + thumbnail
     per peak with a Wikipedia article. Produced by fetch_wikipedia_peaks.py.

Output: guides/peaks-db.json (canonical, pretty-printed) and
        guides/peaks-db.js (window.PEAKS = {…}) for browser loads.

Usage:
    python3 scripts/build_peak_db.py
        # Re-uses every cache. Fast (~30s for the polygon joins).
    python3 scripts/build_peak_db.py --refresh-osm
        # Refetch OSM Overpass (rarely needed — Swiss peaks change slowly).
    python3 scripts/build_peak_db.py --refresh-wikidata
        # Refetch Wikidata SPARQL (~1 min).
    python3 scripts/build_peak_db.py --refresh-wikipedia
        # Refetch Wikipedia summaries (~5 min).
    python3 scripts/build_peak_db.py --refresh-all
        # All of the above.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import time
from difflib import SequenceMatcher
from pathlib import Path

import config

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"

OVERPASS_CACHE = REPO_ROOT / "docs" / "prototypes" / "3d-trails" / "overpass-peaks.json"
WIKIDATA_CACHE = SCRIPTS_DIR / "cache" / "wikidata-peaks.json"
WIKIPEDIA_CACHE = SCRIPTS_DIR / "cache" / "wikipedia-peaks.json"

CANTONS_GEOJSON = REPO_ROOT / "guides" / "cantons.geojson"
REGIONS_GEOJSON = REPO_ROOT / "guides" / "regions.geojson"
SAC_ROUTES_JS = REPO_ROOT / "guides" / "sac-routes.js"

OUT_JSON = REPO_ROOT / "guides" / "peaks-db.json"
OUT_JS = REPO_ROOT / "guides" / "peaks-db.js"

# OSM spot-elevation points ("P.2860", "P 2634", "Pt 2000") are elevation
# markers, not named peaks. Skip them — they add ~1500 unlabelable dots.
SPOT_ELE_PAT = re.compile(r"^(P|Pt|Pkt)[.\s]\s*\d")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Cache orchestration
# ---------------------------------------------------------------------------

def ensure_caches(refresh_osm: bool, refresh_wd: bool, refresh_wp: bool) -> None:
    """Refresh any caches the user asked for; leave the others untouched."""
    if refresh_osm or not OVERPASS_CACHE.exists():
        log("[cache] Refreshing OSM Overpass…")
        cmd = [sys.executable, str(SCRIPTS_DIR / "fetch_osm_peaks.py")]
        if refresh_osm:
            cmd.append("--refresh")
        subprocess.run(cmd, check=True)
    if refresh_wd or not WIKIDATA_CACHE.exists():
        log("[cache] Refreshing Wikidata cache…")
        cmd = [sys.executable, str(SCRIPTS_DIR / "fetch_wikidata_peaks.py")]
        if refresh_wd:
            cmd.append("--refresh")
        subprocess.run(cmd, check=True)
    if refresh_wp or not WIKIPEDIA_CACHE.exists():
        log("[cache] Refreshing Wikipedia cache…")
        cmd = [sys.executable, str(SCRIPTS_DIR / "fetch_wikipedia_peaks.py")]
        if refresh_wp:
            cmd.append("--refresh")
        subprocess.run(cmd, check=True)


# ---------------------------------------------------------------------------
# Geometry helpers (copied from build_ch_peaks.py; keep in one place after
# build_ch_peaks.py is refactored into a projection over the master).
# ---------------------------------------------------------------------------

def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
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


def classify_by_polygon(lon: float, lat: float, features, key: str) -> str | None:
    for feat, bbox in features:
        min_x, min_y, max_x, max_y = bbox
        if lon < min_x or lon > max_x or lat < min_y or lat > max_y:
            continue
        if point_in_feature(lon, lat, feat):
            return feat["properties"].get(key)
    return None


def load_polygon_features(path: Path):
    with path.open() as f:
        data = json.load(f)
    return [(feat, bbox_of(feat)) for feat in data["features"]]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = config.EARTH_RADIUS_M / 1000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# SAC join helpers
# ---------------------------------------------------------------------------

_DIACRITIC = str.maketrans({
    "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
    "Ä": "ae", "Ö": "oe", "Ü": "ue",
    "é": "e", "è": "e", "ê": "e", "ë": "e",
    "É": "e", "È": "e", "Ê": "e", "Ë": "e",
    "à": "a", "â": "a", "Á": "a", "À": "a", "Â": "a",
    "ô": "o", "ó": "o", "ò": "o", "Ô": "o",
    "î": "i", "í": "i", "ì": "i",
    "ù": "u", "û": "u", "ú": "u",
    "ç": "c", "ñ": "n",
})

_GRADE_ORDER = {
    "T1": 1, "T1+": 1.5,
    "T2": 2, "T2+": 2.5, "T2-": 1.8,
    "T3": 3, "T3+": 3.5, "T3-": 2.8,
    "T4": 4, "T4+": 4.5, "T4-": 3.8,
    "T5": 5, "T5+": 5.5, "T5-": 4.8,
    "T6": 6, "T6+": 6.5, "T6-": 5.8,
}


def normalise_name(name: str) -> str:
    n = name.translate(_DIACRITIC).lower()
    return re.sub(r"[^a-z0-9]+", "", n)


def name_ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, normalise_name(a), normalise_name(b)).ratio()


def best_route(routes: list[dict]) -> dict | None:
    scored = [(_GRADE_ORDER.get(r.get("grade") or "", 99), r) for r in routes]
    scored.sort(key=lambda t: t[0])
    return scored[0][1] if scored else None


def load_sac_routes() -> list[dict]:
    text = SAC_ROUTES_JS.read_text()
    prefix = "window.SAC_ROUTES = "
    if not text.startswith(prefix):
        raise SystemExit("sac-routes.js: unexpected header, cannot parse")
    return json.loads(text[len(prefix):].rstrip(";\n"))


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build(refresh_osm: bool, refresh_wd: bool, refresh_wp: bool) -> None:
    ensure_caches(refresh_osm, refresh_wd, refresh_wp)

    log(f"[1/6] Loading OSM base ({OVERPASS_CACHE.relative_to(REPO_ROOT)})")
    with OVERPASS_CACHE.open() as f:
        osm_elements = json.load(f)["elements"]

    log(f"[2/6] Loading polygon layers")
    cantons = load_polygon_features(CANTONS_GEOJSON)
    regions = load_polygon_features(REGIONS_GEOJSON)

    log(f"[3/6] Loading SAC routes ({SAC_ROUTES_JS.name})")
    sac = load_sac_routes()
    sac_summits = [r for r in sac if r.get("type") == "summit"]
    sac_huts = [r for r in sac if r.get("type") == "hut"]
    log(f"      {len(sac_summits)} SAC summits · {len(sac_huts)} SAC huts")

    log(f"[4/6] Loading Wikidata + Wikipedia caches")
    with WIKIDATA_CACHE.open() as f:
        wd_peaks = json.load(f)["peaks"]
    with WIKIPEDIA_CACHE.open() as f:
        wp_peaks = json.load(f)["peaks"]
    log(f"      {len(wd_peaks)} Wikidata records · {len(wp_peaks)} Wikipedia summaries")

    log(f"[5/6] Merging + joining…")
    t0 = time.time()

    peaks: list[dict] = []
    dropped_no_name = 0
    dropped_spot = 0

    for node in osm_elements:
        tags = node.get("tags") or {}
        name = tags.get("name")
        if not name:
            dropped_no_name += 1
            continue
        if SPOT_ELE_PAT.match(name):
            dropped_spot += 1
            continue

        lat = node["lat"]
        lon = node["lon"]
        osm_id = f"n{node['id']}"
        qid = tags.get("wikidata") if tags.get("wikidata", "").startswith("Q") else None

        try:
            ele_osm = float(tags["ele"]) if "ele" in tags else None
        except ValueError:
            ele_osm = None

        rec: dict = {
            "id": osm_id,
            "name": name,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "ele": round(ele_osm, 1) if ele_osm is not None else None,
            "canton": classify_by_polygon(lon, lat, cantons, "ak"),
            "region": classify_by_polygon(lon, lat, regions, "name"),
        }

        # OSM extra tags
        alt_names: list[str] = []
        for k in ("alt_name", "old_name", "name:de", "name:fr", "name:it", "name:rm"):
            v = tags.get(k)
            if v and v != name and v not in alt_names:
                alt_names.append(v)
        if alt_names:
            rec["alt_names"] = alt_names

        if "prominence" in tags:
            try:
                rec["prominence_m"] = int(float(tags["prominence"]))
            except ValueError:
                pass

        if qid:
            rec["wikidata"] = qid
        if "wikipedia" in tags:
            rec["osm_wikipedia_tag"] = tags["wikipedia"]

        # Wikidata enrichment — additive; only overwrite prominence/ele from
        # OSM when Wikidata has a value.
        wd = wd_peaks.get(qid) if qid else None
        if wd:
            for k in ("prominence_m", "isolation_km", "image"):
                if k in wd:
                    rec[k] = wd[k]
            if "ele_m" in wd:
                rec["ele_wikidata"] = wd["ele_m"]
            if "part_of" in wd:
                rec["part_of"] = wd["part_of"]
            if "first_ascent" in wd:
                rec["first_ascent"] = wd["first_ascent"]
            if "wikipedia" in wd:
                rec["wikipedia"] = wd["wikipedia"]

        # Wikipedia summary — try Q-ID first, fall back to OSM ID.
        wp = wp_peaks.get(qid) if qid else None
        if wp is None:
            wp = wp_peaks.get(f"osm:{osm_id}")
        if wp:
            rec["summary"] = {
                "lang": wp["lang"],
                "title": wp["title"],
                "extract": wp["extract"],
                "url": wp.get("url"),
            }
            if "thumbnail" in wp:
                rec["summary"]["thumbnail"] = wp["thumbnail"]

        # Notability heuristic — used by consumers for label tiering.
        prom = rec.get("prominence_m")
        ele_best = rec.get("ele_wikidata") or rec.get("ele")
        notable = (
            (prom is not None and prom >= config.NOTABLE_MIN_PROMINENCE_M)
            or (ele_best is not None and ele_best >= config.NOTABLE_MIN_ELEVATION_M)
            or (qid is not None)
        )
        rec["notable"] = bool(notable)
        if ele_best is not None and ele_best >= 4000:
            rec["is_4000er"] = True

        # Sources actually used for this record (for provenance).
        sources = ["osm"]
        if wd:
            sources.append("wikidata")
        if wp:
            sources.append("wikipedia")
        rec["sources"] = sources

        peaks.append(rec)

    log(f"      merged {len(peaks)} peaks "
        f"(dropped {dropped_spot} spot-elevation + {dropped_no_name} unnamed)")

    # --- SAC summit → OSM peak join (fuzzy name + <100 m proximity) ---------
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

    matched_sac_ids: set[int] = set()
    unmatched: list[str] = []
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
            unmatched.append(s_name)
            continue
        matched_sac_ids.add(s["id"])
        route = best_route(s.get("routes") or [])
        if route is None:
            continue
        best[1]["sac"] = {
            "sac_summit_id": s["id"],
            "route_id": route.get("id"),
            "route_title": route.get("title"),
            "grade": route.get("grade"),
            "time_up": route.get("time_up"),
            "gain": route.get("gain"),
        }
        if "sac" not in best[1]["sources"]:
            best[1]["sources"].append("sac")

    log(f"      SAC join: matched {len(matched_sac_ids)}/{len(sac_summits)} summits "
        f"({len(unmatched)} unmatched)")

    # --- Nearest hut for every peak -----------------------------------------
    if sac_huts:
        for p in peaks:
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
                "sac_hut_id": best_h.get("id"),
            }

    # Sort: by elevation desc, unknowns last.
    peaks.sort(key=lambda p: (
        p.get("ele_wikidata") is None and p.get("ele") is None,
        -(p.get("ele_wikidata") or p.get("ele") or 0),
    ))

    log(f"      done in {time.time() - t0:.1f}s")

    # ------------------------------------------------------------------------
    log(f"[6/6] Writing outputs")
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)

    meta = {
        "name": "Peak Database",
        "version": 1,
        "count": len(peaks),
        "generated_by": "scripts/build_peak_db.py",
        "sources": {
            "osm": str(OVERPASS_CACHE.relative_to(REPO_ROOT)),
            "wikidata": str(WIKIDATA_CACHE.relative_to(REPO_ROOT)),
            "wikipedia": str(WIKIPEDIA_CACHE.relative_to(REPO_ROOT)),
            "sac": str(SAC_ROUTES_JS.relative_to(REPO_ROOT)),
            "cantons": str(CANTONS_GEOJSON.relative_to(REPO_ROOT)),
            "regions": str(REGIONS_GEOJSON.relative_to(REPO_ROOT)),
        },
        "peaks": peaks,
    }

    with OUT_JSON.open("w") as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)

    banner = (
        "// Peak Database — GENERATED FROM guides/peaks-db.json by scripts/build_peak_db.py\n"
        "// Do not edit. Re-run: python3 scripts/build_peak_db.py\n"
        "// See docs/schemas/PEAK-DATABASE.md for schema + consumer examples.\n"
    )
    # Emit the full metadata envelope so consumers can also read version/count.
    payload = json.dumps(
        {"name": meta["name"], "version": meta["version"],
         "count": meta["count"], "peaks": peaks},
        separators=(",", ":"), ensure_ascii=False,
    )
    OUT_JS.write_text(f"{banner}window.PEAKS = {payload};\n")

    log(f"      {OUT_JSON.relative_to(REPO_ROOT)} · {OUT_JSON.stat().st_size / 1024:.0f} KB")
    log(f"      {OUT_JS.relative_to(REPO_ROOT)} · {OUT_JS.stat().st_size / 1024:.0f} KB")
    log(f"      {len(peaks)} peaks · "
        f"{sum(1 for p in peaks if p.get('wikidata'))} with Wikidata · "
        f"{sum(1 for p in peaks if p.get('summary'))} with Wikipedia summary · "
        f"{sum(1 for p in peaks if p.get('sac'))} with SAC route")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh-osm", action="store_true", help="force OSM refetch")
    parser.add_argument("--refresh-wikidata", action="store_true", help="force Wikidata refetch")
    parser.add_argument("--refresh-wikipedia", action="store_true", help="force Wikipedia refetch")
    parser.add_argument("--refresh-all", action="store_true", help="force every refetch")
    args = parser.parse_args()

    build(
        refresh_osm=args.refresh_osm or args.refresh_all,
        refresh_wd=args.refresh_wikidata or args.refresh_all,
        refresh_wp=args.refresh_wikipedia or args.refresh_all,
    )


if __name__ == "__main__":
    main()
