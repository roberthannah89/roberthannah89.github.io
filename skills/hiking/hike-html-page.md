# Hike Plan HTML page (preferred deliverable)

A self-contained interactive HTML page per hike, with embedded live transit, 7-day forecast, trip-report digest, GPX-derived elevation profile, and nearby webcams. Lives at `hikes/<slug>/<slug>.html` alongside its GPX file.

**Architecture (refactored 2026-05):** all per-hike content is a single `<slug>.data.json` file. The HTML is rendered from a shared Jinja template ([`skills/hiking/templates/hike_page.j2.html`](./skills/hiking/templates/hike_page.j2.html)) by [`skills/hiking/scripts/render_hike.py`](./skills/hiking/scripts/render_hike.py). Shared CSS and JS live in [`skills/hiking/templates/_assets/hike_page.{css,js}`](./skills/hiking/templates/_assets/) and are copied to `<root>/_assets/` on every render — each hike page is ~370 lines instead of ~800. To change a hike, edit the JSON. To improve all hike pages at once, edit the asset files or the template and re-render. Never hand-edit a generated `<slug>.html`.

**Validation:** every `data.json` is checked against [`skills/hiking/templates/hike_data.schema.json`](./skills/hiking/templates/hike_data.schema.json) before rendering. Missing required fields fail fast with a clear error.

**Auto-derivation from GPX:** `render_hike.py` automatically:
- parses `<wpt>` entries from `<slug>.gpx` into the data file's `waypoints` field if you leave it empty (matches the trailhead/peak names to set `kind`).
- generates the hero subtitle (`SAC T3 · ~1218 m gain · ~7.4 km one-way · ~7h round-trip`) when you set `hero.auto_subtitle: true` (uses Naismith's rule for time).


## Workflow for a new hike

0. **Scaffold.** Run the scaffold script to create the directory and a pre-filled starter `data.json`:
   ```bash
   cd /opt/code/website
   python skills/hiking/scripts/new_hike.py \
     --slug <slug> --name <Name> \
     --region <Region> --canton <Canton> \
     --grade T3 --elev <elev> --trailhead <Village>
   ```
   The script creates `hikes/<slug>/` and `hikes/<slug>/<slug>.data.json` with all required schema fields pre-filled (TODO placeholders for fields you still need to author). It prints a checklist of remaining TODOs after creation.
1. **Slug.** Pick `<peak-slug>` (lowercase, hyphenated, ASCII).
2. **Identify peak.** SAC Route Portal lookup; cross-check Wikipedia (DE) for elevation, prominence, dominance.
3. **Trailhead.** Pick the standard trailhead from SAC.
4. **Routed GPX + track.js with elevations.** Run the build script (writes to `hikes/<slug>/`):
   ```bash
   python skills/hiking/scripts/build_hike_gpx.py \
     --slug <slug> --peak <Peak> --trailhead <Village> \
     --via <Waypoint1> --via <Waypoint2> \
     --bbox <s,w,n,e> --out-dir hikes/<slug>/
   ```
   Outputs `<slug>.gpx` (full track) and `<slug>.track.js` (~200 points, Douglas-Peucker).
5. **Photos.** 4 Wikimedia Commons photos (`Special:FilePath` recipe) — peak from 2 angles + 1 ridge + 1 valley/lake context shot.
6. **Trip-report digest.** Fetch the peak's hikr index. Pick 3 most recent T3-T4 reports. Summarize each in 2–3 bullets. Synthesize 2–4 cross-report patterns. **Hikr is behind Cloudflare — direct WebFetch fails. Use WebSearch for snippets.**
7. **Webcams.** Browse https://www.foto-webcam.eu/ for cameras within ~10 km. URL pattern: `/webcam/<slug>/current/1200.jpg`. Verify with `--probe` (see below).
8. **Author `<slug>.data.json`.** Copy the structure from any existing hike (e.g. `hikes/zindlenspitz/zindlenspitz.data.json`) and fill in fields. See **Schema** below.
9. **Render + verify.**
   ```bash
   python skills/hiking/scripts/render_hike.py --slug <slug> --probe
   ```
   Open the resulting `hikes/<slug>/<slug>.html` in a browser.

## Render script (`render_hike.py`)

```
# Render every *.data.json under the hikes repo (parallel, profiled):
python skills/hiking/scripts/render_hike.py

# Single hike:
python skills/hiking/scripts/render_hike.py --slug santis

# Also HEAD-check every webcam + photo URL (parallel):
python skills/hiking/scripts/render_hike.py --probe

# Profile the slowest hike (cProfile, top-30 cumulative):
python skills/hiking/scripts/render_hike.py --profile

# Force serial (debugging):
python skills/hiking/scripts/render_hike.py --jobs 1

# Skip the index.html regen (e.g. if you only want to update one hike page):
python skills/hiking/scripts/render_hike.py --slug santis      # implicit --no-index when --slug used
python skills/hiking/scripts/render_hike.py --no-index         # explicit
```

The script auto-renders `hikes/index.html` after all per-hike pages render (unless `--slug` or `--no-index` is given). The index is fully derived from per-hike `data.json` files — never hand-edit `hikes/index.html`.

The summary table prints per-hike stage timings (`load_json`, `gpx_stats`, `load_template`, `render`, `write`) plus a CPU-vs-wall speedup ratio. Per-hike GPX stats (n points, distance, ascent/descent, elevation range) are printed too — useful for sanity-checking your hero subtitle numbers.

## Schema (`<slug>.data.json`)

Top-level fields:

| Field | Required | Notes |
|-------|----------|-------|
| `slug` | recommended | Inferred from filename if omitted. |
| `page` | yes | `{ title, generated, reports_updated, year? }` (ISO dates) |
| `peak` | yes | `{ name, elev, lat, lon }` |
| `trailhead` | yes | `{ name, lat, lon, transit_dest }` |
| `hero` | yes | `{ image_url, subtitle_html, grade }` (grade highlights the SAC table row) |
| `intro_html` | optional | Free HTML block under hero. |
| `quick_facts` | yes | List of `[label, value_html]` pairs. |
| `photos` | yes | List of `{ url, alt, caption_html, lightbox_url? }`. |
| `waypoints` | yes | List of `{ lat, lon, label, kind }` where kind ∈ `start`/`summit`/`way`. |
| `routes_subtitle` | optional | Suffix after the "Routes" h2. |
| `routes` | yes | List of `{ title_html, grade, grade_label?, pill_class?, bullets_html }`. `pill_class` overrides the default `t<N>` pill colour. |
| `getting_there` | yes | `{ by_car_html, by_pt_html, by_pt_heading? }` |
| `day_plans` | yes | List of `{ title?, subheading?, rows: [[time, step], …], footer_html? }`. Multi-day routes use multiple plan objects. |
| `weather` | yes | `{ lapse_rate: { valley_ref, summit_above_ref_m, temp_drop_c, example_html }, sources_html: [...], season_html }` |
| `webcams` | yes | List of `{ url, label, fallback }`. |
| `elev_chart_attrib_html` | optional | Footnote under the elevation chart. |
| `trip_reports` | yes | `{ hikr_index_url, takeaways_html: [...], reports: [{ url, title, season, grade, grade_label?, pill_class?, bullets_html }] }` |
| `gear` | yes | List of `{ title, items_html }`. |
| `safety_html` | yes | List of bullet HTML strings. |
| `resources_html` | yes | List of bullet HTML strings (typically `<a>` tags). |
| `disclaimer_html` | yes | Closing-section HTML. |
| `index_card` | yes | Per-hike fields used **only** by the auto-generated `hikes/index.html` landing page. See below. |

### `index_card` schema

The landing page (`hikes/index.html`) is rendered from `templates/index.j2.html` after all per-hike pages render. It iterates over every `<slug>.data.json` and pulls:

| Source | Index column |
|--------|--------------|
| `peak.name` | Hike name |
| `peak.elev` | Elev. |
| `peak.lat` / `peak.lon` | Open-Meteo forecast lookup |
| `hero.grade` | Grade pill (default colour from grade letter) |
| `photos[0].url` | Thumbnail (auto-rewritten `width=600` → `width=400`) |
| GPX-computed | Distance + Gain (when `index_card.distance`/`gain` not given) |

Required `index_card` keys: `region`, `time`. Optional: `distance`, `gain` (override GPX-derived numbers), `pill_class` (override grade pill colour, e.g. `"t4"` to render T4 in orange instead of red), `photo_url` (override thumbnail).

All `*_html` fields are rendered with `| safe` — escape user-untrusted content yourself.

## Optional sections (opt-in per hike)

- **SLF / avalanche banner** — for shoulder-season (May / Oct–Nov) hikes near avalanche terrain. Fold into `intro_html` or `safety_html`.
- **Cable-car operating hours** — add a row to a day-plan table.
- **Hut booking** — add to `resources_html`.

## Trip-report digest staleness

Hikr summaries go stale fast. The page renders a freshness warning automatically once `page.reports_updated` is older than 6 months. Regenerate the digest each season.

## `_config.js` (optional, shared)

Each hike folder may include a `_config.js` holding the Google Maps Embed API key (referrer-restricted to `localhost:*` and `file:///*`) and a default transit origin. Pages work without it — the embedded iframe disappears, deep-link buttons remain.

## Lookup gotchas (additions to SKILL.md's list)

- **FOTO-WEBCAM coverage is patchy.** Outside high-traffic alpine areas, there may be no nearby camera. Render a Meteoblue webcam-page link card as a fallback (`fallback: true`).
- **FOTO-WEBCAM URL size.** The current image is at `/current/1200.jpg` or `/current/1920.jpg`, never `/current/1024.jpg` (404). Use `render_hike.py --probe` to catch dead URLs.
- **Wikimedia Commons rate-limits HEAD floods** — `--probe` may report 429s on photo URLs even when they're fine in a browser. Re-probe individually if unsure.
- **Google Maps Embed API specifics.** The key must have **Maps Embed API** explicitly enabled. HTTP-referrer restrictions need both `http://localhost:*/*` AND `file:///*` for personal/local use.
- **SRTM under-reads sharp summits** by ~50–100 m on tall, narrow peaks. Acceptable for the elevation chart; use the catalog elevation (SAC/Wikipedia) for `peak.elev` and Quick Facts.
