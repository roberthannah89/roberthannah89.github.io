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
- Optional `--probe` mode: parallel HEAD probes of webcam + photo URLs,
  warning on 4xx/5xx so dead links are caught at build time.

Usage
-----
    python render_hike.py                              # render all hikes under /opt/code/hikes
    python render_hike.py --root /opt/code/hikes
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
import cProfile
import json
import math
import pstats
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from jinja2 import Environment, FileSystemLoader, StrictUndefined

try:
    from jsonschema import Draft7Validator
    SCHEMA_PATH = Path(__file__).resolve().parent.parent / "templates" / "hike_data.schema.json"
    _SCHEMA = json.loads(SCHEMA_PATH.read_text()) if SCHEMA_PATH.exists() else None
except ImportError:
    Draft7Validator = None
    _SCHEMA = None

####################################################################################################################################
# Constants
####################################################################################################################################

SKILL_DIR = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = SKILL_DIR / "templates"
ASSETS_DIR = TEMPLATE_DIR / "_assets"
TEMPLATE_NAME = "hike_page.j2.html"
INDEX_TEMPLATE_NAME = "index.j2.html"
# Skill lives at <repo>/skills/hiking, hikes live at <repo>/hikes
DEFAULT_ROOT = SKILL_DIR.parent.parent / "hikes"

GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}

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

    def __enter__(self) -> "StageTimer":
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc: object) -> None:
        self.store[self.name] = time.perf_counter() - self.t0


####################################################################################################################################
# GPX stats
####################################################################################################################################


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance between two (lat, lon) points in metres."""
    r = 6371000.0
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def compute_gpx_stats(gpx_path: Path) -> dict[str, float]:
    """Return distance / ascent / descent stats from a GPX file.

    Ascent uses a 3 m smoothing threshold to avoid GPS / SRTM noise.
    Returns an empty dict if the file does not exist or has no points.
    """
    if not gpx_path.exists():
        return {}
    tree = ET.parse(gpx_path)
    pts: list[tuple[float, float, float]] = []
    for tp in tree.findall(".//g:trkpt", GPX_NS):
        ele_el = tp.find("g:ele", GPX_NS)
        ele = float(ele_el.text) if ele_el is not None and ele_el.text else 0.0
        pts.append((float(tp.get("lat")), float(tp.get("lon")), ele))
    if len(pts) < 2:
        return {}
    dist = 0.0
    for a, b in zip(pts, pts[1:]):
        dist += _haversine_m((a[0], a[1]), (b[0], b[1]))
    asc = desc = 0.0
    last = pts[0][2]
    for p in pts[1:]:
        d = p[2] - last
        if abs(d) >= 3:
            if d > 0:
                asc += d
            else:
                desc -= d
            last = p[2]
    elev = [p[2] for p in pts]
    return {
        "n_points": float(len(pts)),
        "distance_km": dist / 1000.0,
        "ascent_m": asc,
        "descent_m": desc,
        "min_ele": min(elev),
        "max_ele": max(elev),
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
            "lat": float(w.get("lat")),
            "lon": float(w.get("lon")),
            "label": label,
            "kind": kind,
        })
    return out


def naismith_hours(distance_km: float, ascent_m: float) -> float:
    """Naismith's rule: 1 h per 5 km flat + 1 h per 600 m of ascent."""
    return distance_km / 5.0 + ascent_m / 600.0


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


####################################################################################################################################
# Render core
####################################################################################################################################


def _make_env() -> Environment:
    """Jinja env with strict undefined so missing fields fail loudly."""
    return Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        undefined=StrictUndefined,
        autoescape=False,  # template explicitly marks html-bearing fields with `| safe`
        trim_blocks=False,
        lstrip_blocks=False,
        keep_trailing_newline=True,
    )


def render_one(data_path: Path) -> RenderResult:
    """Render one hike. Pure function — safe for ProcessPoolExecutor."""
    stages: dict[str, float] = {}
    gpx_stats: dict[str, float] = {}
    slug = data_path.stem.replace(".data", "")
    out_path = data_path.parent / f"{slug}.html"
    try:
        with StageTimer(stages, "load_json"):
            data = json.loads(data_path.read_text(encoding="utf-8"))
            data.setdefault("slug", slug)

        with StageTimer(stages, "validate"):
            if Draft7Validator is not None and _SCHEMA is not None:
                errors = sorted(Draft7Validator(_SCHEMA).iter_errors(data),
                                key=lambda e: list(e.absolute_path))
                if errors:
                    msgs = []
                    for e in errors[:5]:
                        loc = "/".join(str(p) for p in e.absolute_path) or "<root>"
                        msgs.append(f"{loc}: {e.message}")
                    raise ValueError("schema validation failed: " + "; ".join(msgs))

        with StageTimer(stages, "gpx_stats"):
            gpx_path = data_path.parent / f"{slug}.gpx"
            gpx_stats = compute_gpx_stats(gpx_path)

        with StageTimer(stages, "augment"):
            # Auto-derive waypoints from GPX <wpt>s when data has none.
            if not data.get("waypoints"):
                data["waypoints"] = parse_gpx_waypoints(
                    gpx_path,
                    peak_name=data.get("peak", {}).get("name"),
                    trailhead_name=data.get("trailhead", {}).get("name"),
                )
            # Auto-derive hero subtitle from GPX when requested.
            hero = data.get("hero") or {}
            if hero.get("auto_subtitle") and gpx_stats:
                hero["subtitle_html"] = auto_subtitle(hero.get("grade", ""), gpx_stats)
                data["hero"] = hero

        with StageTimer(stages, "load_template"):
            env = _make_env()
            template = env.get_template(TEMPLATE_NAME)

        with StageTimer(stages, "render"):
            html = template.render(**data)

        with StageTimer(stages, "write"):
            out_path.write_text(html, encoding="utf-8")

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


def probe_urls(data_files: Iterable[Path], max_workers: int = 16) -> None:
    """HEAD-check every webcam + photo URL across all hikes; warn on failure."""
    targets: list[tuple[str, str]] = []  # (slug, url)
    for f in data_files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        slug = d.get("slug") or f.stem.replace(".data", "")
        for cam in d.get("webcams") or []:
            if not cam.get("fallback") and cam.get("url"):
                targets.append((slug, cam["url"]))
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
    else:
        print(f"[probe] all {len(targets)} URLs OK ({dt:.2f}s)")


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


def _index_photo_url(data: dict) -> str:
    """Pick the index-card photo URL, defaulting to first photo at width=400."""
    override = (data.get("index_card") or {}).get("photo_url")
    if override:
        return override
    photos = data.get("photos") or []
    if not photos:
        return ""
    url = photos[0].get("url", "")
    return url.replace("width=600", "width=400")


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
        grade_class = ic.get("pill_class") or grade.lower()

        distance = ic.get("distance") or (
            f"{gpx['distance_km']:.1f} km" if gpx.get("distance_km") else "—")
        gain = ic.get("gain") or (
            f"{int(round(gpx['ascent_m']))} m" if gpx.get("ascent_m") else "—")

        hikes.append({
            "name": peak.get("name", slug),
            "region": ic.get("region", ""),
            "href": f"{slug}/{slug}.html",
            "elev": f"{peak.get('elev', '')} m" if peak.get("elev") else "",
            "grade": grade,
            "gradeClass": grade_class,
            "distance": distance,
            "gain": gain,
            "time": ic.get("time", ""),
            "lat": peak.get("lat"),
            "lon": peak.get("lon"),
            "photo": _index_photo_url(d),
        })
    return hikes


def render_index(root: Path, hikes: list[dict]) -> tuple[Path, float]:
    """Render the index page; returns (out_path, elapsed_seconds)."""
    t0 = time.perf_counter()
    env = _make_env()
    template = env.get_template(INDEX_TEMPLATE_NAME)
    html = template.render(
        hikes=hikes,
        generated=time.strftime("%Y-%m-%d"),
    )
    out_path = root / "index.html"
    out_path.write_text(html, encoding="utf-8")
    return out_path, time.perf_counter() - t0


####################################################################################################################################
# Reporting
####################################################################################################################################


def print_summary(results: list[RenderResult], wall_seconds: float) -> None:
    """Print per-hike timing table + aggregate stage breakdown."""
    if not results:
        print("No hikes rendered.")
        return

    stage_names = ["load_json", "validate", "gpx_stats", "augment", "load_template", "render", "write"]
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
                   help="Directory to scan for *.data.json (recursive). Default: /opt/code/hikes")
    p.add_argument("--slug", default=None, help="Render only this slug.")
    p.add_argument("--jobs", type=int, default=0,
                   help="Parallel processes (0 = auto = min(N_hikes, cpu_count)).")
    p.add_argument("--profile", action="store_true",
                   help="cProfile the slowest hike and dump top-30 cumulative time.")
    p.add_argument("--probe", action="store_true",
                   help="HEAD-check webcam + photo URLs in parallel before rendering.")
    p.add_argument("--no-index", action="store_true",
                   help="Skip rendering the index.html landing page.")
    args = p.parse_args(argv)

    data_files = find_data_files(args.root, args.slug)
    if not data_files:
        print(f"No *.data.json files found under {args.root}"
              + (f" matching --slug={args.slug}" if args.slug else ""))
        return 1
    print(f"Found {len(data_files)} hike(s):")
    for f in data_files:
        print(f"  {f}")

    if args.probe:
        probe_urls(data_files)

    copied, total = sync_assets(args.root)
    if total:
        print(f"[assets] {copied}/{total} file(s) updated in {args.root}/_assets/")

    n_jobs = args.jobs or min(len(data_files), 8)

    t0 = time.perf_counter()
    if n_jobs <= 1 or len(data_files) == 1:
        results = [render_one(f) for f in data_files]
    else:
        with ProcessPoolExecutor(max_workers=n_jobs) as ex:
            results = list(ex.map(render_one, data_files))
    wall = time.perf_counter() - t0

    print_summary(results, wall)

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
