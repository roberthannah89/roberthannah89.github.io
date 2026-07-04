"""Batch-rescrape SAC route pages for hikes missing end_point.sbb_url.

For each hike in ``routes/`` whose ``end_point`` exists but has no ``sbb_url``,
fetch the SAC page and apply any newly-extractable fields (currently:
``end_point.sbb_url`` from the arrival-side "Public transport" section).
Requires a valid SAC cookie at ``~/.config/sac-hikes/cookie``.

CLI:
    python scripts/rescrape_all_sac.py            # dry run — list what would run
    python scripts/rescrape_all_sac.py --apply    # actually rescrape and patch
    python scripts/rescrape_all_sac.py --apply --sleep 1.5   # be nice to SAC
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO_HIKES = Path(__file__).resolve().parent.parent
ROUTES_DIR = REPO_HIKES / "routes"


def hikes_needing_rescrape() -> list[tuple[str, str]]:
    """Return [(slug, sac_url)] for hikes with end_point but no end_point.sbb_url."""
    out: list[tuple[str, str]] = []
    for data_path in sorted(ROUTES_DIR.glob("*/*.data.json")):
        d = json.loads(data_path.read_text(encoding="utf-8"))
        ep = d.get("end_point")
        if not ep or ep.get("sbb_url"):
            continue
        # First source URL is the route page (per AGENTS.md convention).
        sources = d.get("sources") or []
        route_url = next(
            (s.get("url") for s in sources if s.get("url") and "sac-route-portal" in s["url"]
             and s["url"].rstrip("/").count("/") >= 8),
            None,
        )
        if not route_url:
            print(f"  (skip {data_path.parent.name}: no SAC route URL in sources)", file=sys.stderr)
            continue
        out.append((data_path.parent.name, route_url))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true",
                    help="Actually rescrape (default: dry run — list only)")
    ap.add_argument("--sleep", type=float, default=1.0,
                    help="Seconds to wait between SAC requests (default: 1.0)")
    args = ap.parse_args()

    todo = hikes_needing_rescrape()
    print(f"{len(todo)} hikes to rescrape:")
    for slug, url in todo:
        print(f"  {slug:38s} {url}")

    if not args.apply:
        print("\n[DRY RUN] pass --apply to actually rescrape.")
        return 0

    scraper = REPO_HIKES / "scripts" / "scrape_sac_route_page.py"
    n_ok = n_fail = 0
    for i, (slug, url) in enumerate(todo, 1):
        print(f"\n[{i}/{len(todo)}] {slug}")
        result = subprocess.run(
            [sys.executable, str(scraper), "--url", url, "--slug", slug, "--apply"],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            # Echo just the patched-fields lines (not the whole scraped dict)
            for line in result.stdout.splitlines():
                if line.startswith("[apply]") or line.startswith("  -"):
                    print(f"  {line}")
            n_ok += 1
        else:
            print(f"  ⚠ scraper exited {result.returncode}")
            print(f"    stderr: {result.stderr.strip()[:400]}")
            n_fail += 1
        if i < len(todo):
            time.sleep(args.sleep)

    print(f"\n[APPLY] {n_ok} rescraped · {n_fail} failed")
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
