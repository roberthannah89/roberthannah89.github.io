#!/usr/bin/env python3
"""
Build a routed, elevation-tagged GPX (and a downsampled track.js) for one hike.

This is the consolidated "step 4 + elevation pass" of the hiking skill — it
replaces the prose recipe in topo-map-recipe.md with a single command.

What it does
------------
1. Resolve named endpoints (and optional intermediate waypoints) to OSM nodes
   via Overpass — or accept explicit lat/lon overrides.
2. Pull all walkable ways inside the bbox (cached on disk).
3. Build an undirected graph weighted by highway type and SAC scale.
4. Run Dijkstra start -> [via1 -> via2 -> ...] -> end, snapping each endpoint.
5. Fetch elevations: SwissTopo height API for points inside CH (accurate),
   batched Open-Elevation for points outside or as fallback.
6. Write `<out-dir>/<slug>.gpx` (full track) and `<out-dir>/<slug>.track.js`
   (downsampled with Douglas-Peucker to ~200 points; defines `window.TRACK`).

Usage
-----
    python build_hike_gpx.py \\
        --slug santis \\
        --peak Säntis \\
        --trailhead Wasserauen \\
        --via Seealpsee --via Meglisalp \\
        --bbox 47.22,9.28,47.30,9.45 \\
        --out-dir /opt/code/hikes

Caching
-------
Overpass responses are cached to ~/.cache/hiking-skill/overpass/ keyed by
SHA1 of the query. Re-runs and nearby peaks reuse cached tiles.

Attribution
-----------
- OSM ways: © OpenStreetMap contributors (ODbL)
- SwissTopo height: © swisstopo (CC BY 3.0)
- Open-Elevation: SRTM 30m, public domain
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from heapq import heappop, heappush
from pathlib import Path

# ---------------------------------------------------------------------------- #
# Constants
# ---------------------------------------------------------------------------- #

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
SWISSTOPO_HEIGHT = "https://api3.geo.admin.ch/rest/services/height"
OPEN_ELEVATION = "https://api.open-elevation.com/api/v1/lookup"
OPEN_TOPO_DATA = "https://api.opentopodata.org/v1/srtm30m"
UA = "hike-planner/1.0 (personal use)"

CACHE_DIR = Path.home() / ".cache" / "hiking-skill" / "overpass"

# Switzerland bbox — heuristic for "use SwissTopo height API"
CH_BBOX = (45.7, 5.8, 47.9, 10.6)

WALKABLE = {
    "path": 1.0, "footway": 1.0, "steps": 1.1, "track": 1.2, "bridleway": 1.1,
    "service": 1.5, "unclassified": 1.6, "residential": 1.6,
    "tertiary": 2.0, "secondary": 2.5,
}
SAC_PENALTY = {
    "hiking": 1.0,
    "mountain_hiking": 1.0,
    "demanding_mountain_hiking": 1.05,
    "alpine_hiking": 1.1,
    "demanding_alpine_hiking": 1.3,
    "difficult_alpine_hiking": 1.6,
}


# ---------------------------------------------------------------------------- #
# HTTP helpers
# ---------------------------------------------------------------------------- #

def http_get(url: str, data: bytes | None = None, headers: dict | None = None) -> bytes:
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def overpass(query: str) -> dict:
    """Run an Overpass query, with disk cache and mirror fallback."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(query.encode()).hexdigest()[:16]
    cached = CACHE_DIR / f"{key}.json"
    if cached.exists():
        return json.loads(cached.read_text())

    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(3):
        for mirror in OVERPASS_MIRRORS:
            try:
                raw = http_get(mirror, body)
                data = json.loads(raw)
                cached.write_bytes(raw)
                return data
            except Exception as ex:
                last = ex
                print(f"  overpass mirror {mirror} failed: {ex}", file=sys.stderr)
                continue
        print(f"  retrying overpass in {2**attempt}s...", file=sys.stderr)
        time.sleep(2 ** attempt)
    raise RuntimeError(f"overpass: all mirrors failed: {last}")


# ---------------------------------------------------------------------------- #
# Geo helpers
# ---------------------------------------------------------------------------- #

def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    R = 6371000
    la1, lo1 = math.radians(a[0]), math.radians(a[1])
    la2, lo2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = la2 - la1, lo2 - lo1
    h = math.sin(dlat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def in_ch(lat: float, lon: float) -> bool:
    s, w, n, e = CH_BBOX
    return s <= lat <= n and w <= lon <= e


def wgs84_to_lv95(lat: float, lon: float) -> tuple[float, float]:
    """Approximate WGS84 -> LV95 (Swiss CH1903+). Good to ~1m."""
    phi = (lat * 3600 - 169028.66) / 10000
    lam = (lon * 3600 - 26782.5) / 10000
    e = (
        2600072.37 + 211455.93 * lam
        - 10938.51 * lam * phi - 0.36 * lam * phi * phi
        - 44.54 * lam ** 3
    )
    n = (
        1200147.07 + 308807.95 * phi
        + 3745.25 * lam ** 2 + 76.63 * phi ** 2
        - 194.56 * lam ** 2 * phi + 119.79 * phi ** 3
    )
    return e, n


# ---------------------------------------------------------------------------- #
# OSM lookups
# ---------------------------------------------------------------------------- #

def find_node(query: str) -> tuple[float, float] | None:
    j = overpass(query)
    for el in j.get("elements", []):
        if el["type"] == "node":
            return el["lat"], el["lon"]
    # fall back: take centroid of first way/relation
    for el in j.get("elements", []):
        if "center" in el:
            return el["center"]["lat"], el["center"]["lon"]
    return None


def resolve_named_point(name: str, bbox: tuple[float, float, float, float]) -> tuple[float, float]:
    """Try several OSM tag patterns for a named point; raise if not found."""
    s, w, n, e = bbox
    bb = f"({s},{w},{n},{e})"
    queries = [
        # peaks first (most specific for hike summits)
        f'[out:json][timeout:60];node["natural"="peak"]["name"="{name}"]{bb};out;',
        # train / bus / cable car stations
        f'[out:json][timeout:60];node["railway"="station"]["name"="{name}"]{bb};out;',
        f'[out:json][timeout:60];node["public_transport"="station"]["name"="{name}"]{bb};out;',
        f'[out:json][timeout:60];node["aerialway"="station"]["name"~"{name}"]{bb};out;',
        # villages / hamlets
        f'[out:json][timeout:60];node["place"~"village|hamlet|town"]["name"="{name}"]{bb};out;',
        # lakes / huts / generic name match (with centroid fallback)
        f'[out:json][timeout:60];(node["name"="{name}"]{bb};way["name"="{name}"]{bb};);out center;',
    ]
    for q in queries:
        pt = find_node(q)
        if pt:
            return pt
    raise SystemExit(f"OSM: could not resolve '{name}' inside bbox {bbox}")


def fetch_walkable_ways(bbox):
    s, w, n, e = bbox
    q = f"""
    [out:json][timeout:120];
    (
      way["highway"~"^(path|footway|steps|track|bridleway|service|unclassified|residential|tertiary|secondary)$"]
        ({s},{w},{n},{e});
    );
    (._;>;);
    out;
    """
    return overpass(q)


# ---------------------------------------------------------------------------- #
# Graph + routing
# ---------------------------------------------------------------------------- #

def build_graph(osm: dict):
    nodes = {el["id"]: (el["lat"], el["lon"]) for el in osm["elements"] if el["type"] == "node"}
    adj = defaultdict(list)
    for el in osm["elements"]:
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        hw = tags.get("highway")
        if hw not in WALKABLE:
            continue
        sac = tags.get("sac_scale", "hiking")
        sac_pen = SAC_PENALTY.get(sac, 1.5)
        hw_mult = WALKABLE[hw]
        ids = el["nodes"]
        for a, b in zip(ids, ids[1:]):
            if a not in nodes or b not in nodes:
                continue
            d = haversine(nodes[a], nodes[b])
            w = d * hw_mult * sac_pen
            adj[a].append((b, w))
            adj[b].append((a, w))
    return nodes, adj


def snap(nodes: dict, target: tuple[float, float]) -> tuple[int, float]:
    best_id, best_d = None, float("inf")
    for nid, ll in nodes.items():
        d = haversine(ll, target)
        if d < best_d:
            best_d, best_id = d, nid
    return best_id, best_d


def dijkstra(adj, start: int, goal: int) -> list[int]:
    dist = {start: 0.0}
    prev: dict[int, int] = {}
    pq = [(0.0, start)]
    while pq:
        du, u = heappop(pq)
        if u == goal:
            break
        if du > dist.get(u, float("inf")):
            continue
        for v, w in adj[u]:
            nd = du + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = u
                heappush(pq, (nd, v))
    if goal != start and goal not in prev:
        raise RuntimeError("no path between snapped endpoints")
    path = [goal]
    while path[-1] != start:
        path.append(prev[path[-1]])
    return list(reversed(path))


def route_through(adj, nodes, ordered_target_ids: list[int]) -> list[int]:
    """Concatenate Dijkstra legs through a sequence of node IDs."""
    full: list[int] = []
    for a, b in zip(ordered_target_ids, ordered_target_ids[1:]):
        leg = dijkstra(adj, a, b)
        if full:
            full.extend(leg[1:])
        else:
            full.extend(leg)
    return full


# ---------------------------------------------------------------------------- #
# Elevation
# ---------------------------------------------------------------------------- #

def elev_swisstopo(lat: float, lon: float) -> float | None:
    e, n = wgs84_to_lv95(lat, lon)
    url = f"{SWISSTOPO_HEIGHT}?easting={e:.2f}&northing={n:.2f}"
    try:
        return float(json.loads(http_get(url))["height"])
    except Exception:
        return None


def elev_open_elevation_batch(points: list[tuple[float, float]]) -> list[float | None]:
    """Batch Open-Elevation lookup; falls back to OpenTopoData on 5xx."""
    results: list[float | None] = []
    for i in range(0, len(points), 100):
        chunk = points[i:i + 100]
        body = json.dumps({
            "locations": [{"latitude": p[0], "longitude": p[1]} for p in chunk]
        }).encode()
        url = OPEN_ELEVATION
        for attempt in range(3):
            try:
                raw = http_get(url, data=body, headers={"Content-Type": "application/json"})
                data = json.loads(raw)
                results.extend(float(r["elevation"]) for r in data["results"])
                break
            except Exception as ex:
                print(f"  open-elevation batch {i}: {ex}", file=sys.stderr)
                if attempt == 1:
                    # switch to OpenTopoData as fallback (same JSON shape)
                    url = OPEN_TOPO_DATA
                time.sleep(2 ** attempt)
        else:
            results.extend([None] * len(chunk))
    return results


def attach_elevations(track: list[tuple[float, float]], use_swisstopo: bool) -> list[tuple[float, float, float | None]]:
    """For dense tracks: query elevations efficiently. SwissTopo is one-at-a-time
    and slow, so use it only for points actually inside CH. Outside CH or as
    fallback, use batched Open-Elevation."""
    if use_swisstopo:
        ch_idx = [i for i, (la, lo) in enumerate(track) if in_ch(la, lo)]
        out_idx = [i for i in range(len(track)) if i not in set(ch_idx)]
        eles: list[float | None] = [None] * len(track)
        for k, i in enumerate(ch_idx):
            la, lo = track[i]
            eles[i] = elev_swisstopo(la, lo)
            if k % 50 == 0:
                print(f"  swisstopo {k}/{len(ch_idx)}", flush=True)
            time.sleep(0.03)
        if out_idx:
            outside = [track[i] for i in out_idx]
            for i, e in zip(out_idx, elev_open_elevation_batch(outside)):
                eles[i] = e
    else:
        eles = elev_open_elevation_batch(track)
    return [(la, lo, e) for (la, lo), e in zip(track, eles)]


# ---------------------------------------------------------------------------- #
# Douglas-Peucker downsample
# ---------------------------------------------------------------------------- #

def _perp_distance_m(p, a, b) -> float:
    """Perpendicular distance from p to segment a-b, in meters (lat/lon)."""
    if a == b:
        return haversine((p[0], p[1]), (a[0], a[1]))
    # project in degrees, scale by haversine ratio at midpoint
    ax, ay = a[1], a[0]
    bx, by = b[1], b[0]
    px, py = p[1], p[0]
    dx, dy = bx - ax, by - ay
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return haversine((p[0], p[1]), (cy, cx))


def douglas_peucker(track: list[tuple[float, float, float | None]], epsilon_m: float = 8.0) -> list:
    if len(track) < 3:
        return list(track)
    keep = [False] * len(track)
    keep[0] = keep[-1] = True
    stack = [(0, len(track) - 1)]
    while stack:
        i0, i1 = stack.pop()
        max_d, max_i = 0.0, -1
        a, b = track[i0], track[i1]
        for k in range(i0 + 1, i1):
            d = _perp_distance_m(track[k], a, b)
            if d > max_d:
                max_d, max_i = d, k
        if max_d > epsilon_m and max_i != -1:
            keep[max_i] = True
            stack.append((i0, max_i))
            stack.append((max_i, i1))
    return [track[i] for i, k in enumerate(keep) if k]


def downsample_to(track: list, target: int) -> list:
    """Tune DP epsilon to land near `target` points."""
    if len(track) <= target:
        return track
    lo, hi = 1.0, 200.0
    out = track
    for _ in range(20):
        eps = (lo + hi) / 2
        out = douglas_peucker(track, eps)
        if len(out) > target * 1.1:
            lo = eps
        elif len(out) < target * 0.9:
            hi = eps
        else:
            break
    return out


# ---------------------------------------------------------------------------- #
# Output
# ---------------------------------------------------------------------------- #

def write_gpx(track, waypoints, path: Path, name: str):
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="hike-planner" xmlns="http://www.topografix.com/GPX/1/1">',
        f"  <metadata><name>{name}</name>",
        "    <desc>Routed from OSM (ODbL); elevations from SwissTopo / Open-Elevation</desc>",
        "  </metadata>",
    ]
    for lat, lon, ele, wp_name in waypoints:
        parts.append(f'  <wpt lat="{lat:.6f}" lon="{lon:.6f}">')
        if ele is not None:
            parts.append(f"    <ele>{ele:.1f}</ele>")
        parts.append(f"    <name>{wp_name}</name>")
        parts.append("  </wpt>")
    parts += ["  <trk>", f"    <name>{name}</name>", "    <trkseg>"]
    for lat, lon, ele in track:
        parts.append(f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}">')
        if ele is not None:
            parts.append(f"        <ele>{ele:.1f}</ele>")
        parts.append("      </trkpt>")
    parts += ["    </trkseg>", "  </trk>", "</gpx>", ""]
    path.write_text("\n".join(parts))


def write_track_js(track, full_count: int, path: Path):
    """Emit a small JS file the hike page loads via <script src="...">.
    Avoids file:// CORS issues with fetch()."""
    rows = ",\n".join(
        f"[{la:.6f},{lo:.6f},{int(round(el)) if el is not None else 'null'}]"
        for la, lo, el in track
    )
    js = (
        "// Auto-generated by build_hike_gpx.py\n"
        "// © OpenStreetMap contributors (ODbL); elevations © swisstopo / Open-Elevation\n"
        f"window.TRACK_FULL_COUNT = {full_count};\n"
        f"window.TRACK = [\n{rows}\n];\n"
    )
    path.write_text(js)


# ---------------------------------------------------------------------------- #
# Main
# ---------------------------------------------------------------------------- #

def parse_bbox(s: str) -> tuple[float, float, float, float]:
    parts = [float(x) for x in s.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("bbox must be: south,west,north,east")
    return tuple(parts)  # type: ignore


def parse_latlon(s: str) -> tuple[float, float]:
    a, b = s.split(",")
    return float(a), float(b)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", required=True, help="output filename stem, e.g. 'santis'")
    ap.add_argument("--peak", required=True, help="peak/summit name as in OSM")
    ap.add_argument("--trailhead", required=True, help="trailhead name as in OSM (station/village/...)")
    ap.add_argument("--via", action="append", default=[], help="ordered intermediate waypoint name(s) BEFORE the peak")
    ap.add_argument("--descend-via", action="append", default=[], help="ordered intermediate waypoint name(s) AFTER the peak (descent)")
    ap.add_argument("--end", help="optional descent endpoint name (default: same as trailhead)")
    ap.add_argument("--peak-ll", type=parse_latlon, help="override peak lat,lon")
    ap.add_argument("--trailhead-ll", type=parse_latlon, help="override trailhead lat,lon")
    ap.add_argument("--end-ll", type=parse_latlon, help="override end lat,lon")
    ap.add_argument("--bbox", type=parse_bbox, default=None,
                    help="south,west,north,east. Omit when --peak-ll and --trailhead-ll are both given "
                         "(auto-computed with ±0.05° padding).")
    ap.add_argument("--out-dir", required=True, type=Path)
    ap.add_argument("--track-points", type=int, default=200, help="downsampled point target for track.js")
    ap.add_argument("--elev-points", type=int, default=400, help="elevation lookup point target")
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)

    # Auto-compute bbox from explicit coords when not supplied.
    if args.bbox is None:
        if args.peak_ll and args.trailhead_ll:
            PAD = 0.05
            lats = [args.peak_ll[0], args.trailhead_ll[0]]
            lons = [args.peak_ll[1], args.trailhead_ll[1]]
            args.bbox = (min(lats) - PAD, min(lons) - PAD, max(lats) + PAD, max(lons) + PAD)
            print(f"  auto-bbox from coordinates: {args.bbox[0]:.3f},{args.bbox[1]:.3f},{args.bbox[2]:.3f},{args.bbox[3]:.3f}")
        else:
            print("ERROR: --bbox is required unless both --peak-ll and --trailhead-ll are provided.",
                  file=sys.stderr)
            sys.exit(1)

    print("[1/6] resolving endpoints in OSM...", flush=True)
    trailhead_ll = args.trailhead_ll or resolve_named_point(args.trailhead, args.bbox)
    peak_ll = args.peak_ll or resolve_named_point(args.peak, args.bbox)
    via_lls = [resolve_named_point(v, args.bbox) for v in args.via]
    descend_lls = [resolve_named_point(v, args.bbox) for v in args.descend_via]
    end_ll = None
    if args.end or args.end_ll:
        end_ll = args.end_ll or resolve_named_point(args.end, args.bbox)
    print(f"  trailhead {args.trailhead}: {trailhead_ll}")
    for name, ll in zip(args.via, via_lls):
        print(f"  via {name}: {ll}")
    print(f"  peak {args.peak}: {peak_ll}")
    for name, ll in zip(args.descend_via, descend_lls):
        print(f"  descend via {name}: {ll}")
    if end_ll:
        print(f"  end {args.end}: {end_ll}")

    print("[2/6] fetching walkable ways (cached)...", flush=True)
    osm = fetch_walkable_ways(args.bbox)
    print(f"  {len(osm['elements'])} elements")

    print("[3/6] building graph...", flush=True)
    nodes, adj = build_graph(osm)
    print(f"  {len(nodes)} nodes, {sum(len(v) for v in adj.values())//2} edges")

    print("[4/6] snapping + Dijkstra...", flush=True)
    targets = [trailhead_ll, *via_lls, peak_ll, *descend_lls]
    if end_ll:
        targets.append(end_ll)
    target_names = [args.trailhead, *args.via, args.peak, *args.descend_via]
    if end_ll:
        target_names.append(args.end or "End")
    snapped = []
    for ll in targets:
        nid, d = snap(nodes, ll)
        snapped.append(nid)
        print(f"  snapped {ll} -> {d:.1f} m")
    path_ids = route_through(adj, nodes, snapped)
    raw_track = [nodes[nid] for nid in path_ids]
    total_m = sum(haversine(raw_track[i], raw_track[i+1]) for i in range(len(raw_track)-1))
    print(f"  {len(raw_track)} points, {total_m/1000:.2f} km")

    print(f"[5/6] elevations ({args.elev_points} samples)...", flush=True)
    if len(raw_track) > args.elev_points:
        step = len(raw_track) / args.elev_points
        sampled = [raw_track[int(i * step)] for i in range(args.elev_points)]
    else:
        sampled = raw_track
    use_swisstopo = all(in_ch(la, lo) for la, lo in sampled[::20])
    enriched = attach_elevations(sampled, use_swisstopo=use_swisstopo)
    n_with_ele = sum(1 for _, _, e in enriched if e is not None)
    print(f"  got elevation for {n_with_ele}/{len(enriched)} points "
          f"(swisstopo={use_swisstopo})")

    # Build named waypoints — snap each requested name to its nearest enriched point
    def nearest_enriched(target):
        return min(enriched, key=lambda p: haversine((p[0], p[1]), target))

    waypoints = [(*nearest_enriched(trailhead_ll), args.trailhead)]
    for name, ll in zip(args.via, via_lls):
        waypoints.append((*nearest_enriched(ll), name))
    waypoints.append((*nearest_enriched(peak_ll), args.peak))
    for name, ll in zip(args.descend_via, descend_lls):
        waypoints.append((*nearest_enriched(ll), name))
    if end_ll:
        waypoints.append((*nearest_enriched(end_ll), args.end or "End"))

    gpx_path = args.out_dir / f"{args.slug}.gpx"
    write_gpx(enriched, waypoints, gpx_path, name=f"{args.trailhead} -> {args.peak}")
    print(f"  wrote {gpx_path} ({len(enriched)} pts)")

    print(f"[6/6] downsampling to ~{args.track_points} points for HTML...", flush=True)
    small = downsample_to(enriched, args.track_points)
    track_js_path = args.out_dir / f"{args.slug}.track.js"
    write_track_js(small, full_count=len(enriched), path=track_js_path)
    print(f"  wrote {track_js_path} ({len(small)} pts, {track_js_path.stat().st_size//1024} KB)")

    print("\nDone.")
    print(f"  GPX:      {gpx_path}")
    print(f"  Track JS: {track_js_path}")
    print(f"  Distance: {total_m/1000:.2f} km")


if __name__ == "__main__":
    main()
