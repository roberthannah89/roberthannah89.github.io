"""Fetch Wikidata enrichment for Swiss peaks that carry a Q-ID on OSM.

Reads Q-IDs from the cached OSM Overpass dump (docs/prototypes/3d-trails/
overpass-peaks.json) and issues batched SPARQL queries against the public
query.wikidata.org endpoint, collecting:

  - P2660 topographic prominence (metres, integer)
  - P2659 topographic isolation (kilometres, float)
  - P2044 elevation (metres, float; authoritative — may differ from OSM ele)
  - P18   image (Commons filename; caller builds the URL)
  - P361  part of (parent range/massif; English labels, GROUP_CONCAT)
  - P793  significant event → Q10480714 (first ascent), with:
              P585 point in time (ISO date)
              P710 participants (English labels, GROUP_CONCAT)
  - Wikipedia sitelinks (title per language: en, de, fr, it, rm)

Result cached at scripts/cache/wikidata-peaks.json — safe to delete +
refetch. Structure:

    {
      "fetched_at": "2026-07-05T12:34:56Z",
      "endpoint": "https://query.wikidata.org/sparql",
      "peaks": {
        "Q3403": {
          "prominence_m": 2165,
          "isolation_km": 1148.3,
          "ele_m": 4634,
          "image": "Punta_Dufour_(2022).jpg",
          "part_of": ["Monte Rosa"],
          "first_ascent": {"date": "1855-08-01",
                           "climbers": ["Charles Hudson", ...]},
          "wikipedia": {"en": "Monte Rosa", "de": "Dufourspitze", ...}
        }, ...
      }
    }

Usage:
    python3 scripts/fetch_wikidata_peaks.py           # use cache when present
    python3 scripts/fetch_wikidata_peaks.py --refresh # force full refetch
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

import requests

import config

REPO_ROOT = Path(__file__).resolve().parent.parent
OVERPASS_CACHE = REPO_ROOT / "docs" / "prototypes" / "3d-trails" / "overpass-peaks.json"
OUT_CACHE = REPO_ROOT / "scripts" / "cache" / "wikidata-peaks.json"

# Wikidata item for the "first ascent" event type — used to filter P793 claims.
Q_FIRST_ASCENT = "Q10480714"

SPARQL_TEMPLATE = """
SELECT ?item
       (SAMPLE(?_prom) AS ?prom)
       (SAMPLE(?_iso)  AS ?iso)
       (SAMPLE(?_ele)  AS ?ele)
       (SAMPLE(?_img)  AS ?img)
       (GROUP_CONCAT(DISTINCT ?_partOfLabel; separator="||") AS ?partOfLabels)
       (SAMPLE(?_faDate)  AS ?faDate)
       (GROUP_CONCAT(DISTINCT ?_climberLabel; separator="||") AS ?climbers)
       (SAMPLE(?_enWiki) AS ?enWiki)
       (SAMPLE(?_deWiki) AS ?deWiki)
       (SAMPLE(?_frWiki) AS ?frWiki)
       (SAMPLE(?_itWiki) AS ?itWiki)
       (SAMPLE(?_rmWiki) AS ?rmWiki)
WHERE {
  VALUES ?item { %(values)s }
  OPTIONAL { ?item wdt:P2660 ?_prom . }
  OPTIONAL { ?item wdt:P2659 ?_iso . }
  OPTIONAL { ?item wdt:P2044 ?_ele . }
  OPTIONAL { ?item wdt:P18   ?_img . }
  OPTIONAL {
    ?item wdt:P361 ?_partOf .
    ?_partOf rdfs:label ?_partOfLabel .
    FILTER(LANG(?_partOfLabel) = "en") .
  }
  OPTIONAL {
    ?item p:P793 ?_ev .
    ?_ev  ps:P793 wd:%(first_ascent_q)s .
    OPTIONAL { ?_ev pq:P585 ?_faDate . }
    OPTIONAL {
      ?_ev pq:P710 ?_climber .
      ?_climber rdfs:label ?_climberLabel .
      FILTER(LANG(?_climberLabel) = "en") .
    }
  }
  OPTIONAL { ?_enWiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?_deWiki schema:about ?item ; schema:isPartOf <https://de.wikipedia.org/> . }
  OPTIONAL { ?_frWiki schema:about ?item ; schema:isPartOf <https://fr.wikipedia.org/> . }
  OPTIONAL { ?_itWiki schema:about ?item ; schema:isPartOf <https://it.wikipedia.org/> . }
  OPTIONAL { ?_rmWiki schema:about ?item ; schema:isPartOf <https://rm.wikipedia.org/> . }
}
GROUP BY ?item
""".strip()


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def load_qids() -> list[str]:
    with OVERPASS_CACHE.open() as f:
        data = json.load(f)
    qids: set[str] = set()
    for e in data["elements"]:
        qid = (e.get("tags") or {}).get("wikidata")
        if qid and qid.startswith("Q") and qid[1:].isdigit():
            qids.add(qid)
    return sorted(qids, key=lambda q: int(q[1:]))


def run_sparql(qids: list[str], attempt: int = 0) -> list[dict]:
    values = " ".join(f"wd:{q}" for q in qids)
    query = SPARQL_TEMPLATE % {
        "values": values,
        "first_ascent_q": Q_FIRST_ASCENT,
    }
    resp = requests.post(
        config.WIKIDATA_SPARQL_ENDPOINT,
        data={"query": query, "format": "json"},
        headers={
            "User-Agent": config.WIKIDATA_USER_AGENT,
            "Accept": "application/sparql-results+json",
        },
        timeout=120,
    )
    if resp.status_code == 429 or resp.status_code >= 500:
        if attempt >= 4:
            resp.raise_for_status()
        wait = 5 * (2 ** attempt)
        log(f"      HTTP {resp.status_code} — retrying in {wait}s (attempt {attempt + 1})")
        time.sleep(wait)
        return run_sparql(qids, attempt + 1)
    resp.raise_for_status()
    return resp.json()["results"]["bindings"]


def _uri_qid(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


def _wiki_title(uri: str) -> str:
    # https://en.wikipedia.org/wiki/Foo → Foo
    return requests.utils.unquote(uri.rsplit("/", 1)[-1].replace("_", " "))


def _commons_filename(uri: str) -> str:
    # http://commons.wikimedia.org/wiki/Special:FilePath/Foo.jpg → Foo.jpg
    return requests.utils.unquote(uri.rsplit("/", 1)[-1])


def _to_int(s: str | None) -> int | None:
    if s is None:
        return None
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def _to_float(s: str | None) -> float | None:
    if s is None:
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def parse_bindings(bindings: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for b in bindings:
        qid = _uri_qid(b["item"]["value"])
        rec: dict = {}

        prom = _to_int(b.get("prom", {}).get("value"))
        if prom is not None:
            rec["prominence_m"] = prom

        iso = _to_float(b.get("iso", {}).get("value"))
        if iso is not None:
            rec["isolation_km"] = round(iso, 3)

        ele = _to_float(b.get("ele", {}).get("value"))
        if ele is not None:
            rec["ele_m"] = round(ele, 1)

        img = b.get("img", {}).get("value")
        if img:
            rec["image"] = _commons_filename(img)

        part_of_raw = b.get("partOfLabels", {}).get("value") or ""
        part_of = [s for s in part_of_raw.split("||") if s]
        if part_of:
            rec["part_of"] = part_of

        fa_date = b.get("faDate", {}).get("value")
        climbers_raw = b.get("climbers", {}).get("value") or ""
        climbers = [s for s in climbers_raw.split("||") if s]
        if fa_date or climbers:
            fa: dict = {}
            if fa_date:
                # Wikidata dates are ISO 8601 with a trailing "Z" and a
                # +/-precision hint we don't need for display.
                fa["date"] = fa_date.split("T", 1)[0].lstrip("+")
            if climbers:
                fa["climbers"] = climbers
            rec["first_ascent"] = fa

        wiki: dict[str, str] = {}
        for lang in ("en", "de", "fr", "it", "rm"):
            uri = b.get(f"{lang}Wiki", {}).get("value")
            if uri:
                wiki[lang] = _wiki_title(uri)
        if wiki:
            rec["wikipedia"] = wiki

        out[qid] = rec
    return out


def batch(items: list[str], size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="ignore cache")
    parser.add_argument("--limit", type=int, help="stop after N Q-IDs (for smoke testing)")
    args = parser.parse_args()

    if OUT_CACHE.exists() and not args.refresh:
        log(f"cache hit → {OUT_CACHE.relative_to(REPO_ROOT)} (use --refresh to refetch)")
        return

    OUT_CACHE.parent.mkdir(parents=True, exist_ok=True)

    qids = load_qids()
    if args.limit:
        qids = qids[:args.limit]
    log(f"[1/2] {len(qids)} Q-IDs to fetch from {config.WIKIDATA_SPARQL_ENDPOINT}")

    peaks: dict[str, dict] = {}
    t0 = time.time()
    for i, chunk in enumerate(batch(qids, config.WIKIDATA_BATCH_SIZE), 1):
        n_batches = (len(qids) + config.WIKIDATA_BATCH_SIZE - 1) // config.WIKIDATA_BATCH_SIZE
        log(f"      batch {i}/{n_batches} ({len(chunk)} Q-IDs)…")
        bindings = run_sparql(chunk)
        peaks.update(parse_bindings(bindings))
        # Be polite between batches.
        time.sleep(1.5)

    log(f"[2/2] Writing {OUT_CACHE.relative_to(REPO_ROOT)}")
    payload = {
        "fetched_at": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "endpoint": config.WIKIDATA_SPARQL_ENDPOINT,
        "peaks": peaks,
    }
    with OUT_CACHE.open("w") as f:
        json.dump(payload, f, indent=1, ensure_ascii=False)
    log(f"      {len(peaks)} peaks enriched in {time.time() - t0:.1f}s "
        f"({OUT_CACHE.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
