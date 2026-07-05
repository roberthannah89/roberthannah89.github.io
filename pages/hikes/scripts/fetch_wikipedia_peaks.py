"""Fetch Wikipedia lead-paragraph summaries for peaks that have a sitelink.

Uses the MediaWiki Action API (`/w/api.php`), which batches up to 50 titles
per request. That's ~35 requests total for the full corpus, sequential, no
concurrency — well inside every rate limit even from a residential IP.

Language priority: en > de > fr > it > rm (config.WIKIPEDIA_LANG_PREFERENCE).
Each peak is fetched from ONE Wikipedia — the first available language in
that order.

Also honours the OSM `wikipedia` tag ("lang:Title") on peaks that lack a
Wikidata Q-ID, so all named peaks with a Wikipedia article get a summary.

Result cached at scripts/cache/wikipedia-peaks.json — safe to delete + refetch.
Structure:

    {
      "fetched_at": "…",
      "peaks": {
        "Q3403": {
          "lang": "en",
          "title": "Dufourspitze",
          "extract": "The Dufourspitze is …",
          "thumbnail": "https://upload.wikimedia.org/…",
          "url": "https://en.wikipedia.org/wiki/Dufourspitze"
        },
        "osm:n414760065": { … }        # keyed by OSM ID when no Q-ID
      }
    }

Usage:
    python3 scripts/fetch_wikipedia_peaks.py           # use cache
    python3 scripts/fetch_wikipedia_peaks.py --refresh # force refetch
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import sys
import time
from pathlib import Path

import requests

import config

REPO_ROOT = Path(__file__).resolve().parent.parent
OVERPASS_CACHE = REPO_ROOT / "docs" / "prototypes" / "3d-trails" / "overpass-peaks.json"
WIKIDATA_CACHE = REPO_ROOT / "scripts" / "cache" / "wikidata-peaks.json"
OUT_CACHE = REPO_ROOT / "scripts" / "cache" / "wikipedia-peaks.json"

# MediaWiki Action API accepts up to 50 titles per request.
BATCH_SIZE = 50
# Polite delay between batch requests. Wikimedia's rate limits are per-IP
# per-endpoint — 1s spacing is trivially safe.
BETWEEN_BATCHES_S = 0.6
# Retry backoff for the rare 429 or 5xx.
RETRY_BACKOFF_S = [5, 15, 45]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def collect_targets() -> list[tuple[str, str, str]]:
    """(key, lang, title) tuples to fetch.

    `key` is either "Qxxxx" (from Wikidata) or "osm:n<id>" (OSM peaks with a
    wikipedia tag but no wikidata tag). Language chosen per peak by the
    first available in config.WIKIPEDIA_LANG_PREFERENCE order.
    """
    targets: list[tuple[str, str, str]] = []
    seen_qids: set[str] = set()

    # 1. Peaks with a Wikidata Q-ID → use the sitelinks Wikidata returned.
    if WIKIDATA_CACHE.exists():
        with WIKIDATA_CACHE.open() as f:
            wd = json.load(f)
        for qid, rec in wd.get("peaks", {}).items():
            wiki = rec.get("wikipedia") or {}
            for lang in config.WIKIPEDIA_LANG_PREFERENCE:
                if lang in wiki:
                    targets.append((qid, lang, wiki[lang]))
                    seen_qids.add(qid)
                    break

    # 2. OSM peaks with a wikipedia tag but no wikidata tag → parse "lang:Title".
    with OVERPASS_CACHE.open() as f:
        data = json.load(f)
    for e in data["elements"]:
        tags = e.get("tags") or {}
        qid = tags.get("wikidata")
        if qid in seen_qids:
            continue
        wp = tags.get("wikipedia")
        if not wp or ":" not in wp:
            continue
        lang, _, title = wp.partition(":")
        lang = lang.strip().lower()
        title = title.strip()
        if not title or lang not in config.WIKIPEDIA_LANG_PREFERENCE:
            continue
        key = f"osm:n{e['id']}"
        targets.append((key, lang, title))
    return targets


def fetch_batch(session: requests.Session, lang: str, titles: list[str]) -> dict[str, dict]:
    """Fetch one Action API batch. Returns {title (as returned): summary dict}.

    Some responses use a `normalized` block when Wikimedia rewrote our title
    (e.g. spaces → underscores, unicode normalisation) — the map lets the
    caller re-key by our original title.
    """
    params = {
        "action": "query",
        "prop": "extracts|pageimages",
        "exintro": 1,
        "explaintext": 1,
        "exlimit": "max",              # extract for every title in the batch
        "pilicense": "any",
        "pithumbsize": 320,
        "pilimit": "max",
        "redirects": 1,
        "titles": "|".join(titles),
        "format": "json",
        "formatversion": 2,
    }
    for attempt in range(len(RETRY_BACKOFF_S) + 1):
        try:
            r = session.get(
                f"https://{lang}.wikipedia.org/w/api.php",
                params=params, timeout=45,
            )
        except requests.RequestException as e:
            if attempt >= len(RETRY_BACKOFF_S):
                log(f"      [{lang}] network error {e} — giving up on batch")
                return {}
            time.sleep(RETRY_BACKOFF_S[attempt])
            continue
        if r.status_code == 429 or r.status_code >= 500:
            if attempt >= len(RETRY_BACKOFF_S):
                log(f"      [{lang}] HTTP {r.status_code} — giving up on batch")
                return {}
            retry_after = r.headers.get("Retry-After")
            wait = int(retry_after) if (retry_after and retry_after.isdigit()) \
                                    else RETRY_BACKOFF_S[attempt]
            log(f"      [{lang}] HTTP {r.status_code} — waiting {wait}s")
            time.sleep(wait)
            continue
        if r.status_code != 200:
            log(f"      [{lang}] HTTP {r.status_code} — skipping")
            return {}
        try:
            j = r.json()
        except ValueError:
            log(f"      [{lang}] non-JSON response: {r.text[:100]!r}")
            return {}

        # Build a normalisation map so callers can look up by original title.
        redirected: dict[str, str] = {}
        for n in (j.get("query", {}).get("normalized") or []):
            redirected[n["from"]] = n["to"]
        for n in (j.get("query", {}).get("redirects") or []):
            redirected[n["from"]] = n["to"]

        out: dict[str, dict] = {}
        for page in (j.get("query", {}).get("pages") or []):
            if page.get("missing"):
                continue
            title = page.get("title", "")
            extract = page.get("extract")
            if not extract:
                continue
            rec = {
                "lang": lang,
                "title": title,
                "extract": extract,
                "url": f"https://{lang}.wikipedia.org/wiki/"
                       + title.replace(" ", "_"),
            }
            thumb = page.get("thumbnail")
            if thumb and thumb.get("source"):
                rec["thumbnail"] = thumb["source"]
            # Key by the redirected/normalised title AND every source alias.
            out[title] = rec
            # Also add reverse lookups (from redirected/normalised → target).
            for src, dest in redirected.items():
                if dest == title:
                    out[src] = rec
        return out
    return {}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="ignore cache")
    parser.add_argument("--limit", type=int, help="stop after N peaks (smoke test)")
    args = parser.parse_args()

    if OUT_CACHE.exists() and not args.refresh:
        log(f"cache hit → {OUT_CACHE.relative_to(REPO_ROOT)}")
        return

    OUT_CACHE.parent.mkdir(parents=True, exist_ok=True)

    targets = collect_targets()
    if args.limit:
        targets = targets[:args.limit]
    log(f"[1/2] {len(targets)} Wikipedia summaries to fetch "
        f"(Action API, batch={BATCH_SIZE})")

    # Group by language so each Action API call hits one Wikipedia.
    by_lang: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
    for key, lang, title in targets:
        by_lang[lang].append((key, title))

    session = requests.Session()
    session.headers["User-Agent"] = config.WIKIPEDIA_USER_AGENT

    peaks: dict[str, dict] = {}
    t0 = time.time()
    total_batches = sum(
        (len(v) + BATCH_SIZE - 1) // BATCH_SIZE
        for v in by_lang.values()
    )
    batch_i = 0
    for lang in config.WIKIPEDIA_LANG_PREFERENCE:
        items = by_lang.get(lang) or []
        if not items:
            continue
        # Batch this language.
        for i in range(0, len(items), BATCH_SIZE):
            batch_i += 1
            chunk = items[i:i + BATCH_SIZE]
            titles = [t for _, t in chunk]
            result = fetch_batch(session, lang, titles)
            for key, title in chunk:
                # Try exact title, then redirect map, then title with underscores.
                rec = (result.get(title)
                       or result.get(title.replace("_", " "))
                       or result.get(title.replace(" ", "_")))
                if rec:
                    peaks[key] = rec
            log(f"      batch {batch_i}/{total_batches} "
                f"[{lang}] {len(chunk)} titles, "
                f"{len(peaks)} summaries so far, "
                f"{time.time() - t0:.0f}s elapsed")
            time.sleep(BETWEEN_BATCHES_S)

    log(f"[2/2] Writing {OUT_CACHE.relative_to(REPO_ROOT)}")
    payload = {
        "fetched_at": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "peaks": peaks,
    }
    with OUT_CACHE.open("w") as f:
        json.dump(payload, f, indent=1, ensure_ascii=False)
    log(f"      {len(peaks)}/{len(targets)} summaries kept in {time.time() - t0:.1f}s "
        f"({OUT_CACHE.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
