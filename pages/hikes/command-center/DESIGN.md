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
window.WEATHER_CACHE_META = { updated: "2026-05-25T...", model: "meteoswiss_icon_ch2", peaks: 962 };
window.WEATHER_CACHE = { "47.123,8.456": { elevation, daily: { ... } }, ... };
```

The `_META` header is rendered in the bottom bar so the user knows which model and how stale.

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
│   [⛰ Hikes] [🏚 SAC huts] [📷 Webcams] [🏷 Names]        │
│   N destinations · M routes  [Reset]                    │
│   MeteoSwiss ICON-CH2 · updated 3h ago                  │
└─────────────────────────────────────────────────────────┘
```

A side panel slides in from the right when a marker's "Expand details" button is clicked.

## Markers and clusters

Markers and clusters are horizontal pills, not generic circles.

**Hike/peak/hut marker (single):**
- With weather data → pill showing weather emoji + temperature (e.g. `⛅ 9°`), bordered in the route's grade color.
- Without weather data → small grade-colored dot.
- Permanent name tooltip below the marker, hidden via CSS at low zoom (`body.zoom-labels` is added at zoom ≥ 11). The Names toggle hides/shows the labels via `body.names-off` without re-binding tooltips.

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
| Grade | multi-select | T1-2, T3, T4, T5, T6 |
| Time | single-select | ≤3h, 3-5h, 5h+ |
| Elev (peak altitude) | single-select | ≤2000 m, 2-2.5 k, 2.5 k+ |
| Gain (vertical ascent) | single-select | ≤500, 500-1k, 1-1.5k, 1.5k+ |
| Day | single-select | Today, Tomorrow, … (driven by `WEATHER_CACHE` day count) |
| Sky | multi-select icons | ☀️ Clear · ⛅ Partly · ☁️ Cloudy/fog · 🌧 Rain · ❄️ Snow · ⛈ Storm |
| Temp (peak max) | single-select | >0°, >5°, >10°, >15° |

The selected Day drives both the temperature/sky filters and the emoji + temperature shown on every marker and cluster.

POIs without weather data are never filtered out by sky/temp — the data simply isn't available for them.

The counter (bottom bar) shows `<destinations> · <routes>` after filters apply. A **Reset** button appears whenever the URL hash is non-empty; clicking it clears the hash and reloads (which also resets the non-filter toggles).

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
| 🏷 Names | on | Show permanent name labels above the cluster threshold (toggles `body.names-off`) |

Base-layer choice (Topo+Trails / Topo / Aerial / OSM) is provided by `MapShared.addLayerControl`, then relocated into the bottom bar.

## Side panel

Slides in when "Expand details" is clicked in a marker popup. Sections:

1. Route info: name, grade badge, elevation, per-route ascent time / descent time / elevation gain
2. 3-day forecast cards for the peak
3. Links to [SAC Portal](https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/), [Windy](https://www.windy.com/) (centered on peak), and [Google Maps](https://maps.google.com/) transit directions

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
└── cantons.js              # Canton polygons (loaded; no overlay rendered currently)

scripts/
├── fetch_weather.py        # Open-Meteo (model=meteoswiss_icon_ch2) → weather-cache.js
└── fetch_windy_webcams.py  # Windy Webcams API → webcams_windy_data.js
```

## Data sources

| Source | Used for | Cost |
|---|---|---|
| [SwissTopo WMTS](https://www.swisstopo.admin.ch/) | Base maps + hiking trail overlay | Free, no key |
| [Open-Meteo](https://open-meteo.com/) (MeteoSwiss ICON-CH2) | Per-peak 3-day forecasts | Free, no key |
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
| Sky filter | Multi-select emoji icons | Single-select dropdown | Lets users combine "clear OR partly cloudy" without committing to one |
| URL state | Hash-based with short keys | Query string / no persistence | Hash survives `file://`, no server round-trip, links are shareable |
| Reset behavior | Clear hash + reload | In-place state reset | Reload also clears non-filter toggles (webcams, names) and re-renders every button in its default state — single cheap mechanism |
| Webcam layer | ~80 Windy markers (top-by-views) | All ~800 cams / curated list | Top 80 is enough coverage without map clutter; cheap popup with thumbnail; "View live" link defers to Windy |
| Rain radar | **Removed** | RainViewer tile layer + time slider | Required `fetch()` for timestamp list (breaks under `file://`); added a third UI surface (slider) that competed with filters for attention; live radar belongs on dedicated weather sites |
| Region temperature overlay | **Removed** | Canton polygons tinted by avg temp | Per-marker emoji + temperature already conveys the same information at higher resolution |
| Live precipitation tile | **Removed** | MeteoSwiss WMS overlay | Same reasoning as rain radar — replaced by per-peak pre-baked data |
| "Show weather on markers" toggle | **Removed** | Toggle on/off | Weather-on-markers is now always on; the alternative (grade-only dots) was rarely chosen and added a click |
| Day summary subtitle | **Removed** | Brief sentence under Day buttons | Day labels (Today / Tomorrow / …) are self-explanatory; subtitle was filler |
| Wind filter | **Removed** | Wind speed thresholds | Cache no longer exposes wind via the filter UI (wind data is still in the cache and shown in popups). Adding back if requested |

## Verification

1. `make weather` writes `weather-cache.js` (check `WEATHER_CACHE_META.model === "meteoswiss_icon_ch2"`).
2. `make serve`, open `http://localhost:8000/command-center/`.
3. Markers should show emoji + temperature pills; clusters show count + dominant emoji + avg temp.
4. Toggle filters — counter and visible markers should update; URL hash should reflect the active state.
5. Reload after applying filters — state should restore, Reset button should appear.
6. Click "Reset" — page reloads with default state, hash cleared.
7. Enable Webcams — 80 `📷` markers should appear; click one to see thumbnail popup.
8. Forecast meta in the bottom bar should show `MeteoSwiss ICON-CH2 · updated Nh ago`.
