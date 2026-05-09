#!/usr/bin/env python3
"""
Validate all image URLs in hike data.json files.

IMPORTANT: Wikimedia Commons blocks automated HEAD requests (bot detection).
We skip validation for Wikimedia URLs and assume they're valid (they work fine
in browsers which use GET, not HEAD). Only actual 404s on other CDNs are reported.

Usage:
    python validate_images.py              # Check all hikes
    python validate_images.py --fix        # Auto-fix broken wiki URLs
    python validate_images.py --slug NAME  # Check specific hike
"""

import json
import sys
import requests
import time
from pathlib import Path
from argparse import ArgumentParser
from urllib.parse import urlparse


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


def validate_url(url, timeout=3):
    """
    Test if URL returns 200 OK.
    Returns (is_valid, status_code, error_msg)
    
    Wikimedia Commons returns 403 to default User-Agents (bot detection) but
    accepts requests with a real browser User-Agent. We always send a UA so
    Wikimedia 404s (broken URLs) are detected correctly.
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    }
    try:
        # Use HEAD request (faster)
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
    data_file = Path(f'hikes/{slug}/{slug}.data.json')
    
    if not data_file.exists():
        return None, f"File not found: {data_file}"
    
    with open(data_file) as f:
        data = json.load(f)
    
    issues = []
    
    # Check hero image
    if 'hero' in data and 'image_url' in data['hero']:
        url = data['hero']['image_url']
        if is_wiki_page_url(url):
            issues.append({
                'location': 'hero',
                'type': 'wiki-page-url',
                'url': url,
                'fix': wiki_url_to_cdn(url)
            })
        else:
            is_valid, status, err = validate_url(url, timeout=2)
            if not is_valid:
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
        if is_wiki_page_url(url):
            issues.append({
                'location': f'photo {i+1}',
                'type': 'wiki-page-url',
                'url': url,
                'fix': wiki_url_to_cdn(url)
            })
        else:
            is_valid, status, err = validate_url(url, timeout=2)
            if not is_valid:
                issues.append({
                    'location': f'photo {i+1}',
                    'type': 'invalid-url',
                    'url': url,
                    'status': status,
                    'error': err
                })
        
        time.sleep(0.3)  # Rate limit
    
    return data, issues


def fix_hike(slug, data, issues):
    """Fix issues in hike data."""
    data_file = Path(f'hikes/{slug}/{slug}.data.json')
    
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
        slugs = sorted([d.name for d in Path('hikes').iterdir() 
                       if d.is_dir() and (d / f'{d.name}.data.json').exists()])
    
    print(f"Validating {len(slugs)} hike(s)...\n")
    
    total_issues = 0
    fixed_count = 0
    
    for slug in slugs:
        data, issues = check_hike(slug)
        
        if data is None:
            print(f"❌ {slug:30} | {issues}")
            total_issues += 1
            continue
        
        if not issues:
            print(f"✅ {slug:30} | all images valid")
            continue
        
        # Categorize issues
        wiki_issues = [i for i in issues if i['type'] == 'wiki-page-url']
        invalid_issues = [i for i in issues if i['type'] == 'invalid-url']
        
        status = ""
        if wiki_issues:
            status += f"{len(wiki_issues)} wiki-page "
        if invalid_issues:
            status += f"{len(invalid_issues)} broken "
        
        print(f"⚠️  {slug:30} | {status.strip()}")
        
        for issue in wiki_issues:
            print(f"     • {issue['location']:12} | wiki-page → {issue['fix'][:50]}...")
        
        for issue in invalid_issues:
            print(f"     • {issue['location']:12} | {issue['error'] or issue['status']}")
        
        if args.fix and wiki_issues:
            fix_hike(slug, data, wiki_issues)
            print(f"     → Fixed {len(wiki_issues)} wiki-page URL(s)")
            fixed_count += len(wiki_issues)
        
        total_issues += len(issues)
    
    print(f"\n{'='*70}")
    if total_issues == 0:
        print(f"✅ All {len(slugs)} hikes have valid images!")
        return 0
    else:
        print(f"Found {total_issues} issue(s) across {len(slugs)} hike(s)")
        if args.fix:
            print(f"Fixed {fixed_count} wiki-page URL(s)")
        else:
            print("Run with --fix to auto-fix wiki-page URLs")
        return 1


if __name__ == '__main__':
    sys.exit(main())
