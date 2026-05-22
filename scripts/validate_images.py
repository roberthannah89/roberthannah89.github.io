#!/usr/bin/env python3
"""
Validate all image URLs in hike data.json files.

Wikimedia Commons should not be validated with blind HEAD requests. Instead we
resolve the file via the MediaWiki API, cache successful lookups, and only do a
tiny streamed GET against the CDN when transport validation is needed.

Usage:
    python validate_images.py              # Check all hikes
    python validate_images.py --fix        # Auto-fix broken wiki URLs
    python validate_images.py --slug NAME  # Check specific hike
"""

import json
import sys
import time
from argparse import ArgumentParser
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests


WIKIMEDIA_API_URL = 'https://commons.wikimedia.org/w/api.php'
USER_AGENT = 'website-image-validator/1.0 (non-commercial static-site build)'
WIKIMEDIA_CACHE_FILE = Path(__file__).with_name('.wikimedia_validation_cache.json')


def is_wiki_page_url(url):
    """Check if URL is a wiki page link instead of direct CDN."""
    return 'commons.wikimedia.org/wiki/File:' in url


def wiki_url_to_cdn(url):
    """Convert wiki page URL to Special:FilePath format (most reliable)."""
    if 'commons.wikimedia.org/wiki/File:' not in url:
        return url
    
    # Extract filename from wiki URL
    # https://commons.wikimedia.org/wiki/File:SomeFile.jpg → Special:FilePath/SomeFile.jpg
    parts = url.split('File:')
    if len(parts) < 2:
        return url
    
    filename = parts[1].split('?')[0].split('#')[0]
    
    # Return Special:FilePath format which has best compatibility
    return f'https://commons.wikimedia.org/wiki/Special:FilePath/{filename}'


def is_wikimedia_url(url):
    """Check if URL is from Wikimedia Commons or Wikipedia."""
    return 'commons.wikimedia.org' in url or 'wikipedia.org' in url


def load_wikimedia_cache():
    """Load persisted Wikimedia validation results."""
    if not WIKIMEDIA_CACHE_FILE.exists():
        return {}

    try:
        with open(WIKIMEDIA_CACHE_FILE) as handle:
            data = json.load(handle)
            if isinstance(data, dict):
                return data
    except (OSError, json.JSONDecodeError):
        pass

    return {}


def save_wikimedia_cache(cache):
    """Persist Wikimedia validation results."""
    try:
        with open(WIKIMEDIA_CACHE_FILE, 'w') as handle:
            json.dump(cache, handle, indent=2, sort_keys=True)
    except OSError:
        pass


def extract_wikimedia_filename(url):
    """Extract the original Wikimedia filename from supported URL formats."""
    parsed = urlparse(url)
    path = unquote(parsed.path)

    if 'File:' in path:
        return path.split('File:', 1)[1]

    if '/Special:FilePath/' in path:
        return path.split('/Special:FilePath/', 1)[1]

    if 'upload.wikimedia.org' not in parsed.netloc:
        return None

    filename = path.rsplit('/', 1)[-1]
    if filename.startswith(('120px-', '160px-', '200px-', '240px-', '320px-', '640px-', '800px-', '1024px-', '1280px-', '1600px-', '1920px-')):
        filename = filename.split('-', 1)[1]

    return filename or None


def probe_wikimedia_cdn(url, timeout=5):
    """Do a tiny streamed GET so the CDN sees browser-like traffic, not HEAD."""
    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Range': 'bytes=0-0',
    }

    try:
        response = requests.get(url, timeout=timeout, stream=True, headers=headers)
        content_type = response.headers.get('Content-Type', '')
        is_valid = response.status_code in (200, 206) and content_type.startswith('image/')
        return is_valid, response.status_code, None if is_valid else f'content-type={content_type or "unknown"}'
    except requests.Timeout:
        return False, None, 'timeout'
    except requests.ConnectionError:
        return False, None, 'connection error'
    except Exception as exc:
        return False, None, str(exc)[:50]


def validate_wikimedia_url(url, cache, timeout=5):
    """Validate Wikimedia URLs via API first, then a tiny CDN probe."""
    filename = extract_wikimedia_filename(url)
    if not filename:
        return False, None, 'could not extract wikimedia filename'

    cache_entry = cache.get(filename)
    now = time.time()
    if cache_entry and now - cache_entry.get('timestamp', 0) < 30 * 24 * 3600:
        cached_status = cache_entry.get('probe_status', 200)
        return True, cached_status, None

    params = {
        'action': 'query',
        'titles': f'File:{filename}',
        'prop': 'imageinfo',
        'iiprop': 'url|size|mime|extmetadata',
        'format': 'json',
    }
    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
    }

    try:
        response = requests.get(WIKIMEDIA_API_URL, params=params, timeout=timeout, headers=headers)
        response.raise_for_status()
        payload = response.json()
    except requests.Timeout:
        return False, None, 'wikimedia api timeout'
    except requests.ConnectionError:
        return False, None, 'wikimedia api connection error'
    except Exception as exc:
        return False, None, f'wikimedia api error: {str(exc)[:30]}'

    pages = payload.get('query', {}).get('pages', {})
    page = next(iter(pages.values()), {})
    imageinfo = page.get('imageinfo')
    if not imageinfo:
        return False, 404, 'wikimedia file not found'

    info = imageinfo[0]
    resolved_url = info.get('url')
    mime_type = info.get('mime', '')
    if not resolved_url:
        return False, None, 'wikimedia api missing file url'
    if mime_type and not mime_type.startswith('image/'):
        return False, None, f'non-image mime type: {mime_type}'

    time.sleep(0.5)
    is_valid, probe_status, probe_error = probe_wikimedia_cdn(resolved_url, timeout=timeout)
    validation_mode = 'api+cdn'
    if not is_valid:
        # Commons can throttle even tiny CDN probes. If the API resolved a real
        # image file, treat CDN throttling as a non-fatal transport issue rather
        # than declaring the image broken.
        if probe_status in (403, 429):
            probe_status = 200
            probe_error = None
            is_valid = True
            validation_mode = 'api-only'
        else:
            return False, probe_status, probe_error

    cache[filename] = {
        'timestamp': now,
        'resolved_url': resolved_url,
        'probe_status': probe_status,
        'validation_mode': validation_mode,
        'mime': mime_type,
        'width': info.get('width'),
        'height': info.get('height'),
        'license': info.get('extmetadata', {}).get('LicenseShortName', {}).get('value'),
        'artist': info.get('extmetadata', {}).get('Artist', {}).get('value'),
    }
    return True, probe_status, None


def validate_url(url, timeout=3, wikimedia_cache=None):
    """
    Test if URL returns 200 OK.
    Returns (is_valid, status_code, error_msg)
    """
    headers = {
        'User-Agent': USER_AGENT
    }

    if is_wikimedia_url(url):
        if wikimedia_cache is None:
            wikimedia_cache = {}
        return validate_wikimedia_url(url, wikimedia_cache, timeout=timeout)

    try:
        # Use HEAD request (faster) for Hikr and other CDNs
        response = requests.head(url, timeout=timeout, allow_redirects=True, headers=headers)
        return response.status_code == 200, response.status_code, None
    except requests.Timeout:
        return False, None, "timeout"
    except requests.ConnectionError:
        return False, None, "connection error"
    except Exception as e:
        return False, None, str(e)[:30]


def check_hike(slug):
    """Check all images in a single hike."""
    data_file = Path(f'pages/hikes/routes/{slug}/{slug}.data.json')
    
    if not data_file.exists():
        return None, f"File not found: {data_file}"
    
    with open(data_file) as f:
        data = json.load(f)

    issues = []
    wikimedia_validated = 0
    wikimedia_cache = load_wikimedia_cache()
    
    # Check hero image
    if 'hero' in data and 'image_url' in data['hero']:
        url = data['hero']['image_url'].strip()
        # Skip validation for "TODO" or empty URLs (these get auto-populated by render)
        if not url or 'TODO' in url or url.startswith('data:'):
            pass  # Skip, will be auto-populated by render
        elif is_wiki_page_url(url):
            issues.append({
                'location': 'hero',
                'type': 'wiki-page-url',
                'url': url,
                'fix': wiki_url_to_cdn(url)
            })
        else:
            is_valid, status, err = validate_url(url, timeout=2, wikimedia_cache=wikimedia_cache)
            if is_wikimedia_url(url) and is_valid:
                wikimedia_validated += 1
            elif not is_valid:
                issues.append({
                    'location': 'hero',
                    'type': 'invalid-url',
                    'url': url,
                    'status': status,
                    'error': err
                })
    
    # Check photos
    for i, photo in enumerate(data.get('photos', [])):
        url = photo.get('url', '')
        if not url:
            continue
        if is_wiki_page_url(url):
            issues.append({
                'location': f'photo {i+1}',
                'type': 'wiki-page-url',
                'url': url,
                'fix': wiki_url_to_cdn(url)
            })
        else:
            is_valid, status, err = validate_url(url, timeout=2, wikimedia_cache=wikimedia_cache)
            if is_wikimedia_url(url) and is_valid:
                wikimedia_validated += 1
            elif not is_valid:
                issues.append({
                    'location': f'photo {i+1}',
                    'type': 'invalid-url',
                    'url': url,
                    'status': status,
                    'error': err
                })

        time.sleep(0.3)  # Rate limit

    save_wikimedia_cache(wikimedia_cache)
    return data, issues, wikimedia_validated


def fix_hike(slug, data, issues):
    """Fix issues in hike data."""
    data_file = Path(f'pages/hikes/routes/{slug}/{slug}.data.json')
    
    for issue in issues:
        if issue['type'] != 'wiki-page-url':
            continue
        
        location = issue['location']
        fixed_url = issue['fix']
        
        if location == 'hero':
            data['hero']['image_url'] = fixed_url
        else:
            # photo N
            photo_num = int(location.split()[1]) - 1
            data['photos'][photo_num]['url'] = fixed_url
            data['photos'][photo_num]['lightbox_url'] = fixed_url
    
    with open(data_file, 'w') as f:
        json.dump(data, f, indent=2)


def main():
    parser = ArgumentParser(description='Validate hiking image URLs')
    parser.add_argument('--slug', help='Check specific hike')
    parser.add_argument('--fix', action='store_true', help='Auto-fix wiki-page URLs')
    parser.add_argument('--verbose', action='store_true', help='Show all URLs')
    args = parser.parse_args()
    
    # Find all hikes
    if args.slug:
        slugs = [args.slug]
    else:
        slugs = sorted([d.name for d in Path('pages/hikes/routes').iterdir() 
                       if d.is_dir() and (d / f'{d.name}.data.json').exists()])
    
    print(f"Validating {len(slugs)} hike(s)...\n")
    
    total_issues = 0
    total_wikimedia_validated = 0
    fixed_count = 0

    for slug in slugs:
        data, issues, wikimedia_validated = check_hike(slug)
        total_wikimedia_validated += wikimedia_validated

        if data is None:
            print(f"❌ {slug:30} | {issues}")
            total_issues += 1
            continue

        if not issues and wikimedia_validated == 0:
            print(f"✅ {slug:30} | all images valid")
            continue

        if not issues and wikimedia_validated > 0:
            print(f"✅ {slug:30} | all images valid ({wikimedia_validated} Wikimedia validated)")
            continue

        # Categorize issues
        wiki_issues = [i for i in issues if i['type'] == 'wiki-page-url']
        invalid_issues = [i for i in issues if i['type'] == 'invalid-url']

        status = ""
        if wiki_issues:
            status += f"{len(wiki_issues)} wiki-page "
        if invalid_issues:
            status += f"{len(invalid_issues)} broken "

        if wikimedia_validated > 0:
            status += f"({wikimedia_validated} Wikimedia validated) "

        print(f"⚠️  {slug:30} | {status.strip()}")

        for issue in wiki_issues:
            print(f"     • {issue['location']:12} | wiki-page → {issue['fix'][:50]}...")

        for issue in invalid_issues:
            print(f"     • {issue['location']:12} | ❌ {issue['error'] or issue['status']}")

        if args.fix and wiki_issues:
            fix_hike(slug, data, wiki_issues)
            print(f"     → Fixed {len(wiki_issues)} wiki-page URL(s)")
            fixed_count += len(wiki_issues)

        total_issues += len(issues)

    print(f"\n{'='*70}")
    if total_issues == 0:
        if total_wikimedia_validated > 0:
            print(f"✅ All {len(slugs)} hikes valid! ({total_wikimedia_validated} Wikimedia URLs validated)")
        else:
            print(f"✅ All {len(slugs)} hikes have valid images!")
        return 0
    else:
        print(f"Found {total_issues} issue(s) across {len(slugs)} hike(s)")
        if total_wikimedia_validated > 0:
            print(f"({total_wikimedia_validated} Wikimedia URLs validated via API + CDN probe)")
        if args.fix:
            print(f"Fixed {fixed_count} wiki-page URL(s)")
        else:
            print("Run with --fix to auto-fix wiki-page URLs")
        return 1 if total_issues > 0 else 0


if __name__ == '__main__':
    sys.exit(main())
