"""Project the Peak Database into the 3d-trails prototype's ch-peaks.js.

Thin projection over `guides/peaks-db.json` — the historic Overpass + polygon
+ SAC + hut join pipeline lives in `scripts/build_peak_db.py`; this script
just picks the subset of fields the 3d-trails prototype consumes.

If the Peak Database doesn't exist yet, run `scripts/build_peak_db.py` first.

Fields the 3d-trails UI reads (see docs/prototypes/3d-trails/3d-trails.js):
    id, name, lat, lon, ele, canton, region, prominence, wikipedia,
    sac{grade, route_title, gain, time_up}, nearest_hut{name, dist_km, alt}

Extra fields the projection also carries (the UI ignores unknown keys, so
adding them is safe and lets future UI iterations opt in):
    image           — Wikimedia Commons filename
    summary         — {lang, title, extract, url, thumbnail?}
    isolation_km    — topographic isolation
    ele_wikidata    — authoritative Wikidata elevation
    part_of         — parent range/massif labels
    first_ascent    — {date, climbers[]} when known
    alt_names       — non-primary names
    wikidata        — Q-ID
    notable         — heuristic (prominence ≥100 or ele ≥3000 or has Q-ID)
    is_4000er       — best elevation ≥ 4000 m

Usage:
    python3 scripts/build_ch_peaks.py                 # project from the DB
    python3 scripts/build_ch_peaks.py --rebuild-db    # rebuild the DB first
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_JSON = REPO_ROOT / "guides" / "peaks-db.json"
OUT_JS = REPO_ROOT / "docs" / "prototypes" / "3d-trails" / "ch-peaks.js"

KEEP_FIELDS = (
    "id", "name", "lat", "lon", "canton", "region",
    "wikidata", "sac", "nearest_hut",
    # Extras — the 3d-trails UI ignores unknown keys but future iterations
    # can opt in without another projection roundtrip.
    "image", "summary", "isolation_km", "ele_wikidata",
    "part_of", "first_ascent", "notable", "is_4000er", "alt_names",
)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def project(peak: dict) -> dict:
    out: dict = {}
    for k in KEEP_FIELDS:
        if k in peak:
            out[k] = peak[k]
    # ch-peaks.js has always used the OSM ele (rounded); the DB's `ele` field
    # is the same.
    if "ele" in peak and peak["ele"] is not None:
        out["ele"] = peak["ele"]
    # Prefer prominence_m; strip the "_m" suffix for backwards-compat.
    if "prominence_m" in peak:
        out["prominence"] = peak["prominence_m"]
    # Legacy ch-peaks.js exposes wikipedia as the raw OSM "lang:Title" tag.
    if "osm_wikipedia_tag" in peak:
        out["wikipedia"] = peak["osm_wikipedia_tag"]
    # Drop sac_hut_id from nearest_hut (kept in the DB, not in legacy contract).
    if "nearest_hut" in out:
        nh = dict(out["nearest_hut"])
        nh.pop("sac_hut_id", None)
        out["nearest_hut"] = nh
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild-db", action="store_true",
                        help="run build_peak_db.py first (with cache reuse)")
    args = parser.parse_args()

    if args.rebuild_db or not DB_JSON.exists():
        log("Running build_peak_db.py…")
        subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "build_peak_db.py")],
            check=True,
        )

    with DB_JSON.open() as f:
        db = json.load(f)
    peaks = [project(p) for p in db["peaks"]]

    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    banner = (
        "// GENERATED FROM guides/peaks-db.json by scripts/build_ch_peaks.py — do not edit.\n"
        "// Re-run: python3 scripts/build_ch_peaks.py (or `make peaks`).\n"
    )
    payload = json.dumps(peaks, separators=(",", ":"), ensure_ascii=False)
    OUT_JS.write_text(f"{banner}window.CH_PEAKS = {payload};\n")
    log(f"wrote {len(peaks)} peaks → {OUT_JS.relative_to(REPO_ROOT)} "
        f"({OUT_JS.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
