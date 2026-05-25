# SAC Suissealpine API Reference

Reference for the public SAC route portal API at `suissealpine.sac-cas.ch`. No authentication required.

---

## Endpoints

### Search — paginated POI list with route details

```
GET https://www.suissealpine.sac-cas.ch/api/1/poi/search
```

| Param | Example | Notes |
|-------|---------|-------|
| `lang` | `en` | UI language |
| `output_lang` | `en` | Response language |
| `disciplines` | `mountain_hiking` | Controls which discipline's routes are included. Does NOT filter which POIs are returned — use `type` for that. |
| `type` | `summit` | POI type filter (see types below). **Caution:** pagination breaks when this is set — the API still iterates all POIs internally, making it very slow. |
| `hut_type` | `all` | Required when huts are included |
| `mode` | `per_discipline` | Only return routes matching the `disciplines` param |
| `limit` | `100` | Page size |
| `cursor` | `100` | Cursor-based pagination — use the `cursor` value from the previous response. **Offset-based pagination (`offset=`) does NOT work** — the API ignores it and returns the same page repeatedly. |

**Response:**
```json
{
  "results": [ ... ],
  "cursor": 200
}
```

When `cursor` is absent or `results` is empty, you've reached the end.

### Search Count

```
GET https://www.suissealpine.sac-cas.ch/api/1/poi/search_count
```

Same params as search. Returns `{"count": 962}`.

### Map Layer — bulk GeoJSON (coordinates only)

```
GET https://www.suissealpine.sac-cas.ch/api/1/poi/layer
```

Returns ALL 11,235 POIs as GeoJSON regardless of filters. Coordinates are LV95 (EPSG:2056). Properties include `id`, `type`, and `routes_by_discipline` (counts only, not details). Client-side JS on the SAC site uses IDs from the search endpoint to filter which points to display.

### POI Detail

```
GET https://www.suissealpine.sac-cas.ch/api/1/poi/{id}
```

Returns **405 Method Not Allowed**. Individual POI lookup is not supported via this endpoint.

### Route Detail

Only available by intercepting XHR on individual SAC route pages (requires Playwright + authentication). The response includes segments with LineString geometry, photos, waypoints, and full descriptions. See `docs/workflows/SAC-EXTRACTION.md`.

---

## POI Types

From the layer endpoint (11,235 total):

| Type | Count | Description |
|------|-------|-------------|
| `summit` | 5,817 | Mountain peaks |
| `traverse` | 2,299 | Ridge traverses, multi-peak routes |
| `departure_arrival` | 1,885 | Trailheads, start/end points |
| `hut` | 637 | Mountain huts (SAC and others) |
| `climbing_area` | 348 | Climbing crags/areas |
| `marking_point` | 249 | Passes, waypoints, junctions |

---

## Disciplines

Each POI can have routes in multiple disciplines. Count of POIs per discipline:

| Discipline | POIs | Description |
|------------|------|-------------|
| `archive` | 7,870 | Archived/historical routes |
| `ski_tour` | 3,206 | Ski touring |
| `mountain_hiking` | 2,596 | Graded hiking (T1–T6) |
| `alpine_tour` | 1,111 | Alpine mountaineering |
| `snowshoe_tour` | 811 | Snowshoe routes |
| `alpine_climbing` | 251 | Alpine rock/ice climbing |
| `climbing` | 187 | Sport/trad climbing |
| `via_ferrata` | 70 | Via ferrata routes |

### Mountain Hiking POIs by Type (2,596 total)

| Type | Count |
|------|-------|
| `summit` | 1,271 |
| `traverse` | 545 |
| `hut` | 378 |
| `departure_arrival` | 329 |
| `marking_point` | 72 |
| `climbing_area` | 1 |

The search endpoint with `disciplines=mountain_hiking&mode=per_discipline` returns 962 POIs — the subset that have at least one published (non-archived) mountain hiking route.

---

## Route Fields (from search endpoint)

Each POI's `routes` array contains objects with:

| Field | Example | Notes |
|-------|---------|-------|
| `id` | `1213` | Route ID |
| `title` | `"From the Grimselhospiz"` | |
| `main_difficulty` | `"T5"` | SAC hiking grade |
| `ascent_altitude` | `1000` | Elevation gain in metres |
| `descent_altitude` | `230` | Elevation loss in metres |
| `ascent_time_max` | `480` | Max ascent time in minutes |
| `ascent_time_min` | `420` | Min ascent time in minutes |
| `descent_time_max` | `null` | Max descent time (often null) |
| `descent_time_min` | `null` | Min descent time (often null) |
| `normal_route` | `true` | Whether this is the standard route |
| `availability` | `"free"` | `"free"` or `"premium"` |

**Not available from the search API:** distance/length, geometry, descriptions, photos. These require scraping individual route detail pages.

---

## POI Fields (from search endpoint)

| Field | Example |
|-------|---------|
| `id` | `2100` |
| `display_name` | `"Aiguille des Angroniettes"` |
| `altitude` | `2854.0` |
| `type` | `"summit"` |
| `geom.coordinates` | `[2668227.47, 1141772.93]` (LV95) |
| `regions_denormalization` | `"Valais, Central Switzerland"` |

---

## Coordinate System

The API uses **LV95 (EPSG:2056)** Swiss coordinates. Convert to WGS84 using the swisstopo approximate formulas (implemented in `scripts/scrape_sac_pois.py`).

---

## Pagination Gotchas

1. **Use cursor, not offset.** The `offset` parameter is accepted but ignored — every page returns the same results.
2. **Avoid `type` filter for bulk scraping.** It doesn't reduce what the API paginates through internally, so requests are extremely slow (~34k items traversed regardless).
3. **`disciplines` filters routes, not POIs.** With `mode=per_discipline`, POIs without routes in the requested discipline are still returned (with empty `routes` arrays) unless you omit the `type` param entirely.

---

## Current Usage

`scripts/scrape_sac_pois.py` scrapes all 962 mountain hiking POIs (~10 pages, ~10 seconds) and writes `guides/sac-routes.js` for the interactive map at `guides/sac-map.html`.
