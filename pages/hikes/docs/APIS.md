# Swiss APIs & Data Layers

External APIs and data sources used or available for the hiking site. Each section lists the endpoint, what it provides, auth requirements, and browser compatibility.

For live demos of each API, see the `docs/prototypes/` folder.

---

## Currently Used

### SwissTopo WMTS — Map Tiles

Provides the base map and hiking trail overlay for all map views.

```
https://wmts.geo.admin.ch/1.0.0/{layer}/default/current/3857/{z}/{x}/{y}.{ext}
```

| Layer ID | Description | Format |
|----------|-------------|--------|
| `ch.swisstopo.pixelkarte-farbe` | Topo map (color) | JPEG |
| `ch.swisstopo.pixelkarte-grau` | Topo map (greyscale) | JPEG |
| `ch.swisstopo.swissimage` | Aerial / satellite | JPEG |
| `ch.swisstopo.swisstlm3d-wanderwege` | Hiking trail overlay | PNG |

- **Auth:** None
- **CORS:** Yes
- **Browser:** Loads via `<img>` (Leaflet tile layers) — works on `file://`
- **Used in:** `map_shared.js`, all hike pages, index map

### Open-Meteo — Weather Forecast

7-day weather forecast for hike pages and index weather strips, plus the pre-baked per-peak forecast cache used by the command center.

```
GET https://api.open-meteo.com/v1/forecast
    ?latitude={lat}&longitude={lon}&elevation={elev}
    &daily=temperature_2m_max,temperature_2m_min,precipitation_sum,
           wind_gusts_10m_max,weather_code,sunrise,sunset
    &timezone=Europe/Zurich
    &models=meteoswiss_icon_ch2     # command-center only
```

- **Auth:** None
- **CORS:** Yes
- **Rate limit:** Generous (10,000 req/day free tier)
- **Used in:** `hike_page.js`, `index_page.js`, `scripts/fetch_weather.py` (command-center cache, uses MeteoSwiss ICON-CH2)

### Swiss Transport (SBB) — Timetable Links

Static timetable links to SBB for trailhead connections.

```
https://www.sbb.ch/en/buying/pages/fahrplan/fahrplan.xhtml?von={from}&nach={to}
```

- **Used in:** `hike_page.js` — generates clickable link in "Getting There" section
- **Limitation:** Static link, no live data

### geo.admin.ch — Geodata API

Swiss federal geodata for canton/region detection and elevation lookup.

**MapServer Identify** (canton + region from coordinates):
```
GET https://api3.geo.admin.ch/rest/services/api/MapServer/identify
    ?geometry={lon},{lat}&geometryType=esriGeometryPoint
    &sr=4326&layers=all:{layer}&tolerance=0
```

| Layer ID | Returns |
|----------|---------|
| `ch.swisstopo.swissboundaries3d-kanton-flaeche.fill` | Canton name |
| `ch.bafu.biogeographische_regionen` | Biogeographical region |

**Height API** (elevation from coordinates):
```
GET https://api3.geo.admin.ch/rest/services/height
    ?easting={e}&northing={n}&sr=2056
```

- **Auth:** None
- **CORS:** Yes
- **Used in:** `add_sac_hike_v2.py`, `fetch_geodata.py`, `new_hike.py`

### SAC Suissealpine — Route Data

Public API for SAC mountain hiking routes. Full reference: [`SAC-API.md`](SAC-API.md).

```
GET https://www.suissealpine.sac-cas.ch/api/1/poi/search
    ?lang=en&output_lang=en&disciplines=mountain_hiking
    &mode=per_discipline&limit=100&cursor={cursor}
```

- **Auth:** None (search/layer endpoints). Route detail requires authenticated Playwright session.
- **CORS:** Yes
- **Used in:** `scrape_sac_pois.py` → `sac-routes.js` for SAC map

---

## Available — Not Yet Integrated

### transport.opendata.ch — Live Transit Connections

Full Swiss public transport API wrapping SBB/search.ch. Could replace static SBB timetable links with live departure data.

**Base URL:** `https://transport.opendata.ch/v1`

#### `/connections` — Route between two stations

```
GET /v1/connections?from=Zürich+HB&to=Glarus&limit=4
```

| Param | Required | Description |
|-------|----------|-------------|
| `from` | Yes | Departure station name or ID |
| `to` | Yes | Arrival station name or ID |
| `via[]` | No | Up to 5 intermediate stops |
| `date` | No | `YYYY-MM-DD` |
| `time` | No | `HH:MM` |
| `isArrivalTime` | No | `1` = time is arrival time |
| `transportations[]` | No | Filter: `train`, `bus`, `tram`, `ship`, `cableway` |
| `limit` | No | 1–16 connections |
| `page` | No | 0–3 for pagination |

Response includes `from/to` stops with `departure`, `arrival`, `delay`, `platform`, `prognosis` objects, plus `sections` breaking down each leg (train, walk, etc.) with `journey.category` and `journey.number` (e.g. "IR", "35").

#### `/stationboard` — Departures from a station

```
GET /v1/stationboard?station=Aarau&limit=10
```

Returns upcoming departures with journey name, category, destination, operator, and capacity.

#### `/locations` — Station search

```
GET /v1/locations?query=Glarus
GET /v1/locations?x=47.05&y=8.95&type=station
```

Returns matching stations with ID, name, coordinates (WGS84), and relevance score.

- **Auth:** None
- **CORS:** Yes
- **Rate limit:** Constrained by timetable.search.ch (undocumented, generous in practice)
- **`fields[]` param:** Cherry-pick response fields to reduce payload
- **Live use:** shipped as the transit widget on every hike page (`templates/_assets/transit_widget.js`).

### geo.admin.ch WMS — Additional Map Layers

The same geo.admin.ch infrastructure serves dozens of thematic WMS layers that can overlay the existing Leaflet maps.

**WMS endpoint:**
```
https://wms.geo.admin.ch/
```

Use with `L.tileLayer.wms()` in Leaflet.

| Layer ID | Description | Use case |
|----------|-------------|----------|
| `ch.bafu.bundesinventare-flachmoore` | Nature reserves (raised bogs) | Show protected areas near routes |
| `ch.swisstopo.swisstlm3d-uebrigerverkehr` | Cable cars, funiculars, lifts | Show lift access to trailheads |
| `ch.bafu.gewaesserschutzbereiche` | Water protection zones | Identify water sources |
| `ch.bab.schutzgebiete-lawinengefahrenzonen` | Avalanche hazard zones | Winter/shoulder-season safety |

Full layer catalogue: [api3.geo.admin.ch/api/faq](https://api3.geo.admin.ch/api/faq/index.html)

- **Auth:** None
- **CORS:** Yes (loads via `<img>` tile requests)
- **Prototype:** [`prototypes/geo-layers.html`](prototypes/geo-layers.html)
- **Integration idea:** Add toggle overlays to hike page maps — especially hiking trails, avalanche zones, and cable cars.

### Overpass API — OSM Points of Interest

Query OpenStreetMap for hiker-relevant POIs near a coordinate or along a route.

**Endpoint:**
```
POST https://overpass-api.de/api/interpreter
Content-Type: application/x-www-form-urlencoded

data=[out:json][timeout:25];(node["amenity"="drinking_water"](around:2000,{lat},{lon});...);out body;
```

| POI query | What it finds |
|-----------|---------------|
| `amenity=drinking_water` | Fountains, taps |
| `tourism=alpine_hut` or `amenity=shelter` | Huts, bivouacs, shelters |
| `tourism=viewpoint` | Marked viewpoints |
| `amenity=parking` | Trailhead parking |
| `amenity=restaurant` or `amenity=cafe` | Refreshment stops |
| `highway=bus_stop` | Bus stops near route |

- **Auth:** None
- **CORS:** Yes
- **Rate limit:** ~10,000 requests/day, max 2 concurrent
- **Prototype:** [`prototypes/overpass-pois.html`](prototypes/overpass-pois.html)
- **Integration idea:** Auto-populate "Nearby" section on hike pages with POIs within 500m of the GPX track. Use XHR (not fetch) for `file://` compatibility.

### SLF — Avalanche Bulletins

WSL Institute for Snow and Avalanche Research publishes avalanche danger data.

**No public JSON API from the browser.** The practical approach is:

1. **geo.admin.ch WMS** layer `ch.bab.schutzgebiete-lawinengefahrenzonen` for hazard zone overlays on maps (works now, see geo layers above)
2. **Link to SLF bulletin:** `https://www.slf.ch/en/avalanche-bulletin-and-snow-situation.html`
3. **Link to WhiteRisk:** `https://whiterisk.ch/en/conditions` (interactive conditions map)

**European Avalanche Danger Scale** (for reference display):

| Level | Name | Color | Hiker guidance |
|-------|------|-------|----------------|
| 1 | Low | `#ccff66` | Generally safe, isolated hazards possible |
| 2 | Moderate | `#ffff00` | Favorable conditions, caution on steep slopes |
| 3 | Considerable | `#ff9900` | Critical — evaluate slopes >30° carefully |
| 4 | High | `#ff0000` | Avoid avalanche terrain entirely |
| 5 | Very High | `#ff0000` | Extraordinary conditions, stay off mountains |

Relevant season: November–May. Above 2000m, check SLF bulletin before any alpine hike.

- **Integration idea:** Seasonal safety banner on hike pages for routes above 2000m. Link to SLF bulletin + WhiteRisk.

### Roundshot / Windy — Mountain Webcams

Live camera feeds showing current mountain conditions.

**Roundshot** (Swiss panorama cameras):
```
https://backend.roundshot.com/cams/{id}/thumbnail
```

Camera pages: `https://www.roundshot.com/en/livecam/{name}`

**Windy webcams:**
```
https://www.windy.com/webcams/
```

- **Auth:** None (thumbnails may be blocked by CORS/hotlink protection)
- **Browser pattern:** Use `<img>` with `onerror` fallback → link to live page
- **Integration idea:** Show nearest webcam link on hike pages to check conditions before departure. Practical approach is links, not embedded images, due to CORS.

---

## Summary

| API | Status | Auth | CORS | Primary use |
|-----|--------|------|------|-------------|
| SwissTopo WMTS | **In use** | None | Yes | Base maps + trail overlay |
| Open-Meteo | **In use** | None | Yes | Weather forecasts |
| SBB timetable | **In use** | None | — | Static transit links |
| geo.admin.ch REST | **In use** | None | Yes | Canton/region/elevation |
| SAC suissealpine | **In use** | Partial | Yes | Route data + POI map |
| transport.opendata.ch | Available | None | Yes | Live transit connections |
| geo.admin.ch WMS | Available | None | Yes | Thematic map overlays |
| Overpass (OSM) | Available | None | Yes | Nearby POIs |
| SLF / WhiteRisk | Available | — | — | Avalanche safety (links) |
| Roundshot / Windy | Available | — | Partial | Mountain webcams (links) |
