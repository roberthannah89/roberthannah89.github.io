"""Extract photo URLs from SAC route/peak data and update data.json.

The peak page has a single hero photo (best for summit/hero images).
The route JSON has a full photo gallery (best for trail/landscape shots).
This script combines both: peak hero first, then route gallery photos.

Usage
-----
    # Route photos only:
    python scripts/extract_sac_photos.py --json sac-route-4567.json --slug zindlenspitz

    # With peak hero image:
    python scripts/extract_sac_photos.py --json sac-route-4567.json --slug zindlenspitz \
        --peak-hero "https://...hero.jpg"
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def extract_photos(data: dict, peak_hero_url: str | None = None) -> list[dict]:
    photos = []

    if peak_hero_url:
        photos.append({
            "url": peak_hero_url,
            "lightbox_url": peak_hero_url,
            "alt": f"{data.get('destination_poi', {}).get('display_name', '')} — peak photo",
            "caption_html": f"<p>{data.get('destination_poi', {}).get('display_name', '')} — peak photo</p>",
        })

    for p in data.get("photos", []):
        photo = p.get("photo", {})
        thumbs = photo.get("thumbnails", {})
        photos.append({
            "url": thumbs.get("1200x750") or photo.get("url", ""),
            "lightbox_url": thumbs.get("1800x1125") or photo.get("url", ""),
            "alt": p.get("caption", ""),
            "caption_html": f"<p>{p.get('caption', '')}</p>",
        })
    return photos


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract SAC photo URLs into data.json")
    parser.add_argument("--json", type=Path, required=True, help="SAC route JSON file")
    parser.add_argument("--slug", required=True, help="Hike slug")
    parser.add_argument("--peak-hero", type=str, default=None,
                        help="Peak page hero image URL (from Playwright, takes first position)")
    args = parser.parse_args()

    with open(args.json, encoding="utf-8") as f:
        sac = json.load(f)

    photos = extract_photos(sac, args.peak_hero)
    if not photos:
        sys.exit("No photos found in SAC JSON.")

    copyright_holders = sorted({
        p.get("photo", {}).get("copyright", "?")
        for p in sac.get("photos", [])
    })
    attrib = f"All photos: {', '.join(copyright_holders)} / SAC Route Portal"

    repo_root = Path(__file__).resolve().parent.parent
    data_path = repo_root / "routes" / args.slug / f"{args.slug}.data.json"

    if not data_path.exists():
        sys.exit(f"data.json not found: {data_path}")

    with open(data_path, encoding="utf-8") as f:
        data = json.load(f)

    data["photos"] = photos
    data["photos_attrib_html"] = attrib

    if args.peak_hero:
        data["hero"]["image_url"] = args.peak_hero
        print(f"[sac-photos] Set hero image: {args.peak_hero}")

    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"[sac-photos] Updated {data_path}")
    print(f"[sac-photos] {len(photos)} photo(s), attribution: {attrib}")
    for i, p in enumerate(photos):
        print(f"  [{i}] {p['alt']}")
        print(f"      {p['url']}")


if __name__ == "__main__":
    main()
