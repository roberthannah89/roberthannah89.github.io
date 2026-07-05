# Agent Instructions — hikes

**Before starting any task, read all documents linked from [docs/README.md](docs/README.md).** This includes the data schema, workflows, and troubleshooting guide — not just the top-level README.

## Key rules

- **Prefer repo docs over memory.** Project context (design specs, architecture decisions, feature status) belongs in `docs/` or feature-level `DESIGN.md` files — not in Claude memory. If information is already documented in the repo, don't duplicate it in memory.
- **Never make up or approximate data.** All coordinates, elevations, times, and other factual values must come from an authoritative source (SAC JSON, GPX, SwissTopo, the route page). If the data isn't available, leave the field as `"TODO"` rather than guessing.
- **Derive from primary data, don't guess.** Whenever possible, values should be reproducibly computed from objective source data rather than manually entered or approximated. For example, distance and elevation gain are computed from the GPX track, SBB timetable links are extracted from the SAC route JSON, and Google Maps directions use the trailhead coordinates. If a value can be derived from data already in the pipeline, add that derivation rather than hardcoding the result.
- **Validate derived data when practical.** After constructing a new hike, spot-check that key derived values are correct — e.g. verify the SBB timetable link resolves to the right station, confirm Google Maps directions point to the trailhead, and sanity-check distances/elevations against the source. Not every render needs full validation, but new hike creation should include a quick check of external links.
- **Never directly ingest data files (GPX, JSON, CSV, etc.) into conversation context.** Always use project scripts to process them (`parse_gpx`, `compute_gpx_stats`, `make new-gpx`, `make render`). Reading data files inline wastes time and tokens — the scripts exist so you don't have to.
- **Never pass inline Python to Bash for data processing.** If a script doesn't exist for what you need, create one in `scripts/` first, then call it. All data transformations should be maintainable, reusable scripts.
- **Keep files organized.** Route-specific files (SAC JSON, GPX, data.json, HTML) go in `routes/<slug>/`. Scripts go in `scripts/`. Docs go in `docs/`. Never dump files in the repo root. If you see misplaced files, move them proactively.
- Never hand-edit generated files — re-run `make render` after editing the source. Generated files carry a `GENERATED FROM …` banner:
  - `routes/<slug>/<slug>.html` ← `templates/hike_page.j2.html` + `<slug>.data.json`
  - `routes/<slug>/<slug>.track.js` ← GPX
  - `routes/_assets/*.{js,css}` ← `templates/_assets/*` (any edit here is silently reverted by CI's `make render`)
  - `index.html`, `guides/difficulty.html`, `guides/_nav.js` ← their `.j2.html` templates
- **Never hardcode shared constants in individual scripts.** Physical constants (earth radius, lapse rate), algorithm parameters (Naismith's rule, elevation smoothing), default text (disclaimer, weather sources), and lookup tables (source URLs, difficulty blurbs) all live in `scripts/config.py`. Import from there — do not duplicate values across files.
- **Pages are opened via `file://` protocol** — `fetch()` and `XMLHttpRequest` will silently fail. Data files that JS needs at runtime must be loaded via `<script>` tags setting globals (e.g. `swiss_border.js` sets `window.SWISS_BORDER`), never fetched. Keep data in separate `.js` files — don't inline large blobs into code files.
- **Maps share construction via `map_shared.js`.** All map features (layers, fullscreen, Swiss border) belong in `addLayerControl` so every map gets them automatically. Never add map features in individual page scripts — put them in the shared code so improvements propagate to all maps. Every template with a map must include `swiss_border.js` before `map_shared.js`.
- **No filler content.** Don't add generic, AI-sounding information that clutters pages and distracts from what hikers actually care about. Every sentence on a hike page should earn its place — if it doesn't add specific, useful detail, cut it. Be short and to the point.
- **Link to authoritative sources inline.** When creating content pages, every tool, app, or organization mentioned should be a clickable link to its most relevant page (MeteoSwiss, SAC, Rega, swisstopo, etc.). Don't collect links in a separate "resources" section — put them where they're useful. Use `target="_blank" rel="noopener"` for external links.
- **Before committing, delete any files made obsolete by your changes.** Temporary outputs, superseded scripts, orphan screenshots, etc. A file is **not** obsolete if it's needed for reproducibility — e.g. SAC route JSONs are raw source data and must be kept even after extraction.
- **When editing map / filter / panel behavior, edit `templates/_assets/hike_map/`, not the pages.** Both `command-center/` and `templates/index.j2.html` compose from the shared engine. Marker rendering, cluster tinting, side panel, filter matching, URL sync, weather lookup, webcam layer, and avalanche layer all live in `hike_map/`. A change there propagates to both pages automatically. Page files stay thin (data + composition + page-specific chrome). See [`templates/_assets/hike_map/DESIGN.md`](templates/_assets/hike_map/DESIGN.md).
- **Command center marker popups: do not regress the first-click fix.** When editing `command-center/command-center.js` or `command-center.css`, preserve all three pieces or the popup will need a second click (or Enter) to open:
  1. `interactive: false` on the permanent tooltip (`marker.bindTooltip(..., { interactive: false })`)
  2. `.leaflet-tooltip-pane { pointer-events: none; }` in CSS
  3. `openPopup()` uses `getPopup()` + `setPopupContent()` for re-clicks, not a fresh `bindPopup()` each time

  Look for the `FIRST-CLICK REGRESSION GUARD` comment in `bindMarkerTooltips()` in command-center.js — read it before editing marker/popup/tooltip code.

## Generated pages

`make render` produces all of these from templates + hike data. Never hand-edit them:

| Output | Template | What it contains |
|---|---|---|
| `routes/<slug>/<slug>.html` | `hike_page.j2.html` | Individual hike page |
| `routes/<slug>/<slug>.track.js` | *(generated from GPX)* | Leaflet track data |
| `index.html` | `index.j2.html` | Gallery landing page with filters and map |
| `guides/difficulty.html` | `difficulty.j2.html` | Trail system, grades, markings, organisations, and national routes |

The remaining guide pages (e.g. `guides/planning.html`, `guides/weather.html`, `guides/gear.html`) are static HTML — edit them directly. To add a new guide page to the nav bar, include these `<meta>` tags in its `<head>`:

```html
<meta name="guide-label" content="Short nav label">
<meta name="guide-card-title" content="Card title on main-page nav">
<meta name="guide-card-desc" content="One-line description (used in meta).">
<meta name="guide-order" content="50">
```

The render script auto-discovers all `guides/*.html` files with these tags and builds the guide nav bar and main-page links from them. Use `guide-order` to control sort position (10, 20, 30… — leave gaps for future pages).

## Shared constants — `scripts/config.py`

All pipeline constants live here. Scripts import from `config.py` instead of defining their own values:

- **Physical:** `EARTH_RADIUS_M`, `LAPSE_RATE_C_PER_KM`
- **GPX processing:** `ELEV_SMOOTH_M`, `LOOP_THRESHOLD_M`
- **Time estimation:** `NAISMITH_SPEED_KMH`, `NAISMITH_ASCENT_MH`
- **Display:** `INDEX_PHOTO_WIDTH`, `DIFFICULTY_BLURBS`, `SOURCE_URL_MAP`
- **Scaffold defaults:** `DEFAULT_WEATHER_SOURCES`, `DEFAULT_DISCLAIMER`

When adding a new constant or lookup table, put it in `config.py` rather than inline in a script.

## SAC Route Portal Structure

SAC organises content as **peak pages** containing one or more **route pages**:

- **Peak page:** `sac-cas.ch/.../zindlenspitz-2260/mountain-hiking/` — lists all routes for a peak
- **Route page:** `sac-cas.ch/.../zindlenspitz-2260/mountain-hiking/bruennelistock-rossaelplispitz-and-zindlenspitz-4567/` — a specific route with GPX geometry

**Hike pages in this repo are based on routes, not peaks.** Each `data.json` corresponds to one specific route. If the user provides a peak URL instead of a route URL, check how many routes exist. If there's only one route, use it. If there are multiple, ask which one before proceeding. In the `sources` array, list the route URL first (primary object), then the peak URL (so readers can find alternative routes):

```json
"sources": [
  { "name": "SAC Route Portal (route)", "url": "https://www.sac-cas.ch/.../route-slug/" },
  { "name": "SAC Route Portal (peak)",  "url": "https://www.sac-cas.ch/.../peak-slug/mountain-hiking/" }
]
```

## Extracting Data from SAC Route Portal

> [!IMPORTANT]
> SAC retired the old monolithic JSON endpoint between 2026-05-22 and 2026-06-01. **New hikes use the v2 pipeline** — see [`docs/workflows/SAC-EXTRACTION.md`](docs/workflows/SAC-EXTRACTION.md) for the full guide. The pre-cutover Playwright/Phase 1–Phase 2 flow is gone (`extract_sac_route.py`/`extract_sac_gpx.py`/`extract_sac_photos.py` have been removed).

### Adding a new hike (one command)

```bash
python scripts/add_sac_hike_v2.py \
    --url '<route-page-url>' --slug '<slug>' \
    --region '<Region>'   # canton auto-detects from peak coords
```

This chains: layer-API GPX → SwissTopo elevation → HTML scrape → scaffold `data.json` with scraped fields → `make render`. Flags: `--no-elevation` / `--no-scrape` / `--no-render` for iteration; `--grade` / `--canton` / `--trailhead` to override; `--stitch` / `--include-dashed` for rare GPX tweaks.

Prerequisites: the peak ID embedded in the URL must already be in `guides/sac-routes.js`; the saved cookie at `~/.config/sac-hikes/cookie` must still be valid (see below to refresh).

### Refreshing the SAC cookie (Cookie-Editor workflow)

The v2 pipeline needs a valid `fe_typo_user` session cookie at `~/.config/sac-hikes/cookie`. When the SAC scrape suddenly returns the login wall (typically every few days), refresh the cookie:

1. In Chrome, log in at https://www.sac-cas.ch.
2. Install the [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm) extension if you haven't already.
3. Click the Cookie-Editor toolbar icon on the SAC tab → **Export** → **Export as JSON** (copies to clipboard).
4. Paste the JSON to the agent, or save it yourself:
   ```bash
   pbpaste | python scripts/fetch_sac_route.py --save-cookie -
   ```
   The script auto-detects Cookie-Editor JSON and writes `~/.config/sac-hikes/cookie` (mode 0600). It also accepts a raw `fe_typo_user` value if you'd rather paste that directly.
5. Re-run `make add-sac …` or `python scripts/scrape_sac_route_page.py …` — it'll pick the cookie up automatically.

**Re-rendering an existing hike** that already has a `sac-route-<ID>.json` capture: just `make render` — the frozen pre-cutover JSONs stay valid for those hikes.

**Never delete SAC source files** (`sac-route-<ID>.json` from v1 captures, or `sac-layer-<ID>.json` from v2 fetches) — they're raw source data needed for reproducibility.
