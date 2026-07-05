"""Emit ``guides/sources-credits.js`` from the current set of hike ``data.json``
files. The sources page reads the emitted globals at page load, so the
photographer + route-author lists on that page stay in sync with the hikes.

Two globals are emitted:

* ``window.PHOTO_CREDITS`` — array of ``{name, count, sample}`` per
  photographer, sorted by photo count desc. ``sample`` points at one photo
  they contributed so the sources page can render a thumbnail per author.
* ``window.ROUTE_AUTHOR_CREDITS`` — array of ``{name, count, bio_html,
  portrait_url}`` per route contributor, sorted by route count desc.

Total counts are attached as ``window.CREDIT_TOTALS`` so the page can show
"42 photographers · 970 photos" summary lines without recomputing.

Run:
    python scripts/gen_credits.py
    python scripts/gen_credits.py --out guides/sources-credits.js  # explicit
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_HIKES = Path(__file__).resolve().parent.parent
ROUTES_DIR = REPO_HIKES / "routes"
DEFAULT_OUT = REPO_HIKES / "guides" / "sources-credits.js"


def collect() -> dict:
    photo_by_name: dict[str, dict] = {}
    author_by_name: dict[str, dict] = {}
    total_hikes = 0
    total_credited_photos = 0

    for data_path in sorted(ROUTES_DIR.glob("*/*.data.json")):
        d = json.loads(data_path.read_text(encoding="utf-8"))
        total_hikes += 1
        slug = data_path.parent.name

        # Photographers
        for ph in d.get("photos") or []:
            name = (ph.get("copyright") or "").strip()
            if not name:
                continue
            total_credited_photos += 1
            entry = photo_by_name.setdefault(name, {"name": name, "count": 0, "sample": None})
            entry["count"] += 1
            if entry["sample"] is None:
                entry["sample"] = {
                    "url": ph.get("url", ""),
                    "alt": ph.get("alt", ""),
                    "credit_date": ph.get("credit_date", ""),
                    "hike_slug": slug,
                    "hike_name": (d.get("peak") or {}).get("name") or slug,
                }

        # Route authors
        ra = d.get("route_author")
        if isinstance(ra, dict) and (ra.get("name") or "").strip():
            name = ra["name"].strip()
            entry = author_by_name.setdefault(name, {
                "name": name,
                "count": 0,
                "bio_html": ra.get("bio_html", ""),
                "portrait_url": ra.get("portrait_url", ""),
            })
            entry["count"] += 1
            # Keep the first non-empty bio/portrait we saw
            if not entry["bio_html"] and ra.get("bio_html"):
                entry["bio_html"] = ra["bio_html"]
            if not entry["portrait_url"] and ra.get("portrait_url"):
                entry["portrait_url"] = ra["portrait_url"]

    photos = sorted(photo_by_name.values(), key=lambda e: (-e["count"], e["name"]))
    authors = sorted(author_by_name.values(), key=lambda e: (-e["count"], e["name"]))

    return {
        "photos": photos,
        "authors": authors,
        "totals": {
            "hikes": total_hikes,
            "photographers": len(photos),
            "photos": total_credited_photos,
            "route_authors": len(authors),
        },
    }


def emit_js(data: dict, out_path: Path) -> None:
    body = (
        "// GENERATED FROM routes/*.data.json by scripts/gen_credits.py — do not hand-edit.\n"
        "// Regenerates on every `make render`.\n"
        f"window.PHOTO_CREDITS = {json.dumps(data['photos'], ensure_ascii=False, indent=2)};\n"
        f"window.ROUTE_AUTHOR_CREDITS = {json.dumps(data['authors'], ensure_ascii=False, indent=2)};\n"
        f"window.CREDIT_TOTALS = {json.dumps(data['totals'], ensure_ascii=False, indent=2)};\n"
    )
    out_path.write_text(body, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help=f"Output path (default: {DEFAULT_OUT.relative_to(REPO_HIKES)})")
    args = ap.parse_args(argv)

    data = collect()
    emit_js(data, args.out)
    t = data["totals"]
    print(
        f"[credits] {args.out.relative_to(REPO_HIKES)} — "
        f"{t['photographers']} photographers · {t['photos']} credited photos · "
        f"{t['route_authors']} route authors · {t['hikes']} hikes"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
