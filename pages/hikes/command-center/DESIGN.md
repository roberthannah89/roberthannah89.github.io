# Command Center — Design Spec

**Date:** 2026-05-25
**Status:** In progress — core map + filters + weather working, weather data pipeline being finalized

## Context

The hike planning workflow today: check weather on [MeteoSwiss](https://www.meteoswiss.admin.ch/), browse SAC routes on sac-map.html, look at webcams separately, cross-reference difficulty and transport — all in different tabs. The command center consolidates everything into a single full-screen map where you can filter 4000+ SAC routes by difficulty AND weather forecast simultaneously.

The core question this tool answers: **"Where should I hike this weekend given the weather?"**

## Architecture

**Stack:** Leaflet.js on SwissTopo tiles — extends the existing `map_shared.js` infrastructure. NOT Windy (Windy wins on weather visualization but can't filter routes by forecast, locks you into their base map, and prevents SwissTopo).

**Deployment:** GitHub Pages (static site). All data loaded via `<script>` tags setting `window.*` globals — no client-side `fetch()` for data files. Weather forecasts are pre-baked by a GitHub Action.

**Data loading:**
- SAC routes: `sac-routes.js` (existing, 962 POIs, loaded as `window.SAC_ROUTES`)
- Weather: `weather-cache.js` (pre-baked daily by GitHub Action, loaded as `window.WEATHER_CACHE`)
- Webcams: `webcams.js` (new, scraped from Windy webcam API, loaded as `window.WEBCAMS`)
- Region boundaries: `cantons.geojson` / `regions.geojson` (existing — loaded via `<script>` wrapper)
- Swiss border: `swiss_border.js` (existing)
- Completed hikes: `completed-hikes.js` (new, generated from `routes/` directory data)

### Weather Data Pipeline

**Problem:** [Open-Meteo](https://open-meteo.com/) rate-limits browser-side bulk requests (962 peaks × batches = 429 errors). API keys embedded in client-side JS are publicly visible on GitHub Pages.

**Solution:** Pre-bake weather data server-side via GitHub Action.

1. **GitHub Action** runs daily (e.g., 5am) on a schedule
2. `scripts/fetch_weather.py` calls Open-Meteo for all 962 unique peak coordinates
   - 40 peaks per batch, 2-second delay between batches (~50 seconds total)
   - Well within free tier limits (no API key needed)
3. Writes `command-center/weather-cache.js` setting `window.WEATHER_CACHE`
4. Commits and pushes — GitHub Pages deploys the updated file
5. Page loads instantly via `<script>` tag — no client-side API calls

**Locally:** Run `make weather` to generate fresh `weather-cache.js` before opening the page.

## Layout

Full-screen map with four UI zones:

```
┌─────────────────────────────────────────────────────────┐
│ Filter bar (top)                                        │
│ [Grade: Any T1-2 T3 T4 T5 T6] [Time: Any 3-5h 5h+]   │
│ [Elev: Any ≤2000 2000-2500 2500+] [Weather filters...] │
├─────────────────────────────────────────┬───────────────┤
│                                         │  Side panel   │
│              MAP                        │  (slides in   │
│    (SwissTopo + weather tiles           │   when route  │
│     + route markers + webcams)          │   expanded)   │
│                                         │               │
│  Weather toggles ──┐                    │  - Route info │
│  [🌧 Rain]         │ (top-right)       │  - 3-day fcst │
│  [☁️ Cloud]        │                    │  - Webcam     │
│  [🌡 Temp]         │                    │  - Photo      │
│  [📷 Cams]         │                    │  - Links      │
│  [❄️ Snow line]    │                    │               │
│                    ┘                    │               │
│                                         │               │
├─────────────────────────────────────────┴───────────────┤
│ Rain radar slider (bottom)                              │
│ [▶ Rain Radar  ----●----  Mon, May 25 · 17:50]         │
└─────────────────────────────────────────────────────────┘
```

### Interaction model

1. **Default:** Full-screen map with route markers (colored by grade) and filter bar
2. **Click route marker → popup:** Key info (grade, time, elevation, mini weather line), "Expand details" button
3. **Click "Expand" → side panel slides in:** Full details — 3-day forecast, nearest webcam thumbnail, SAC photo, links to [SAC portal](https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/) / your hike page / "Open in [Windy](https://www.windy.com/)"
4. **Close panel → back to full map**

## Features

### Route Filters (filter bar, top of map)

Existing filters from sac-map.html, extended:

| Filter | Type | Values |
|---|---|---|
| Grade | multi-select | Any, T1-2, T3, T4, T5, T6 |
| Duration | single-select | Any, ≤3h, 3-5h, 5h+ |
| Elevation | single-select | Any, ≤2000m, 2000-2500m, 2500m+ |

### Weather Filters (new, in filter bar)

| Filter | Type | Values |
|---|---|---|
| Day | single-select | Today, Tomorrow, Day+2 (with dates from cache) |
| Conditions | single-select | Any, Dry only, Clear only |
| Summit temp | single-select | Any, >0°C, >5°C, >10°C, >15°C |
| Wind | single-select | Any, Calm (<20 km/h), Moderate (<40 km/h) |

**How weather filtering works:**
1. `weather-cache.js` loads per-peak 3-day forecasts (pre-baked by GitHub Action / `make weather`)
2. Open-Meteo returns temperature at each peak's actual grid elevation — no lapse rate adjustment needed
3. Filter matching is instant — all data is already in memory
4. Counter shows: "**847 destinations** · **1102 routes**"

### Weather Tile Overlays (toggle panel, top-right of map)

Toggleable tile layers over the base map:

| Layer | Source | Notes |
|---|---|---|
| Rain radar | [RainViewer](https://www.rainviewer.com/) (free, no key) | Animated tiles with time slider |
| Precipitation | [MeteoSwiss](https://www.meteoswiss.admin.ch/) WMS via geo.admin.ch | Swiss-specific, 10-min updates |
| Region temperature | Derived from weather cache | Canton polygons colored by avg temp |

### Rain Radar Time Slider (bottom of map)

- Uses [RainViewer API](https://www.rainviewer.com/api.html) for timestamped radar tiles
- Play/pause button for animation
- Drag slider to scrub through available timestamps (~2 hours past + ~1 hour nowcast)
- Only visible when rain radar layer is active

### Region Temperature Overlay

- Toggle: color-code canton polygons by average peak temperature
- Data: aggregated from per-peak forecasts within each canton (from `cantons.geojson`)
- Visualization: warm (>20°C, amber/red) → cold (<5°C, blue) gradient fill
- Tooltip on hover: "Valais: 18°C"

### Webcam Layer (planned)

- Source: [Windy webcam API](https://api.windy.com/webcams) pre-scraped to `webcams.js` (~800 Swiss cams)
- Display: camera icon markers on map (clustered when zoomed out)
- Click → popup with live thumbnail image, name, elevation, "View Live" link
- Scrape script: `scripts/scrape_webcams.py` — run monthly to refresh

### Completed Hikes Overlay (planned)

- Source: generated from `routes/*/data.json` files
- Display: different marker style (filled vs outlined, or checkmark badge)
- Filter toggle: "Show only unvisited" / "Highlight completed"
- Links to your hike page when expanded

### Side Panel (on route expand)

Sections:

1. **Route info:** Name, grade badge, elevation, all routes with ascent time, descent time, elevation gain
2. **3-day forecast:** Mini weather cards (icon, high/low temp, precipitation, wind) for the peak location
3. **Nearest webcam:** Live thumbnail from closest webcam marker (planned)
4. **Links:**
   - "View on [SAC Portal](https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/)" → SAC route page
   - "Open in [Windy](https://www.windy.com/)" → `windy.com/{lat}/{lon}` centered on the peak
   - "Directions ([Google Maps](https://maps.google.com/))" → transit directions to the peak

## Current Implementation Status

### Built and working
- `command-center/index.html` — full-screen Leaflet map with SwissTopo tiles
- `command-center/command-center.css` — dark amber theme matching site design
- `command-center/command-center.js` — map setup, markers, filter bar, weather toggles, rain radar slider
- `command-center/weather.js` — reads pre-baked `window.WEATHER_CACHE`, provides forecast lookup
- `command-center/filters.js` — route filters (grade, duration, elevation) + weather filters (day, conditions, temp, wind)
- `command-center/side-panel.js` — expandable route detail with forecast and links
- `scripts/fetch_weather.py` — fetches Open-Meteo forecasts for all 962 peaks, writes `weather-cache.js`
- Makefile `weather` target added

### Needs work
- [ ] Run `make weather` to generate initial `weather-cache.js` and verify weather filters
- [ ] RainViewer slider — uses `fetch()` for timestamp list; needs `file://` fallback or accept HTTP-only
- [ ] Region temperature overlay — uses `fetch()` for `cantons.geojson`; wrap as JS global
- [ ] GitHub Action for daily weather refresh
- [ ] Webcam scraper (`scripts/scrape_webcams.py`) and webcam markers
- [ ] Completed hikes overlay (`scripts/gen_completed_hikes.py`)
- [ ] Mobile responsiveness testing
- [ ] Visual polish pass (loading states, empty states, error handling)

## File Structure

```
command-center/
├── index.html              # Main page (hand-authored, not generated)
├── command-center.js       # Core application logic
├── command-center.css      # Styles (dark amber theme)
├── weather.js              # Reads WEATHER_CACHE, provides forecast lookup + icons
├── filters.js              # Route + weather filter state and matching
├── side-panel.js           # Expandable detail panel
├── weather-cache.js        # Pre-baked forecasts (generated by fetch_weather.py)
├── webcams.js              # Pre-scraped webcam data (planned, window.WEBCAMS)
├── completed-hikes.js      # Generated from routes/ (planned, window.COMPLETED)
scripts/
├── fetch_weather.py        # Open-Meteo → weather-cache.js (run daily via GH Action)
├── scrape_webcams.py       # Windy API → webcams.js (planned, run monthly)
├── gen_completed_hikes.py  # routes/*/data.json → completed-hikes.js (planned)
```

Shared dependencies (loaded from existing paths):
- `routes/_assets/map_shared.js`
- `routes/_assets/swiss_border.js`
- `guides/sac-routes.js`
- `guides/cantons.geojson` / `regions.geojson`

## Data Sources

| Source | How used | Frequency | Cost |
|---|---|---|---|
| [Open-Meteo](https://open-meteo.com/) | Per-peak 3-day forecasts | Daily via GitHub Action | Free, no key |
| [RainViewer](https://www.rainviewer.com/) | Precipitation radar tiles | Live tile loads | Free, no key |
| [MeteoSwiss WMS](https://www.geo.admin.ch/) | Precipitation overlay tiles | Live tile loads | Free |
| [SwissTopo WMTS](https://www.swisstopo.admin.ch/) | Base map + hiking trails | Live tile loads | Free |
| [Windy Webcam API](https://api.windy.com/webcams) | Webcam scrape | Monthly | Free tier with API key |
| [SAC Route Portal](https://www.sac-cas.ch/) | Route data (existing) | Already scraped | Free |

## Decisions Log

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Map platform | Leaflet + SwissTopo | Windy API | SwissTopo is essential for Swiss hiking; Windy can't filter routes by weather; full UI control needed |
| Weather data | Open-Meteo per-peak (pre-baked) | Client-side API calls | Rate limits (429 errors with 962 peaks); API keys exposed in client JS on GitHub Pages |
| Weather pipeline | GitHub Action daily + `make weather` | Client-side fetch | Free tier works server-side with delays; no API key needed; instant page load |
| Lapse rate adjustment | Not needed | −6.5°C/1000m adjustment | Open-Meteo returns temperature at each peak's grid elevation directly |
| Webcam source | Windy API (pre-scraped) | Curated list only | ~800 cams vs 6; scrape once, display on our map |
| Deployment | GitHub Pages (static) | `make serve` only | Site is published; all data via `<script>` tags with `window.*` globals |
| Rain radar | RainViewer (HTTP-only) | Pre-baked | Radar data changes every few minutes; pre-baking impractical; accept HTTP requirement |
| Interaction model | Popup + expandable side panel | Popup only / Panel only | Quick scanning + deep planning without compromise |

## Verification

1. Run `make weather` to generate `weather-cache.js`
2. Run `make serve`, open `http://localhost:8000/command-center/`
3. Filter by grade T3-T4, verify only matching routes show
4. Select a day in weather filters, apply "Dry only" — verify route count decreases
5. Apply temperature filter (>10°C) — verify further reduction
6. Click a route marker → popup shows grade, elevation, weather summary
7. Click "Expand details" → side panel slides in with 3-day forecast and links
8. Toggle rain radar overlay → tiles load, slider controls playback
9. Toggle region temperature overlay → cantons colored by average temp
10. Verify counter updates correctly with all filter combinations
