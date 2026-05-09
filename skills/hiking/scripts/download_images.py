#!/usr/bin/env python3
"""
Download hike images locally and rewrite data.json URLs to relative paths.

Why: Wikimedia Commons rate-limits (HTTP 429) and occasionally returns 404 for
renamed files. Downloading once eliminates both runtime issues and gives us
faster page loads from GitHub Pages.

Behavior:
  - For each hike, downloads `hero.image_url` and every `photos[].url` /
    `photos[].lightbox_url` into `hikes/<slug>/images/`.
  - Resizes to a max width (default 1600px) and saves as JPEG (quality 85).
  - Rewrites data.json to use relative paths: `./images/<filename>`.
  - Skips downloads that already exist (idempotent).
  - 404s are reported, original URL is left in place.

Usage:
  python download_images.py                 # all hikes
  python download_images.py --slug santis   # single hike
  python download_images.py --max-width 1200
  python download_images.py --dry-run       # show what would happen
  python download_images.py --jobs 8        # parallel downloads
"""

import json
import re
import sys
import time
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests
from PIL import Image

UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36')
HEADERS = {'User-Agent': UA}

SAFE = re.compile(r'[^A-Za-z0-9._-]+')


def is_local(url: str) -> bool:
    return url.startswith('./') or url.startswith('images/') or not url.startswith('http')


def filename_for(url: str) -> str:
    """Derive a safe local filename from a URL."""
    path = unquote(urlparse(url).path)
    name = path.rsplit('/', 1)[-1]
    name = name.split('?')[0]
    # Wikimedia Special:FilePath URLs have the filename as the last segment
    name = SAFE.sub('_', name).strip('_') or 'image'
    if not re.search(r'\.(jpg|jpeg|png|webp)$', name, re.I):
        name += '.jpg'
    # Normalize all to .jpg for consistency (we re-encode anyway)
    name = re.sub(r'\.(jpeg|png|webp)$', '.jpg', name, flags=re.I)
    return name


def download_one(url: str, dest: Path, max_width: int, retries: int = 5) -> tuple[bool, str]:
    """Download + resize. Returns (ok, message)."""
    if dest.exists():
        return True, 'cached'

    last_err = ''
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30, allow_redirects=True)
            if r.status_code == 429:
                # Rate-limited — exponential backoff
                wait = min(30, 2 ** (attempt + 2))
                time.sleep(wait)
                last_err = '429 rate-limited'
                continue
            if r.status_code != 200:
                return False, f'HTTP {r.status_code}'

            img = Image.open(BytesIO(r.content))
            if img.mode not in ('RGB', 'L'):
                img = img.convert('RGB')

            if img.width > max_width:
                ratio = max_width / img.width
                new_size = (max_width, int(img.height * ratio))
                img = img.resize(new_size, Image.LANCZOS)

            dest.parent.mkdir(parents=True, exist_ok=True)
            img.save(dest, 'JPEG', quality=85, optimize=True, progressive=True)
            return True, f'{img.width}x{img.height}'
        except requests.RequestException as e:
            last_err = str(e)[:50]
            time.sleep(2)
        except Exception as e:
            return False, f'decode error: {str(e)[:50]}'

    return False, last_err or 'failed'


def collect_urls(data: dict) -> list[tuple[str, list, str]]:
    """
    Return [(url, container, key), ...] for every image URL in data.
    `container[key] = new_value` rewrites the URL.
    """
    items = []
    if 'hero' in data and isinstance(data['hero'], dict):
        if 'image_url' in data['hero']:
            items.append((data['hero']['image_url'], data['hero'], 'image_url'))
    for photo in data.get('photos', []) or []:
        if not isinstance(photo, dict):
            continue
        for k in ('url', 'lightbox_url'):
            if k in photo and isinstance(photo[k], str):
                items.append((photo[k], photo, k))
    return items


def process_hike(slug: str, max_width: int, dry_run: bool, jobs: int, delay: float) -> dict:
    data_file = Path(f'hikes/{slug}/{slug}.data.json')
    if not data_file.exists():
        return {'slug': slug, 'error': f'missing {data_file}'}

    data = json.loads(data_file.read_text())
    images_dir = Path(f'hikes/{slug}/images')

    items = collect_urls(data)
    plan = []
    by_url: dict[str, list] = {}
    for url, container, key in items:
        if is_local(url):
            continue
        by_url.setdefault(url, []).append((container, key))

    for url, refs in by_url.items():
        dest = images_dir / filename_for(url)
        plan.append((url, dest, refs))

    results = {'slug': slug, 'ok': 0, 'cached': 0, 'failed': []}

    if dry_run:
        for url, dest, refs in plan:
            status = 'cached' if dest.exists() else 'would download'
            print(f'  {slug:30} | {status:18} | {dest.name} <- {url[:70]}')
        return results

    def task(item):
        url, dest, refs = item
        ok, msg = download_one(url, dest, max_width)
        return url, dest, refs, ok, msg

    if jobs == 1:
        outcomes = []
        for it in plan:
            outcomes.append(task(it))
            if delay > 0:
                time.sleep(delay)
    else:
        with ThreadPoolExecutor(max_workers=jobs) as ex:
            outcomes = [f.result() for f in as_completed([ex.submit(task, it) for it in plan])]

    for url, dest, refs, ok, msg in outcomes:
        if ok:
            if msg == 'cached':
                results['cached'] += 1
            else:
                results['ok'] += 1
            rel = './' + str(dest.relative_to(data_file.parent))
            for container, key in refs:
                container[key] = rel
        else:
            results['failed'].append({'url': url, 'msg': msg})

    if results['ok'] or results['cached']:
        data_file.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')

    return results


def main():
    p = ArgumentParser(description=__doc__, formatter_class=__import__('argparse').RawDescriptionHelpFormatter)
    p.add_argument('--slug', help='Process single hike')
    p.add_argument('--max-width', type=int, default=1600, help='Max image width (default 1600)')
    p.add_argument('--dry-run', action='store_true', help='Show plan, do not download')
    p.add_argument('--jobs', type=int, default=1, help='Parallel downloads (default 1; raise carefully — Wikimedia rate-limits)')
    p.add_argument('--delay', type=float, default=1.5, help='Seconds between sequential downloads (default 1.5)')
    args = p.parse_args()

    if args.slug:
        slugs = [args.slug]
    else:
        slugs = sorted([d.name for d in Path('hikes').iterdir()
                        if d.is_dir() and (d / f'{d.name}.data.json').exists()])

    print(f'Processing {len(slugs)} hike(s) with max_width={args.max_width}, jobs={args.jobs}, delay={args.delay}s\n')

    total_ok = total_cached = 0
    total_failed = []

    for slug in slugs:
        res = process_hike(slug, args.max_width, args.dry_run, args.jobs, args.delay)
        if 'error' in res:
            print(f'❌ {slug:30} | {res["error"]}')
            continue
        total_ok += res['ok']
        total_cached += res['cached']
        total_failed.extend([(slug, f) for f in res['failed']])
        status = f'{res["ok"]} new, {res["cached"]} cached'
        if res['failed']:
            status += f', {len(res["failed"])} FAILED'
            print(f'⚠️  {slug:30} | {status}')
            for f in res['failed']:
                print(f'     • {f["msg"]:20} | {f["url"][:80]}')
        else:
            print(f'✅ {slug:30} | {status}')

    print(f'\n{"=" * 70}')
    print(f'Downloaded: {total_ok} new, {total_cached} cached, {len(total_failed)} failed')
    if total_failed:
        print('\nFailed URLs (need manual replacement):')
        for slug, f in total_failed:
            print(f'  {slug:30} | {f["msg"]:20} | {f["url"]}')
        sys.exit(1)


if __name__ == '__main__':
    main()
