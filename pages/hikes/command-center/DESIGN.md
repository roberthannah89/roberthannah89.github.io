# Command Center — Design Spec

**Status:** Live — core map, filters, weather, webcams, URL state sync all working.

## Context

The hike planning workflow today: check weather on [MeteoSwiss](https://www.meteoswiss.admin.ch/), browse SAC routes on `sac-map.html`, look at webcams separately, cross-reference difficulty and transport — all in different tabs. The command center consolidates everything into a single full-screen map where you can filter all SAC routes by difficulty AND weather forecast simultaneously.

The core question this tool answers: **"Where should I hike this weekend given the weather?"**

## Architecture

**Stack:** Leaflet.js on SwissTopo tiles, extending the existing `map_shared.js` infrastructure (Topo+Trails / Topo / Aerial / OpenStreetMap base layers; Swiss border overlay; fullscreen). Not Windy — Windy can't filter routes by forecast and locks you into its base map.

**Deployment:** Static site (GitHub Pages or `file://`). All data is loaded via `<script>` tags setting `window.*` globals — no client-side `fetch()`. Weather forecasts are pre-baked.

**Data loaded at boot:**

| Global | File | Source |
|---|---|---|
| `SAC_ROUTES` | `../guides/sac-routes.js` | Scraped SAC POIs (peaks + huts) |
| `WEATHER_CACHE` + `WEATHER_CACHE_META` | `weather-cache.js` | Pre-baked by `scripts/fetch_weather.py` |
| `WINDY_WEBCAMS` | `webcams_windy_data.js` | Pre-fetched by `scripts/fetch_windy_webcams.py` |
| `SWISS_BORDER` | `../routes/_assets/swiss_border.js` | GADM boundary |
| `cantons` data | `cantons.js` | Canton polygons (not currently rendered as overlay) |

### Weather data pipeline

**Model:** [MeteoSwiss ICON-CH2](https://www.meteoswiss.admin.ch/weather/warning-and-forecasting-systems/icon-forecasting-system.html) (2 km Alpine-tuned grid, 5-day horizon), served via the Open-Meteo API by passing `models=meteoswiss_icon_ch2`. ICON-CH1 is finer (1 km) but only 33 h horizon — too short for multi-day filtering.

**Pipeline:** `scripts/fetch_weather.py` calls Open-Meteo for every unique peak coordinate (40 peaks/batch, 2 s between batches), writes `command-center/weather-cache.js`:

```js
window.WEATHER_CACHE_META = { updated: "2026-05-25T...", model: "meteoswiss_icon_ch2", peaks: 962, schema: 2 };
window.WEATHER_CACHE = { "47.123,8.456": { elevation, daily: { ... } }, ... };
```

The `_META` header is rendered in the bottom bar so the user knows which model and how stale. `schema` bumps whenever a new daily field is added so client code can detect older caches.

**Daily fields** (per-peak `daily.*` arrays, one entry per forecast day):

| Field | Source | Notes |
|---|---|---|
| `time` | Open-Meteo daily | `YYYY-MM-DD`, Europe/Zurich |
| `weathercode` | Open-Meteo daily | WMO code → emoji + sky category |
| `temperature_2m_max` / `_min` | Open-Meteo daily | Drives Temp filter and marker pill |
| `precipitation_sum` | Open-Meteo daily | mm |
| `windspeed_10m_max` | Open-Meteo daily | km/h |
| `sunrise` / `sunset` | Open-Meteo daily | ISO |
| `freezing_level_max` | **schema 2** — rolled up from hourly `freezing_level_height` | Metres above sea level. Open-Meteo only exposes freezing-level as an hourly variable, so `fetch_weather.py` requests the hourly series and stores the per-day max. Used by the snow-line indicator on markers and side-panel cards. `null` per day if the hourly samples were missing; field absent entirely on older (schema 1) caches. |

Run `make weather` locally before opening the page.

## Layout

```
┌─────────────────────────────────────────────────────────┐
│ Filter bar (top-left, wraps): Grade · Time · Elev ·     │
│   Gain · Day · Sky · Temp                                │
│                                                          │
│                                                          │
│                       MAP                                │
│       (SwissTopo + markers + clusters + webcams)         │
│                                                          │
│                                                          │
├─────────────────────────────────────────────────────────┤
│ Bottom bar (left → right):                              │
│   [Topo+Trails | Topo | Aerial | OSM]   ← base switcher │
│   [⛰] [🏚] [📷]            ← icon-only POI/layer toggles │
│   📍 N · 🥾 M  [Reset]      ← icon-only counter + reset  │
│   [Share]                  ← copy current URL to clipboard │
│   MeteoSwiss ICON-CH2 · updated 3h ago                  │
└─────────────────────────────────────────────────────────┘
```

Filter and bottom-bar elements are icon-first: labels for Grade / Time / Day / Sky / Temp are dropped because the buttons themselves carry meaning (SAC trail-marker SVGs for Grade, `h` / `°` suffixes for Time / Temp, day names for Day, weather emoji for Sky). Only Elev, Gain, and Show keep word labels because their button content is otherwise ambiguous.

A side panel slides in from the right when a marker's "Expand details" button is clicked.

## Markers and clusters

Markers and clusters are horizontal pills, not generic circles.

**Hike/peak/hut marker (single):**
- With weather data → pill showing weather emoji + temperature (e.g. `⛅ 9°`), bordered in the route's grade color.
- Without weather data → small grade-colored dot.
- Has a built hike page in this repo → small amber ★ at the marker's top-right corner (`.hike-marker--has-page::after`). Matching is delegated to `SidePanel.matchingHike` so the on-map cue can never drift from the side-panel's "Open hike page" link.
- Peak elevation above the forecast snow line → pale-blue ❄ at the marker's bottom-right corner (`.hike-marker--above-freezing::before`). Computed in `refreshMarkerIcons` from `WeatherService.freezingLevel(lat, lon, dayIndex)` against `poi.alt` — so it tracks the currently selected Day filter. POIs without an `alt` or without freezing data never get the badge (no false negatives surface as "safe").
- Permanent name tooltip below the marker, hidden via CSS at low zoom (`body.zoom-labels` is added at zoom ≥ 11). Tooltip visibility is controlled by the filter-bar **Show** pills: turning Name off sets `body.display-name-off`, which hides the name line; if no other Show pill (Grade/Gain/Time/Alt) is active, the whole tooltip box also collapses via `:not(:has(.hike-tt__meta))`.

**Cluster:** Horizontal pill `count · dominant-sky-emoji · avg-temp` (e.g. `6 ⛅ 4°`), tinted by the dominant sky category among its children. Tints (`SKY_TINTS` in `command-center.js`):

| Category | Tint |
|---|---|
| clear | amber |
| partly-cloudy | warm grey |
| cloudy | dark slate |
| rain | blue |
| snow | pale grey-blue |
| storm | red |

Clustering disabled at zoom ≥ 13 (each marker visible individually).

## Filters

Filter bar at top-left. **No "Any" buttons** — empty/no selection means any. For single-select filters, clicking the active button deactivates it.

| Filter | Type | Values |
|---|---|---|
| Grade | multi-select, SAC trail-marker SVG icons | T1-2 (yellow Wanderweg), T3 (white-red-white Bergwanderweg), T4 / T5 / T6 (white-blue-white Alpinwanderweg) |
| Time | single-select | ≤3h, 3-5h, 5h+ |
| Elev (peak altitude) | single-select | ≤2000 m, 2-2.5 k, 2.5 k+ |
| Gain (vertical ascent) | single-select | ≤500, 500-1k, 1-1.5k, 1.5k+ |
| Day | single-select | Today, Tomorrow, … (driven by `WEATHER_CACHE` day count — up to 5 days per `FORECAST_DAYS` in `fetch_weather.py`) |
| Sky | threshold-select, emoji icons | ☀️ Clear · ⛅ Partly · ☁️ Cloudy/fog · 🌧 Rain. Snow ❄️ and Storm ⛈ remain in `SKY_CATEGORIES` for ordering (so "Rain or better" still excludes them) and marker emoji, but are hidden from the filter UI — nobody filters "snow or better". |
| Temp (peak max) | single-select | >0°, >5°, >10°, >15° |

The selected Day drives both the temperature/sky filters and the emoji + temperature shown on every marker and cluster.

POIs without weather data are never filtered out by sky/temp — the data simply isn't available for them.

The counter (bottom bar) shows `📍 <destinations> · 🥾 <routes>` after filters apply. A **Reset** button appears whenever the URL hash is non-empty; clicking it clears the hash and reloads (which also resets non-filter toggles). A separate **Share** pill copies the current URL (including hash state) to the clipboard.

A **Show** multi-select group at the end of the filter bar controls per-POI rendering (not which POIs match): `⛅` toggles the weather pill marker (off = grade-colored dot), and `Name` / `T` / `↑m` / `h` / `alt` toggle which fields appear in the marker tooltip. Default: only `weather` is on — Name tooltips are opt-in to keep the map uncluttered.

## URL state sync (`url-sync.js`)

Filter state is mirrored to `window.location.hash` so views are bookmarkable/shareable. Short keys keep URLs compact and tolerant to schema drift:

| State key | URL key |
|---|---|
| grades | `g` |
| duration | `dur` |
| elevation | `el` |
| gain | `gn` |
| showHikes | `h` |
| showHuts | `u` |
| weatherDay | `d` |
| sky | `sk` |
| tempMin | `t` |

`Filters.setState` writes the hash on every change. `Filters.loadState(UrlSync.readFromUrl())` is called before the filter UI is built so buttons reflect the restored state.

## Toggles (bottom bar)

| Toggle | Default | What it does |
|---|---|---|
| ⛰ Hikes | on | Show peak/summit/traverse POIs (`Filters.showHikes`) |
| 🏚 SAC huts | on | Show SAC hut POIs (`Filters.showHuts`) |
| 📷 Webcams | off | Add the Windy webcam layer (`WebcamLayer.create()`) |

Tooltip/name visibility is controlled by the filter-bar **Show** pills, not a bottom-bar toggle (see Markers and clusters section above).

Base-layer choice (Topo+Trails / Topo / Aerial / OSM) is provided by `MapShared.addLayerControl`, then relocated into the bottom bar.

## Side panel

Opens when "Expand details" is clicked in a marker popup, OR when a marker is clicked while the panel is already open (the panel swaps to the new POI and no popup is shown — see the `popupopen` guard in `createMarkers()`). Sections:

1. Route info: name (linked to SAC peak portal, `/mountain-hiking/` variant), grade badge, elevation, per-route ascent / descent / elevation gain (each linked to its SAC route page)
2. Forecast cards for the peak — one per day in `WEATHER_CACHE` (currently up to 5). Each card includes a `❄ NNNN m` snow-line value when the cache has freezing-level data; the value pops to pale blue (`day-freeze--above`) when the peak is above it.
3. Selected-day summary line under the cards: max wind, sunrise/sunset, and a `❄️ Freezing level: NNNN m (peak +/- N m)` indicator so the delta is unambiguous.
4. Links to [Windy](https://www.windy.com/) (centered on peak) and [Google Maps](https://maps.google.com/) transit directions

The panel re-renders live on every filter change via `Filters.subscribe()`, so flipping Day / Sky / Temp while the panel is open updates the forecast cards in place.

## Webcam layer (`webcams.js`)

- Data: `WINDY_WEBCAMS` from `webcams_windy_data.js` (pre-fetched by `scripts/fetch_windy_webcams.py`).
- Display: top ~80 webcams by view count as simple `📷` markers.
- Click → popup with thumbnail, name, location, "Updated N min ago", and "View live →" link.
- Toggle in the bottom bar; layer is created lazily on first activation.

## File structure

```
command-center/
├── index.html              # Page shell (hand-authored)
├── command-center.js       # Map setup, markers, clusters, filter bar, toggles, reset
├── command-center.css      # Dark amber theme
├── filters.js              # Filter state + matching (grade, duration, elev, gain, sky, temp)
├── url-sync.js             # Filter state ↔ window.location.hash
├── weather.js              # WEATHER_CACHE accessor, sky categories, day choices, meta
├── side-panel.js           # Expandable detail panel
├── webcams.js              # Windy webcam Leaflet layer
├── weather-cache.js        # Pre-baked forecasts (generated)
├── webcams_windy_data.js   # Pre-fetched webcam data (generated)
└── cantons.js              # Canton polygons (kept on disk for a future overlay; NOT loaded from index.html)

scripts/
├── fetch_weather.py        # Open-Meteo (model=meteoswiss_icon_ch2) → weather-cache.js
└── fetch_windy_webcams.py  # Windy Webcams API → webcams_windy_data.js
```

## Data sources

| Source | Used for | Cost |
|---|---|---|
| [SwissTopo WMTS](https://www.swisstopo.admin.ch/) | Base maps + hiking trail overlay | Free, no key |
| [Open-Meteo](https://open-meteo.com/) (MeteoSwiss ICON-CH2) | Per-peak forecasts (`FORECAST_DAYS = 5`) | Free, no key |
| [Windy Webcams API](https://api.windy.com/webcams) | Webcam thumbnails + links | Free tier (key needed for scrape) |
| [SAC Route Portal](https://www.sac-cas.ch/) | Route POIs (existing pipeline) | Free |

## Decisions log

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Map platform | Leaflet + SwissTopo | Windy API | SwissTopo essential for Swiss hiking; full UI control required for filtering |
| Weather data | Pre-baked Open-Meteo cache | Client-side fetches | Rate limits (~960 peaks) + API keys exposed on static hosting |
| Weather model | MeteoSwiss ICON-CH2 (2 km, 5-day) | Open-Meteo `best_match`, ICON-CH1 (1 km, 33 h) | CH2 is Alpine-tuned and covers the multi-day filter horizon; CH1 too short; best_match opaque/inconsistent across peaks |
| Filter "Any" buttons | Removed | Explicit Any button per group | Empty selection already means any; the extra button added clutter. Click-active-to-clear is unambiguous |
| Marker style | Horizontal pill with emoji + temp | Grade-colored dot only | Weather is the primary planning lens; surfacing temp + sky on every marker removes the need to open popups while scanning |
| Cluster style | Pill with count + dominant emoji + avg temp | Plain count circle | Same reasoning — the cluster needs to convey weather at a glance |
| Name labels | Permanent tooltips at zoom ≥ 11, toggle | Always-on / on-hover | Visible when zoomed in for planning, hidden when zoomed out to avoid clutter; toggle for users who want a clean map |
| Sky filter | Threshold-select emoji icons ("X or better") | Multi-select / single-select dropdown | Threshold matches how hikers actually think ("I'll accept rain or better"); auto-includes everything cleaner without per-pill clicks |
| Sky filter — Snow / Storm | Hidden from UI, kept in `SKY_CATEGORIES` for ordering | Show them as filter buttons | Nobody filters "snow or better"; keeping them in the data preserves marker emoji and lets "Rain or better" correctly exclude snow/storm peaks |
| Grade filter icons | SAC trail-marker SVG (yellow / red-white / blue-white) with TX overlaid | Plain text "T3" pill | Authentic Swiss trail signage — instantly recognisable to anyone who's hiked here, replaces text label + colored pill with a single semantically loaded glyph |
| Filter-group word labels | Dropped for Grade / Time / Day / Sky / Temp; kept for Elev / Gain / Show | Word label per group | Most buttons carry units or icons that say what they are; Elev/Gain are pure numbers and need disambiguation; Show needs to signal filter-vs-display |
| Bottom-bar toggles & counter | Icon-only (emoji + numbers) with `title` tooltips | Icon + label | Eliminates redundant word labels; pills are compact enough that mobile fits without horizontal scroll |
| Names toggle (bottom bar) | **Removed** | Bottom-bar 🏷 button | Redundant with the Show:Name pill (turning Show:Name off + no other Show pill = same effect); having both was confusing because the bottom toggle wasn't URL-synced |
| Default tooltip content | Empty (no Name, no metadata) | Name on by default | Map is more scannable with just weather pills; users opt into labels via Show pills |
| Forecast horizon | 5 days (full ICON-CH2 horizon) | 3 days | Cheap to fetch the extra two days; weekend planners want to see further ahead |
| Share button | Standalone bottom-bar pill | Buried in route-counter | URL state is already mirrored to hash — surfacing a one-click copy makes "share this view" a first-class action |
| Side-panel re-render | `Filters.subscribe()` callback | Render once on open | Otherwise the panel's forecast cards / wind lines go stale when the user changes Day / Sky / Temp |
| Marker click while panel open | Swap panel content directly; suppress popup | Open popup, force Expand click | One fewer click; panel is the canonical detail surface so the popup adds nothing in that state |
| URL state | Hash-based with short keys | Query string / no persistence | Hash survives `file://`, no server round-trip, links are shareable |
| Reset behavior | Clear hash + reload | In-place state reset | Reload also clears non-filter toggles (webcams) and re-renders every button in its default state — single cheap mechanism |
| Webcam layer | ~80 Windy markers (top-by-views) | All ~800 cams / curated list | Top 80 is enough coverage without map clutter; cheap popup with thumbnail; "View live" link defers to Windy |
| Rain radar | **Removed** | RainViewer tile layer + time slider | Required `fetch()` for timestamp list (breaks under `file://`); added a third UI surface (slider) that competed with filters for attention; live radar belongs on dedicated weather sites |
| Region temperature overlay | **Removed** | Canton polygons tinted by avg temp | Per-marker emoji + temperature already conveys the same information at higher resolution |
| Live precipitation tile | **Removed** | MeteoSwiss WMS overlay | Same reasoning as rain radar — replaced by per-peak pre-baked data |
| "Show weather on markers" toggle | **Removed** | Toggle on/off | Weather-on-markers is now always on; the alternative (grade-only dots) was rarely chosen and added a click |
| Day summary subtitle | **Removed** | Brief sentence under Day buttons | Day labels (Today / Tomorrow / …) are self-explanatory; subtitle was filler |
| Wind filter | **Removed** | Wind speed thresholds | Cache no longer exposes wind via the filter UI (wind data is still in the cache and shown in popups). Adding back if requested |
| Snow-line indicator surface | Pale-blue ❄ corner badge on the marker (bottom-right) + numeric snow-line on every side-panel forecast card | Standalone filter pill ("Above freezing only") | The marker badge is glanceable while scanning the map and mirrors the existing ★ has-page corner-badge pattern — adding a *filter* would gate visibility, which is usually not what the user wants (T6 climbers may *want* the snowy peaks). Showing the value in the side-panel cards lets the user see the snow line shift day-by-day, which is the real planning signal. A filter pill can be added later if it turns out hikers reach for it. |
| Snow-line daily roll-up | Max of the hourly `freezing_level_height` series, per day | Mean / median / min | Highest excursion during the day is the conservative bound — "could the peak be in snow at any point today?" matters more for planning than the daily average. Computed in `fetch_weather.py` so client code never has to crunch the hourly array. |

## Verification

1. `make weather` writes `weather-cache.js` (check `WEATHER_CACHE_META.model === "meteoswiss_icon_ch2"`; the `daily.time` array should have 5 entries).
2. `make serve`, open `http://localhost:8000/command-center/`.
3. Markers should show emoji + temperature pills; clusters show count + dominant emoji + avg temp.
4. Toggle filters — counter and visible markers should update; URL hash should reflect the active state.
5. Reload after applying filters — state should restore, Reset button should appear.
6. Click "Reset" — page reloads with default state, hash cleared.
7. Click "Share" — current URL (with hash) lands in clipboard; button briefly reads "Copied".
8. Enable Webcams — 📷 markers should appear; click one to see thumbnail popup.
9. Forecast meta in the bottom bar should show `MeteoSwiss ICON-CH2 · updated Nh ago`.
10. Click any peak — popup opens on first click (no Enter needed). Click "Expand details" — side panel slides in. Click another peak — panel content swaps directly, no popup re-appears.
11. With the side panel open, change the Day filter — the forecast cards in the panel update live without re-opening.
12. Snow line: each side-panel forecast card shows `❄ NNNN m`. When the peak's elevation exceeds the value, the line goes pale blue and the marker on the map gains a small ❄ at its bottom-right corner (mirroring the ★ has-page badge at top-right). Flipping Day re-renders both surfaces.
