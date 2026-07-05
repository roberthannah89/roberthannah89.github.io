"""Sanity-check the Peak Database and its projections.

Verifies:
  - guides/peaks-db.json exists and parses
  - Every peak has id, name, lat, lon
  - Every projection file exists and its JS wrapper is intact
  - Coverage stats (Wikidata, Wikipedia, SAC route, image, first ascent)
  - Warns on unusual conditions (0 peaks in a canton, huge elevation, etc.)

Usage:
    python3 scripts/validate_peaks_db.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_JSON = REPO_ROOT / "guides" / "peaks-db.json"
DB_JS   = REPO_ROOT / "guides" / "peaks-db.js"
COMPACT = REPO_ROOT / "guides" / "peaks-compact.js"
CH_PEAKS = REPO_ROOT / "docs" / "prototypes" / "3d-trails" / "ch-peaks.js"
ROUTE_ZINDLENSPITZ = REPO_ROOT / "routes" / "zindlenspitz" / "nearby-peaks.js"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def check_js(path: Path, global_name: str) -> None:
    if not path.exists():
        raise SystemExit(f"MISSING: {path.relative_to(REPO_ROOT)}")
    text = path.read_text()
    if f"window.{global_name}" not in text:
        raise SystemExit(f"{path.relative_to(REPO_ROOT)}: no `window.{global_name}` assignment")
    log(f"  ok  {path.relative_to(REPO_ROOT)} · window.{global_name} · "
        f"{path.stat().st_size / 1024:.0f} KB")


def main() -> None:
    if not DB_JSON.exists():
        raise SystemExit(f"MISSING: {DB_JSON.relative_to(REPO_ROOT)} — run `make peaks`")

    with DB_JSON.open() as f:
        db = json.load(f)

    peaks = db.get("peaks") or []
    if not peaks:
        raise SystemExit("Peak Database has 0 peaks — likely a build failure")

    log(f"[Peak Database] {db.get('name')} v{db.get('version')} · {len(peaks)} peaks")

    # Required fields
    missing_id = [p for p in peaks if not p.get("id")]
    missing_name = [p for p in peaks if not p.get("name")]
    missing_coord = [p for p in peaks if p.get("lat") is None or p.get("lon") is None]
    if missing_id or missing_name or missing_coord:
        raise SystemExit(
            f"REQUIRED fields missing: id={len(missing_id)}, "
            f"name={len(missing_name)}, coord={len(missing_coord)}"
        )
    log(f"  ok  every peak has id/name/lat/lon")

    # Coverage stats
    stats = {
        "wikidata":    sum(1 for p in peaks if p.get("wikidata")),
        "wikipedia":   sum(1 for p in peaks if p.get("wikipedia")),
        "summary":     sum(1 for p in peaks if p.get("summary")),
        "image":       sum(1 for p in peaks if p.get("image")),
        "prominence":  sum(1 for p in peaks if p.get("prominence_m")),
        "isolation":   sum(1 for p in peaks if p.get("isolation_km")),
        "first_ascent":sum(1 for p in peaks if p.get("first_ascent")),
        "part_of":     sum(1 for p in peaks if p.get("part_of")),
        "sac":         sum(1 for p in peaks if p.get("sac")),
        "canton":      sum(1 for p in peaks if p.get("canton")),
        "region":      sum(1 for p in peaks if p.get("region")),
        "notable":     sum(1 for p in peaks if p.get("notable")),
        "4000er":      sum(1 for p in peaks if p.get("is_4000er")),
    }
    log(f"\n[Coverage]")
    for k, v in stats.items():
        pct = 100.0 * v / len(peaks)
        log(f"  {k:12s} {v:5d}  ({pct:5.1f}%)")

    # Elevation sanity
    ele_values = [p.get("ele_wikidata") or p.get("ele") for p in peaks]
    ele_values = [e for e in ele_values if e is not None]
    if ele_values:
        log(f"\n[Elevation] min={min(ele_values):.0f} max={max(ele_values):.0f} "
            f"median={sorted(ele_values)[len(ele_values)//2]:.0f}")
        if max(ele_values) > 5000:
            log(f"  WARN: max elevation > 5000 m ({max(ele_values):.0f}) — check data")

    # Canton coverage
    cantons = set(p.get("canton") for p in peaks if p.get("canton"))
    log(f"\n[Cantons] {len(cantons)} distinct: {sorted(cantons)}")
    if len(cantons) < 20:
        log(f"  WARN: fewer than 20 cantons — polygon join may be off")

    # Projections
    log(f"\n[Projections]")
    check_js(DB_JS, "PEAKS")
    check_js(COMPACT, "SWISS_PEAKS")
    check_js(CH_PEAKS, "CH_PEAKS")
    check_js(ROUTE_ZINDLENSPITZ, "ROUTE_PEAKS")

    log(f"\nOK")


if __name__ == "__main__":
    main()
