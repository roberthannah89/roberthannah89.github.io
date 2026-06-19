"""Render hike-plan HTML pages from <slug>.data.json + Jinja template.

Discovers all `*.data.json` files under one or more hike roots, renders each via
the shared Jinja template at `templates/hike_page.j2.html`, and writes
`<slug>.html` next to its data file.

Features
--------
- Parallel rendering via `ProcessPoolExecutor` (one process per hike).
- Per-stage timing for every render (load JSON, render template, compute GPX
  stats, write file). A summary table is printed at the end.
- Optional `--profile` mode: runs the slowest hike under `cProfile` and dumps
  the top 30 cumulative-time entries.
- Optional `--probe` mode: parallel HEAD probes of photo URLs,
  warning on 4xx/5xx so dead links are caught at build time.

Usage
-----
    python render_hike.py                              # render all hikes under routes
    python render_hike.py --root routes
    python render_hike.py --slug zindlenspitz          # render a single hike
    python render_hike.py --probe                      # also HEAD-check URLs
    python render_hike.py --profile                    # cProfile slowest hike
    python render_hike.py --jobs 1                     # serial (debugging)
"""

from __future__ import annotations

####################################################################################################################################
# Imports
####################################################################################################################################
import argparse
import contextlib
import cProfile
import json
import math
import pstats
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from config import (
    DIFFICULTY_BLURBS,
    EARTH_RADIUS_M,
    ELEV_SMOOTH_M,
    INDEX_PHOTO_WIDTH,
    LAPSE_RATE_C_PER_KM,
    NAISMITH_ASCENT_MH,
    NAISMITH_SPEED_KMH,
    SOURCE_URL_MAP,
)
from jinja2 import Environment, FileSystemLoader, StrictUndefined

try:
    from jsonschema import Draft7Validator as _Draft7Validator
    SCHEMA_PATH = Path(__file__).resolve().parent.parent / "templates" / "hike_data.schema.json"
    _SCHEMA = json.loads(SCHEMA_PATH.read_text()) if SCHEMA_PATH.exists() else None
    Draft7Validator: Any = _Draft7Validator
except ImportError:
    Draft7Validator = None
    _SCHEMA = None

####################################################################################################################################
# Constants
####################################################################################################################################

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = REPO_ROOT / "templates"
ASSETS_DIR = TEMPLATE_DIR / "_assets"
TEMPLATE_NAME = "hike_page.j2.html"
TEMPLATE_3D_NAME = "3d_map.j2.html"
INDEX_TEMPLATE_NAME = "index.j2.html"
DIFFICULTY_TEMPLATE_NAME = "difficulty.j2.html"
DEFAULT_ROOT = REPO_ROOT / "routes"

GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}


class _GuideMetaParser(HTMLParser):
    """Extract guide-* meta tags from an HTML file's <head>."""

    def __init__(self):
        super().__init__()
        self.meta: dict[str, str] = {}
        self._in_head = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        if tag == "head":
            self._in_head = True
        if tag == "meta" and self._in_head:
            d = dict(attrs)
            name = d.get("name") or ""
            content = d.get("content")
            if name.startswith("guide-") and content:
                self.meta[name] = content

    def handle_endtag(self, tag: str):
        if tag == "head":
            self._in_head = False


def discover_guide_pages(hikes_root: Path) -> list[dict[str, Any]]:
    """Scan guides/ and command-center/ for HTML files with guide-* meta tags.

    ``hikes_root`` is the ``pages/hikes/`` directory (the parent of ``routes/``).
    Each entry's ``path`` is dir-qualified (e.g. ``guides/planning.html``,
    ``command-center/index.html``) so callers don't have to know which directory
    a nav entry lives in.
    """
    candidates: list[Path] = []
    guides_dir = hikes_root / "guides"
    if guides_dir.is_dir():
        candidates.extend(f for f in sorted(guides_dir.glob("*.html")) if f.name != "index.html")
    cc_index = hikes_root / "command-center" / "index.html"
    if cc_index.is_file():
        candidates.append(cc_index)

    pages: list[dict[str, Any]] = []
    for html_file in candidates:
        parser = _GuideMetaParser()
        parser.feed(html_file.read_text(encoding="utf-8"))
        m = parser.meta
        if "guide-card-title" not in m:
            continue
        pages.append({
            "path": f"{html_file.parent.name}/{html_file.name}",
            "label": m.get("guide-label", m["guide-card-title"]),
            "card_title": m["guide-card-title"],
            "card_desc": m.get("guide-card-desc", ""),
            "_order": int(m.get("guide-order", "999")),
        })
    pages.sort(key=lambda p: p["_order"])
    return pages

####################################################################################################################################
# Stage timing helpers
####################################################################################################################################


@dataclass
class RenderResult:
    """Outcome of a single hike render, including per-stage timings (seconds)."""

    slug: str
    out_path: str
    ok: bool
    error: str = ""
    stages: dict[str, float] = field(default_factory=dict)
    gpx_stats: dict[str, float] = field(default_factory=dict)

    @property
    def total(self) -> float:
        return sum(self.stages.values())


class StageTimer:
    """Context manager that records elapsed seconds into a dict under `name`."""

    def __init__(self, store: dict[str, float], name: str) -> None:
        self.store = store
        self.name = name

    def __enter__(self) -> StageTimer:
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc: object) -> None:
        self.store[self.name] = time.perf_counter() - self.t0


####################################################################################################################################
# GPX stats
####################################################################################################################################


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance between two (lat, lon) points in metres."""
    r = EARTH_RADIUS_M
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def compute_gpx_stats(gpx_path: Path) -> dict[str, float]:
    """Return distance / ascent / descent stats from a GPX file.

    Walks each ``<trkseg>`` independently so phantom jumps between disconnected
    segments (e.g. the v2 SAC pipeline emits one trkseg per layer feature)
    don't get counted as real distance or elevation change. Ascent uses a 3 m
    smoothing threshold to avoid GPS / SRTM noise. Returns an empty dict if
    the file does not exist or has no points.
    """
    if not gpx_path.exists():
        return {}
    tree = ET.parse(gpx_path)
    segments: list[list[tuple[float, float, float]]] = []
    for trkseg in tree.findall(".//g:trkseg", GPX_NS):
        seg_pts: list[tuple[float, float, float]] = []
        for tp in trkseg.findall("g:trkpt", GPX_NS):
            ele_el = tp.find("g:ele", GPX_NS)
            ele = float(ele_el.text) if ele_el is not None and ele_el.text else 0.0
            seg_pts.append((float(tp.get("lat") or 0), float(tp.get("lon") or 0), ele))
        if seg_pts:
            segments.append(seg_pts)
    # Fallback for GPX with bare <trkpt>s (shouldn't normally happen).
    if not segments:
        flat: list[tuple[float, float, float]] = []
        for tp in tree.findall(".//g:trkpt", GPX_NS):
            ele_el = tp.find("g:ele", GPX_NS)
            ele = float(ele_el.text) if ele_el is not None and ele_el.text else 0.0
            flat.append((float(tp.get("lat") or 0), float(tp.get("lon") or 0), ele))
        if flat:
            segments = [flat]

    n_total = sum(len(s) for s in segments)
    if n_total < 2:
        return {}

    dist = 0.0
    max_grade = 0.0
    for seg in segments:
        for a, b in zip(seg, seg[1:], strict=False):
            d_m = _haversine_m((a[0], a[1]), (b[0], b[1]))
            dist += d_m
            if d_m > 5:
                grade = abs(b[2] - a[2]) / d_m
                if grade > max_grade:
                    max_grade = grade

    asc = desc = 0.0
    for seg in segments:
        last = seg[0][2]
        for p in seg[1:]:
            d = p[2] - last
            if abs(d) >= ELEV_SMOOTH_M:
                if d > 0:
                    asc += d
                else:
                    desc -= d
                last = p[2]

    all_elev = [p[2] for seg in segments for p in seg]
    return {
        "n_points": float(n_total),
        "distance_km": dist / 1000.0,
        "ascent_m": asc,
        "descent_m": desc,
        "min_ele": min(all_elev),
        "max_ele": max(all_elev),
        "steepest_grade_pct": max_grade * 100.0,
    }


def parse_gpx_waypoints(gpx_path: Path,
                        peak_name: str | None = None,
                        trailhead_name: str | None = None) -> list[dict]:
    """Read <wpt> elements from a GPX into the data.json waypoints schema.

    `kind` is inferred: matches `trailhead_name` → "start", matches `peak_name`
    → "summit", everything else → "way".
    """
    if not gpx_path.exists():
        return []
    tree = ET.parse(gpx_path)
    out: list[dict] = []
    for w in tree.findall(".//g:wpt", GPX_NS):
        name_el = w.find("g:name", GPX_NS)
        label = (name_el.text or "").strip() if name_el is not None else ""
        if not label:
            continue
        kind = "way"
        if trailhead_name and label.lower() == trailhead_name.lower():
            kind = "start"
        elif peak_name and label.lower() == peak_name.lower():
            kind = "summit"
        out.append({
            "lat": float(w.get("lat") or 0),
            "lon": float(w.get("lon") or 0),
            "label": label,
            "kind": kind,
        })
    return out


def _grade_pill_class(grade: str) -> str:
    """Convert 'T4+' → 't4', 'T5-' → 't5', etc. for CSS pill class.

    Keep in sync with ``gradeClass`` in ``command-center/side-panel.js``.
    """
    m = re.match(r'[Tt](\d)', str(grade))
    return f"t{m.group(1)}" if m else grade.lower()


def _parse_meters(value: object) -> float | None:
    """Parse a string like ``"1490 m"`` / ``"~1411 m"`` / ``"1,490m"`` into a float.

    Used to read canonical values out of ``index_card.gain`` / ``index_card.drop``
    so we can prefer the SAC-scraped numbers over naive GPX-derived ascent /
    descent (which over-counts on figure-8 / circuit routes that retrace
    ridges). Returns ``None`` when the input is missing or unparseable.
    """
    if not isinstance(value, str):
        return None
    digits = re.search(r"-?\d[\d,.]*", value)
    if not digits:
        return None
    try:
        return float(digits.group(0).replace(",", ""))
    except ValueError:
        return None


def naismith_hours(distance_km: float, ascent_m: float) -> float:
    """Naismith's rule: 1 h per 5 km flat + 1 h per 600 m of ascent."""
    return distance_km / NAISMITH_SPEED_KMH + ascent_m / NAISMITH_ASCENT_MH


def auto_subtitle(grade: str, gpx: dict, round_trip: bool = True) -> str:
    """Build a hero-subtitle string from the GPX stats: 'T3 · 1218 m gain · 7.4 km · ~5h30 round-trip'."""
    if not gpx or not gpx.get("distance_km"):
        return ""
    km = gpx["distance_km"]
    asc = gpx.get("ascent_m", 0)
    desc = gpx.get("descent_m", 0)
    # If ascent ≈ descent, the GPX is a round-trip (Naismith uses one-way distance + ascent).
    is_loop = abs(asc - desc) < max(50, asc * 0.1)
    one_way_km = km / 2 if is_loop and round_trip else km
    one_way_asc = asc / 2 if is_loop and round_trip else asc
    h_one = naismith_hours(one_way_km, one_way_asc)
    h = h_one * 2 if round_trip else h_one
    hh = int(h)
    mm = int(round((h - hh) * 60 / 30) * 30)
    if mm == 60:
        hh += 1
        mm = 0
    time_str = f"~{hh}h{mm:02d}" if mm else f"~{hh}h"
    parts = [f"SAC {grade}", f"~{int(round(asc))} m gain",
             f"~{km:.1f} km" + (" round-trip" if is_loop else " one-way"),
             time_str + (" round-trip" if round_trip else "")]
    return " · ".join(parts)


def difficulty_blurb(grade: str) -> str:
    """Return a concise description for an SAC grade."""
    return DIFFICULTY_BLURBS.get(grade, "Check the route notes below for terrain and commitment level.")


def _source_to_link(source: str) -> str:
    """Convert a source string to HTML hyperlinks, handling multiple sources."""
    import re
    # If source contains a URL in parentheses (e.g., "hikr.org (https://...)"), use that
    url_match = re.search(r'\((https?://[^)]+)\)', source)
    if url_match:
        url = url_match.group(1)
        display = source[:url_match.start()].strip()
        return f'<a href="{url}" target="_blank" rel="noopener">{display}</a>'

    # Split multiple sources (separated by " and ", ", ", or ";")
    # Split on commas and "and", removing "and" from results
    parts = re.split(r',\s*|\s+and\s+', source)
    parts = [p.strip().lstrip('and ').strip() for p in parts if p.strip()]
    links = []

    for part in parts:
        part = part.strip()
        if not part:
            continue

        # Try to find a matching URL from the map
        url = None
        for keyword, base_url in SOURCE_URL_MAP.items():
            if keyword.lower() in part.lower():
                url = base_url
                break

        if url:
            links.append(f'<a href="{url}" target="_blank" rel="noopener">{part}</a>')
        else:
            links.append(part)

    # Rejoin with " and " or ", " as appropriate
    if len(links) > 1:
        return ", ".join(links[:-1]) + ", and " + links[-1]
    return links[0] if links else source


def build_display_quick_facts(
    quick_facts: list[list[str]],
    grade: str,
    routes: list[dict] | None = None,
) -> list[list[str]]:
    """Return quick facts with one consolidated difficulty row and route sources."""
    facts = list(quick_facts or [])

    # Add difficulty if grade is available
    if grade:
        difficulty_value = (
            f'<span class="pill {_grade_pill_class(grade)}">SAC {grade}</span> '
            f'{difficulty_blurb(grade)} '
            f'<a href="../../guides/difficulty.html">Guide</a>'
        )
        labels_to_replace = {"standard sac grade", "difficulty", "sac grade", "grade"}
        for idx, item in enumerate(facts):
            if len(item) != 2:
                continue
            label, _value = item
            if label.strip().lower() in labels_to_replace:
                facts[idx] = ["Difficulty", difficulty_value]
                break
        else:
            facts.append(["Difficulty", difficulty_value])

    # Add route sources if available
    if routes:
        unique_sources = set()
        for route in routes:
            if "source" in route:
                unique_sources.add(route["source"])
        if unique_sources:
            # Convert sources to hyperlinks
            source_links = []
            for source in sorted(unique_sources):
                link = _source_to_link(source)
                source_links.append(link)
            sources_html = "; ".join(source_links)
            facts.append(["Route sources", sources_html])

    return facts




####################################################################################################################################
# Render core
####################################################################################################################################


def _make_env() -> Environment:
    """Jinja env with strict undefined so missing fields fail loudly."""
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        undefined=StrictUndefined,
        autoescape=False,  # template explicitly marks html-bearing fields with `| safe`
        trim_blocks=False,
        lstrip_blocks=False,
        keep_trailing_newline=True,
    )
    env.filters["grade_class"] = _grade_pill_class
    return env


def _write_track_js(gpx_path: Path, out_path: Path) -> None:
    """Generate a track.js file from a GPX for the Leaflet map and elevation chart.

    Emits TRACK as a flat list (back-compat) PLUS TRACK_SEGMENTS, a list of
    [start_index, end_index_exclusive] pairs. The page JS uses the segment
    map to draw the Leaflet polyline as a multi-line (no fake connector
    across gap-split feature boundaries) and to break the elevation chart at
    the same places.
    """
    if not gpx_path.exists():
        return
    tree = ET.parse(gpx_path)
    segments: list[list[tuple[float, float, float]]] = []
    for trkseg in tree.findall(".//g:trkseg", GPX_NS):
        seg: list[tuple[float, float, float]] = []
        for tp in trkseg.findall("g:trkpt", GPX_NS):
            ele_el = tp.find("g:ele", GPX_NS)
            ele = float(ele_el.text) if ele_el is not None and ele_el.text else 0.0
            seg.append((float(tp.get("lat") or 0), float(tp.get("lon") or 0), ele))
        if seg:
            segments.append(seg)
    if not segments:
        return
    flat: list[tuple[float, float, float]] = [p for s in segments for p in s]
    spans: list[tuple[int, int]] = []
    cursor = 0
    for s in segments:
        spans.append((cursor, cursor + len(s)))
        cursor += len(s)
    lines = [
        f"window.TRACK_FULL_COUNT = {len(flat)};",
        "window.TRACK = [",
        *[f"[{lat},{lon},{int(round(ele))}]," for lat, lon, ele in flat],
        "];",
        "window.TRACK_SEGMENTS = ["
        + ",".join(f"[{a},{b}]" for a, b in spans) + "];",
    ]
    out_path.write_text("\n".join(lines), encoding="utf-8")


_TRANSPORT_KEYWORDS = (
    "kabinenbahn", "zahnradbahn", "sesselbahn", "seilbahn", "luftseilbahn",
    "gondola", "cable car", "cog railway", "funicular", "standseilbahn",
    "car-free", "car free", "autofrei",
    "alpentaxi", "rufbus",
    "timetable", "fahrplan", "opening hours",
    "season", "saison", "winter",
    "parking", "parkplatz", "parkhaus",
    "shuttle", "ferry",
)


def _is_useful_transport(html: str) -> bool:
    lower = html.lower()
    if any(kw in lower for kw in _TRANSPORT_KEYWORDS):
        return True
    return lower.count("<p>") > 1 or "<li>" in lower


def _build_transport_notes(data: dict) -> None:
    """Merge by_car_html / by_pt_html into transport_notes_html.

    Drops TODO placeholders and simple 'Bus/Train to X' lines that are
    redundant with the SBB deep-link button. Keeps cable cars, seasonal
    restrictions, parking info, and other genuinely useful details.
    """
    gt = data.get("getting_there") or {}
    parts: list[str] = []
    for key in ("by_car_html", "by_pt_html"):
        val = (gt.get(key) or "").strip()
        if val and "TODO" not in val and _is_useful_transport(val):
            parts.append(val)
    gt["transport_notes_html"] = "\n".join(parts) if parts else ""


def _filter_todo_sections(data: dict) -> None:
    """Strip sections that are pure TODO placeholders so the template skips them."""
    # Day plans: drop if every row is a TODO placeholder
    plans = data.get("day_plans") or []
    if plans and all(
        all("TODO" in row[1] or "HH:MM" in row[0] for row in p.get("rows", []))
        for p in plans
    ):
        data["day_plans"] = []

    # Snow / season: clear if TODO
    weather = data.get("weather") or {}
    if "TODO" in (weather.get("season_html") or ""):
        weather["season_html"] = ""


def load_hike_data(data_path: Path) -> dict:
    """Read a hike's data.json from disk. No augmentation — pure I/O.

    Sets ``slug`` from the file stem if missing so downstream callers can rely
    on it.
    """
    slug = data_path.stem.replace(".data", "")
    data = json.loads(data_path.read_text(encoding="utf-8"))
    data.setdefault("slug", slug)
    return data


def validate_hike_data(data: dict) -> None:
    """JSON-schema validate hike data. Raises ``ValueError`` on failure.

    No-op if ``jsonschema`` isn't installed or the schema file is missing.
    """
    if Draft7Validator is None or _SCHEMA is None:
        return
    errors = sorted(Draft7Validator(_SCHEMA).iter_errors(data),
                    key=lambda e: list(e.absolute_path))
    if not errors:
        return
    msgs = []
    for e in errors[:5]:
        loc = "/".join(str(p) for p in e.absolute_path) or "<root>"
        msgs.append(f"{loc}: {e.message}")
    raise ValueError("schema validation failed: " + "; ".join(msgs))


def augment_hike_data(data: dict, gpx_stats: dict[str, float], hike_dir: Path) -> dict:
    """Derive all the rendered fields on top of raw hike data.

    Mutates and returns ``data`` so callers can chain. Performs no disk I/O
    apart from the GPX waypoint parse (which reads from ``hike_dir``) and the
    ``_config.js`` existence probe; everything else is in-memory field
    derivation: hero fallbacks, quick-facts assembly, source-link expansion,
    transport notes, TODO filtering, and the pipeline-constants block.
    """
    slug = data.get("slug") or ""
    gpx_path = hike_dir / f"{slug}.gpx"

    # Prefer SAC-scraped gain/drop (``index_card.gain`` / ``index_card.drop``)
    # over naive GPX-derived ascent/descent. The GPX walker sums every positive
    # delta along the track, which over-counts on figure-8 / circuit routes
    # whose features retrace a ridge (Federispitz: 2830 m GPX vs SAC's 1490 m).
    # SAC's published gain is the canonical headline value, so we override
    # ``gpx_stats`` in place — that way the elevation-profile headline, the
    # hero auto-subtitle, and the Naismith time all converge on the same
    # number without each consumer having to know about the override.
    ic = data.get("index_card") or {}
    sac_gain = _parse_meters(ic.get("gain"))
    sac_drop = _parse_meters(ic.get("drop"))
    for key, sac_val in (("ascent_m", sac_gain), ("descent_m", sac_drop)):
        if sac_val is None:
            continue
        gpx_val = gpx_stats.get(key)
        if gpx_val and gpx_val > 0:
            diff_pct = abs(gpx_val - sac_val) / sac_val * 100.0 if sac_val else 0.0
            if diff_pct > 25.0:
                label = "ascent" if key == "ascent_m" else "descent"
                print(
                    f"[gain-warn] {slug}: GPX {label} {int(round(gpx_val))} m vs SAC "
                    f"{int(round(sac_val))} m (diff {diff_pct:.1f}%)",
                    file=sys.stderr,
                )
        gpx_stats[key] = sac_val

    data["gpx_stats"] = gpx_stats
    # Auto-derive waypoints from GPX <wpt>s when data has none.
    if not data.get("waypoints"):
        data["waypoints"] = parse_gpx_waypoints(
            gpx_path,
            peak_name=data.get("peak", {}).get("name"),
            trailhead_name=data.get("trailhead", {}).get("name"),
        )
    # Auto-derive hero subtitle from GPX when requested.
    # Auto-populate hero image from photos[0] if hero image is missing/TODO
    hero = data.get("hero") or {}
    if hero.get("auto_subtitle") and gpx_stats:
        hero["subtitle_html"] = auto_subtitle(hero.get("grade", ""), gpx_stats)

    # Auto-use first photo as hero if hero image is empty or TODO
    photos = data.get("photos") or []
    hero_url = hero.get("image_url", "").strip()
    if photos and (not hero_url or "TODO" in hero_url):
        hero["image_url"] = photos[0].get("url", "")
        hero["subtitle_html"] = hero.get("subtitle_html", "") or f"Photo via {photos[0].get('caption_html', '')}"
    elif not photos and (not hero_url or "TODO" in hero_url):
        # No photos available; use placeholder
        hero["image_url"] = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYwMCIgaGVpZ2h0PSI5MDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iI2YzZjRmNiIvPjwvc3ZnPg=="  # noqa: E501  -- inline base64 SVG placeholder; kept on one line to avoid an asset file

    if hero:
        data["hero"] = hero
    data["display_quick_facts"] = build_display_quick_facts(
        data.get("quick_facts") or [],
        hero.get("grade", ""),
        data.get("routes"),
    )
    _build_transport_notes(data)
    _filter_todo_sections(data)
    # Optional per-hike _config.js (e.g. Google Maps Embed API key).
    data["has_config_js"] = (hike_dir / "_config.js").exists()
    data["pipeline_constants"] = {
        "naismith_speed_kmh": NAISMITH_SPEED_KMH,
        "naismith_ascent_mh": NAISMITH_ASCENT_MH,
        "lapse_rate_c_per_km": LAPSE_RATE_C_PER_KM,
    }
    return data


def render_one(data_path: Path) -> RenderResult:
    """Render one hike. Pure function — safe for ProcessPoolExecutor."""
    stages: dict[str, float] = {}
    gpx_stats: dict[str, float] = {}
    slug = data_path.stem.replace(".data", "")
    out_path = data_path.parent / f"{slug}.html"
    try:
        with StageTimer(stages, "load_json"):
            data = load_hike_data(data_path)

        with StageTimer(stages, "validate"):
            validate_hike_data(data)

        with StageTimer(stages, "gpx_stats"):
            gpx_path = data_path.parent / f"{slug}.gpx"
            gpx_stats = compute_gpx_stats(gpx_path)

        with StageTimer(stages, "augment"):
            augment_hike_data(data, gpx_stats, data_path.parent)

        with StageTimer(stages, "load_template"):
            env = _make_env()
            template = env.get_template(TEMPLATE_NAME)
            template_3d = env.get_template(TEMPLATE_3D_NAME)

        with StageTimer(stages, "render"):
            html = template.render(**data)
            html_3d = template_3d.render(**data)

        with StageTimer(stages, "write"):
            out_path.write_text(html, encoding="utf-8")
            (data_path.parent / f"{slug}.3d.html").write_text(html_3d, encoding="utf-8")

        with StageTimer(stages, "track_js"):
            _write_track_js(gpx_path, data_path.parent / f"{slug}.track.js")

        return RenderResult(slug=slug, out_path=str(out_path), ok=True,
                            stages=stages, gpx_stats=gpx_stats)
    except Exception as e:  # noqa: BLE001 — surfaced to summary
        return RenderResult(slug=slug, out_path=str(out_path), ok=False,
                            error=f"{type(e).__name__}: {e}",
                            stages=stages, gpx_stats=gpx_stats)


####################################################################################################################################
# Discovery
####################################################################################################################################


def find_data_files(root: Path, only_slug: str | None) -> list[Path]:
    """Find every `*.data.json` under `root`, optionally filtered to one slug."""
    files = sorted(root.rglob("*.data.json"))
    if only_slug:
        files = [f for f in files if f.stem.replace(".data", "") == only_slug]
    return files


def _newest_template_mtime() -> float:
    """Return the newest mtime across all hike templates and shared _assets.

    Used by incremental render to bust the per-hike cache whenever a template
    or asset changes — those changes affect every hike, so we have to assume
    the whole site needs re-rendering.
    """
    candidates: list[float] = []
    if TEMPLATE_DIR.exists():
        for f in TEMPLATE_DIR.glob("*.j2.html"):
            with contextlib.suppress(OSError):
                candidates.append(f.stat().st_mtime)
    if ASSETS_DIR.exists():
        for f in ASSETS_DIR.iterdir():
            if f.is_file():
                with contextlib.suppress(OSError):
                    candidates.append(f.stat().st_mtime)
    return max(candidates) if candidates else 0.0


def _hike_needs_render(data_path: Path, template_mtime: float) -> bool:
    """True if the rendered HTML is missing or older than any input."""
    slug = data_path.stem.replace(".data", "")
    out_path = data_path.parent / f"{slug}.html"
    if not out_path.exists():
        return True
    try:
        out_mtime = out_path.stat().st_mtime
    except OSError:
        return True
    data_mtime = data_path.stat().st_mtime
    gpx_path = data_path.parent / f"{slug}.gpx"
    gpx_mtime = gpx_path.stat().st_mtime if gpx_path.exists() else 0.0
    newest_input = max(data_mtime, gpx_mtime, template_mtime)
    return out_mtime <= newest_input


####################################################################################################################################
# URL probing (optional)
####################################################################################################################################


def _head(url: str, timeout: float = 5.0) -> tuple[str, int | None, str]:
    req = urllib.request.Request(url, method="HEAD",
                                 headers={"User-Agent": "render_hike/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return url, r.status, ""
    except Exception as e:  # noqa: BLE001
        return url, None, str(e)


def probe_urls(data_files: Iterable[Path], max_workers: int = 16) -> bool:
    """HEAD-check every photo URL across all hikes; warn on failure. Returns True if any URLs failed."""
    targets: list[tuple[str, str]] = []  # (slug, url)
    for f in data_files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        slug = d.get("slug") or f.stem.replace(".data", "")
        for p in d.get("photos") or []:
            if p.get("url"):
                targets.append((slug, p["url"]))
    print(f"[probe] HEAD-checking {len(targets)} URLs with {max_workers} workers…")
    t0 = time.perf_counter()
    bad: list[tuple[str, str, str]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(_head, url): (slug, url) for slug, url in targets}
        for fut in as_completed(futs):
            slug, url = futs[fut]
            _, status, err = fut.result()
            if status is None or status >= 400:
                bad.append((slug, url, err or f"HTTP {status}"))
    dt = time.perf_counter() - t0
    if bad:
        print(f"[probe] {len(bad)} bad URLs in {dt:.2f}s:")
        for slug, url, err in bad:
            print(f"  [{slug}] {url}  →  {err}")
        return True
    else:
        print(f"[probe] all {len(targets)} URLs OK ({dt:.2f}s)")
        return False


####################################################################################################################################
# Asset sync
####################################################################################################################################


def sync_assets(root: Path) -> tuple[int, int]:
    """Copy templates/_assets/* to <root>/_assets/ if changed.

    Returns (n_copied, n_total). The shared CSS + JS live in the skill repo so
    edits propagate to all hikes on the next render.
    """
    import shutil
    src_dir = ASSETS_DIR
    dst_dir = root / "_assets"
    if not src_dir.exists():
        return 0, 0
    dst_dir.mkdir(parents=True, exist_ok=True)
    copied = 0
    total = 0
    for src in src_dir.iterdir():
        if not src.is_file():
            continue
        total += 1
        dst = dst_dir / src.name
        if (not dst.exists()
                or dst.stat().st_size != src.stat().st_size
                or dst.read_bytes() != src.read_bytes()):
            shutil.copy2(src, dst)
            copied += 1
    return copied, total


####################################################################################################################################
# Index page (single source of truth: per-hike data.json + GPX)
####################################################################################################################################


def _resize_photo_url(url: str, width: int = INDEX_PHOTO_WIDTH) -> str:
    """Set or replace the 'width' query parameter in a photo URL."""
    from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    params["width"] = [str(width)]
    return urlunparse(parsed._replace(query=urlencode(params, doseq=True)))


def _index_photo_url(data: dict) -> str:
    """Pick the index-card photo URL from first photo at width=400."""
    photos = data.get("photos") or []
    if not photos:
        return ""
    url = photos[0].get("url", "")
    if "width=" in url:
        return _resize_photo_url(url, INDEX_PHOTO_WIDTH)
    return url


def build_index_hikes(data_files: list[Path],
                      results: list[RenderResult]) -> list[dict]:
    """Build the HIKES list for the index page from per-hike data + GPX stats.

    Single source of truth: each `<slug>.data.json` plus computed GPX stats.
    Only `index_card.region` and `index_card.time` are required additions
    (everything else falls back to peak/hero/photos[0] + GPX).
    """
    gpx_by_slug = {r.slug: r.gpx_stats for r in results}
    hikes: list[dict] = []
    for f in data_files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"[index] skipping {f.name}: {e}")
            continue
        slug = d.get("slug") or f.stem.replace(".data", "")
        peak = d.get("peak") or {}
        hero = d.get("hero") or {}
        ic = d.get("index_card") or {}
        gpx = gpx_by_slug.get(slug, {})

        grade = hero.get("grade", "")
        grade_class = _grade_pill_class(grade)

        distance = ic.get("distance") or (
            f"{gpx['distance_km']:.1f} km" if gpx.get("distance_km") else "—")
        gain = ic.get("gain") or (
            f"{int(round(gpx['ascent_m']))} m" if gpx.get("ascent_m") else "—")

        # Try to extract the SAC peak_id and route_id from any source URL —
        # they're the cleanest join key for the command-center side panel,
        # which has the SAC IDs but doesn't know about umlaut-transliterated
        # hike names ("Faulhorn" hike on a Berghaus-Männdlenen route, etc.).
        sac_peak_id, sac_route_id = None, None
        for src in d.get("sources") or []:
            url = src.get("url") or ""
            if "sac-route-portal" not in url:
                continue
            # Peak id: digits in segment right after sac-route-portal/
            m_peak = re.search(r"sac-route-portal/[^/]*?-(\d+)/", url)
            if m_peak and not sac_peak_id:
                sac_peak_id = int(m_peak.group(1))
            # Route id: digits at end of path (only when URL is a full route URL)
            m_route = re.search(r"/mountain-hiking/[^/]*?-(\d+)/?$", url)
            if m_route and not sac_route_id:
                sac_route_id = int(m_route.group(1))

        # Trailhead + end_point: expose the names + coords + elevations so the
        # command-center side panel can surface Google Maps + SBB links for
        # both endpoints without needing to fetch the per-hike data.json.
        th_d = d.get("trailhead") or {}
        ep_d = d.get("end_point") or {}
        trailhead = {
            "name": th_d.get("name"),
            "elev": th_d.get("elev"),
            "lat": th_d.get("lat"),
            "lon": th_d.get("lon"),
        } if th_d.get("name") else None
        end_point = {
            "name": ep_d.get("name"),
            "elev": ep_d.get("elev"),
        } if ep_d.get("name") else None

        entry = {
            "name": peak.get("name", slug),
            "region": ic.get("region", ""),
            "canton": ic.get("canton", ""),
            "href": f"routes/{slug}/{slug}.html",
            "elev": f"{peak.get('elev', '')} m" if peak.get("elev") else "",
            "grade": grade,
            "gradeClass": grade_class,
            "distance": distance,
            "gain": gain,
            "time": ic.get("time", ""),
            "route_type": ic.get("route_type", ""),
            "lat": peak.get("lat"),
            "lon": peak.get("lon"),
            "summitElev": peak.get("elev", ""),
            "photo": _index_photo_url(d),
            "sac_peak_id": sac_peak_id,
            "sac_route_id": sac_route_id,
            "trailhead": trailhead,
            "end_point": end_point,
        }
        hikes.append(entry)
    return hikes


def render_index(root: Path, hikes: list[dict]) -> tuple[Path, float]:
    """Render the index page; returns (out_path, elapsed_seconds).

    Writes to parent directory so index.html lives at ./ not routes/
    """
    t0 = time.perf_counter()
    env = _make_env()
    template = env.get_template(INDEX_TEMPLATE_NAME)
    guide_pages = discover_guide_pages(root.parent)

    guides_dir = root.parent / "guides"
    guides_dir.mkdir(exist_ok=True)
    canton_path = guides_dir / "cantons.geojson"
    region_path = guides_dir / "regions.geojson"
    if not canton_path.exists() or not region_path.exists():
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from fetch_geodata import fetch_cantons, fetch_regions
        if not canton_path.exists():
            fc = fetch_cantons()
            canton_path.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
        if not region_path.exists():
            fc = fetch_regions()
            region_path.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    cantons_geojson = json.loads(canton_path.read_text(encoding="utf-8")) if canton_path.exists() else {}
    regions_geojson = json.loads(region_path.read_text(encoding="utf-8")) if region_path.exists() else {}

    html = template.render(
        hikes=hikes,
        guide_pages=guide_pages,
        generated=time.strftime("%Y-%m-%d"),
        cantons_geojson=cantons_geojson,
        regions_geojson=regions_geojson,
    )
    out_path = root.parent / "index.html"
    out_path.write_text(html, encoding="utf-8")

    # Also emit a stand-alone hikes.js so the command-center (and any other
    # file:// page) can look up the built hikes by exact lat/lon match. Used
    # by side-panel.js to surface the hero image + local page link inside the
    # expanded route view. Keep it small — JSON only.
    hikes_js_path = root.parent / "hikes.js"
    hikes_js_path.write_text(
        "/* Auto-generated by render_hike.py. Do not edit. */\n"
        f"window.HIKES = {json.dumps(hikes, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    return out_path, time.perf_counter() - t0




def build_difficulty_examples(data_files: list[Path], max_per_grade: int = 2) -> dict[str, list[str]]:
    """Pick up to *max_per_grade* hike names per base grade (T1–T6) for the difficulty guide.

    Returns e.g. {"T2": ["Rigi Kulm"], "T3": ["Augstmatthorn", "Zindlenspitz"], ...}.
    Each name is wrapped as a link: '<a href="...">Name</a>'.
    """
    from collections import defaultdict
    by_grade: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for f in data_files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        slug = d.get("slug") or f.stem.replace(".data", "")
        peak = d.get("peak") or {}
        hero = d.get("hero") or {}
        grade = hero.get("grade", "")
        base = re.match(r'[Tt]\d', grade)
        if not base:
            continue
        name = peak.get("name", slug)
        by_grade[base.group().upper()].append((name, slug))

    examples: dict[str, list[str]] = {}
    for g in ("T1", "T2", "T3", "T4", "T5", "T6"):
        hikes = by_grade.get(g, [])
        selected = sorted(hikes, key=lambda x: x[0])[:max_per_grade]
        examples[g] = [
            f'<a href="../routes/{slug}/{slug}.html">{name}</a>'
            for name, slug in selected
        ]
    return examples


def render_difficulty(root: Path, data_files: list[Path]) -> tuple[Path, float]:
    """Render the difficulty guide page; returns (out_path, elapsed_seconds)."""
    t0 = time.perf_counter()
    env = _make_env()
    template = env.get_template(DIFFICULTY_TEMPLATE_NAME)
    examples = build_difficulty_examples(data_files)
    html = template.render(examples=examples)
    guides_dir = root.parent / "guides"
    guides_dir.mkdir(exist_ok=True)
    out_path = guides_dir / "difficulty.html"
    out_path.write_text(html, encoding="utf-8")
    return out_path, time.perf_counter() - t0


def render_guide_nav_js(hikes_root: Path) -> list[tuple[Path, float]]:
    """Generate _nav.js in every nav-consuming directory.

    The script auto-injects a horizontal guide nav after the ``.crumbs`` element.
    Hrefs are stored with a ``../`` prefix so they resolve correctly from any page
    that lives exactly one directory below ``pages/hikes/`` (guides/, command-center/).
    Active match is by suffix of ``location.pathname``.
    """
    t0 = time.perf_counter()
    pages = discover_guide_pages(hikes_root)
    entries = json.dumps([{"path": p["path"], "label": p["label"]} for p in pages])
    js = (
        "(function(){\n"
        f"var pages={entries};\n"
        "var cur=location.pathname;\n"
        'var crumbs=document.querySelector(".crumbs");\n'
        "if(!crumbs)return;\n"
        'var nav=document.createElement("nav");\n'
        'nav.className="guide-nav";\n'
        "var parts=[];\n"
        'parts.push(\'<a href="../index.html">Hikes</a>\');\n'
        "pages.forEach(function(p){\n"
        '  var active=cur.indexOf("/"+p.path)>=0||cur.endsWith(p.path);\n'
        '  parts.push(\'<a href="../\'+p.path+\'"\'+(active?\' class="active"\':"")+">"+p.label+"</a>");\n'
        "});\n"
        'nav.innerHTML=parts.join(\'<span class="dot">\\u00b7</span>\');\n'
        'crumbs.insertAdjacentElement("afterend",nav);\n'
        "})();\n"
    )
    elapsed = time.perf_counter() - t0
    out_path = hikes_root / "guides" / "_nav.js"
    out_path.write_text(js, encoding="utf-8")
    return [(out_path, elapsed)]


####################################################################################################################################
# Reporting
####################################################################################################################################


def print_summary(results: list[RenderResult], wall_seconds: float) -> None:
    """Print per-hike timing table + aggregate stage breakdown."""
    if not results:
        print("No hikes rendered.")
        return

    stage_names = ["load_json", "validate", "gpx_stats", "augment", "load_template", "render", "write", "track_js"]
    header = f"{'slug':<22}  {'ok':>3}  " + "  ".join(f"{s:>11}" for s in stage_names) + f"  {'total':>9}"
    print()
    print(header)
    print("-" * len(header))
    for r in sorted(results, key=lambda x: -x.total):
        row = f"{r.slug:<22}  {('Y' if r.ok else 'N'):>3}  "
        row += "  ".join(f"{r.stages.get(s, 0)*1000:>8.1f} ms" for s in stage_names)
        row += f"  {r.total*1000:>6.1f} ms"
        print(row)
        if not r.ok:
            print(f"   ERROR: {r.error}")

    # Aggregate (summed across hikes, useful for spotting hot stages)
    print()
    totals = {s: sum(r.stages.get(s, 0) for r in results) for s in stage_names}
    cpu_total = sum(totals.values())
    print(f"{'TOTAL CPU':<22}     " + "  ".join(f"{totals[s]*1000:>8.1f} ms" for s in stage_names)
          + f"  {cpu_total*1000:>6.1f} ms")
    print(f"Wall time: {wall_seconds*1000:.1f} ms across {len(results)} hike(s) "
          f"(speedup vs serial: {cpu_total / max(wall_seconds, 1e-9):.2f}×)")

    # GPX stats sanity print
    print()
    print("GPX stats (per hike):")
    for r in results:
        if r.gpx_stats:
            g = r.gpx_stats
            print(f"  {r.slug:<22}  {int(g['n_points']):>4} pts  "
                  f"{g['distance_km']:>5.1f} km  "
                  f"↑{int(g['ascent_m']):>5} m  ↓{int(g['descent_m']):>5} m  "
                  f"ele {int(g['min_ele'])}–{int(g['max_ele'])} m")
        else:
            print(f"  {r.slug:<22}  (no GPX)")


####################################################################################################################################
# CLI
####################################################################################################################################


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--root", type=Path, default=DEFAULT_ROOT,
                   help="Directory to scan for *.data.json (recursive). Default: routes")
    p.add_argument("--slug", default=None, help="Render only this slug.")
    p.add_argument("--jobs", type=int, default=0,
                   help="Parallel processes (0 = auto = min(N_hikes, cpu_count)).")
    p.add_argument("--profile", action="store_true",
                   help="cProfile the slowest hike and dump top-30 cumulative time.")
    p.add_argument("--probe", action="store_true",
                   help="HEAD-check photo URLs in parallel before rendering.")
    p.add_argument("--no-index", action="store_true",
                   help="Skip rendering the index.html landing page.")
    p.add_argument("--validate-only", action="store_true",
                   help="Schema-validate all data.json files without rendering. Exits non-zero on any error.")
    p.add_argument("--force", action="store_true",
                   help="Force re-render of every hike, ignoring mtime-based incremental cache.")
    args = p.parse_args(argv)

    data_files = find_data_files(args.root, args.slug)
    if not data_files:
        print(f"No *.data.json files found under {args.root}"
              + (f" matching --slug={args.slug}" if args.slug else ""))
        return 1
    print(f"Found {len(data_files)} hike(s):")
    for f in data_files:
        print(f"  {f}")

    if args.validate_only:
        errors_found = False
        for f in data_files:
            slug = f.stem.replace(".data", "")
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if Draft7Validator is not None and _SCHEMA is not None:
                    errs = sorted(Draft7Validator(_SCHEMA).iter_errors(data),
                                  key=lambda e: list(e.absolute_path))
                    if errs:
                        errors_found = True
                        for e in errs[:5]:
                            loc = "/".join(str(p) for p in e.absolute_path) or "<root>"
                            print(f"[validate] FAIL {slug}: {loc}: {e.message}")
                    else:
                        print(f"[validate] OK   {slug}")
                elif Draft7Validator is None:
                    print(f"[validate] SKIP {slug}  (jsonschema not installed)")
                else:
                    print(f"[validate] SKIP {slug}  (schema file missing)")
            except json.JSONDecodeError as exc:
                errors_found = True
                print(f"[validate] FAIL {slug}: JSON parse error: {exc}")
        return 1 if errors_found else 0

    probe_failed = False
    if args.probe:
        probe_failed = probe_urls(data_files)
        if probe_failed:
            print("\n[probe] FAILED: broken URLs detected (see above)")
            return 1

    copied, total = sync_assets(args.root)
    if total:
        print(f"[assets] {copied}/{total} file(s) updated in {args.root}/_assets/")

    # Incremental: skip hikes whose <slug>.html is newer than its inputs.
    # Templates/_assets changes affect every hike, so a single new template
    # mtime busts the cache for the whole site.
    skipped_files: list[Path] = []
    if args.force:
        to_render = list(data_files)
    else:
        template_mtime = _newest_template_mtime()
        to_render = []
        for f in data_files:
            if _hike_needs_render(f, template_mtime):
                to_render.append(f)
            else:
                skipped_files.append(f)
                slug = f.stem.replace(".data", "")
                print(f"[skip] {slug} (unchanged)")

    n_jobs = args.jobs or max(1, min(len(to_render), 8))

    t0 = time.perf_counter()
    if not to_render:
        results: list[RenderResult] = []
    elif n_jobs <= 1 or len(to_render) == 1:
        results = [render_one(f) for f in to_render]
    else:
        with ProcessPoolExecutor(max_workers=n_jobs) as ex:
            results = list(ex.map(render_one, to_render))
    wall = time.perf_counter() - t0

    print_summary(results, wall)

    # Skipped hikes still need GPX stats so the index/difficulty pages have
    # complete data. Fill them in as ok=True placeholders with computed stats.
    if skipped_files:
        for f in skipped_files:
            slug = f.stem.replace(".data", "")
            results.append(RenderResult(
                slug=slug,
                out_path=str(f.parent / f"{slug}.html"),
                ok=True,
                gpx_stats=compute_gpx_stats(f.parent / f"{slug}.gpx"),
            ))

    # Render the index page from the union of per-hike data + GPX stats.
    # Skipped when filtering to a single slug (would drop the others) or --no-index.
    if not args.no_index and not args.slug:
        all_files = find_data_files(args.root, None)
        if len(all_files) != len(data_files):
            # Some hikes weren't rendered this run; pick up GPX stats for them too.
            extra = [f for f in all_files if f not in data_files]
            results = list(results) + [
                RenderResult(slug=f.stem.replace(".data", ""), out_path="",
                             ok=True, gpx_stats=compute_gpx_stats(f.parent / f"{f.stem.replace('.data', '')}.gpx"))
                for f in extra
            ]
        hikes = build_index_hikes(all_files, results)
        out_path, elapsed = render_index(args.root, hikes)
        print(f"\n[index] {out_path}  ({len(hikes)} hike(s), {elapsed*1000:.1f} ms)")

        out_path, elapsed = render_difficulty(args.root, all_files)
        print(f"[difficulty] {out_path}  ({elapsed*1000:.1f} ms)")

        for out_path, elapsed in render_guide_nav_js(args.root.parent):
            print(f"[guide-nav] {out_path}  ({elapsed*1000:.1f} ms)")

        # Guide index page removed — nav bar provides direct links to all guide pages

    if args.profile:
        slowest = max(results, key=lambda r: r.total)
        print(f"\n[profile] re-rendering slowest hike '{slowest.slug}' under cProfile…")
        target = next(f for f in data_files if f.stem.replace(".data", "") == slowest.slug)
        prof = cProfile.Profile()
        prof.enable()
        render_one(target)
        prof.disable()
        stats = pstats.Stats(prof).sort_stats("cumulative")
        stats.print_stats(30)

    return 0 if all(r.ok for r in results) else 2


if __name__ == "__main__":
    sys.exit(main())
