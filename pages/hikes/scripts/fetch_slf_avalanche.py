#!/usr/bin/env python3
"""Fetch the current SLF avalanche bulletin and write ``slf-cache.js``.

Source: ``https://aws.slf.ch/api/bulletin/caaml/en/geojson`` — the official
EAWS CAAML V6.0 GeoJSON feed published by the WSL Institute for Snow and
Avalanche Research (SLF). Each feature aggregates one or more SLF
micro-regions sharing the same danger rating; geometry is a Polygon or
MultiPolygon in WGS84.

Off-season behaviour: SLF returns an empty ``FeatureCollection`` between
roughly mid-June and early November. We still write a valid (empty) cache
in that case so the front-end can render a "no active bulletin" state.

Raw upstream payload is also kept under ``scripts/cache/slf/`` for
reproducibility (per repo policy).

Usage::

    python scripts/fetch_slf_avalanche.py            # fetch live bulletin
    python scripts/fetch_slf_avalanche.py --active-at 2026-02-15T10:00Z
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Resolve repo paths regardless of cwd.
HIKES_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HIKES_ROOT / "scripts"))

from config import (  # noqa: E402  (sys.path bump above)
    SLF_BULLETIN_GEOJSON_URL,
    SLF_DANGER_LEVELS,
)

OUTPUT = HIKES_ROOT / "templates" / "_assets" / "hike_map" / "slf_cache.js"
CACHE_DIR = HIKES_ROOT / "scripts" / "cache" / "slf"

REQUEST_TIMEOUT = 30
MAX_RETRIES = 3
RETRY_BACKOFF = 2.0


def fetch_bulletin(active_at: str | None = None) -> dict:
    """Download the SLF GeoJSON bulletin. Returns the parsed JSON."""
    url = SLF_BULLETIN_GEOJSON_URL
    if active_at:
        url += "?" + urllib.parse.urlencode({"activeAt": active_at})

    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "hikes-website/1.0 (https://github.com)",
                },
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                payload = json.load(resp)
            return payload
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            wait = RETRY_BACKOFF * (2**attempt)
            print(
                f"  Network error ({e}); retry {attempt + 2}/{MAX_RETRIES} in {wait:.0f}s...",
                file=sys.stderr,
            )
            time.sleep(wait)
    raise RuntimeError(f"SLF fetch failed after {MAX_RETRIES} retries: {last_err}")


def save_raw(payload: dict) -> Path:
    """Save the raw upstream GeoJSON under scripts/cache/slf/ for reproducibility."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    iso = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    raw_path = CACHE_DIR / f"bulletin-{iso}.geojson"
    raw_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return raw_path


def _danger_int(rating: dict) -> int:
    """Map a CAAML mainValue keyword ('considerable' etc.) to 1-5."""
    main = (rating.get("mainValue") or "").lower()
    return SLF_DANGER_LEVELS.get(main, 0)


def _primary_rating(props: dict) -> dict | None:
    """Pick a representative dangerRating for this feature.

    SLF features may carry multiple ratings split by validTimePeriod
    (``earlier`` / ``later`` / ``all_day``) or by elevation band. We prefer
    ``all_day``, fall back to the highest-danger entry otherwise.
    """
    ratings = props.get("dangerRatings") or []
    if not ratings:
        return None
    all_day = [r for r in ratings if r.get("validTimePeriod") == "all_day"]
    pool = all_day or ratings
    return max(pool, key=_danger_int)


def transform(payload: dict) -> list[dict]:
    """Convert SLF features → compact regions list for the front-end."""
    regions: list[dict] = []
    for idx, feature in enumerate(payload.get("features") or []):
        geometry = feature.get("geometry")
        if not geometry:
            continue
        props = feature.get("properties") or {}
        rating = _primary_rating(props)
        if not rating:
            continue
        danger = _danger_int(rating)
        if danger == 0:
            continue
        # Pull subdivision (-/neutral/+) used by SLF for half-step grading.
        subdivision = (
            ((rating.get("customData") or {}).get("CH") or {}).get("subdivision")
        )
        # Pluralised region name: feature aggregates many micro-regions, so list
        # the first few in the popup. Names are German originals from SLF.
        region_names = [r.get("name") for r in (props.get("regions") or []) if r.get("name")]
        label_parts = [_danger_label(danger)]
        if subdivision in ("plus", "minus"):
            label_parts.append("+" if subdivision == "plus" else "−")
        label = " ".join(label_parts)
        regions.append({
            "id": props.get("bulletinID") or f"feature-{idx}",
            "name": ", ".join(region_names[:3]) + ("…" if len(region_names) > 3 else ""),
            "regionCount": len(region_names),
            "regionIDs": [r.get("regionID") for r in (props.get("regions") or []) if r.get("regionID")],
            "danger": danger,
            "subdivision": subdivision,
            "label": label,
            "validTime": props.get("validTime"),
            "geometry": geometry,
        })
    return regions


def _danger_label(level: int) -> str:
    # Imported lazily to keep config dependency confined to module top.
    from config import SLF_DANGER_LABELS

    return SLF_DANGER_LABELS.get(level, "Unknown")


def write_cache(payload: dict, regions: list[dict], active_at: str | None) -> None:
    """Write templates/_assets/hike_map/slf_cache.js as window.SLF_CACHE globals."""
    iso_now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    # Extract publicationTime from the first feature if present — that's the
    # "real" bulletin time, while iso_now is just when we fetched it.
    pub_time = None
    features = payload.get("features") or []
    if features:
        pub_time = (features[0].get("properties") or {}).get("publicationTime")

    meta = {
        "updated": iso_now,
        "publicationTime": pub_time,
        "source": SLF_BULLETIN_GEOJSON_URL,
        "activeAt": active_at,
        "regionCount": len(regions),
    }
    body = (
        "// Auto-generated by scripts/fetch_slf_avalanche.py — do not edit.\n"
        "// Source: SLF / WSL Institute for Snow and Avalanche Research.\n"
        f"// Endpoint: {SLF_BULLETIN_GEOJSON_URL}\n"
        f"window.SLF_CACHE_META = {json.dumps(meta, ensure_ascii=False)};\n"
        f"window.SLF_CACHE = {json.dumps({'regions': regions}, ensure_ascii=False, separators=(',', ':'))};\n"
    )
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(body, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--active-at",
        help="ISO-8601 timestamp passed to SLF as activeAt (defaults to live now). "
        "Useful for testing the schema in off-season — e.g. 2026-02-15T10:00Z.",
    )
    parser.add_argument(
        "--no-save-raw",
        action="store_true",
        help="Skip saving the raw upstream GeoJSON to scripts/cache/slf/.",
    )
    args = parser.parse_args()

    print(f"Fetching SLF bulletin from {SLF_BULLETIN_GEOJSON_URL}"
          + (f" (activeAt={args.active_at})" if args.active_at else " (live)"))
    payload = fetch_bulletin(args.active_at)
    n_features = len(payload.get("features") or [])
    print(f"  Received {n_features} feature(s)")

    if not args.no_save_raw:
        raw_path = save_raw(payload)
        print(f"  Raw payload saved → {raw_path.relative_to(HIKES_ROOT)}")

    regions = transform(payload)
    write_cache(payload, regions, args.active_at)
    if regions:
        by_level: dict[int, int] = {}
        for r in regions:
            by_level[r["danger"]] = by_level.get(r["danger"], 0) + 1
        breakdown = ", ".join(
            f"L{lvl}={cnt}" for lvl, cnt in sorted(by_level.items())
        )
        print(f"  Cached {len(regions)} region group(s): {breakdown}")
    else:
        print("  No active bulletin (off-season). Empty cache written.")
    size_kb = OUTPUT.stat().st_size / 1024
    print(f"Written {OUTPUT.relative_to(HIKES_ROOT)} ({size_kb:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
