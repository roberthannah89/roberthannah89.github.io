#!/usr/bin/env python3
"""Generate static preview JPEGs of each hike's 3D map.

Headless Chromium opens routes/<slug>/<slug>.3d.html, waits for the
swisstopo satellite + terrarium tiles to settle, screenshots, and writes
routes/<slug>/<slug>.3d-preview.jpg. The hike page uses this image as the
backdrop behind the "Load interactive 3D view" button so users see the
route on terrain before any WebGL initializes.

Slow (a few seconds per hike for tiles + GPU). Not run by default;
invoked via the `make 3d-previews` target.
"""

from __future__ import annotations

import argparse
import http.server
import socketserver
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parent.parent  # pages/hikes/
ROUTES_DIR = REPO_ROOT / "routes"

# 16:9 frame — matches the .hike3d-wrap aspect ratio on the hike page.
VIEWPORT = {"width": 1280, "height": 720}
# Time to let satellite + terrain tiles render after the map fits to bounds.
TILE_SETTLE_SECONDS = 7
# JPEG quality (1–100). 80 keeps each preview around 80–120 KB.
JPEG_QUALITY = 82


@contextmanager
def _local_server(root: Path, port: int):
    """Serve `root` on localhost:port for the duration of the context.

    A static server is required because Playwright refuses file:// URLs
    and the page loads track.js / hike_3d.js via relative paths.
    """
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(root), **kw)  # noqa: E731
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def _hike_slugs(only: list[str] | None) -> list[str]:
    slugs: list[str] = []
    for d in sorted(ROUTES_DIR.iterdir()):
        if not d.is_dir() or d.name.startswith("_"):
            continue
        if not (d / f"{d.name}.3d.html").exists():
            continue
        if only and d.name not in only:
            continue
        slugs.append(d.name)
    return slugs


def _capture(page, base_url: str, slug: str) -> Path:
    url = f"{base_url}/routes/{slug}/{slug}.3d.html"
    page.goto(url, wait_until="load")
    # The map initializes on script load; give tiles time to download + render.
    time.sleep(TILE_SETTLE_SECONDS)
    out_path = ROUTES_DIR / slug / f"{slug}.3d-preview.jpg"
    page.locator("#map").screenshot(path=str(out_path), type="jpeg", quality=JPEG_QUALITY)
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="*", help="Restrict to specific hike slugs")
    parser.add_argument("--port", type=int, default=8456, help="Local server port (default: 8456)")
    args = parser.parse_args()

    slugs = _hike_slugs(args.only)
    if not slugs:
        print("No hikes with <slug>.3d.html found.", file=sys.stderr)
        return 1

    print(f"Generating 3D preview JPEGs for {len(slugs)} hike(s)…")

    with _local_server(REPO_ROOT, args.port) as base_url, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--use-gl=swiftshader"])
        ctx = browser.new_context(viewport=VIEWPORT, device_scale_factor=1)
        page = ctx.new_page()

        ok = 0
        for i, slug in enumerate(slugs, 1):
            t0 = time.time()
            try:
                out = _capture(page, base_url, slug)
                kb = out.stat().st_size / 1024
                print(f"  [{i:2d}/{len(slugs)}] {slug:<32} {kb:5.0f} KB  ({time.time()-t0:4.1f}s)")
                ok += 1
            except Exception as e:  # noqa: BLE001 — keep going on individual failures
                print(f"  [{i:2d}/{len(slugs)}] {slug:<32} FAILED: {e}", file=sys.stderr)

        browser.close()

    print(f"Done: {ok}/{len(slugs)} previews written.")
    return 0 if ok == len(slugs) else 2


if __name__ == "__main__":
    sys.exit(main())
