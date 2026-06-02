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
by ``route_id``, stitches segments (reusing ``extract_sac_gpx._stitch_segments``),
converts LV95 → WGS84, and writes ``routes/<slug>/<slug>.gpx``.

Metadata scraping is intentionally out of scope here — it deserves a clean
redesign of the rest of the pipeline rather than a tactical add-on.

Usage
-----
    python scripts/fetch_sac_route_v2.py \\
        --url 'https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/federispitz-601/mountain-hiking/von-ziegelbruecke-via-vorder-federispitz-abstieg-via-plaettlispitz-nach-weesen-6819/' \\
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

from extract_sac_gpx import _lv95_to_wgs84, _stitch_segments  # noqa: E402

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

    Inverse of ``_lv95_to_wgs84`` in extract_sac_gpx. Accurate to ~1m, plenty
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


def _features_for_route(layer: dict, route_id: int) -> list[dict]:
    """Pick out the features tagged with this route_id."""
    out = []
    for f in layer.get("features", []):
        props = f.get("properties") or {}
        if props.get("route_id") != route_id:
            continue
        if props.get("alternative"):
            continue
        out.append(f)
    return out


def _build_gpx(features: list[dict], title: str, slug: str, out_dir: Path) -> Path:
    """Stitch features into a single GPX track and write it."""
    raw: list[tuple[str, list]] = []
    for i, f in enumerate(features):
        coords = f.get("geometry", {}).get("coordinates", [])
        if not coords:
            continue
        # Strip any Z components — _stitch_segments expects [E, N] pairs.
        clean = [[float(c[0]), float(c[1])] for c in coords]
        style = (f.get("properties") or {}).get("style", "?")
        raw.append((f"seg{i}({style})", clean))

    if not raw:
        sys.exit("ERROR: no usable LineString features matched this route_id.")

    stitched = _stitch_segments(raw)
    print(f"[gpx  ] {len(features)} features → {len(stitched)} stitched segments")

    gpx = gpxpy.gpx.GPX()
    track = gpxpy.gpx.GPXTrack(name=title)
    gpx.tracks.append(track)

    for seg_name, coords in stitched:
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
    features = _features_for_route(layer, route_id)
    print(f"[layer] {len(layer.get('features', []))} features in bbox, "
          f"{len(features)} matched route_id={route_id} (non-alternative)")

    if not features:
        sys.exit("ERROR: no features matched; try a larger --bbox-padding.")

    out_dir = REPO_ROOT / "routes" / args.slug
    title = args.title or args.slug
    _build_gpx(features, title, args.slug, out_dir)

    if args.save_layer:
        layer_path = out_dir / f"sac-layer-{route_id}.json"
        layer_path.write_text(json.dumps(layer, ensure_ascii=False, separators=(",", ":")),
                              encoding="utf-8")
        print(f"[layer] saved raw layer to {layer_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
