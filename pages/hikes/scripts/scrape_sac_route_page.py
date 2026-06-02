"""Scrape rich metadata from an authenticated SAC route page.

After the 2026-06 architecture migration, the old monolithic JSON is gone;
the metadata that used to live there now sits in the HTML page itself.
This script reads that HTML (either from disk or fetched live with a cookie)
and produces a structured ``dict`` plus an optional patch applied to a
``<slug>.data.json``.

Reliable hooks on the new (English) page template:

  * ``<meta property="og:title|og:image|og:description">``
  * ``<dl>`` blocks with ``<dt>`` label + ``<dd>`` value for Difficulty,
    Ascent, Descent, Walking time, Departure point
  * ``<img src="/processed/...">`` for the photo gallery
  * The first long ``<p>`` after the route title is the teaser/description

Run ``--inspect`` to see exactly what was scraped without touching anything.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("ERROR: beautifulsoup4 is required. pip install beautifulsoup4")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_sac_route import DEFAULT_COOKIE_FILE, _load_cookie  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

# Regexes for the structured value strings the page renders.
_ASCENT_RE = re.compile(r"(?P<h>\d+):(?P<m>\d+)\s*h.*?(?P<gain>\d+)\s*m", re.I)
_TIME_RE = re.compile(r"(\d+):(\d+)\s*h", re.I)
_ELEV_PARENS_RE = re.compile(r"\((\d+)\s*m\)")


@dataclass
class ScrapedRoute:
    title: str | None = None
    teaser: str | None = None
    description_html: str | None = None
    hero_image_url: str | None = None
    difficulty: str | None = None       # e.g. "T4-"
    ascent_time_min: int | None = None  # minutes
    ascent_gain_m: int | None = None
    descent_time_min: int | None = None
    descent_drop_m: int | None = None
    departure_name: str | None = None
    departure_elev_m: int | None = None
    departure_transport: str | None = None  # "Bus" / "Train" / etc.
    segments: list[str] = field(default_factory=list)
    photos: list[dict] = field(default_factory=list)


def _meta(soup: BeautifulSoup, prop: str) -> str | None:
    tag = soup.find("meta", attrs={"property": prop}) or soup.find("meta", attrs={"name": prop})
    return tag.get("content", "").strip() if tag else None


def _dt_dd_lookup(soup: BeautifulSoup, label: str) -> str | None:
    """Find the <dd> sibling of a <dt> whose stripped text == label."""
    for dt in soup.find_all("dt"):
        if dt.get_text(strip=True) == label:
            dd = dt.find_next_sibling("dd")
            if dd:
                return re.sub(r"\s+", " ", dd.get_text(separator=" ", strip=True)).strip()
    return None


def _parse_time_gain(s: str) -> tuple[int | None, int | None]:
    """Parse 'H:MM h, NNN m' → (minutes, metres)."""
    if not s:
        return None, None
    m = _ASCENT_RE.search(s)
    if not m:
        # Sometimes only one or the other
        tm = _TIME_RE.search(s)
        gm = re.search(r"(\d+)\s*m\b", s)
        time_min = int(tm.group(1)) * 60 + int(tm.group(2)) if tm else None
        gain = int(gm.group(1)) if gm else None
        return time_min, gain
    return int(m.group("h")) * 60 + int(m.group("m")), int(m.group("gain"))


def _parse_departure(raw: str) -> tuple[str | None, int | None]:
    """Pull 'Name (NNN m)' out; ignore the 'Show on map' / 'Get there' chrome that follows."""
    if not raw:
        return None, None
    # Truncate at known chrome strings
    for cut in ["Show on map", "Get there", "Google Maps", "View on map"]:
        if cut in raw:
            raw = raw.split(cut, 1)[0]
    raw = raw.strip(" ,;")
    m = _ELEV_PARENS_RE.search(raw)
    elev = int(m.group(1)) if m else None
    name = _ELEV_PARENS_RE.sub("", raw).strip(" ,;") or None
    return name, elev


def _detect_transport(soup: BeautifulSoup) -> str | None:
    """Look for the SVG icon class next to the departure point: bus / train / boat."""
    for cls in ["bus", "train", "boat", "tram", "cable_car"]:
        if soup.find(class_=re.compile(rf"\b{cls}\b")):
            return cls.replace("_", " ").title()
    return None


def _extract_photos(soup: BeautifulSoup) -> list[dict]:
    """Collect unique `/processed/` image URLs and their captions where available."""
    seen: set[str] = set()
    out: list[dict] = []
    for img in soup.find_all("img"):
        src = (img.get("src") or "").strip()  # SAC's `src` attrs sometimes have leading/trailing whitespace
        if "/processed/" not in src:
            continue
        url = src if src.startswith("http") else "https://www.sac-cas.ch" + src
        # Strip query string for dedup; SAC adds image-processing params per render.
        key = url.split("?", 1)[0]
        if key in seen:
            continue
        seen.add(key)
        caption = (img.get("alt") or "").strip()
        out.append({
            "url": url,
            "lightbox_url": url,
            "alt": caption or "Route photo (SAC)",
            "caption_html": f"<p>{caption}</p>" if caption else "",
        })
    return out


def _extract_description(soup: BeautifulSoup, teaser: str | None) -> str | None:
    """Build a multi-paragraph HTML description from the first long article-body paragraphs.

    The og:description is server-truncated mid-sentence; prefer body <p> tags. Skip
    paragraphs that look like the segment list (e.g. 'A - B, T3, 2 Std. 45 Min.').
    """
    paragraphs: list[str] = []
    seg_pattern = re.compile(r"T[1-6][+\-]?\s*,|\d+\s*Std\.|\d+\s*Min\.")
    for p in soup.find_all("p"):
        txt = re.sub(r"\s+", " ", p.get_text(strip=True))
        if not txt or len(txt) < 60:
            continue
        if any(kw in txt.lower() for kw in ("cookie", "javascript", "browser", "abonnement", "newsletter")):
            continue
        if seg_pattern.search(txt) and " - " in txt:
            # Looks like a route segment, not narrative
            continue
        # Author bio paragraphs (Remo Kundert is a hiking guide...) — skip
        if re.search(r"\b(hiking guide|alpine journalist|co-authored|freelance photographer|guidebook author|Bergf(ü|u)hrer|Tourenleiter)\b",
                     txt, re.I):
            continue
        paragraphs.append(txt)
        if len(paragraphs) >= 2:
            break

    # Prefer body paragraphs (full sentences) over og:description (server-truncated).
    # Only fall back to the teaser if the body had nothing.
    if not paragraphs and teaser:
        paragraphs = [teaser]
    if not paragraphs:
        return None

    # Dedupe near-duplicates: paragraphs sharing >=40 chars of overlap with a previous one.
    deduped: list[str] = []
    for p in paragraphs:
        if any(_overlap_len(p, q) >= 40 for q in deduped):
            continue
        deduped.append(p)
    return "\n".join(f"<p>{p}</p>" for p in deduped[:3])


def _overlap_len(a: str, b: str) -> int:
    """Length of the longest contiguous substring shared between a and b (cheap heuristic)."""
    a_low, b_low = a.lower(), b.lower()
    # Take the shorter as the haystack-source; check ~30-char windows
    short = a_low if len(a_low) <= len(b_low) else b_low
    long_ = b_low if short is a_low else a_low
    best = 0
    for i in range(0, len(short) - 30, 10):
        chunk = short[i:i + 30]
        if chunk in long_:
            best = max(best, len(chunk))
    return best


def _extract_segments(soup: BeautifulSoup) -> list[str]:
    """The route page lists numbered legs like 'A - B, T3, 2 Std. 45 Min.' — collect them."""
    out: list[str] = []
    for p in soup.find_all("p"):
        txt = re.sub(r"\s+", " ", p.get_text(strip=True))
        if not txt:
            continue
        if re.search(r"T[1-6][+\-]?,\s*\d+", txt) or re.search(r"\d+\s*(?:Std|h)\.?\s*\d*\s*(?:Min|min)?\.?", txt):
            if " - " in txt or " – " in txt:
                out.append(txt)
    # Deduplicate while preserving order
    seen: set[str] = set()
    uniq = []
    for s in out:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    return uniq


def scrape(html: str) -> ScrapedRoute:
    soup = BeautifulSoup(html, "html.parser")
    res = ScrapedRoute()

    res.title = _meta(soup, "og:title")
    res.teaser = _meta(soup, "og:description")
    res.hero_image_url = _meta(soup, "og:image")

    res.difficulty = _dt_dd_lookup(soup, "Difficulty")
    res.ascent_time_min, res.ascent_gain_m = _parse_time_gain(_dt_dd_lookup(soup, "Ascent") or "")
    res.descent_time_min, res.descent_drop_m = _parse_time_gain(_dt_dd_lookup(soup, "Descent") or "")

    raw_dep = _dt_dd_lookup(soup, "Departure point") or ""
    res.departure_name, res.departure_elev_m = _parse_departure(raw_dep)
    res.departure_transport = _detect_transport(soup)

    res.photos = _extract_photos(soup)
    res.description_html = _extract_description(soup, res.teaser)
    res.segments = _extract_segments(soup)

    return res


def fetch_html(url: str, cookie: str) -> str:
    req = urllib.request.Request(url, headers={
        "Cookie": cookie,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "User-Agent": USER_AGENT,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _humanize_time(minutes: int | None) -> str | None:
    if not minutes:
        return None
    h, m = divmod(minutes, 60)
    return f"{h} h {m:02d} min" if h else f"{m} min"


def patch_data_json(data_path: Path, sr: ScrapedRoute, *, replace_todo_only: bool = True) -> list[str]:
    """Apply scraped values into ``data.json``. Returns a list of field paths changed."""
    data = json.loads(data_path.read_text(encoding="utf-8"))
    changed: list[str] = []

    def is_placeholder(val) -> bool:
        if val in (None, "", 0, 0.0):
            return True
        if isinstance(val, str):
            return val.startswith("TODO") or val == "TODO"
        return False

    def maybe_set(path: list[str | int], value):
        if value is None:
            return
        ref = data
        for p in path[:-1]:
            ref = ref[p]
        last = path[-1]
        if replace_todo_only and not is_placeholder(ref[last] if isinstance(ref, list) or last in ref else None):
            return
        ref[last] = value
        changed.append(".".join(str(p) for p in path))

    # Hero
    if sr.hero_image_url:
        maybe_set(["hero", "image_url"], sr.hero_image_url)

    # Index card / quick facts
    if sr.ascent_gain_m:
        maybe_set(["index_card", "gain"], f"{sr.ascent_gain_m} m")
        # Quick facts row 4: ["Total ascent", "..."]
        if "quick_facts" in data and len(data["quick_facts"]) > 4:
            maybe_set(["quick_facts", 4, 1], f"<strong>{sr.ascent_gain_m} m</strong>")
    total_min = (sr.ascent_time_min or 0) + (sr.descent_time_min or 0)
    if total_min:
        h = total_min // 60
        # Round up: an extra 30+ minutes pushes us to the next hour band
        band_hi = h + (1 if total_min % 60 >= 30 else 0)
        maybe_set(["index_card", "time"], f"{h}–{band_hi} h" if band_hi > h else f"~{h} h")
    # Distance quick fact (row 3): derive from existing index_card.distance
    dist = (data.get("index_card") or {}).get("distance")
    if dist and dist != "TODO" and "quick_facts" in data and len(data["quick_facts"]) > 3:
        maybe_set(["quick_facts", 3, 1], f"<strong>{dist}</strong> round-trip" if "loop" not in (data.get("index_card", {}).get("route_type", "")) else f"<strong>{dist}</strong>")

    # Trailhead elevation
    if sr.departure_elev_m and (data.get("trailhead") or {}).get("elev") in (None, 0):
        data["trailhead"]["elev"] = sr.departure_elev_m
        changed.append("trailhead.elev")

    # Intro / description
    if sr.description_html:
        maybe_set(["intro_html"], sr.description_html)

    # Hero subtitle (only if still TODO)
    if (data.get("hero") or {}).get("subtitle_html", "").startswith("TODO"):
        dist_part = data.get("index_card", {}).get("distance", "")
        gain_part = data.get("index_card", {}).get("gain", "")
        time_part = data.get("index_card", {}).get("time", "")
        grade = data.get("hero", {}).get("grade") or sr.difficulty or "T?"
        pill_cls = "t" + (grade[1] if len(grade) >= 2 and grade[1].isdigit() else "?")
        parts = []
        if sr.departure_name:
            parts.append(f"{sr.departure_name} → {data.get('peak', {}).get('name', '')}")
        if grade:
            parts.append(f'<span class="pill {pill_cls}">SAC {grade}</span>')
        if gain_part and gain_part != "TODO":
            parts.append(f"{gain_part} gain")
        if dist_part and dist_part != "TODO":
            parts.append(dist_part)
        if time_part and time_part != "TODO":
            parts.append(time_part)
        if parts:
            data["hero"]["subtitle_html"] = " | ".join(parts)
            changed.append("hero.subtitle_html")

    # Routes[0] title + bullets
    routes = data.get("routes") or []
    if routes and sr.title and routes[0].get("title_html", "").startswith("TODO"):
        # Use the part before "|" in og:title for cleanliness
        title_clean = sr.title.split(" | ")[0]
        routes[0]["title_html"] = f"<strong>{title_clean}</strong>"
        changed.append("routes.0.title_html")
    if routes and sr.segments:
        bullets = routes[0].get("bullets_html") or []
        # Replace TODO bullets only
        for i, b in enumerate(bullets):
            if isinstance(b, str) and b.startswith("TODO") and i < len(sr.segments):
                bullets[i] = sr.segments[i]
                changed.append(f"routes.0.bullets_html.{i}")
        routes[0]["bullets_html"] = bullets

    # Photos: append scraped photos if data has empty list (don't clobber manual curation)
    if not data.get("photos") and sr.photos:
        # Drop the hero image (already used) and dedupe against it
        hero = sr.hero_image_url.split("?", 1)[0] if sr.hero_image_url else None
        gallery = [p for p in sr.photos if p["url"].split("?", 1)[0] != hero]
        # Take up to 12 photos to avoid huge pages
        data["photos"] = gallery[:12]
        changed.append("photos")

    # Public transport (getting_there)
    gt = data.get("getting_there") or {}
    if gt.get("by_pt_html", "").startswith("TODO") and sr.departure_transport and sr.departure_name:
        gt["by_pt_html"] = f"<p><strong>{sr.departure_transport}</strong> to <strong>{sr.departure_name}</strong>.</p>"
        changed.append("getting_there.by_pt_html")

    if changed:
        data_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return changed


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--html", type=Path, help="Read HTML from a local file (for offline iteration).")
    src.add_argument("--url", help="Fetch HTML from this SAC route page URL (requires cookie).")

    p.add_argument("--slug", help="If --apply, patch routes/<slug>/<slug>.data.json")
    p.add_argument("--apply", action="store_true", help="Patch the slug's data.json with the scraped values.")
    p.add_argument("--inspect", action="store_true", help="Print the scraped dict and exit (no patching).")
    p.add_argument("--cookie-file", type=Path)
    p.add_argument("--cookie-env", default="SAC_COOKIE")
    p.add_argument("--replace-non-todo", action="store_true",
                   help="By default we only overwrite TODO placeholders; this flag overrides existing values too.")
    args = p.parse_args(argv)

    if args.url:
        cookie = _load_cookie(args.cookie_env, args.cookie_file)
        html = fetch_html(args.url, cookie)
    else:
        html = args.html.read_text(encoding="utf-8", errors="replace")

    sr = scrape(html)

    if args.inspect or not args.apply:
        printable = asdict(sr)
        # Trim photos for readability
        if printable.get("photos"):
            printable["photos_count"] = len(printable["photos"])
            printable["photos_sample"] = printable["photos"][:3]
            del printable["photos"]
        print(json.dumps(printable, ensure_ascii=False, indent=2))
        if not args.apply:
            return 0

    if not args.slug:
        sys.exit("ERROR: --slug is required with --apply.")
    data_path = REPO_ROOT / "routes" / args.slug / f"{args.slug}.data.json"
    if not data_path.exists():
        sys.exit(f"ERROR: {data_path} does not exist; scaffold the hike first.")
    changed = patch_data_json(data_path, sr, replace_todo_only=not args.replace_non_todo)
    if changed:
        print(f"[apply] patched {len(changed)} fields in {data_path.name}:")
        for c in changed:
            print(f"  - {c}")
    else:
        print("[apply] nothing to patch (no placeholders to fill or no values scraped).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
