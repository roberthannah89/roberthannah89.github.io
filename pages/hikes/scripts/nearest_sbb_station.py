"""Find the nearest SBB station to a lat/lon.

Wraps transport.opendata.ch's ``/locations?y=<lat>&x=<lon>&type=station`` endpoint
(a free wrapper around SBB / search.ch that the transit widget also uses).
Returns the closest station's name, which can then be dropped into the
legacy timetable deep-link ``?nach=<name>``.

Used as an automatic fallback in the SAC add-hike pipeline for trailheads
whose SAC route page doesn't include a machine-readable SBB link — hut
approaches, cable-car summit stations, and other non-standard trailheads.
The nearest actual station is a much better user-facing default than the
raw trailhead name (which fuzzy-matches to random towns abroad on SBB).

CLI:
    python scripts/nearest_sbb_station.py 46.82 8.88
    → Linthal

Programmatic:
    from nearest_sbb_station import nearest_station
    name = nearest_station(46.82, 8.88)
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request

API = "https://transport.opendata.ch/v1/locations"
USER_AGENT = "hiking-site nearest-sbb-station lookup"
TIMEOUT_S = 15


def nearest_station(lat: float, lon: float) -> str | None:
    """Return the name of the SBB station closest to (lat, lon), or None on
    empty response. The API orders results by distance ascending, so we just
    take the first one.
    """
    qs = urllib.parse.urlencode({"y": lat, "x": lon, "type": "station"})
    req = urllib.request.Request(
        f"{API}?{qs}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    stations = data.get("stations") or []
    for s in stations:
        coord = s.get("coordinate") or {}
        # Skip results without coordinates — those are address-only matches,
        # not real stations, and would just be the trailhead name echoed back.
        if coord.get("x") is None or coord.get("y") is None:
            continue
        name = (s.get("name") or "").strip()
        if name:
            return name
    return None


def sbb_deep_link(station_name: str) -> str:
    """Build the same SBB legacy-timetable URL that SAC route pages emit."""
    qs = urllib.parse.urlencode({"language": "en", "von": "", "nach": station_name})
    return f"https://www.sbb.ch/en/buying/pages/fahrplan/fahrplan.xhtml?{qs}"


def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    if len(argv) != 2:
        print("Usage: nearest_sbb_station.py <lat> <lon>", file=sys.stderr)
        return 2
    try:
        lat, lon = float(argv[0]), float(argv[1])
    except ValueError:
        print("lat and lon must be numeric", file=sys.stderr)
        return 2
    name = nearest_station(lat, lon)
    if not name:
        print("(no station found)", file=sys.stderr)
        return 1
    print(name)
    print(sbb_deep_link(name), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
