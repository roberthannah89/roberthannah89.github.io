# Hikes page harmonization — design

**Status:** Phases 1, 2, 3, 5 shipped on 2026-06-28. Phase 4 (side panel) deferred — pulling in CC's side panel requires extracting ~120 lines of theme-coupled CSS (`.panel-*`, `.grade-badge`, `.popup-*`, `.day-card`, …) into a shared file scoped to its own CSS variables. Worth doing, just bigger than the original estimate; tracked as a follow-up.

## Goal

Bring the older Hikes index page (`index.html`, generated from `templates/index.j2.html` + `routes/_assets/index_page.js`) up to feature parity with the newer Command Center on the things that matter for hike planning, without giving up the page's editorial card-grid identity.

The Hikes page stays the curated front door — photo cards, region/canton filters, links to local trip-report pages. The Command Center stays the universe-of-routes power tool. After this work, the two pages share the same weather data source, the same map markers, the same side panel, and the same overlay layers — so future improvements land in both places automatically.

## Non-goals

- Replacing the photo-card grid with a full-screen map (that's Approach C from brainstorming, explicitly rejected).
- Merging the two pages or retiring `index.html`.
- Refactoring CC modules to be fully POI-shape-agnostic (that's Approach B; we accept a thin adapter instead).
- Changing the SAC pipeline or `make render` outputs other than `index.html` itself.

## What we're cherry-picking, in order

Each phase ships a working improvement. Stop after any phase and the page still works.

| # | Feature | What it gives the user | What it costs |
|---|---|---|---|
| 1 | Pre-baked `WEATHER_CACHE` | Instant forecast on load, no Open-Meteo round-trip, no failure case, exact same model as CC | Replace `routes/_assets/index_page.js` weather fetcher; require `make weather` before render |
| 2 | URL state sync | Bookmarkable / shareable filter views; Reset + Share buttons | New `routes/_assets/index_url_sync.js`; small filter-state refactor |
| 3 | CC-style marker pills | `⛅ 9°` weather pill bordered by grade colour; ❄ snow-line pip | Replace marker-icon builder in `index_page.js`; copy a small CSS block |
| 4 | Side panel | Slide-in panel with 5-day forecast cards, freezing-level line, links to the local hike page (the unique twist), Windy, Google Maps | Include `command-center/side-panel.js`; build a thin POI adapter per hike |
| 5 | Webcam + SLF avalanche overlays | Bottom-bar toggles for both, same data files as CC | Include `command-center/{webcams,slf-layer}.js` + the cache files |

Phases 1 and 3 are tightly coupled (the pill needs cache data); ship together. Phase 2 is independent. Phases 4 and 5 each stand alone.

## Architecture

### Module reuse strategy

Both pages live under `pages/hikes/`. The Hikes page can include CC modules directly with `<script src="command-center/<file>.js">` — they're already plain IIFEs attaching to `window.*`, no bundler.

What we **reuse verbatim** (no edits in `command-center/`):
- `command-center/weather-cache.js` (data)
- `command-center/weather.js` (the `WeatherService` accessor is already POI-shape-agnostic — it takes `(lat, lon, dayIndex)`)
- `command-center/side-panel.js` (the hike-page link logic in `matchingHike()` is exactly what we want here; it returns the matching `HIKES` entry by `sac_route_id` → `sac_peak_id` → coords → name)
- `command-center/webcams.js` + `command-center/webcams_windy_data.js`
- `command-center/slf-layer.js` + `command-center/slf-cache.js`

What we **write new** (lives next to `index_page.js`):
- `routes/_assets/index_url_sync.js` — same shape as `command-center/url-sync.js` but with the Hikes page's filter keys. Keeping them separate (rather than reusing CC's) because the filter sets genuinely differ — Hikes has `region` / `canton` / `route_type` that CC doesn't, and CC has `showHikes` / `showHuts` / `hasPage` that the Hikes page doesn't.

What we **edit**:
- `templates/index.j2.html` — add `<script>` includes for the CC modules and the new url-sync; tweak the toggles row in the toolbar.
- `routes/_assets/index_page.js` — swap live Open-Meteo for `WeatherService`; swap marker icon builder for the CC pill style; wire side panel open on marker click.

### Data shape: HIKES vs SAC_ROUTES

`window.HIKES` (Hikes page) is a flat list of curated hikes with shape:

```js
{ name, lat, lon, grade, gradeClass, summitElev, distance, gain, time,
  region, canton, route_type, href, photo, trailhead, end_point,
  sac_peak_id, sac_route_id }
```

`SidePanel.render(poi)` (CC) expects POI shape:

```js
{ name, lat, lon, alt, id /* peak id */, routes: [{ id, grade, ... }] }
```

We bridge by building a POI view at marker-creation time inside `index_page.js`:

```js
function hikeToPoi(h) {
  return {
    name: h.name,
    lat: h.lat,
    lon: h.lon,
    alt: h.summitElev,
    id: h.sac_peak_id || null,
    routes: h.sac_route_id ? [{ id: h.sac_route_id, grade: h.grade }] : [],
  };
}
```

This is the **only** adapter we write. `SidePanel.matchingHike(poi)` then runs against `window.HIKES` and resolves back to the same `h` object — so the panel hero links to `../<h.href>` correctly.

### Weather data: do we have coverage?

`fetch_weather.py` is keyed off `guides/sac-routes.js`, which is the scraped SAC POI list. Every built hike in this repo has a `sac_peak_id`, and every peak with an id ends up in `sac-routes.js`, so `WEATHER_CACHE` already has forecasts for all our hikes' peak coordinates. The cache key is `lat.toFixed(3) + ',' + lon.toFixed(3)` (3-decimal rounding ≈ 110 m), which is wider than the typical drift between the HIKES `lat/lon` and the SAC peak coord — so the existing lookup just works.

If a peak coord doesn't round to a matching cache key (e.g. hikes whose summit was hand-entered before SAC ingestion), `WeatherService.getForPeak` returns null and the marker falls back to the grade-coloured dot. We log a console warning during boot listing any hike without a forecast, so it's caught at render time rather than silently degrading the UI.

### What gets removed

In `routes/_assets/index_page.js`:
- The live Open-Meteo fetch block (the `/v1/forecast?…&daily=weather_code,temperature_2m_max` URL build, the batch loop, the per-hike weather-strip update DOM code).
- The `weatherByHike[]` array — replaced by direct calls to `WeatherService.getForPeak(h.lat, h.lon, dayIndex)`.
- The "loading forecast…" placeholder strip on each card.

The card grid itself stays — the weather strip on each card is replaced by a compact `WeatherService`-driven version that re-renders when the Day picker changes (so cards and map markers always agree).

## Phase 1 — Pre-baked WEATHER_CACHE

**Template changes** (`templates/index.j2.html`):

Add before `index_page.js`:

```html
<script src="command-center/weather-cache.js"></script>
<script src="command-center/weather.js"></script>
```

`weather-cache.js` is regenerated by `make weather`. We add `command-center/weather-cache.js` as a prerequisite of `make render` in the `Makefile` so missing data is caught at build time; a stale-but-present file is checked at boot in `index_page.js` (cache `updated` more than 7 days old → warning banner above the map, but page still renders).

**`index_page.js` changes:**

Replace the live-fetch block (around the existing `https://api.open-meteo.com/v1/forecast` call) with a `WeatherService.init([])` call (no peak list needed — the cache is whole-Switzerland), then on every card render and marker render, call `WeatherService.getForPeak(h.lat, h.lon, currentDayIndex)`.

The existing `mapDayBtns` day-picker bar already drives a `currentDayIndex`. We swap its data source from `weatherByHike` to `WeatherService.getDayChoices()` (which reads from the cache and returns up to 5 days). The picker UI does not change shape.

**Acceptance:**
- Page loads with weather visible on every marker and card with no network call (run with devtools offline).
- Day picker shows the same 5 days as CC (`Today`, `Mon 30`, …).
- A hike whose peak coord doesn't match any cache key still renders, with a grade dot instead of a pill, and logs a single console warning naming the hike.

## Phase 2 — URL state sync

**New file:** `routes/_assets/index_url_sync.js` — mirrors `command-center/url-sync.js` shape, with hikes-page filter keys.

URL keys (short, like CC's):

| State | Key |
|---|---|
| grade | `g` |
| region | `r` |
| canton | `c` |
| weather | `wx` |
| dist | `di` |
| gain | `gn` |
| temp | `t` |
| elev | `el` |
| time | `tm` |
| route_type | `rt` |
| weatherDay | `d` |

`UrlSync.readFromUrl()` runs before the filter UI is built; `UrlSync.writeToUrl(state)` is called on every filter change. Same hash-only pattern as CC — no history pollution.

**Reset / Share buttons** in the existing `filters` toolbar:
- **Reset** appears when `location.hash` is non-empty; clears the hash and reloads.
- **Share** copies `location.href` to the clipboard and flashes "Copied".

**Acceptance:**
- Click filters → URL hash updates live.
- Reload preserves the visible filter state.
- Copy URL, open in a new tab → same filter state.

## Phase 3 — CC-style marker pills

**`index_page.js`** — replace the current `L.divIcon({...})` builder for hike markers with the CC pill version. The CSS classes (`.hike-marker`, `.hike-marker--has-page`, `.hike-marker--above-freezing`, the grade-tint variables, the `wx-pill` shape, the cluster pill, sky tints) are copied verbatim from `command-center/command-center.css` into the page's inline `<style>` block — or, cleaner, extracted into a new `command-center/marker-pill.css` that both pages include. Lean toward extraction so the two pages can't drift on this again.

**`hike-marker--has-page`** logic is the inverse on the Hikes page: every hike in the grid already has a built page, so the star is on every marker. Skip the star entirely on this page — it'd be on 100% of markers, which carries no information. Keep the grade border and the ❄ snow-line pip; both are useful here.

**Clusters:** same horizontal pill `count · dominant-sky-emoji · avg-temp` as CC, using the same `SKY_TINTS` table. The Hikes page is already using markercluster, so the icon builder is the only change.

**Acceptance:**
- Markers render as `⛅ 9°` pills with grade-coloured borders.
- ❄ pip shows on markers whose summit is above the day's freezing level.
- Clusters show the CC-style summary pill.

## Phase 4 — Side panel

**Include in template:**

```html
<script src="command-center/side-panel.js"></script>
```

**Wire in `index_page.js`:**

- On marker click → `SidePanel.open(hikeToPoi(h))` instead of opening a Leaflet popup. The popup goes away; the panel takes its job.
- On filter change → `SidePanel.refresh()` (CC already does this via `Filters.subscribe()`; we add an equivalent subscribe hook in the Hikes page's filter code).

**Hero strip:** `SidePanel.render` already calls `matchingHike(poi)` and, on a hit, renders a clickable hero linking to `../<h.href>`. For Hikes-page POIs every hit returns a valid `href`, so every panel gets a hero linking to the local trip report. This is the unique value-add over CC's panel — same panel code, different surfacing.

**Card grid:** keep it. The grid is the page's identity; the side panel is the map's detail view. A user clicking a card still navigates to the local page (existing behaviour). A user clicking a marker now gets the panel — and from the panel's hero, also navigates to the local page if they want. Two paths to the same destination, one optimised for "I want to see the photos" and one optimised for "I want the forecast and the map context first."

**Acceptance:**
- Click marker → panel slides in from the right.
- Panel hero links to the local hike page.
- 5-day cards update live when the Day filter changes.
- Closing the panel returns the map to normal.

## Phase 5 — Webcams + SLF avalanche

**Include in template:**

```html
<script src="command-center/webcams.js"></script>
<script src="command-center/slf-layer.js"></script>
```

`webcams_windy_data.js` and `slf-cache.js` are loaded lazily by those modules on first toggle, identical to CC behaviour.

**Toolbar** (`templates/index.j2.html`): add two icon toggles to the existing filters bar (or a new "Map layers" row beneath it — decide during implementation, depends on space):

- `📷` Webcams (default off)
- `❄️` Avalanche (default off)

**Acceptance:**
- Toggle webcams on → Windy markers appear; clicking one shows the thumbnail popup.
- Toggle SLF on → avalanche regions render (or empty in summer, matching CC).
- Toggle states persist across reload. If phase 2 ships first, they ride on the same hash mechanism (`wc` / `av` keys). If phase 5 ships before phase 2, they persist via `localStorage` — switch to hash when phase 2 lands.

## File-by-file summary

| File | Phase | Change |
|---|---|---|
| `templates/index.j2.html` | 1, 2, 4, 5 | Add `<script>` includes; add Reset/Share/Webcam/SLF UI |
| `routes/_assets/index_page.js` | 1, 3, 4 | Replace live weather fetch; replace marker icon builder; wire side panel; remove `weatherByHike` |
| `routes/_assets/index_url_sync.js` | 2 | New file — hikes-page filter ↔ hash |
| `command-center/marker-pill.css` | 3 | New file — extracted CC marker CSS, included by both pages |
| `command-center/command-center.css` | 3 | Remove marker-pill block (moved to `marker-pill.css`); CC includes both |
| `command-center/{weather-cache,weather,side-panel,webcams,slf-layer}.js` | 1, 4, 5 | No edits — included verbatim |

Total surface: ~1 new JS file, ~1 new CSS file, ~2 edited files in `routes/_assets/`, ~1 edited template, ~1 edited CC CSS (extract-and-include refactor).

## Risks and open questions

1. **Cache coverage gap.** A hike whose peak coord doesn't round to a cache key gets no weather. We mitigate with a boot-time console warning; in practice this should be zero hikes today (every built hike came through SAC), but it's a real risk if a future hike is added with hand-entered coords. Fallback to grade dot is graceful.

2. **CSS extraction is mildly invasive.** Pulling the marker-pill block out of `command-center.css` into a new `marker-pill.css` means CC has to include the new file too. This is a small CC change that affects a live page; we'll verify no visual regression on the CC page after the extraction.

3. **`make weather` dependency.** The Hikes page reads from the pre-baked cache instead of fetching live forecasts. We document this in `docs/README.md`. If the cache file is **missing**, the boot path falls back to grade-coloured dots on every marker and shows "Forecast unavailable — run `make weather`" in the day picker (no crash, but no forecasts either). If the cache is **stale** (`updated` > 7 days), the page renders normally and shows an amber banner above the map noting the forecast age.

4. **Card weather strip refresh on Day change.** Currently the cards' weather strips are rendered once at boot. After phase 1, they need to re-render when the Day picker changes. This is a small but non-zero behaviour change; we'll handle it in phase 1, not deferred.

5. **Side panel vs. existing card navigation.** Users have a learned behaviour: click anything → go to the hike page. The new marker → panel flow breaks that on the map. We mitigate by making the panel hero the most prominent call-to-action (CC already does this), but expect this to be the one piece of feedback that lands during user testing.

## What's next

Once approved, hand off to the writing-plans skill to break the phases into ordered, individually-testable implementation tasks with file-level diff sketches.
