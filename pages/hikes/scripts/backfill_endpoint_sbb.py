"""Backfill end_point.sbb_url for hikes that have end_point but no sbb_url.

The transit widget's Return card queries transport.opendata.ch with
``end_point.sbb_url``'s ``?nach=`` param when present, and falls back to
``end_point.name`` otherwise. Display names like "Habergschwänd, Bergstation"
or "Ober Musenalp" aren't in SBB's timetable system, so the fallback returns
0 connections and the Return card shows "No connections" even when the
station is obviously served.

Two source strategies, tried in order per hike:

1. **SAC v1 route JSON** (``sac-route-<ID>.json``, pre-cutover captures).
   ``all_additional_informations[1].publicTransport.timetableLink`` holds the
   arrival-side SBB link SAC's editors curated. Human-verified and preferred
   whenever present.

2. **Nearest-station lookup on end coordinates.** Uses the same free
   opendata.ch endpoint the widget itself queries. The end coords come from
   ``end_point.lat/lon`` when set, otherwise from the last GPX track point
   (point-to-point hikes end where the GPX ends by definition).

When ``end_point`` lacks lat/lon, the fallback also fills those in from the
GPX so the data is complete for future use (e.g. Google Maps directions to
the end point).

CLI:
    python scripts/backfill_endpoint_sbb.py           # dry run
    python scripts/backfill_endpoint_sbb.py --write   # commit changes
    python scripts/backfill_endpoint_sbb.py --slug fronalpstock-gl --write
"""
from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nearest_sbb_station import nearest_station, sbb_deep_link  # noqa: E402

REPO_HIKES = Path(__file__).resolve().parent.parent
ROUTES_DIR = REPO_HIKES / "routes"
GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}


def gpx_last_point(gpx_path: Path) -> tuple[float, float] | None:
    """(lat, lon) of the final ``<trkpt>`` in a GPX file, or None."""
    try:
        tree = ET.parse(gpx_path)
    except (ET.ParseError, FileNotFoundError):
        return None
    pts = tree.getroot().findall(".//g:trkpt", GPX_NS)
    if not pts:
        return None
    last = pts[-1]
    try:
        return float(last.get("lat")), float(last.get("lon"))
    except (TypeError, ValueError):
        return None


def sac_arrival_sbb_from_v1(route_dir: Path) -> str | None:
    """Return the second SBB timetable link from a SAC v1 capture.

    v1 captures store per-section transport info as
    ``all_additional_informations[i].publicTransport.timetableLink`` — index 0
    is the departure, index 1 (when present) is the arrival for point-to-point
    routes.
    """
    v1_jsons = sorted(route_dir.glob("sac-route-*.json"))
    if not v1_jsons:
        return None
    try:
        raw = json.loads(v1_jsons[0].read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    sections = raw.get("all_additional_informations") or []
    for section in sections[1:]:
        pt = (section or {}).get("publicTransport") or {}
        link = pt.get("timetableLink")
        if isinstance(link, str) and "fahrplan.xhtml" in link:
            return link
    return None


def process_hike(data_path: Path, *, write: bool) -> tuple[str, str]:
    """Return (status, detail). status ∈ {'ok-sac','ok-nearest','skip','fail'}."""
    slug = data_path.parent.name
    data = json.loads(data_path.read_text(encoding="utf-8"))
    ep = data.get("end_point")
    if ep is None:
        return "skip", "out-and-back (no end_point)"
    if ep.get("sbb_url"):
        return "skip", "already has sbb_url"

    # Strategy 1: SAC-authoritative arrival link from v1 capture
    sac_link = sac_arrival_sbb_from_v1(data_path.parent)
    if sac_link:
        ep["sbb_url"] = sac_link
        data["end_point"] = ep
        if write:
            data_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        return "ok-sac", f"→ {sac_link.rsplit('=', 1)[-1]} (SAC v1 capture)"

    # Strategy 2: nearest-station on end coordinates
    lat, lon = ep.get("lat"), ep.get("lon")
    filled_coords = False
    if lat is None or lon is None:
        gpx = data_path.parent / f"{slug}.gpx"
        coords = gpx_last_point(gpx)
        if coords is None:
            return "fail", f"no lat/lon and can't read {gpx.name}"
        lat, lon = coords
        filled_coords = True

    station = nearest_station(lat, lon)
    if not station:
        return "fail", f"nearest_station({lat:.5f},{lon:.5f}) returned nothing"

    if filled_coords:
        ep["lat"] = lat
        ep["lon"] = lon
    ep["sbb_url"] = sbb_deep_link(station)
    data["end_point"] = ep

    if write:
        data_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    coord_note = " +coords" if filled_coords else ""
    return "ok-nearest", f"→ {station!r}  ({lat:.4f},{lon:.4f}){coord_note}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write", action="store_true",
                    help="Write changes to data.json (default: dry run)")
    ap.add_argument("--slug", help="Process only this slug (default: all)")
    args = ap.parse_args()

    data_paths = sorted(ROUTES_DIR.glob("*/*.data.json"))
    if args.slug:
        data_paths = [p for p in data_paths if p.parent.name == args.slug]
        if not data_paths:
            print(f"No hike with slug {args.slug!r}", file=sys.stderr)
            return 2

    counts = {"ok-sac": 0, "ok-nearest": 0, "skip": 0, "fail": 0}
    for path in data_paths:
        slug = path.parent.name
        status, detail = process_hike(path, write=args.write)
        counts[status] += 1
        if status == "ok-sac":
            print(f"  ✓ {slug:38s} {detail}")
        elif status == "ok-nearest":
            print(f"  ~ {slug:38s} {detail}")
        elif status == "fail":
            print(f"  ⚠ {slug:38s} {detail}")

    mode = "WRITE" if args.write else "DRY RUN"
    print(
        f"\n[{mode}] SAC-authoritative: {counts['ok-sac']}"
        f" · nearest-station: {counts['ok-nearest']}"
        f" · skipped: {counts['skip']}"
        f" · failed: {counts['fail']}"
    )
    return 0 if counts["fail"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
