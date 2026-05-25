# SAC Map Page — Design Spec

## Overview

A static guide page (`guides/sac-map.html`) displaying all SAC mountain hiking routes on an interactive Leaflet map with grade, region, elevation, and duration filters.

## Data Pipeline

### Scrape script (`scripts/scrape_sac_pois.py`)

Paginates the SAC search API:
```
GET https://www.suissealpine.sac-cas.ch/api/1/poi/search
  ?lang=en&output_lang=en
  &disciplines=mountain_hiking
  &hut_type=all
  &mode=per_discipline
  &limit=100&offset=0
```

Per POI, extracts:
- `id`, `display_name`, `altitude`, `type` (summit/traverse/hut/etc.)
- `geom.coordinates` (Swiss LV95) — converted to WGS84 at scrape time
- `regions_denormalization` (region name)
- Per route: `id`, `title`, `main_difficulty`, `ascent_altitude`, `ascent_time_max`, `descent_time_max`

LV95 to WGS84 conversion uses the official swisstopo approximate formulas (CH1903+/LV95).

Output: `guides/sac-routes.json` — array of objects:
```json
[
  {
    "id": 27,
    "name": "Almagellerhorn",
    "alt": 3326,
    "type": "summit",
    "lat": 46.0912,
    "lon": 7.9623,
    "region": "Valais",
    "routes": [
      {
        "id": 6268,
        "title": "Von Heitbodme uber den Sudwestgrat",
        "grade": "T4+",
        "gain": 1000,
        "time_up": 180,
        "time_down": 120
      }
    ]
  }
]
```

### Makefile target

`make scrape-sac` runs the scrape script. This is a manual, infrequent operation — not part of `make render`.

## Page: `guides/sac-map.html`

Static HTML with guide meta tags for auto-discovery in the guide index.

### Layout

- Guide nav bar (same as other guide pages)
- Filter bar (pill buttons, same style as index page)
- Full-width map (~80vh height)
- Counter: "X routes visible"

### Filters

All use the same `.filter-btn` pill style as the index page.

| Filter | Values |
|---|---|
| Grade | Any, T1–T2, T3, T4, T5, T6 |
| Region | Any, then dynamic from data (Valais, Bern, Graubunden, etc.) |
| Elevation | Any, ≤2000m, 2001–2500m, >2500m |
| Duration | Any, ≤3h, 3–5h, >5h (based on `time_up`) |

Filters are AND-combined. Changing a filter updates marker visibility and the counter.

### Map

- Uses existing `map_shared.js` for tiles, layer control, Swiss border.
- Markers clustered via Leaflet.markerCluster (CDN) for performance at low zoom.
- Marker icons colored by grade: green (T1-T2), yellow (T3), orange (T4), red (T5), purple (T6).
- Simple circle markers or colored div icons.

### Marker popup

Clicking a marker shows:
- Peak name and elevation
- Route name, difficulty pill, elevation gain
- Ascent time (formatted as Xh Ym)
- Link to SAC route page: `https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/{poi_id}/mountain_hiking`

### Scripts loaded

1. Leaflet CSS + JS (CDN)
2. Leaflet.markerCluster CSS + JS (CDN)
3. `swiss_border.js`
4. `map_shared.js`
5. Inline: `<script src="sac-routes.json">` — loaded as a JS file setting `window.SAC_ROUTES`
   (Or fetched via script tag pattern to comply with file:// protocol constraint)
6. `sac-map.js` — page-specific logic

### `guides/sac-map.js`

Responsibilities:
- Parse `window.SAC_ROUTES`, create markers with grade-colored icons
- Build marker cluster group, add to map
- Generate region filter buttons dynamically from data
- Implement `applyFilters()` — show/hide markers, update counter
- Bind filter button click handlers
- Create popups on marker click

## What's excluded

- No weather overlay
- No card grid or list view
- No connection to the user's own hike pages
- No live API calls — data is static JSON refreshed by re-running scrape
