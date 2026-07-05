"""Backfill photographer credit + route author on SAC hikes that pre-date the
credit-capture landing in ``scrape_sac_route_page.py``.

Walks ``routes/*/*.data.json``, finds hikes whose photos reference SAC's
``sac-cas.ch/processed/`` CDN but lack the ``copyright`` field, and re-scrapes
each via the SAC route URL in its ``sources``. The scraper's apply function
merges credit/date/caption into existing photos by URL match, so manual
curation of the photo list is preserved.

Uses the saved cookie at ``~/.config/sac-hikes/cookie``.

CLI:
    python scripts/backfill_sac_credits.py                  # dry run — list only
    python scripts/backfill_sac_credits.py --apply          # fetch + patch
    python scripts/backfill_sac_credits.py --apply --sleep 1.5
    python scripts/backfill_sac_credits.py --apply --limit 5
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_sac_route import _load_cookie  # noqa: E402
from scrape_sac_route_page import (  # noqa: E402
    PaywallError,
    fetch_html,
    patch_data_json,
    scrape,
)

REPO_HIKES = Path(__file__).resolve().parent.parent
ROUTES_DIR = REPO_HIKES / "routes"


def hikes_needing_credits() -> list[tuple[Path, str]]:
    """Return [(data_path, sac_route_url)] for SAC hikes missing photo credit."""
    todo: list[tuple[Path, str]] = []
    for data_path in sorted(ROUTES_DIR.glob("*/*.data.json")):
        d = json.loads(data_path.read_text(encoding="utf-8"))
        photos = d.get("photos") or []
        sac_photos = [p for p in photos if "sac-cas.ch/processed/" in (p.get("url") or "")]
        if not sac_photos:
            continue
        if all(p.get("copyright") for p in sac_photos):
            continue
        # Pick the first source URL that looks like a SAC route page (has a
        # numeric route slug segment; peak pages end at .../mountain-hiking/).
        route_url = ""
        for s in d.get("sources") or []:
            url = (s or {}).get("url", "")
            if "sac-cas.ch" in url and "sac-route-portal" in url:
                # Route pages have >= 8 path segments; peak pages have 7.
                if url.rstrip("/").count("/") >= 8:
                    route_url = url
                    break
        if not route_url:
            print(f"  (skip {data_path.parent.name}: no SAC route URL in sources)", file=sys.stderr)
            continue
        todo.append((data_path, route_url))
    return todo


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true",
                    help="Actually fetch + patch (default: dry run — list only)")
    ap.add_argument("--sleep", type=float, default=1.0,
                    help="Seconds to wait between SAC requests (default: 1.0)")
    ap.add_argument("--limit", type=int, default=0,
                    help="Stop after N hikes (0 = no limit)")
    ap.add_argument("--cookie-file", type=Path, default=None)
    args = ap.parse_args()

    todo = hikes_needing_credits()
    if args.limit:
        todo = todo[:args.limit]

    print(f"{len(todo)} hikes to backfill:")
    for data_path, url in todo:
        print(f"  {data_path.parent.name:38s} {url}")

    if not args.apply:
        print("\n(dry run — pass --apply to actually fetch + patch)")
        return 0

    cookie = _load_cookie("SAC_COOKIE", args.cookie_file)
    ok = fail = 0
    for i, (data_path, url) in enumerate(todo, start=1):
        slug = data_path.parent.name
        print(f"[{i}/{len(todo)}] {slug} …", end=" ", flush=True)
        try:
            html = fetch_html(url, cookie)
            sr = scrape(html)
            changed = patch_data_json(data_path, sr, replace_todo_only=True)
        except PaywallError as e:
            print(f"PAYWALL — {e}")
            fail += 1
            break  # Cookie is dead; no point continuing.
        except Exception as e:  # noqa: BLE001 — surface any failure per-hike
            print(f"FAIL — {e}")
            fail += 1
            continue
        credit_fields = [c for c in changed if c in ("photos", "photos_attrib_html", "route_author")]
        print("ok" if credit_fields else "no change", f"({', '.join(changed) or 'nothing'})")
        ok += 1
        if i < len(todo):
            time.sleep(args.sleep)

    print(f"\ndone: {ok} succeeded, {fail} failed")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
