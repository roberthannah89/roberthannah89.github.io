"""Validate that every hike's SBB station names resolve on opendata.ch.

For each hike, this pulls the ``?nach=<Station>`` param out of
``trailhead.sbb_url`` and ``end_point.sbb_url`` and asks the
``transport.opendata.ch/v1/connections`` endpoint whether it can plan
*any* trip from Zürich HB to that station. That's the same endpoint the
transit widget hits, so a pass here means "the widget will actually find
connections" — not just "there's a plausibly-named stop nearby."

Fast: one API call per *unique station name*, not per hike (many hikes
share stations like "Kemmeriboden" or "Zermatt"). Results are cached to
``pages/hikes/scripts/.sbb-stations-cache.json`` (ignored by git) so
subsequent runs are near-instant — only new/changed stations hit the
API. Uncached: ~1 min for 100 stations at 0.6s pacing.

Chose ``/v1/connections`` over ``/v1/locations`` after finding that the
locations endpoint is stricter than the widget's actual query — SAC-
provided names like "Gamplüt", "Isenthal, Post", and "Schwändi b.
Schwanden GL, Post" all fail a strict station-name lookup but succeed
as connection endpoints (opendata.ch fuzzy-aliases stop names in the
routing engine). The widget uses connections, so we should too.

CLI:
    python scripts/check_sbb_stations.py            # audit all hikes
    python scripts/check_sbb_stations.py --slug X   # audit one
    python scripts/check_sbb_stations.py --clear-cache  # force re-query

Exit code is nonzero when any station fails to resolve, so this fits
into pre-commit or CI.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO_HIKES = Path(__file__).resolve().parent.parent
ROUTES_DIR = REPO_HIKES / "routes"
CACHE_PATH = Path(__file__).resolve().parent / ".sbb-stations-cache.json"

API = "https://transport.opendata.ch/v1/connections"
CHECK_ORIGIN = "Zürich HB"    # arbitrary hub — any origin the widget also uses
USER_AGENT = "hiking-site sbb-station-check"
SLEEP_BETWEEN = 1.5           # /v1/connections is rate-limited tighter than /locations
TIMEOUT_S = 45                # some obscure stops (Kleiner Gumen) need 20-30s to resolve


def station_from_sbb_url(url):
    if not url:
        return None
    m = re.search(r"[?&]nach=([^&]+)", url)
    if not m:
        return None
    try:
        return urllib.parse.unquote_plus(m.group(1)).strip() or None
    except Exception:
        return None


def load_cache():
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_cache(cache):
    CACHE_PATH.write_text(
        json.dumps(cache, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def resolve_station(name, cache):
    """Return (status, resolved_name).

    status ∈ {"ok", "notfound", "error"}. resolved_name is the API's
    matched station name (may differ from the query, e.g. "Isenthal,
    Post" → "Isenthal, Untergässli 4") or None on failure.

    We call ``/v1/connections`` from CHECK_ORIGIN to the queried station
    with limit=1: if it comes back with at least one connection and a
    resolved-to name, the station is real and reachable — exactly what
    the transit widget cares about.
    """
    if name in cache:
        entry = cache[name]
        return entry["status"], entry.get("resolved")

    qs = urllib.parse.urlencode({"from": CHECK_ORIGIN, "to": name, "limit": 1})
    req = urllib.request.Request(
        f"{API}?{qs}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            data = json.load(r)
    except Exception:
        return "error", None
    time.sleep(SLEEP_BETWEEN)

    conns = data.get("connections") or []
    resolved_to = (data.get("to") or {}).get("name")

    # Rate-limit signature: empty connections AND no resolved to-name.
    # Do NOT cache — caller will retry next run when budget refreshes.
    if not conns and not resolved_to:
        return "error", None

    # We got a routable target back: the widget will find connections
    # here. Even if the resolved name differs from what SAC/we wrote,
    # that's fine — the API is doing its own alias resolution.
    if resolved_to and conns:
        cache[name] = {"status": "ok", "resolved": resolved_to}
        return "ok", resolved_to

    # API knows the name but couldn't route from Zürich HB on this
    # timetable — genuinely unreachable, or the station only serves a
    # regional feeder we haven't picked. Record as notfound.
    cache[name] = {
        "status": "notfound",
        "resolved": resolved_to,
        "nearest": resolved_to,
    }
    return "notfound", None


def collect_stations(paths):
    """Return {station_name: [(slug, side)]} — side ∈ {"trailhead","end_point"}."""
    by_station = {}
    for p in paths:
        d = json.loads(p.read_text(encoding="utf-8"))
        slug = p.parent.name
        for side in ("trailhead", "end_point"):
            obj = d.get(side) or {}
            name = station_from_sbb_url(obj.get("sbb_url"))
            if name:
                by_station.setdefault(name, []).append((slug, side))
    return by_station


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--slug", help="Audit a single slug (default: all).")
    ap.add_argument("--clear-cache", action="store_true",
                    help="Delete the cache before running (forces fresh API queries).")
    args = ap.parse_args()

    if args.clear_cache and CACHE_PATH.exists():
        CACHE_PATH.unlink()
        print(f"[cache] cleared {CACHE_PATH.name}")

    paths = sorted(ROUTES_DIR.glob("*/*.data.json"))
    if args.slug:
        paths = [p for p in paths if p.parent.name == args.slug]
        if not paths:
            print(f"No hike with slug {args.slug!r}", file=sys.stderr)
            return 2

    by_station = collect_stations(paths)
    cache = load_cache()
    n_cached_hit = 0
    n_queried = 0

    print(f"Auditing {len(by_station)} unique station names across {len(paths)} hikes…\n")

    results = {}  # station → (status, resolved)
    for name in sorted(by_station):
        was_cached = name in cache
        status, resolved = resolve_station(name, cache)
        if was_cached:
            n_cached_hit += 1
        else:
            n_queried += 1
        results[name] = (status, resolved)

    save_cache(cache)

    fails = []
    ok = 0
    for name, (status, resolved) in sorted(results.items()):
        icon = "✓" if status == "ok" else ("?" if status == "error" else "✗")
        detail = f"→ {resolved}" if resolved and resolved.lower() != name.lower() else ""
        hikes = ", ".join(f"{s}({side})" for s, side in by_station[name][:3])
        if len(by_station[name]) > 3:
            hikes += f", +{len(by_station[name]) - 3} more"
        print(f"  {icon} {name:38s} {detail:32s} [{hikes}]")
        if status == "ok":
            ok += 1
        else:
            fails.append((name, status, cache.get(name, {}).get("nearest")))

    print(f"\n{ok}/{len(results)} stations resolve on SBB "
          f"(cache: {n_cached_hit} hit, {n_queried} queried)")
    if fails:
        print("\nBroken stations — the transit widget's API queries will return 0 connections:")
        for name, status, nearest in fails:
            hikes = ", ".join(f"{s}({side})" for s, side in by_station[name])
            near = f" (nearest: {nearest!r})" if nearest else ""
            print(f"  {status:8s} {name!r}{near}")
            print(f"    used by: {hikes}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
