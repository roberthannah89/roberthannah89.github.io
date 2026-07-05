#!/usr/bin/env python3
"""Regenerate the per-hike <slug>.3d-preview.jpg images from the live Cesium
photorealistic prototype.

Iterates every hike under routes/<slug>/, navigates Playwright to the prototype
in capture mode, waits for tiles to settle, snapshots the canvas, saves over
the existing .3d-preview.jpg.

Usage:
    # Snapshot ALL hikes (~75) against the deployed site (one Cesium session each):
    pip install playwright
    playwright install chromium
    python pages/hikes/scripts/snapshot_3d_previews.py

    # Snapshot just one or a few:
    python pages/hikes/scripts/snapshot_3d_previews.py wildspitz-rossberg saentis

    # Point at a local server (e.g. python -m http.server 8000 in pages/hikes/):
    HIKE_3D_HOST=http://localhost:8000 python pages/hikes/scripts/snapshot_3d_previews.py

Each snapshot burns ONE Map Tiles session (3-hour token). 75 hikes = ~7.5% of
the 1,000-session/month free tier. Sharp quality is forced via ?capture=1.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

HIKES_ROOT = Path(__file__).resolve().parent.parent
ROUTES = HIKES_ROOT / "routes"
DEFAULT_HOST = "https://roberthannah89.github.io/pages/hikes"
HOST = os.environ.get("HIKE_3D_HOST", DEFAULT_HOST).rstrip("/")
PROTO_URL = f"{HOST}/embed/3d.html"

VIEWPORT = {"width": 1280, "height": 720}
TILE_WAIT_MS = 25_000
JPEG_QUALITY = 85


def all_slugs() -> list[str]:
    return sorted(d.name for d in ROUTES.iterdir() if d.is_dir() and not d.name.startswith("_"))


async def snapshot(page, slug: str) -> bool:
    target = ROUTES / slug / f"{slug}.3d-preview.jpg"
    if not (ROUTES / slug).is_dir():
        print(f"  ✗ {slug:40s} no route directory")
        return False
    url = f"{PROTO_URL}?hike={slug}&activate=1&capture=1"
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
    except Exception as e:
        print(f"  ✗ {slug:40s} navigation failed: {e}")
        return False

    # Let Cesium load the tileset + render tiles.
    await page.wait_for_timeout(TILE_WAIT_MS)

    # Sanity-check the viewer + tileset are alive.
    state = await page.evaluate("""() => ({
        hasViewer: !!window.cesiumViewer,
        hasTileset: !!window.cesiumTileset,
        hasError: !!document.querySelector('.pane-error'),
    })""")
    if state.get("hasError"):
        body = await page.evaluate("document.querySelector('.pane-error pre')?.innerText || ''")
        print(f"  ✗ {slug:40s} Cesium error: {body[:80]}")
        return False
    if not state.get("hasViewer") or not state.get("hasTileset"):
        print(f"  ✗ {slug:40s} viewer not ready: {state}")
        return False

    # Freeze the render loop, hide Cesium's attribution badge for a clean shot.
    await page.evaluate("""() => {
        cesiumViewer.useDefaultRenderLoop = false;
        cesiumViewer.render();
        const credits = document.querySelector('.cesium-credit-container');
        if (credits) credits.style.opacity = '0';
    }""")

    img = await page.screenshot(full_page=False, type="jpeg", quality=JPEG_QUALITY)
    target.write_bytes(img)
    kb = len(img) // 1024
    print(f"  ✓ {slug:40s} {kb} KB")
    return True


async def main(slugs: list[str]) -> int:
    if not slugs:
        print("No hikes to snapshot.")
        return 0

    print(f"Host: {HOST}")
    print(f"Snapshotting {len(slugs)} hike(s), {TILE_WAIT_MS//1000}s tile-load wait each.\n")

    fails = 0
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport=VIEWPORT, device_scale_factor=1)
        page = await context.new_page()
        for i, slug in enumerate(slugs, 1):
            print(f"[{i}/{len(slugs)}]", end=" ")
            ok = await snapshot(page, slug)
            if not ok:
                fails += 1
        await browser.close()

    print(f"\nDone. {len(slugs) - fails} succeeded, {fails} failed.")
    return 1 if fails else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    slugs = args if args else all_slugs()
    sys.exit(asyncio.run(main(slugs)))
