# Command Center — Design Spec

**Status:** Live — core map, filters, weather, webcams, URL state sync all working.

> **Architecture:** Command Center is a thin composition of the shared hike-map engine. See [`../templates/_assets/hike_map/DESIGN.md`](../templates/_assets/hike_map/DESIGN.md) for marker/cluster/filter/panel design.

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
| `WEATHER_CACHE` + `WEATHER_CACHE_META` | `../templates/_assets/hike_map/weather-cache.js` | Pre-baked by `scripts/fetch_weather.py` |
| `WINDY_WEBCAMS` | `../templates/_assets/hike_map/webcams_windy_data.js` | Pre-fetched by `scripts/fetch_windy_webcams.py` |
| `SLF_CACHE` + `SLF_CACHE_META` | `../templates/_assets/hike_map/slf_cache.js` | Pre-baked by `scripts/fetch_slf_avalanche.py` (lazy-loaded by `window.Overlays.Avalanche.create()`, called automatically at boot — no toggle) |
| `SWISS_BORDER` | `../routes/_assets/swiss_border.js` | GADM boundary |
| `cantons` data | `cantons.js` | Canton polygons (not currently rendered as overlay) |

Weather pipeline, cache schema, and lookup API are documented in [`hike_map/DESIGN.md`](../templates/_assets/hike_map/DESIGN.md#weather-data) (the modules and the generated cache both live in `hike_map/` now — shared with the index page). Run `make weather` locally before opening the page.

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

A side panel slides in from the right when a marker's "Expand details" button is clicked. Marker/cluster rendering, filter matching, URL sync, side-panel structure, and the weather/webcam/avalanche layers are all engine concerns now — see [`hike_map/DESIGN.md`](../templates/_assets/hike_map/DESIGN.md).

## Filter groups CC exposes

CC mounts `HikeMap.FilterBar` with this subset of the canonical URL keys (full table + semantics in [`hike_map/DESIGN.md`](../templates/_assets/hike_map/DESIGN.md#canonical-url-keys)):

`g` (grade) · `tm` (time) · `el` (elev) · `gn` (gain) · `d` (day) · `sk` (sky) · `t` (temp min) · `sn` (season) · `h` (show hikes) · `u` (show huts) · `dp` (display — which fields render in the marker tooltip; doesn't affect visibility)

No `av` key — the avalanche layer has no toggle (see "Always-on layers" in the engine doc). Region (`r`), canton (`c`), route type (`rt`), and distance (`di`) are index-only filters; CC doesn't expose them since SAC POIs aren't grouped that way in the UI.

**No "Any" buttons** — empty/no selection means any. For single-select filters, clicking the active button deactivates it.

## Toggles (bottom bar)

| Toggle | Default | What it does |
|---|---|---|
| ⛰ Hikes | on | Show peak/summit/traverse POIs (filter key `h`) |
| 🏚 SAC huts | on | Show SAC hut POIs (filter key `u`) |
| 📷 Webcams | off | Add the Windy webcam layer (`window.WebcamLayer.create()`) |

Avalanche is **not** a bottom-bar toggle — it's always on, auto-created at boot by `bootAvalancheLayer()` in `command-center.js` (`window.Overlays.Avalanche.create()`, called unconditionally, no gate). See "Always-on layers" in [`hike_map/DESIGN.md`](../templates/_assets/hike_map/DESIGN.md#always-on-layers).

Tooltip/name visibility is controlled by the filter-bar **Show** (`dp`) pills, not a bottom-bar toggle.

Base-layer choice (Topo+Trails / Topo / Aerial / OSM) is provided by `MapShared.addLayerControl`, then relocated into the bottom bar.

## File structure

```
command-center/
├── index.html              # Page shell (hand-authored)
├── command-center.js       # Thin composition: HikeMap.* mounts, bottom bar, toggles, reset
├── command-center.css      # Dark amber theme (CC-specific chrome only)
├── season.js               # Heuristic season window per POI (altitude + grade → month range) — CC-only filter
├── overlays.js             # Prototype layer factories (window.Overlays.<name>.create()) not yet promoted to hike_map/
├── nav-menu.js             # ☰ nav dropdown wiring
├── cities.js               # Reference city coords for sanity-checking the weather cache — CC-only
└── cantons.js              # Canton polygons (kept on disk for a future overlay; NOT loaded from index.html)

templates/_assets/hike_map/  # shared engine — see hike_map/DESIGN.md for the full module list
```

## Data sources

| Source | Used for | Cost |
|---|---|---|
| [SwissTopo WMTS](https://www.swisstopo.admin.ch/) | Base maps + hiking trail overlay | Free, no key |
| [Open-Meteo](https://open-meteo.com/) (MeteoSwiss ICON-CH2) | Per-peak forecasts (`FORECAST_DAYS = 5`) | Free, no key |
| [Windy Webcams API](https://api.windy.com/webcams) | Webcam thumbnails + links | Free tier (key needed for scrape) |
| [SLF CAAML bulletin (aws.slf.ch)](https://aws.slf.ch/api/bulletin/caaml/en/geojson) | Daily avalanche danger regions + polygons | Free, no key |
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
| Season filter — data source | Heuristic (altitude + grade → tier) labeled "(estimated)" | (a) Re-scrape `discipline_season` for all ~960 routes, (b) per-hut `opening` codes from the search API | SAC's only per-route season field is binary `"summer"`/`"winter"` and lives on individual route detail pages — re-scraping 960 of them just to derive a coarse signal isn't worth it. Per-hut opening codes ARE in the search API but would only cover huts (~25% of POIs). A documented heuristic from altitude + grade is reproducible, defensible (high alpine = summer-only by convention), and clearly labeled in the UI as estimated. See `season.js` for the tier table |
| Season filter — UI | Single toggle "In season now" (🍂) | Multi-select month picker / "what's in season in August" | v1 matches the existing single-toggle idiom (like Day picker); planning a hike for a specific future month is rare enough that a date-picker would clutter the bar. Easy to extend later if the use case shows up |
| Snow-line indicator surface | Pale-blue ❄ corner badge on the marker (bottom-right) + numeric snow-line on every side-panel forecast card | Standalone filter pill ("Above freezing only") | The marker badge is glanceable while scanning the map and mirrors the existing ★ has-page corner-badge pattern — adding a *filter* would gate visibility, which is usually not what the user wants (T6 climbers may *want* the snowy peaks). Showing the value in the side-panel cards lets the user see the snow line shift day-by-day, which is the real planning signal. A filter pill can be added later if it turns out hikers reach for it. |
| Snow-line daily roll-up | Max of the hourly `freezing_level_height` series, per day | Mean / median / min | Highest excursion during the day is the conservative bound — "could the peak be in snow at any point today?" matters more for planning than the daily average. Computed in `fetch_weather.py` so client code never has to crunch the hourly array. |
| Avalanche data source | SLF EAWS CAAML GeoJSON (`aws.slf.ch/api/bulletin/caaml/en/geojson`) | geo.admin.ch WMS `ch.bab.schutzgebiete-lawinengefahrenzonen`; scraping the SLF bulletin HTML | The CAAML GeoJSON is the same feed WhiteRisk uses — gives both the merged region polygons and the current 1–5 danger rating per region group in one CORS-enabled call. The WMS layer only shows static hazard *zones* (where avalanches can happen) not today's danger *level*, which is what hikers actually need |
| Avalanche colour scheme | Official EAWS levels: 1 `#ccff66` · 2 `#ffff00` · 3 `#ff9900` · 4 `#ff0000` · 5 `#640000`, 0.4 fill opacity | Custom scheme; greyscale; black-and-red chequer for level 5 | Hikers recognise the EAWS scale from every Swiss avalanche bulletin. The dark red (`#640000`) for level 5 matches WhiteRisk's app convention and reads better as a semi-transparent fill than the print-bulletin chequer pattern |
| Avalanche layer default | Always on, no toggle | Off by default (opt-in, matching the webcam pattern) | Superseded 2026-07: hazard/safety layers must never be hidden behind a click a user might not know to make. Off-season the SLF bulletin renders nothing anyway, so there's no summer clutter cost to being always-on. May extend to future "danger segments" layers |
| Avalanche module pattern | IIFE + `window.SlfLayer` global, plain `<script src>` | ES modules with `import/export` | Pages are opened via `file://`, so `<script type="module">` is blocked for local files. Matches the existing `weather.js` / `webcams.js` convention so command-center.js can consume `SlfLayer` as a plain global inside its IIFE |

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
