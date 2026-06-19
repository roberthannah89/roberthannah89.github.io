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
import gzip
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("ERROR: beautifulsoup4 is required. pip install beautifulsoup4")

try:
    import brotli  # type: ignore
except ImportError:  # pragma: no cover
    brotli = None  # request gzip only and fall back gracefully

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_sac_route import _load_cookie  # noqa: E402

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
    departure_transport: str | None = None  # "Bus" / "Train" / "Cable car" / etc.
    end_name: str | None = None         # set only when distinct from departure
    end_elev_m: int | None = None
    terrain_html: str | None = None     # "Difficulty / Material" section — terrain/safety notes
    segments: list[str] = field(default_factory=list)   # per-leg "A → B, T3, 2 Std. 45 Min." strings
    waypoints: list[dict] = field(default_factory=list) # [{name, elev_m, description}]
    photos: list[dict] = field(default_factory=list)


def _meta(soup: BeautifulSoup, prop: str) -> str | None:
    tag = soup.find("meta", attrs={"property": prop}) or soup.find("meta", attrs={"name": prop})
    return tag.get("content", "").strip() if tag else None


def _dt_dd_lookup(soup: BeautifulSoup, *labels: str) -> str | None:
    """Find the <dd> sibling of the first <dt> whose stripped text matches one
    of ``labels`` (case-insensitive). SAC uses different labels on different
    pages — e.g. "Departure point" vs. "Departure and arrival point" for
    round-trip vs. point-to-point routes.
    """
    targets = {lbl.casefold() for lbl in labels}
    for dt in soup.find_all("dt"):
        if dt.get_text(strip=True).casefold() in targets:
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
    """Pull 'Name (NNN m)' out of the departure dd; ignore everything after.

    Examples seen in the wild:
      "Ziegelbrücke, Bahnhof (425 m)Show on mapGet there Google MapsZiegelbrücke"
        → ("Ziegelbrücke, Bahnhof", 425)
      "Morgenholz, Bergstation (982 m) Informationen zur Seilbahn: www.niederurnertaeli.ch/..."
        → ("Morgenholz, Bergstation", 982)
    """
    if not raw:
        return None, None
    # The reliable anchor is the elevation parens — everything before is the
    # name, everything after is extra content (transit info, chrome, etc.).
    m = re.search(r"^\s*(.+?)\s*\((\d+)\s*m\)", raw)
    if m:
        name = re.sub(r"\s+", " ", m.group(1)).strip(" ,;")
        return name or None, int(m.group(2))

    # Fallback: no elevation parens — strip known chrome and use what's left.
    cleaned = raw
    for cut in ("Show on map", "Get there", "Google Maps", "View on map",
                "Informationen zur", "Information about"):
        if cut in cleaned:
            cleaned = cleaned.split(cut, 1)[0]
    cleaned = cleaned.strip(" ,;")
    return (cleaned or None), None


def _detect_transport(soup: BeautifulSoup, dd_text: str | None) -> str | None:
    """Best-effort detection of the public-transport mode for the departure.

    Two signals: (a) a transport-named CSS class on a nearby icon span, and
    (b) German keywords in the departure dd's text (Seilbahn = cable car, etc.).
    """
    for cls in ("bus", "train", "boat", "tram", "cable_car"):
        if soup.find(class_=re.compile(rf"\b{cls}\b")):
            return cls.replace("_", " ").title()
    if dd_text:
        text_de = dd_text.lower()
        for kw, label in (
            ("seilbahn", "Cable car"),
            ("luftseilbahn", "Cable car"),
            ("bergbahn", "Mountain railway"),
            ("zahnradbahn", "Cog railway"),
            ("postauto", "Post bus"),
            ("bahnhof", "Train"),
            ("bahn", "Train"),
            ("station", "Train"),
        ):
            if kw in text_de:
                return label
    return None


def _parse_time_breakdown(raw: str) -> list[str]:
    """Split the 'Time' dd into one entry per leg.

    Examples seen:
      Hirzli:       "Morgenholz – Hirzli 1 Std. 45 Min. Hirzli – Planggenstock 30 Min. …"
      Federispitz:  "… T3, 30 Min. Federispitz - Plättlispitz - Unternätenalp T3, 1 Std. Unternätenalp - Weesen, T2, 1 Std. 45 Min."

    Delimiter: 'Min.' OR 'Std.' followed by whitespace and a capital letter
    that starts the next leg's name. "Std." in the middle of '2 Std. 45 Min.'
    is naturally skipped because '45' isn't a capital letter.
    """
    if not raw:
        return []
    # Split capturing the trailing 'Min.' or 'Std.' so we can stitch it back
    # onto the preceding chunk.
    chunks = re.split(r"((?:Std|Min)\.)\s+(?=[A-ZÄÖÜ])", raw.strip())
    # chunks alternates body / delimiter / body / delimiter / … / final body
    out: list[str] = []
    i = 0
    while i < len(chunks):
        body = chunks[i]
        delim = chunks[i + 1] if i + 1 < len(chunks) else ""
        seg = re.sub(r"\s+", " ", (body + " " + delim)).strip()
        if seg:
            out.append(seg)
        i += 2
    return out


def _parse_waypoints(raw: str) -> list[dict]:
    """Split the 'Waypoints' dd into structured entries.

    Each waypoint is shaped 'Name (NNN m) [optional description] Show on map'.
    Multiple waypoints repeat that pattern back-to-back.
    """
    if not raw:
        return []
    pat = re.compile(
        r"([A-ZÄÖÜ][^()]*?)\s*\((\d+)\s*m\)\s*(.*?)\s*Show on map",
        re.DOTALL,
    )
    out: list[dict] = []
    for m in pat.finditer(raw):
        name = re.sub(r"\s+", " ", m.group(1)).strip(" ,;-–")
        elev = int(m.group(2))
        desc = re.sub(r"\s+", " ", m.group(3)).strip(" ,;")
        if name:
            entry = {"name": name, "elev_m": elev}
            if desc:
                entry["description"] = desc
            out.append(entry)
    return out


def _terrain_html(raw: str) -> str | None:
    """Wrap the 'Difficulty / Material' dd content as one or more <p>s."""
    if not raw:
        return None
    cleaned = re.sub(r"\s+", " ", raw).strip()
    if not cleaned:
        return None
    # Split into paragraphs on " . " or "! " or "? " boundaries that look like
    # sentence ends followed by an uppercase word — rare in this short field
    # but harmless. Otherwise emit as a single paragraph.
    return f"<p>{cleaned}</p>"


_MASTER_RE = re.compile(r"csm_(\d+_\d+)master")


def _extract_photos(soup: BeautifulSoup) -> list[dict]:
    """Collect route gallery photos only — no page chrome.

    We restrict the search to the route's ``<div class="m-media-gallery">``
    container. Within it, SAC renders each source image twice (full-size with
    class ``m-media-gallery__image`` and a smaller ``m-media-gallery__thumbnail``);
    we group by SAC's master ID (``csm_<master_id>master_<hash>``) and keep
    only the full-size variant per group.

    Anything outside ``m-media-gallery`` (navigation chrome, related-content
    cards, footer logos, paywall banner) is ignored.
    """
    gallery = soup.find(class_=re.compile(r"\bm-media-gallery\b"))
    if gallery is None:
        return []

    def rank_for(img) -> int:
        cls = " ".join(img.get("class") or [])
        parent_cls = " ".join((img.parent.get("class") if img.parent else []) or [])
        all_cls = cls + " " + parent_cls
        if "m-media-gallery__image" in all_cls:
            return 0  # full-size
        if "m-media-gallery__thumbnail" in all_cls:
            return 5  # smaller — only used if no full-size found
        return 3  # other gallery-internal images

    by_master: dict[str, tuple[int, str, str]] = {}
    for img in gallery.find_all("img"):
        src = (img.get("src") or "").strip()
        if "/processed/" not in src:
            continue  # ignore inline data: URIs etc.
        url = src if src.startswith("http") else "https://www.sac-cas.ch" + src
        m = _MASTER_RE.search(url)
        if not m:
            continue  # not a SAC master-ID image; skip rather than guess
        master_id = m.group(1)
        caption = (img.get("alt") or "").strip()
        r = rank_for(img)
        existing = by_master.get(master_id)
        if existing is None or r < existing[0]:
            by_master[master_id] = (r, url, caption)

    out: list[dict] = []
    seen_urls: set[str] = set()
    for _, url, caption in by_master.values():
        key = url.split("?", 1)[0]
        if key in seen_urls:
            continue
        seen_urls.add(key)
        out.append({
            "url": url,
            "lightbox_url": url,
            "alt": caption or "Route photo (SAC)",
            "caption_html": f"<p>{caption}</p>" if caption else "",
        })
    return out


def _extract_description(soup: BeautifulSoup, teaser: str | None,
                         exclude_texts: list[str] | None = None) -> str | None:
    """Build a multi-paragraph HTML description from the first long article-body paragraphs.

    The og:description is server-truncated mid-sentence; prefer body <p> tags. Skip
    paragraphs that look like the segment list, transit/URL notes ("Informationen
    zur Seilbahn:…"), or duplicate content from terrain/safety sections.
    """
    paragraphs: list[str] = []
    seg_pattern = re.compile(r"T[1-6][+\-]?\s*,|\d+\s*Std\.|\d+\s*Min\.")
    url_pattern = re.compile(r"https?://|www\.[a-z]")
    excludes_norm = [re.sub(r"\W+", " ", (t or "").lower())[:160] for t in (exclude_texts or [])]

    for p in soup.find_all("p"):
        txt = re.sub(r"\s+", " ", p.get_text(strip=True))
        if not txt or len(txt) < 60:
            continue
        low = txt.lower()
        if any(kw in low for kw in ("cookie", "javascript", "browser", "abonnement", "newsletter")):
            continue
        if seg_pattern.search(txt) and " - " in txt:
            # Looks like a route segment, not narrative
            continue
        if url_pattern.search(txt):
            # "Informationen zur Seilbahn:www.niederurnertaeli.ch/…" and friends
            continue
        # Author bio paragraphs (Remo Kundert is a hiking guide...) — skip
        if re.search(r"\b(hiking guide|alpine journalist|co-authored|freelance photographer|guidebook author|Bergf(ü|u)hrer|Tourenleiter)\b",
                     txt, re.I):
            continue
        # Substantial overlap with terrain/excluded text — skip
        norm = re.sub(r"\W+", " ", low)[:160]
        if any(ex and (norm[:80] in ex or ex[:80] in norm) for ex in excludes_norm):
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


class PaywallError(RuntimeError):
    """Raised when SAC serves the paywall page instead of the route content
    (typically: cookie expired, or this route requires a separate purchase)."""


def _is_paywall_page(soup: BeautifulSoup) -> bool:
    """Detect SAC's paywall template. Distinctive markers:
       - og:title is exactly "SAC Route Portal" (generic, no route name)
       - og:image URL contains "paywall" or generic "Tourenportal" banner
       - body contains the explicit English paywall string "not free of charge"

    The body-text check intentionally does NOT look for the German
    ``kostenpflichtig``: real route descriptions legitimately use the word to
    describe toll roads or paid parking (e.g. Uri Rotstock notes the
    chargeable road to Musenalp), and combined with "abo" (which appears in
    SAC's site chrome on every page) it produced false positives.
    """
    title = _meta(soup, "og:title") or ""
    if title.strip().lower() == "sac route portal":
        return True
    og_image = _meta(soup, "og:image") or ""
    if "paywall" in og_image.lower() or "csm_tourenportal" in og_image.lower():
        return True
    body = soup.get_text(" ", strip=True).lower()
    if "not free of charge" in body:
        return True
    return False


def scrape(html: str) -> ScrapedRoute:
    soup = BeautifulSoup(html, "html.parser")
    if _is_paywall_page(soup):
        raise PaywallError(
            "SAC served the paywall page instead of the route content. "
            "Refresh ~/.config/sac-hikes/cookie (cookie likely expired) or "
            "verify this route is included in your SAC subscription."
        )
    res = ScrapedRoute()

    res.title = _meta(soup, "og:title")
    res.teaser = _meta(soup, "og:description")
    res.hero_image_url = _meta(soup, "og:image")

    res.difficulty = _dt_dd_lookup(soup, "Difficulty")
    res.ascent_time_min, res.ascent_gain_m = _parse_time_gain(_dt_dd_lookup(soup, "Ascent") or "")
    res.descent_time_min, res.descent_drop_m = _parse_time_gain(_dt_dd_lookup(soup, "Descent") or "")

    raw_dep = (_dt_dd_lookup(soup, "Departure point", "Departure and arrival point",
                              "Starting point", "Trailhead", "Start point") or "")
    res.departure_name, res.departure_elev_m = _parse_departure(raw_dep)
    res.departure_transport = _detect_transport(soup, raw_dep)

    # End point only set when distinct from departure (i.e. point-to-point
    # routes use a separate "End point" label; round-trips use "Departure and
    # arrival point" instead, so we leave end_* null in that case).
    raw_end = _dt_dd_lookup(soup, "End point", "Arrival point", "End and arrival point")
    if raw_end:
        res.end_name, res.end_elev_m = _parse_departure(raw_end)

    # Per-leg time breakdown — the cleanest source for "what does the route do".
    raw_time = _dt_dd_lookup(soup, "Time") or ""
    res.segments = _parse_time_breakdown(raw_time)

    # Terrain / safety notes
    res.terrain_html = _terrain_html(_dt_dd_lookup(soup, "Difficulty / Material",
                                                   "Material / Difficulty",
                                                   "Conditions") or "")

    # Named via-points with elevations + descriptions
    res.waypoints = _parse_waypoints(_dt_dd_lookup(soup, "Waypoints", "Via points") or "")

    res.photos = _extract_photos(soup)
    # Strip terrain HTML wrapper so the substring comparison sees raw text.
    terrain_text = re.sub(r"<[^>]+>", "", res.terrain_html or "")
    res.description_html = _extract_description(soup, res.teaser,
                                                exclude_texts=[terrain_text])

    return res


def fetch_html(url: str, cookie: str) -> str:
    """GET ``url`` with the saved cookie, transparently decompressing the response.

    SAC's nginx serves brotli for `Accept-Encoding: br, gzip` — about 9x smaller
    on the wire (~130 KB → 15 KB for a route page) and ~20-30% faster end-to-end.
    """
    accept_encoding = "br, gzip" if brotli else "gzip"
    req = urllib.request.Request(url, headers={
        "Cookie": cookie,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Accept-Encoding": accept_encoding,
        "User-Agent": USER_AGENT,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        encoding = (resp.headers.get("Content-Encoding") or "").lower().strip()
    if encoding == "br":
        if not brotli:
            sys.exit("ERROR: server returned brotli but the brotli package isn't installed.")
        raw = brotli.decompress(raw)
    elif encoding == "gzip":
        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    elif encoding and encoding != "identity":
        sys.exit(f"ERROR: unsupported Content-Encoding: {encoding}")
    return raw.decode("utf-8", errors="replace")


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
        # Prefer "departure → end" when both endpoints are known and distinct
        # (point-to-point routes); fall back to "departure → peak name" otherwise.
        endpoint = sr.end_name or data.get("peak", {}).get("name", "")
        if sr.departure_name and endpoint:
            parts.append(f"{sr.departure_name} → {endpoint}")
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

    # Routes[0] title + bullets + source (replace TODO source with the SAC route link)
    routes = data.get("routes") or []
    if routes and sr.title and routes[0].get("title_html", "").startswith("TODO"):
        # Use the part before "|" in og:title for cleanliness
        title_clean = sr.title.split(" | ")[0]
        routes[0]["title_html"] = f"<strong>{title_clean}</strong>"
        changed.append("routes.0.title_html")
    if routes and (not routes[0].get("source") or routes[0]["source"].startswith("TODO")):
        route_url = next(
            (s["url"] for s in (data.get("sources") or [])
             if "route" in s.get("name", "").lower() and "peak" not in s.get("name", "").lower()),
            None,
        )
        if route_url:
            routes[0]["source"] = (
                f'<a href="{route_url}" target="_blank" rel="noopener">SAC Route Portal</a>'
            )
            changed.append("routes.0.source")
    if routes and sr.segments:
        bullets = list(routes[0].get("bullets_html") or [])
        has_todo = any(isinstance(b, str) and b.startswith("TODO") for b in bullets)
        if not has_todo:
            # No TODO markers means the bullets were already populated -- either
            # by a prior scrape (which may now be stale or wrong-count) or by
            # hand. We can't tell, so replace wholesale with the fresh scrape;
            # the alternative (preserving a wrong-count prior scrape) is what
            # produced the duplicate-leg bug.
            new_bullets = list(sr.segments)
        else:
            scraped_iter = iter(sr.segments)
            new_bullets = []
            for b in bullets:
                if isinstance(b, str) and b.startswith("TODO"):
                    nxt = next(scraped_iter, None)
                    new_bullets.append(nxt if nxt is not None else b)
                else:
                    new_bullets.append(b)
            for extra in scraped_iter:
                new_bullets.append(extra)
            while new_bullets and isinstance(new_bullets[-1], str) and new_bullets[-1].startswith("TODO"):
                new_bullets.pop()
        if new_bullets != bullets:
            routes[0]["bullets_html"] = new_bullets
            changed.append(f"routes.0.bullets_html ({len(new_bullets)} legs)")

    # Terrain / safety notes — append to intro if intro got patched, or attach
    # to routes[0] as a notes_html if the schema accepts it.
    if sr.terrain_html and routes:
        existing_notes = routes[0].get("notes_html", "")
        if is_placeholder(existing_notes) or not existing_notes:
            routes[0]["notes_html"] = sr.terrain_html
            changed.append("routes.0.notes_html")

    # Waypoints — the scraper gives names + elevations but no coordinates;
    # the schema requires lat/lon as numbers, so we stash them under a
    # separate key (`scraped_waypoints`) instead of `waypoints`. Backfilling
    # coordinates by matching the names against the GPX track is a future job.
    if sr.waypoints and not data.get("scraped_waypoints"):
        data["scraped_waypoints"] = [
            {"name": w["name"], "elev_m": w["elev_m"],
             **({"description": w["description"]} if w.get("description") else {})}
            for w in sr.waypoints
        ]
        changed.append(f"scraped_waypoints (+{len(sr.waypoints)})")

    # End point — record as a top-level field for downstream rendering.
    if sr.end_name and not data.get("end_point"):
        data["end_point"] = {
            "name": sr.end_name,
            "elev": sr.end_elev_m,
        }
        changed.append("end_point")

    # Route type — derive from the scraped data, don't trust the scaffold default.
    # Truth table:
    #   end_name set + name differs from trailhead → point-to-point traverse
    #   end_name set + name matches trailhead       → out-and-back (start == end)
    #   no end_name + trailhead name == peak name   → likely a loop
    #   no end_name                                 → can't tell, leave alone
    ic = data.get("index_card") or {}
    if ic.get("route_type") in (None, "", "out-and-back", "TODO"):
        trailhead_name = (data.get("trailhead") or {}).get("name", "")
        if sr.end_name:
            if sr.end_name.strip().lower() == trailhead_name.strip().lower():
                new_type = "out-and-back"
            else:
                new_type = "point-to-point"
            if new_type != ic.get("route_type"):
                ic["route_type"] = new_type
                data["index_card"] = ic
                changed.append("index_card.route_type")

    # Photos: append scraped photos if data has empty list (don't clobber manual curation)
    if not data.get("photos") and sr.photos:
        # Drop the hero image (already used) and dedupe against it
        hero = sr.hero_image_url.split("?", 1)[0] if sr.hero_image_url else None
        gallery = [p for p in sr.photos if p["url"].split("?", 1)[0] != hero]
        # Take up to 12 photos to avoid huge pages
        data["photos"] = gallery[:12]
        changed.append("photos")
    # Set the correct attribution when our photos came from SAC. The template's
    # default ("All photos: Wikimedia Commons …") is wrong for SAC photos.
    if data.get("photos") and (sr.photos or any("/processed/" in (p.get("url") or "") for p in data.get("photos", []))):
        attrib = "All photos: SAC Route Portal"
        if data.get("photos_attrib_html") != attrib:
            data["photos_attrib_html"] = attrib
            changed.append("photos_attrib_html")

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
