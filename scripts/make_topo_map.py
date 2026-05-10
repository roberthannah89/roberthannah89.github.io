"""
SwissTopo topographic route-map generator.

Stitches official SwissTopo WMTS tiles (EPSG:3857), draws a polyline route
on top, marks waypoints, and saves a PNG.

Usage
-----
    # From a real GPX file (preferred):
    python make_topo_map.py --gpx route.gpx --out map.png \\
        --title "My hike" --subtitle "swisstopo + OSM"

    # From hardcoded ROUTE list at bottom of file:
    python make_topo_map.py --out map.png

Requirements
------------
    pip install Pillow

Attribution
-----------
SwissTopo Pixelkarte: CC BY 3.0 — credit "© swisstopo".
GPX from OpenStreetMap: ODbL — credit "© OpenStreetMap contributors".
"""

import argparse
import io
import math
import sys
import urllib.request
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont

TILE = 256
URL_TEMPLATE = "https://wmts.geo.admin.ch/1.0.0/{layer}/default/current/3857/{z}/{x}/{y}.jpeg"


# ---------------------------------------------------------------------------- #
# GPX parsing
# ---------------------------------------------------------------------------- #

def parse_gpx(path: str) -> tuple[list[tuple[float, float]], list[tuple[float, float, str]]]:
    """Return (track_points, waypoints) from a GPX file. Both are (lat, lon[, name])."""
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    tree = ET.parse(path)
    root = tree.getroot()
    track = []
    for trkpt in root.iter(f"{{{ns['g']}}}trkpt"):
        track.append((float(trkpt.get("lat")), float(trkpt.get("lon"))))
    waypoints = []
    for wpt in root.iter(f"{{{ns['g']}}}wpt"):
        name_el = wpt.find(f"{{{ns['g']}}}name")
        name = name_el.text if name_el is not None else ""
        waypoints.append((float(wpt.get("lat")), float(wpt.get("lon")), name))
    return track, waypoints


# ---------------------------------------------------------------------------- #
# Tile math
# ---------------------------------------------------------------------------- #

def latlon_to_pix(lat: float, lon: float, z: int) -> tuple[float, float]:
    n = 2**z
    x = (lon + 180.0) / 360.0 * n * TILE
    lat_rad = math.radians(lat)
    y = (
        (1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi)
        / 2.0 * n * TILE
    )
    return x, y


def fetch_tile(z: int, x: int, y: int, layer: str) -> Image.Image:
    url = URL_TEMPLATE.format(layer=layer, z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGB")


# ---------------------------------------------------------------------------- #
# Rendering
# ---------------------------------------------------------------------------- #

def render(track, waypoints, title, subtitle, zoom, layer, pad_px, out_path):
    """track: [(lat, lon)], waypoints: [(lat, lon, label)]."""
    if not track:
        raise ValueError("empty track")

    track_pix = [latlon_to_pix(lat, lon, zoom) for lat, lon in track]
    wpt_pix = [latlon_to_pix(lat, lon, zoom) for lat, lon, _ in waypoints]
    all_pix = track_pix + wpt_pix
    xs, ys = zip(*all_pix)
    x_min, x_max = min(xs) - pad_px, max(xs) + pad_px
    y_min, y_max = min(ys) - pad_px * 1.2, max(ys) + pad_px

    tx_min, tx_max = int(x_min // TILE), int(x_max // TILE)
    ty_min, ty_max = int(y_min // TILE), int(y_max // TILE)

    w = (tx_max - tx_min + 1) * TILE
    h = (ty_max - ty_min + 1) * TILE
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    for tx in range(tx_min, tx_max + 1):
        for ty in range(ty_min, ty_max + 1):
            tile = fetch_tile(zoom, tx, ty, layer)
            canvas.paste(tile, ((tx - tx_min) * TILE, (ty - ty_min) * TILE))

    left = int(x_min - tx_min * TILE)
    top = int(y_min - ty_min * TILE)
    right = int(x_max - tx_min * TILE)
    bottom = int(y_max - ty_min * TILE)
    img = canvas.crop((left, top, right, bottom))

    draw = ImageDraw.Draw(img, "RGBA")
    track_xy = [(px - x_min, py - y_min) for px, py in track_pix]
    wpt_xy = [(px - x_min, py - y_min) for px, py in wpt_pix]

    # Route: white halo + red line.
    for width, color in ((9, (255, 255, 255, 230)), (5, (220, 30, 30, 255))):
        draw.line(track_xy, fill=color, width=width, joint="curve")

    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 16
        )
        font_s = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13
        )
    except OSError:
        font = ImageFont.load_default()
        font_s = font

    # Waypoint markers.
    for (lat, lon, label), (x, y) in zip(waypoints, wpt_xy):
        r = 9
        draw.ellipse((x - r, y - r, x + r, y + r),
                     fill=(220, 30, 30, 255), outline=(255, 255, 255, 255), width=2)
        if label:
            tx_, ty_ = x + 14, y - 24
            bbox = draw.textbbox((tx_, ty_), label, font=font)
            draw.rectangle(
                (bbox[0] - 3, bbox[1] - 2, bbox[2] + 3, bbox[3] + 2),
                fill=(255, 255, 255, 220), outline=(0, 0, 0, 255),
            )
            draw.text((tx_, ty_), label, fill=(0, 0, 0, 255), font=font)

    # Title bar.
    tb = 46
    final = Image.new("RGB", (img.width, img.height + tb), (245, 245, 245))
    final.paste(img, (0, tb))
    d2 = ImageDraw.Draw(final)
    d2.rectangle((0, 0, final.width, tb), fill=(20, 40, 80))
    d2.text((12, 6), title, fill=(255, 255, 255), font=font)
    d2.text((12, 26), subtitle, fill=(200, 210, 230), font=font_s)

    final.save(out_path, "PNG", optimize=True)
    print(f"OK {out_path} {final.size}")


# ---------------------------------------------------------------------------- #
# Hardcoded fallback (edit per hike if not using --gpx)
# ---------------------------------------------------------------------------- #

ROUTE_DEFAULT = [
    (47.1055, 8.9183, "Innerthal"),
    (47.0763, 8.9598, "Zindlenspitz 2097m"),
]


# ---------------------------------------------------------------------------- #
# CLI
# ---------------------------------------------------------------------------- #

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--gpx", help="GPX file with <trkpt> track and optional <wpt> markers")
    p.add_argument("--out", default="topo_map.png")
    p.add_argument("--title", default="Hike route")
    p.add_argument(
        "--subtitle",
        default="© swisstopo (CC BY 3.0) | track © OpenStreetMap contributors (ODbL)",
    )
    p.add_argument("--zoom", type=int, default=14)
    p.add_argument(
        "--layer",
        default="ch.swisstopo.pixelkarte-farbe",
        help="ch.swisstopo.pixelkarte-farbe | pixelkarte-grau | swissimage",
    )
    p.add_argument("--pad", type=int, default=260)
    args = p.parse_args()

    if args.gpx:
        track, waypoints = parse_gpx(args.gpx)
        if not waypoints:
            # Fall back to start/end of track as markers.
            waypoints = [(*track[0], "start"), (*track[-1], "end")]
    else:
        # ROUTE_DEFAULT is treated as both the line and the markers.
        track = [(lat, lon) for lat, lon, _ in ROUTE_DEFAULT]
        waypoints = ROUTE_DEFAULT

    render(track, waypoints, args.title, args.subtitle,
           args.zoom, args.layer, args.pad, args.out)


if __name__ == "__main__":
    main()
