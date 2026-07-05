"""Project the Peak Database peak DB into a compact all-Switzerland marker set.

Produces `guides/peaks-compact.js` (window.SWISS_PEAKS) — a minimal per-peak
record suitable for scattering markers on a 3D map without pulling in the full
master (multi-MB) payload. Uses the short OSM-style keys the 3D-trails
prototype already understands:

    { n: name, e: ele, y: lat, x: lon,
      w: 1 if wikidata else 0,
      p: prominence_m or null,
      s: sac.grade or null,
      q: wikidata Q-ID (may be null) }

Consumers can promote a peak to a labelled/big-tier marker by presence of `w`,
elevation, or prominence — same heuristics as before, just with more inputs.

If the Peak Database doesn't exist yet, run `scripts/build_peak_db.py` first.

Usage:
    python3 scripts/build_swiss_peaks.py
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_JSON = REPO_ROOT / "guides" / "peaks-db.json"
OUT_JS = REPO_ROOT / "guides" / "peaks-compact.js"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


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
        master = json.load(f)

    compact: list[dict] = []
    for p in master["peaks"]:
        rec = {
            "n": p["name"],
            "e": p.get("ele_wikidata") or p.get("ele"),
            "y": round(p["lat"], 5),
            "x": round(p["lon"], 5),
            "w": 1 if p.get("wikidata") else 0,
        }
        if p.get("prominence_m") is not None:
            rec["p"] = p["prominence_m"]
        sac = p.get("sac") or {}
        if sac.get("grade"):
            rec["s"] = sac["grade"]
        if p.get("wikidata"):
            rec["q"] = p["wikidata"]
        compact.append(rec)

    compact.sort(key=lambda r: (-(r["e"] or 0), r["n"]))

    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    banner = (
        "// GENERATED FROM guides/peaks-db.json by scripts/build_swiss_peaks.py — do not edit.\n"
        "// Re-run: python3 scripts/build_swiss_peaks.py\n"
    )
    body = json.dumps(
        {"peaks": compact, "count": len(compact)},
        separators=(",", ":"), ensure_ascii=False,
    )
    OUT_JS.write_text(f"{banner}window.SWISS_PEAKS = {body};\n")
    log(f"wrote {len(compact)} peaks → {OUT_JS.relative_to(REPO_ROOT)} "
        f"({OUT_JS.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
