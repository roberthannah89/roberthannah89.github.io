"""Fetch a SAC route's GPS track from the new public layer API.

The old ``?type=1567765346410`` JSON endpoint was retired in late May 2026.
The replacement is split:

  * Geometry → ``https://www.suissealpine.sac-cas.ch/api/1/route/layer``
    (public; bbox-keyed GeoJSON FeatureCollection; features tagged with
    ``properties.route_id`` and ``properties.style``)
  * Rich metadata (description, photos, difficulty, departure point,
    public transport) → still embedded in the authenticated route page
    HTML at ``www.sac-cas.ch``.

This script handles just the geometry half — fetches the layer API, filters
by ``route_id``, stitches segments,
converts LV95 → WGS84, and writes ``routes/<slug>/<slug>.gpx``.

Metadata scraping is intentionally out of scope here — it deserves a clean
redesign of the rest of the pipeline rather than a tactical add-on.

Usage
-----
    python scripts/fetch_sac_route_v2.py \\
        --url 'https://www.sac-cas.ch/.../federispitz-601/mountain-hiking/<route-slug>-6819/' \\
        --slug federispitz

The peak ID (used to look up coordinates for the bbox) is read from the URL.
Peak coordinates are looked up in ``guides/sac-routes.js``.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import gpxpy
    import gpxpy.gpx
except ImportError:
    sys.exit("ERROR: gpxpy is required.  pip install gpxpy")

from itertools import permutations

_GAP_THRESHOLD_M = 200  # LV95 is in metres; segments closer than this are "connected"


def _lv95_to_wgs84(e: float, n: float) -> tuple[float, float]:
    """Convert Swiss LV95 (EPSG:2056) to WGS84 (lat, lon)."""
    y_aux = (e - 2_600_000) / 1_000_000
    x_aux = (n - 1_200_000) / 1_000_000
    lon = (2.6779094
           + 4.728982 * y_aux
           + 0.791484 * y_aux * x_aux
           + 0.1306 * y_aux * x_aux * x_aux
           - 0.0436 * y_aux * y_aux * y_aux)
    lat = (16.9023892
           + 3.238272 * x_aux
           - 0.270978 * y_aux * y_aux
           - 0.002528 * x_aux * x_aux
           - 0.0447 * y_aux * y_aux * x_aux
           - 0.0140 * x_aux * x_aux * x_aux)
    return lat * 100 / 36, lon * 100 / 36


def _lv95_dist(a: list, b: list) -> float:
    """Euclidean distance between two LV95 [e, n] coordinates (metres)."""
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _stitch_segments(raw: list[tuple[str, list]]) -> list[tuple[str, list]]:
    """Reorder/reverse/retrace segments to form a connected track.

    SAC routes can contain out-and-back spurs (e.g. summit detours) and
    segments whose geometry is stored in reverse.  Stitches them into a
    continuous line by choosing, for each transition, the best of four
    options: forward, reverse next, retrace previous + forward, or retrace
    previous + reverse next. Operates on LV95 coordinates before WGS84
    conversion.
    """
    if len(raw) <= 1:
        return list(raw)

    placed: list[tuple[str, list]] = [raw[0]]

    for i in range(1, len(raw)):
        title, coords = raw[i]
        _, prev_coords = placed[-1]

        prev_end = prev_coords[-1]
        prev_start = prev_coords[0]
        next_start = coords[0]
        next_end = coords[-1]

        d_fwd = _lv95_dist(prev_end, next_start)
        d_rev = _lv95_dist(prev_end, next_end)
        d_ret_fwd = _lv95_dist(prev_start, next_start)
        d_ret_rev = _lv95_dist(prev_start, next_end)

        best = min(d_fwd, d_rev, d_ret_fwd, d_ret_rev)

        if best == d_fwd:
            placed.append((title, coords))
            if d_fwd > _GAP_THRESHOLD_M:
                print(f"[sac-gpx] WARNING: {d_fwd:.0f}m gap before '{title}'")
        elif best == d_rev:
            placed.append((title, list(reversed(coords))))
            print(f"[sac-gpx] Reversed '{title}' to connect ({d_rev:.0f}m)")
        elif best == d_ret_fwd:
            prev_title = placed[-1][0]
            placed.append((f"{prev_title} (retrace)", list(reversed(prev_coords))))
            placed.append((title, coords))
            print(f"[sac-gpx] Retraced '{prev_title}' then '{title}' forward ({d_ret_fwd:.0f}m)")
        else:
            prev_title = placed[-1][0]
            placed.append((f"{prev_title} (retrace)", list(reversed(prev_coords))))
            placed.append((title, list(reversed(coords))))
            print(f"[sac-gpx] Retraced '{prev_title}' then reversed '{title}' ({d_ret_rev:.0f}m)")

    return placed

REPO_ROOT = Path(__file__).resolve().parent.parent
ROUTES_DB = REPO_ROOT / "guides" / "sac-routes.js"
LAYER_API = "https://www.suissealpine.sac-cas.ch/api/1/route/layer"

# Bbox padding around the peak, in LV95 metres. Most single-day routes fit
# within a 20×20 km window. Bigger bbox = more features to filter, but the
# layer API is fast enough that even 30 km is fine.
BBOX_PADDING_M = 12_000


def _route_id_from_url(url: str) -> int:
    """Extract the trailing ``-<digits>/`` from the URL path."""
    m = re.search(r"-(\d+)/?$", urllib.parse.urlsplit(url).path)
    if not m:
        sys.exit(f"ERROR: couldn't extract route ID from URL: {url}")
    return int(m.group(1))


def _peak_id_from_url(url: str) -> int:
    """Extract the peak ID (second-to-last ``-<digits>/`` in the path)."""
    parts = [p for p in urllib.parse.urlsplit(url).path.split("/") if p]
    # Path looks like .../sac-route-portal/<peak-slug>-<peak-id>/mountain-hiking/<route-slug>-<route-id>
    for p in reversed(parts[:-2]):  # skip discipline and route
        m = re.search(r"-(\d+)$", p)
        if m:
            return int(m.group(1))
    sys.exit(f"ERROR: couldn't extract peak ID from URL: {url}")


def _load_peak_coords(peak_id: int) -> tuple[float, float]:
    """Look up (lat, lon) for a peak from guides/sac-routes.js."""
    if not ROUTES_DB.exists():
        sys.exit(f"ERROR: missing routes DB at {ROUTES_DB}")
    raw = ROUTES_DB.read_text(encoding="utf-8")
    # File is `window.SAC_ROUTES = [...]` — strip assignment and trailing semicolon.
    payload = raw.split("=", 1)[1].strip().rstrip(";").strip()
    db = json.loads(payload)
    for peak in db:
        if peak.get("id") == peak_id:
            return peak["lat"], peak["lon"]
    sys.exit(f"ERROR: peak id {peak_id} not in routes DB; add it manually or extend the lookup.")


def _wgs84_to_lv95(lat: float, lon: float) -> tuple[float, float]:
    """WGS84 (lat, lon) → LV95 (E, N) using swisstopo approximation formulas.

    Inverse of ``_lv95_to_wgs84`` above. Accurate to ~1m, plenty
    for computing a bbox padding.
    """
    phi = (lat * 3600 - 169028.66) / 10000
    lam = (lon * 3600 - 26782.5) / 10000
    e = (2_600_072.37
         + 211_455.93 * lam
         - 10_938.51 * lam * phi
         - 0.36 * lam * phi * phi
         - 44.54 * lam * lam * lam)
    n = (1_200_147.07
         + 308_807.95 * phi
         + 3_745.25 * lam * lam
         + 76.63 * phi * phi
         - 194.56 * lam * lam * phi
         + 119.79 * phi * phi * phi)
    return e, n


def _fetch_layer(bbox: tuple[float, float, float, float]) -> dict:
    """Fetch the GeoJSON layer for the given bbox."""
    qs = urllib.parse.urlencode({"bbox": ",".join(f"{v:.0f}" for v in bbox)})
    url = f"{LAYER_API}?{qs}"
    print(f"[layer] GET {url}")
    req = urllib.request.Request(url, headers={
        "Accept": "*/*",
        "Origin": "https://www.sac-cas.ch",
        "Referer": "https://www.sac-cas.ch/",
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"),
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _features_for_route(layer: dict, route_id: int, include_dashed: bool = True) -> list[dict]:
    """Pick out the features tagged with this route_id.

    Drops features flagged ``alternative=True`` (route variants). Keeps
    ``style=dashed`` features by default: on routes like Nüenchamm the
    dashed segment is the descent leg (the connector between the two
    plain features), not a variant. Pass ``include_dashed=False`` to
    revert to the old "plain only" behaviour.
    """
    out = []
    for f in layer.get("features", []):
        props = f.get("properties") or {}
        if props.get("route_id") != route_id:
            continue
        if props.get("alternative"):
            continue
        if not include_dashed and props.get("style") == "dashed":
            continue
        out.append(f)
    return out


def _gap_lv95(a: tuple[float, float], b: tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _densify_and_split(coords: list[list[float]],
                       densify_below_m: float = 50,
                       split_above_m: float = 250) -> list[list[list[float]]]:
    """Walk the merged-after-smart-stitch coordinate list and decide, for each
    consecutive pair, whether to:

      * gap < ``densify_below_m``: leave the pair as-is (real trail data).
      * gap in [densify, split): insert evenly-spaced intermediate points so
        the elevation profile reads as terrain (SwissTopo enrichment fills in
        Z afterwards). The map still shows a short straight connector but
        it's a few tens of metres — well within trail-simplification noise.
      * gap >= ``split_above_m``: don't connect at all. End the current
        trkseg and start a fresh one at ``b``. The map then shows a visible
        break, which is honest — the SAC layer API genuinely doesn't
        publish trail geometry between the two endpoints.

    Returns a list of trksegs (each is a list of [E, N] coords).
    """
    segs: list[list[list[float]]] = [[coords[0]]]
    for a, b in zip(coords, coords[1:], strict=False):
        gap = _gap_lv95((a[0], a[1]), (b[0], b[1]))
        if gap >= split_above_m:
            segs.append([b])
            continue
        if gap > densify_below_m:
            n_inter = int(gap // densify_below_m)
            for k in range(1, n_inter + 1):
                t = k / (n_inter + 1)
                segs[-1].append([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
        segs[-1].append(b)
    return segs


def _smart_stitch(raw: list[tuple[str, list]]) -> tuple[list[tuple[str, list]], float]:
    """Brute-force the best ordering + per-segment direction.

    For each permutation of segments and each binary direction choice,
    compute the sum of LV95 distances between consecutive endpoint pairs.
    Return the lowest-total-gap ordering. O(N! * 2^N) — fine for N <= 7.

    Returns ``(ordered_segments, total_gap_metres)``.
    """
    n = len(raw)
    coords_per_seg = [seg_coords for _, seg_coords in raw]

    best: tuple[list[tuple[str, list]], float] | None = None
    for perm in permutations(range(n)):
        for dir_bits in range(1 << n):
            ordered: list[tuple[str, list]] = []
            total_gap = 0.0
            for i, idx in enumerate(perm):
                title = raw[idx][0]
                coords = coords_per_seg[idx]
                reverse = bool((dir_bits >> i) & 1)
                if reverse:
                    coords = list(reversed(coords))
                    title = f"{title}↺"
                if ordered:
                    gap = _gap_lv95(ordered[-1][1][-1], coords[0])
                    total_gap += gap
                ordered.append((title, coords))
            if best is None or total_gap < best[1]:
                best = (ordered, total_gap)
    assert best is not None
    return best


def _build_gpx(features: list[dict], title: str, slug: str, out_dir: Path,
               stitch: bool = False, smart: bool = True) -> Path:
    """Write a GPX with one track segment per feature.

    The default mode (``stitch=False``) preserves each layer-API feature as a
    separate ``<trkseg>``. This keeps elevation gain accurate (no double-counting
    from retraces on figure-8 routes) and the Leaflet renderer in this repo
    treats the multi-segment track as a single visual line. Pass ``stitch=True``
    to invoke the legacy greedy stitcher (``_stitch_segments`` above) — only useful
    for routes you know are a strict point-to-point with no shared trail.
    """
    raw: list[tuple[str, list]] = []
    for i, f in enumerate(features):
        coords = f.get("geometry", {}).get("coordinates", [])
        if not coords:
            continue
        # Strip any Z components — coords list expects [E, N] pairs.
        clean = [[float(c[0]), float(c[1])] for c in coords]
        style = (f.get("properties") or {}).get("style", "?")
        raw.append((f"seg{i}({style})", clean))

    if not raw:
        sys.exit("ERROR: no usable LineString features matched this route_id.")

    if stitch:
        raw = _stitch_segments(raw)
        print(f"[gpx  ] stitched into {len(raw)} segments")
    elif smart and 2 <= len(raw) <= 7:
        ordered, total_gap = _smart_stitch(raw)
        print(f"[gpx  ] smart-stitched: order=[{', '.join(t for t, _ in ordered)}], "
              f"total endpoint gap={total_gap:.0f} m")
        raw = ordered
    elif smart and len(raw) > 7:
        print(f"[gpx  ] {len(raw)} features > 7; smart stitcher skipped (too many permutations). "
              "Using raw order; consider --stitch.")

    gpx = gpxpy.gpx.GPX()
    track = gpxpy.gpx.GPXTrack(name=title)
    gpx.tracks.append(track)

    # When smart-stitched, fuse all segments into ONE trkseg so the elevation
    # profile renders as a single connected line. Densify any large gaps
    # between feature endpoints with intermediate points so the chart shows
    # actual terrain (post-enrichment) instead of a diagonal connector.
    # Otherwise keep them split (each feature in its own trkseg).
    if smart and not stitch and 2 <= len(raw) <= 7:
        merged_coords: list[list[float]] = []
        for _, coords in raw:
            merged_coords.extend(coords)
        chunks = _densify_and_split(merged_coords)
        added = sum(len(c) for c in chunks) - len(merged_coords)
        splits = len(chunks) - 1
        if added or splits:
            note = []
            if added:
                note.append(f"densified {added} intermediate point(s)")
            if splits:
                note.append(f"split into {len(chunks)} trkseg(s) on >250 m gaps")
            print(f"[gpx  ] {'; '.join(note)}")
        for chunk in chunks:
            seg = gpxpy.gpx.GPXTrackSegment()
            seg.points = [gpxpy.gpx.GPXTrackPoint(*_lv95_to_wgs84(e, n)) for e, n in chunk]
            track.segments.append(seg)
    else:
        for _seg_name, coords in raw:
            seg = gpxpy.gpx.GPXTrackSegment()
            seg.points = [
                gpxpy.gpx.GPXTrackPoint(*_lv95_to_wgs84(e, n)) for e, n in coords
            ]
            track.segments.append(seg)

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{slug}.gpx"
    out_path.write_text(gpx.to_xml(), encoding="utf-8")
    pts = sum(len(s.points) for s in track.segments)
    print(f"[gpx  ] wrote {out_path} ({pts} points across {len(track.segments)} segments)")
    return out_path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--url", required=True, help="SAC route page URL")
    p.add_argument("--slug", required=True, help="Folder slug under routes/")
    p.add_argument("--title", help="Track title (default: derived from slug)")
    p.add_argument("--bbox-padding", type=int, default=BBOX_PADDING_M,
                   help=f"Half-width of bbox in LV95 metres (default: {BBOX_PADDING_M}).")
    p.add_argument("--save-layer", action="store_true",
                   help="Save the raw GeoJSON layer response next to the GPX (for debugging).")
    p.add_argument("--no-dashed", action="store_true",
                   help="Drop style=dashed features (default: keep — they are usually genuine route connectors).")
    p.add_argument("--stitch", action="store_true",
                   help="Run the legacy greedy stitcher with retraces (rarely useful).")
    p.add_argument("--no-smart", action="store_true",
                   help="Skip the smart brute-force stitcher; emit one trkseg per feature "
                        "in raw API order (debugging only).")
    args = p.parse_args(argv)

    route_id = _route_id_from_url(args.url)
    peak_id = _peak_id_from_url(args.url)
    lat, lon = _load_peak_coords(peak_id)
    cx, cy = _wgs84_to_lv95(lat, lon)
    bbox = (cx - args.bbox_padding, cy - args.bbox_padding,
            cx + args.bbox_padding, cy + args.bbox_padding)

    print(f"[init ] route_id={route_id} peak_id={peak_id} center=({lat:.5f},{lon:.5f}) "
          f"→ LV95 ({cx:.0f},{cy:.0f}), bbox padding {args.bbox_padding} m")

    layer = _fetch_layer(bbox)
    features = _features_for_route(layer, route_id, include_dashed=not args.no_dashed)
    print(f"[layer] {len(layer.get('features', []))} features in bbox, "
          f"{len(features)} matched route_id={route_id} (non-alternative"
          f"{', excl. dashed' if args.no_dashed else ', incl. dashed'})")

    if not features:
        sys.exit("ERROR: no features matched; try a larger --bbox-padding.")

    out_dir = REPO_ROOT / "routes" / args.slug
    title = args.title or args.slug
    _build_gpx(features, title, args.slug, out_dir,
               stitch=args.stitch, smart=not args.no_smart)

    if args.save_layer:
        layer_path = out_dir / f"sac-layer-{route_id}.json"
        layer_path.write_text(json.dumps(layer, ensure_ascii=False, separators=(",", ":")),
                              encoding="utf-8")
        print(f"[layer] saved raw layer to {layer_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
