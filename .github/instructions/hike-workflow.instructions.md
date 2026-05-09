---
applyTo: "**"
---

# Hike page workflow & data.json schema

All per-hike content lives in `hikes/<slug>/<slug>.data.json`. The rendered HTML is generated
by `skills/hiking/scripts/render_hike.py` from `skills/hiking/templates/hike_page.j2.html`.
**Never hand-edit a generated `<slug>.html` or `hikes/index.html`.**

## Scripts

```bash
cd /opt/code/website

# Fast path for agents / batch work:
~/venvs/dev/bin/python skills/hiking/scripts/add_hike.py \
  --spec /abs/path/to/<slug>.spec.json

# Scaffold a new hike:
~/venvs/dev/bin/python skills/hiking/scripts/new_hike.py \
  --slug <slug> --name <Name> --region <Region> --canton <Canton> \
  --grade T3 --elev <elev> --trailhead <Village>

# Build GPX + track.js (once per hike):
~/venvs/dev/bin/python skills/hiking/scripts/build_hike_gpx.py \
  --slug <slug> --peak <Peak> --trailhead <Village> \
  --via <Wpt1> --via <Wpt2> \
  --bbox <s,w,n,e> --out-dir hikes/<slug>/

# Render (all hikes + index.html):
~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py
~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py --slug <slug>   # single
~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py --probe         # + URL checks
~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py --jobs 1        # serial
```

### Preferred fast path (`add_hike.py`)

Use `add_hike.py` when parallel agents are researching multiple hikes at once.
It does three things in one command:

1. Generates `hikes/<slug>/<slug>.data.json` from the normal template.
2. Merges the provided JSON spec on top of the template.
3. Runs `build_hike_gpx.py` and `render_hike.py --slug <slug>`.

Supported flags:

- `--overwrite` — replace an existing `<slug>.data.json`
- `--skip-gpx` — write data only
- `--skip-render` — write data (and maybe GPX) only
- `--probe` — pass `--probe` through to `render_hike.py`
- `--print-spec-template` — emit an example spec JSON

Spec examples live in `skills/hiking/spec-examples/`.

- `eiger-trail.spec.json` — straightforward route with named waypoints only
- `kreuzberge.spec.json` — explicit waypoint coordinates for ambiguous OSM names

Required spec keys:

- `slug`, `name`, `region`, `canton`, `grade`, `elev`
- `peak.{name?,lat,lon}`
- `trailhead.{name,lat,lon}`

All other top-level keys are merged directly into the generated `data.json`.
That means agents can fill only the sections they already know (for example
`index_card`, `hero`, `intro_html`, `photos`, `trip_reports`) and leave the
rest as template TODOs.

`route_build` controls GPX generation:

- `via` and `descend_via` may contain either strings or objects with
  `{ "name", "lat", "lon" }`
- `end_name` / `end_ll` are optional
- `bbox` is optional when `peak.lat/lon` and `trailhead.lat/lon` are present

`--slug` implicitly skips the index regen. Use `--no-index` to skip explicitly on full runs.
The summary table prints per-hike stage timings and GPX stats for sanity-checking.

## data.json — full schema

| Field | Required | Notes |
|-------|----------|-------|
| `slug` | recommended | Inferred from filename if omitted |
| `page` | yes | `{ title, generated, reports_updated, year? }` (ISO dates) |
| `peak` | yes | `{ name, elev, lat, lon }` |
| `trailhead` | yes | `{ name, lat, lon, transit_dest }` |
| `hero` | yes | `{ image_url, subtitle_html, grade }` — `grade` highlights the SAC table row |
| `intro_html` | optional | Free HTML block under the hero |
| `quick_facts` | yes | List of `[label, value_html]` pairs |
| `photos` | yes | List of `{ url, alt, caption_html, lightbox_url? }` |
| `waypoints` | yes | `{ lat, lon, label, kind }` — kind ∈ `start`/`summit`/`way` |
| `routes_subtitle` | optional | Suffix after the Routes heading |
| `routes` | yes | `{ title_html, grade, grade_label?, pill_class?, bullets_html }` |
| `getting_there` | yes | `{ by_car_html, by_pt_html, by_pt_heading? }` |
| `day_plans` | yes | `{ title?, subheading?, rows: [[time, step], …], footer_html? }` |
| `weather` | yes | `{ lapse_rate: { valley_ref, summit_above_ref_m, temp_drop_c, example_html }, sources_html: [...], season_html }` |
| `webcams` | yes | `{ url, label, fallback }` — fallback=true renders a Meteoblue link card |
| `elev_chart_attrib_html` | optional | Footnote under elevation chart |
| `trip_reports` | yes | `{ hikr_index_url, takeaways_html: [...], reports: [{ url, title, season, grade, grade_label?, pill_class?, bullets_html }] }` |
| `gear` | yes | `{ title, items_html }` |
| `safety_html` | yes | List of bullet HTML strings |
| `resources_html` | yes | List of bullet HTML strings (typically `<a>` tags) |
| `disclaimer_html` | yes | Closing-section HTML |
| `index_card` | yes | Fields for the auto-generated hikes index page (see below) |

### index_card fields

The index page (`hikes/index.html`) reads from each `data.json`:

| Source | Used for |
|--------|----------|
| `peak.name` | Hike name |
| `peak.elev` | Elevation |
| `peak.lat` / `peak.lon` | Open-Meteo weather lookup |
| `hero.grade` | Grade pill colour |
| `photos[0].url` | Thumbnail (auto-rewritten `width=600` → `width=400`) |
| `index_card.canton` | Map marker colour + filter button |

Required `index_card` keys: `region`, `canton`, `time`.
Optional: `distance`, `gain` (override GPX-derived), `pill_class` (e.g. `"t4"` for orange), `photo_url`.

All `*_html` fields render with `| safe` — escape untrusted content yourself.

### Auto-derivation

- `hero.auto_subtitle: true` → generates subtitle string from GPX (Naismith's rule for time).
- Empty `waypoints` list → parsed from `<slug>.gpx` `<wpt>` entries (matched by name to set `kind`).

### Optional sections

- **SLF / avalanche banner** — fold into `intro_html` or `safety_html` for shoulder-season hikes.
- **Cable-car operating hours** — add as a row in a `day_plans` table.
- **Hut booking** — add to `resources_html`.

## Staleness warning

Pages render a freshness warning automatically once `page.reports_updated` is older than
6 months. Regenerate the trip-report digest each season.

## Gotchas

- **FOTO-WEBCAM URL sizes**: use `/current/1200.jpg` or `/current/1920.jpg` — never `/current/1024.jpg` (404).
- **Wikimedia Commons rate-limits HEAD floods** — `--probe` may 429 on photo URLs that are
  fine in a browser. Re-probe individually if unsure.
- **SRTM under-reads sharp summits** by ~50–100 m. Use catalog elevation (SAC/Wikipedia)
  for `peak.elev`; SRTM is fine for the elevation chart.
- **Hikr is behind Cloudflare** — direct fetches fail. Use a web search for snippets.

## `_config.js` (optional per-hike)

Each `hikes/<slug>/` folder may contain a `_config.js` with a referrer-restricted
Google Maps Embed API key and a default transit origin:

```js
window.HIKE_CONFIG = {
  gmaps_key: "YOUR_KEY",  // Maps Embed API; restrict to localhost:* + file:///*
  transit_origin: "Zurich HB",
};
```

Pages work without it — the embedded transit iframe disappears, but deep-link buttons remain.
