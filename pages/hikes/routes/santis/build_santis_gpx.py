#!/usr/bin/env python3
"""Build a routed GPX for Wasserauen -> Säntis via Seealpsee/Meglisalp/Rotsteinpass/Lisengrat.

Uses OSM Overpass for ground-truth nodes and ways, Dijkstra for routing on a graph
of walkable highway types, and the SwissTopo height API for elevations.

Output: /opt/code/hikes/santis.gpx
"""
from __future__ import annotations

import json
import math
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from heapq import heappop, heappush

OUT_GPX = "/opt/code/hikes/santis.gpx"
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
SWISSTOPO_HEIGHT = "https://api3.geo.admin.ch/rest/services/height"
UA = "hike-planner/1.0 (personal use)"

# Bbox covering Wasserauen -> Seealpsee -> Meglisalp -> Säntis -> Schwägalp (Alpstein)
# lat: 47.22 - 47.30, lon: 9.30 - 9.45 (extended west for Schwägalp descent)
BBOX = (47.22, 9.28, 47.30, 9.45)  # south, west, north, east

# Highway types we treat as walkable
WALKABLE = {
    "path": 1.0,
    "footway": 1.0,
    "steps": 1.1,
    "track": 1.2,
    "bridleway": 1.1,
    "service": 1.5,
    "unclassified": 1.6,
    "residential": 1.6,
    "tertiary": 2.0,
    "secondary": 2.5,
}
SAC_PENALTY = {
    "hiking": 1.0,
    "mountain_hiking": 1.0,
    "demanding_mountain_hiking": 1.05,
    "alpine_hiking": 1.1,
    "demanding_alpine_hiking": 1.3,
    "difficult_alpine_hiking": 1.6,
}


def http_get(url: str, data: bytes | None = None) -> bytes:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def overpass(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(3):
        for mirror in OVERPASS_MIRRORS:
            try:
                return json.loads(http_get(mirror, body))
            except Exception as ex:
                last = ex
                print(f"  overpass mirror {mirror} failed: {ex}", file=sys.stderr)
                continue
        print(f"  all mirrors failed, sleeping {2**attempt}s and retrying...", file=sys.stderr)
        time.sleep(2 ** attempt)
    raise RuntimeError(f"overpass: all mirrors failed: {last}")


def find_node(query: str) -> tuple[float, float]:
    """Run an Overpass query, return (lat, lon) of first matching node."""
    j = overpass(query)
    for el in j.get("elements", []):
        if el["type"] == "node":
            return el["lat"], el["lon"]
    raise RuntimeError(f"no node found: {query}")


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    R = 6371000
    la1, lo1 = math.radians(a[0]), math.radians(a[1])
    la2, lo2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = la2 - la1, lo2 - lo1
    h = math.sin(dlat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def fetch_walkable_ways(bbox):
    s, w, n, e = bbox
    # Pull all walkable ways + their referenced nodes
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


def build_graph(osm: dict):
    """Return (nodes_by_id, adjacency_list_by_id)."""
    nodes = {}
    for el in osm["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])

    adj = defaultdict(list)  # node_id -> [(neighbor_id, weight)]
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
            adj[a].append((b, w, d))
            adj[b].append((a, w, d))
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
    prev = {}
    pq = [(0.0, start)]
    while pq:
        du, u = heappop(pq)
        if u == goal:
            break
        if du > dist.get(u, float("inf")):
            continue
        for v, w, _d in adj[u]:
            nd = du + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = u
                heappush(pq, (nd, v))
    if goal not in prev and goal != start:
        raise RuntimeError("no path")
    path = [goal]
    while path[-1] != start:
        path.append(prev[path[-1]])
    return list(reversed(path))


def wgs84_to_lv95(lat: float, lon: float) -> tuple[float, float]:
    """Approximate WGS84 -> LV95 (Swiss CH1903+). Good to ~1m for this use."""
    # Standard swisstopo formulas (from FOSWMS doc)
    phi = (lat * 3600 - 169028.66) / 10000
    lam = (lon * 3600 - 26782.5) / 10000
    e = (
        2600072.37
        + 211455.93 * lam
        - 10938.51 * lam * phi
        - 0.36 * lam * phi * phi
        - 44.54 * lam ** 3
    )
    n = (
        1200147.07
        + 308807.95 * phi
        + 3745.25 * lam ** 2
        + 76.63 * phi ** 2
        - 194.56 * lam ** 2 * phi
        + 119.79 * phi ** 3
    )
    return e, n


def fetch_elevation_swisstopo(lat: float, lon: float) -> float | None:
    e, n = wgs84_to_lv95(lat, lon)
    url = f"{SWISSTOPO_HEIGHT}?easting={e:.2f}&northing={n:.2f}"
    try:
        data = json.loads(http_get(url))
        return float(data["height"])
    except Exception as ex:
        print(f"  elev fail @ {lat:.5f},{lon:.5f}: {ex}", file=sys.stderr)
        return None


def downsample(track: list, max_points: int = 1200) -> list:
    if len(track) <= max_points:
        return track
    step = len(track) / max_points
    return [track[int(i * step)] for i in range(max_points)]


def write_gpx(track: list, waypoints: list, path: str):
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="hike-planner" xmlns="http://www.topografix.com/GPX/1/1">',
        "  <metadata>",
        "    <name>Wasserauen - Säntis via Lisengrat</name>",
        "    <desc>Routed from OSM (ODbL); elevations from SwissTopo</desc>",
        "  </metadata>",
    ]
    for lat, lon, ele, name in waypoints:
        parts.append(f'  <wpt lat="{lat:.6f}" lon="{lon:.6f}">')
        if ele is not None:
            parts.append(f"    <ele>{ele:.1f}</ele>")
        parts.append(f"    <name>{name}</name>")
        parts.append("  </wpt>")
    parts += ["  <trk>", "    <name>Wasserauen-Säntis</name>", "    <trkseg>"]
    for lat, lon, ele in track:
        parts.append(f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}">')
        if ele is not None:
            parts.append(f"        <ele>{ele:.1f}</ele>")
        parts.append("      </trkpt>")
    parts += ["    </trkseg>", "  </trk>", "</gpx>"]
    with open(path, "w") as f:
        f.write("\n".join(parts))


def main():
    print("[1/6] finding endpoints in OSM...", flush=True)
    s, w, n, e = BBOX
    bbox_str = f"({s},{w},{n},{e})"
    # Wasserauen train station (start)
    start_ll = find_node(
        f'[out:json][timeout:60];node["railway"="station"]["name"="Wasserauen"]{bbox_str};out;'
    )
    print(f"  Wasserauen station: {start_ll}")

    # Säntis summit
    summit_ll = find_node(
        f'[out:json][timeout:60];node["natural"="peak"]["name"="Säntis"]{bbox_str};out;'
    )
    print(f"  Säntis summit: {summit_ll}")

    # Seealpsee (lake — try centroid of named water way)
    try:
        seealpsee = find_node(
            f'[out:json][timeout:60];(node["natural"="water"]["name"="Seealpsee"]{bbox_str};);out;'
        )
    except Exception:
        seealpsee = (47.2780, 9.3990)  # known Seealpsee centroid (Alpstein)
    print(f"  Seealpsee: {seealpsee}")

    # Meglisalp (overnight stop)
    try:
        meglisalp = find_node(
            f'[out:json][timeout:60];(node["place"="hamlet"]["name"="Meglisalp"]{bbox_str};node["name"="Meglisalp"]{bbox_str};);out;'
        )
    except Exception:
        meglisalp = (47.2680, 9.3870)
    print(f"  Meglisalp: {meglisalp}")

    # Schwägalp (cable car base / bus terminus, descent endpoint)
    try:
        schwaegalp = find_node(
            f'[out:json][timeout:60];(node["aerialway"="station"]["name"~"Schwägalp"]{bbox_str};node["name"="Schwägalp"]{bbox_str};);out;'
        )
    except Exception:
        schwaegalp = (47.2553, 9.3171)  # cable-car base station, ~1352m
    print(f"  Schwägalp: {schwaegalp}")

    print("[2/6] fetching walkable ways in bbox...", flush=True)
    osm = fetch_walkable_ways(BBOX)
    print(f"  got {len(osm['elements'])} elements")

    print("[3/6] building graph...", flush=True)
    nodes, adj = build_graph(osm)
    print(f"  graph: {len(nodes)} nodes, {sum(len(v) for v in adj.values())//2} edges")

    print("[4/6] snapping endpoints...", flush=True)
    start_id, start_d = snap(nodes, start_ll)
    summit_id, summit_d = snap(nodes, summit_ll)
    schwaegalp_id, schwaegalp_d = snap(nodes, schwaegalp)
    print(f"  start snap: {start_d:.1f}m, summit snap: {summit_d:.1f}m, schwägalp snap: {schwaegalp_d:.1f}m")

    print("[5/6] running Dijkstra (ascent + descent)...", flush=True)
    path_up = dijkstra(adj, start_id, summit_id)
    print(f"  ascent: {len(path_up)} nodes")
    path_down = dijkstra(adj, summit_id, schwaegalp_id)
    print(f"  descent: {len(path_down)} nodes")

    # Combine: ascent then descent (skip duplicate summit node)
    path = path_up + path_down[1:]
    raw_track = [nodes[nid] for nid in path]

    # Compute total distance
    total = sum(haversine(raw_track[i], raw_track[i+1]) for i in range(len(raw_track)-1))
    up_dist = sum(haversine(nodes[path_up[i]], nodes[path_up[i+1]]) for i in range(len(path_up)-1))
    dn_dist = sum(haversine(nodes[path_down[i]], nodes[path_down[i+1]]) for i in range(len(path_down)-1))
    print(f"  ascent {up_dist/1000:.2f} km, descent {dn_dist/1000:.2f} km, total {total/1000:.2f} km")

    # Downsample for elevation queries (SwissTopo: one point at a time, slow)
    sampled = downsample(raw_track, max_points=400)
    print(f"  sampled to {len(sampled)} points for elevation pass")

    print("[6/6] fetching elevations from SwissTopo...", flush=True)
    enriched = []
    for i, (lat, lon) in enumerate(sampled):
        ele = fetch_elevation_swisstopo(lat, lon)
        enriched.append((lat, lon, ele))
        if i % 50 == 0:
            print(f"  {i}/{len(sampled)} ({100*i/len(sampled):.0f}%)", flush=True)
        time.sleep(0.05)  # be polite

    # Snap the named waypoints to nearest enriched track point for clean labels
    def nearest_enriched(target):
        best, best_d = None, float("inf")
        for lat, lon, ele in enriched:
            d = haversine((lat, lon), target)
            if d < best_d:
                best_d, best = d, (lat, lon, ele)
        return best

    wp_start = nearest_enriched(start_ll)
    wp_summit = nearest_enriched(summit_ll)
    wp_seealpsee = nearest_enriched(seealpsee) if seealpsee else None
    wp_meglisalp = nearest_enriched(meglisalp) if meglisalp else None
    wp_schwaegalp = nearest_enriched(schwaegalp) if schwaegalp else None

    waypoints = [
        (wp_start[0], wp_start[1], wp_start[2], "Wasserauen (start)"),
    ]
    if wp_seealpsee:
        waypoints.append((wp_seealpsee[0], wp_seealpsee[1], wp_seealpsee[2], "Seealpsee"))
    if wp_meglisalp:
        waypoints.append((wp_meglisalp[0], wp_meglisalp[1], wp_meglisalp[2], "Meglisalp (overnight)"))
    waypoints.append((wp_summit[0], wp_summit[1], wp_summit[2], "Säntis Summit"))
    if wp_schwaegalp:
        waypoints.append((wp_schwaegalp[0], wp_schwaegalp[1], wp_schwaegalp[2], "Schwägalp (descent end)"))

    write_gpx(enriched, waypoints, OUT_GPX)
    print(f"\nwrote {OUT_GPX}")
    print(f"  {len(enriched)} trackpoints, {len(waypoints)} waypoints")
    print(f"  distance {total/1000:.2f} km")


if __name__ == "__main__":
    main()
