# Hike Map Engine — Design Spec

**Status:** Live. This is the sole source of truth for engine behavior — markers, clusters, side panel, filter store/matcher, URL sync, weather lookup, webcam layer, and avalanche layer. Every hike-map-touching change lands here first; the change then propagates to both `command-center/` and `templates/index.j2.html` automatically, because both pages compose the same modules rather than reimplementing them. Page-specific `DESIGN.md` files (`command-center/DESIGN.md`, `templates/index.DESIGN.md`) cover only what's left over: page chrome, layout, and which subset of the engine each page turns on.

Background: [`docs/superpowers/specs/2026-07-05-cc-index-engine-unification-design.md`](../../../docs/superpowers/specs/2026-07-05-cc-index-engine-unification-design.md) is the design doc that drove this module into existence (Phases A–H). This file is the living spec that supersedes it for day-to-day engine questions; the spec remains useful for the historical migration narrative and rationale.

## Module list + APIs

Every module attaches to `window.HikeMap.*`. Pages load them via plain `<script src>` tags (no bundler, no ES modules — pages open via `file://`).

```js
// grade_colors.js — SAC grade → color, shared by markers, clusters, filter chips.
window.HikeMap.GRADE_COLORS = { 1:'#5cbf6a', 2:'#5cbf6a', 3:'#e8a832', 4:'#d97333', 5:'#cc3333', 6:'#8844cc' };
window.HikeMap.gradeColor = (grade) => /* 'T3' -> '#e8a832' */;

// wx_lookup.js — wraps WeatherService with optional fuzzy fallback. Both pages
// construct one at init and pass it into MarkerFactory, ClusterGroupFactory,
// and FilterMatcher so weather reads are consistent everywhere on the page.
window.HikeMap.WxLookup = ({ fuzzy = false } = {}) => ({
  get(latOrPoi, lonMaybe, dayIndex),   // exact; if fuzzy, fall back to nearest ≤ ~1 km
  freezingLevel(lat, lon, dayIndex),
});

// marker_factory.js — builds the L.divIcon for a single POI. CC shows the
// has-page star (some SAC POIs lack a built hike page); index never needs it
// (every hike on the index has a page by definition).
window.HikeMap.MarkerFactory = ({
  wxLookup,
  showHasPage = false,   // CC true (some POIs lack pages), index false (all have pages)
  showFreezing = true,   // ❄ pip when peak > forecast snow line
  gradeColors = window.HikeMap.GRADE_COLORS,
}) => ({
  makeIcon(poi, dayIndex),   // L.divIcon — pill if wx, dot otherwise; adds ★/❄ per config
});

// cluster_group.js — cluster pill: count + dominant-sky emoji + avg temp,
// tinted by the dominant sky category among the cluster's children.
window.HikeMap.SKY_TINTS = { clear: {...}, 'partly-cloudy': {...}, cloudy: {...}, rain: {...}, snow: {...}, storm: {...} };
window.HikeMap.ClusterGroupFactory = ({ wxLookup, skyTints = window.HikeMap.SKY_TINTS, dayIndexGetter }) =>
  L.markerClusterGroup({ /* count + dominant emoji + avg temp pill */ });

// day_picker.js — forecast-day selector, mounts into whatever container each
// page hands it (CC's filter-bar day slot, index's external day buttons).
window.HikeMap.DayPicker = {
  mount({ container, initial = 0, onChange })
  // returns { setActive(i), destroy() }; picks reads from WeatherService.getDayChoices()
};

// filter_store.js — the single mutable filter-state object each page builds
// once at init. See "Filter store: subscribe/notify semantics" below.
window.HikeMap.FilterStore = ({ keys, initial = {} }) => ({
  get(k), set(k, v), setAll(partial), state(),
  subscribe(fn),   // fn(state, changedKeys)
  unsubscribe(fn),
  // Accepts unknown keys into state so cross-page URL hashes still apply via the matcher.
});

// filter_matcher.js — the one function that decides whether a POI is visible
// given the current store state. Same matcher instance backs both the map
// markers and (on the index page) the card grid.
window.HikeMap.FilterMatcher = {
  factory({ wxLookup }) => ({
    match(matchablePoi, state),   // boolean; handles all known filter keys
  }),
};

// filter_bar.js — CC-only UI (index renders its filter subset as external
// buttons instead of mounting this).
window.HikeMap.FilterBar = {
  mount({ container, store, filters, daySlotId = 'hm-day-slot' })
  // filters: e.g. ['g','tm','el','gn','d','sk','t','sn','h','u','dp']
  // Renders only the listed groups. Provides <div id={daySlotId}> for DayPicker to mount into.
};

// url_sync.js — mirrors store state to window.location.hash with short
// canonical keys (see table below) so views are bookmarkable/shareable
// across both pages.
window.HikeMap.UrlSync = {
  KEYS,                         // canonical short-key map (see § Canonical URL keys below)
  readFromUrl(),                // -> state object
  bind({ store }),              // two-way sync store <-> location.hash; does NOT fire on initial read
  reset(),                      // clear hash + reload
  copyLink(el, label='Copied'), // copy location.href, flash label
  mountCrossPageBanner({ store, uiKeys, container }), // see "Cross-page URL semantics" below
};

// side_panel.js — the expandable detail panel. Both pages mount one; only
// the container id and the two adapter functions differ.
window.HikeMap.SidePanel = {
  mount({ container, wxLookup, dataAdapter, matchingHike, store })
  // dataAdapter: page-native -> matchablePoi/POI. matchingHike: (poi) -> optional local hike-page href.
  // Subscribes to store: day/filter changes re-render panel cards live.
  // returns { open(pageNative), close(), refresh() }
};

// webcams.js, slf_layer.js — always-on / opt-in map layers. See "Always-on
// layers" below for why avalanche has no create-time gate.
window.HikeMap.WebcamLayer   = { create({ map }) };
window.HikeMap.AvalancheLayer = { create({ map }) };
```

## Weather data

`weather.js` (WeatherService) and `weather-cache.js` (the pre-baked `WEATHER_CACHE` / `WEATHER_CACHE_META` data, generated by `scripts/fetch_weather.py` via `make weather`) both live in `hike_map/` — moved here from `command-center/` in Phase A since both pages consume the same cache. Source: MeteoSwiss ICON-CH2 via Open-Meteo (see [`docs/APIS.md`](../../../docs/APIS.md) for the raw API schema and rate limits). `WxLookup` above is the only interface pages/engine code should use to read it — don't reach into `WEATHER_CACHE` directly from page code.

## The `matchablePoi` contract

The shared matcher (`filter_matcher.js`) and the shared marker/cluster factories all operate on one normalized POI shape. Each page produces it once at init from its own native data — the adapter is page code (~15 lines), not engine code.

```js
{
  name, lat, lon,
  grade: 'T3',           // best/highest grade if multiple routes
  region, canton, routeType,
  alt,                   // summit / peak altitude, metres
  gain,                  // vertical ascent, metres
  timeH,                 // hours, numeric
  hasPage: true|false,   // built page in this repo?
  poiKind: 'hike'|'hut', // for showHikes/showHuts filter (CC)
  raw: <original>,       // page-native ref, used by adapters/popups
}
```

Adapters:

- **Index:** `hikeToMatchable` — HIKES entries already align field-for-field; `hasPage: true` and `poiKind: 'hike'` are constants.
- **CC:** `sacPoiToMatchable` — flattens a SAC POI's `routes[]` to its best grade; `hasPage` comes from `SidePanel.matchingHike` so the on-map ★ badge can never drift from what the side panel actually links to.

## Filter store: subscribe/notify semantics

`FilterStore({ keys, initial })` holds one page's filter state as a plain object. `store.set(k, v)` (or `setAll(partial)`) updates state and calls every subscriber as `fn(state, changedKeys)`, where `changedKeys` is the array of keys that actually changed in that call.

**Only listed keys fire subscribers.** A `set()` call that doesn't change any value (same value written back) does not notify. This is what makes the `dp`-only guard below safe: a subscriber can inspect `changedKeys` and skip expensive work when it knows a particular key can't affect its output.

**Hot-path optimization pattern — the `dp`-only skip.** `dp` (Display) controls which fields render in the marker tooltip (name/temp/gain/time/alt) and whether the weather pill or a grade dot is drawn — it never changes *which* POIs are visible. `filter_matcher.js` never reads `dp` at all. So CC's main store subscriber (`command-center.js`) special-cases it:

```js
store.subscribe(function (state, changedKeys) {
  if (changedKeys && changedKeys.length === 1 && changedKeys[0] === 'dp') {
    document.body.classList.toggle('display-name-off', (state.dp || []).indexOf('name') === -1);
    refreshMarkerIcons();
    refreshMarkerTooltips();
    return;
  }
  applyFilters();   // full ~960-marker visibility pass
});
```

Without this guard, every Display-pill click would re-run the full filter-and-redraw pass over every marker — pure waste, since `dp` can't change any marker's visibility. Any future page composing the engine with a `dp`-like display-only key should apply the same pattern: check `changedKeys` before deciding how much work a subscriber needs to do. This is a general engine idiom, not a CC-only quirk — document it here so it isn't rediscovered per page.

## Canonical URL keys

One table, defined in `hike_map/url_sync.js`. Both pages use the same short keys — a hash minted on one page applies on the other via the shared matcher, even for keys the receiving page has no UI for (see "Cross-page URL semantics" below).

| Key | Short | Type | CC UI | Index UI | Matcher applies |
|---|---|---|---|---|---|
| grade | `g` | multi-select `T1,T3,T5` | ✅ | ✅ | ✅ |
| region | `r` | multi-select | — | ✅ external | ✅ |
| canton | `c` | multi-select | — | ✅ external | ✅ |
| route_type | `rt` | multi-select | — | ✅ external | ✅ |
| distance | `di` | bucket | — | ✅ | ✅ |
| time | `tm` | bucket ≤3h / 3-5h / 5h+ | ✅ (was `dur`) | ✅ | ✅ |
| elev (peak alt) | `el` | bucket | ✅ | ✅ | ✅ |
| gain | `gn` | bucket | ✅ | ✅ | ✅ |
| day (forecast idx) | `d` | int 0–4 | ✅ | ✅ | drives wx display |
| sky (threshold) | `sk` | "or better" ordinal | ✅ | — | ✅ |
| tempMin | `t` | number | ✅ | — | ✅ |
| season | `sn` | bool | ✅ | — | ✅ |
| showHikes | `h` | bool | ✅ | — | ✅ |
| showHuts | `u` | bool | ✅ | — | ✅ (no huts on index anyway) |
| webcams | `wc` | bool | ✅ toggle | ✅ toggle | not a filter |

**No `av` key.** The avalanche layer has no toggle — it is always created at boot on both pages (see "Always-on layers" below), so there is nothing to encode in the URL for it.

**Breaking rename (historical):** CC's `dur` → `tm` happened in Phase F. Old CC hash bookmarks from before that phase no longer resolve. Acceptable on a personal site.

## Cross-page URL semantics + banner

`FilterStore` accepts unknown keys into `state()`. So a CC URL `#g=T3&sk=rain&t=10` pasted onto index:

- Index UI has no sky/temp controls.
- The matcher still applies `sk=rain` and `t=10`, so cards + markers filter accordingly.
- A **"Cross-page filters"** banner appears above the map noting that some active filters have no UI on this page, with a **Clear** button that removes only the invisible keys.

Both pages wire this the same way: `UrlSync.mountCrossPageBanner({ store, uiKeys: <page's own key list>, container })`. `uiKeys` is simply the list of keys the page's own filter UI exposes (CC: `store.keys` after FilterBar mounts its filter set; index: the keys behind its external buttons) — anything in `state()` but not in `uiKeys` triggers the banner.

## Init order

Order matters — each step depends on state built in the previous one:

1. Read hash → `initial = UrlSync.readFromUrl()`
2. Build store: `store = FilterStore({ keys, initial })`
3. Construct factories: `wx`, `markerFactory`, `clusterGroup`, `matcher = FilterMatcher.factory({ wxLookup: wx })`
4. Mount UI: `DayPicker.mount(...)`, `FilterBar.mount(...)` (CC), external region/canton buttons wired to store (index)
5. `SidePanel.mount({ store, ... })` — subscribes for live refresh
6. Create markers, add to cluster group, add to map. Define `applyVisibility(state)` closure using `matcher.match`.
7. `store.subscribe((state) => { applyVisibility(state); refreshMarkerIcons(state.d); })`
8. `UrlSync.bind({ store })` — starts writing hash on subsequent `store.set` calls; must NOT fire during step 1's read.

## What's page-owned vs engine-owned

| Concern | Owner |
|---|---|
| Marker icon rendering (pill/dot, ★/❄ badges) | Engine (`marker_factory.js`) |
| Cluster icon rendering + sky tinting | Engine (`cluster_group.js`) |
| Filter state, subscribe/notify | Engine (`filter_store.js`) |
| Filter matching logic (which POIs pass) | Engine (`filter_matcher.js`) |
| Filter bar UI (buttons/pills) | Engine (`filter_bar.js`) — CC-only mount; index opts out |
| URL hash sync + cross-page banner | Engine (`url_sync.js`) |
| Weather lookup (exact + fuzzy) | Engine (`wx_lookup.js`) |
| Day picker widget | Engine (`day_picker.js`) |
| Side panel (forecast cards, links) | Engine (`side_panel.js` + `side_panel.css`) |
| Webcam layer | Engine (`webcams.js`) |
| Avalanche layer | Engine (`slf_layer.js`) |
| `matchablePoi` adapter (native data → shape) | Page (`sacPoiToMatchable` / `hikeToMatchable`) |
| Which filter keys/UI groups are shown | Page (composition config passed to `FilterStore`/`FilterBar`) |
| Page shell, layout, bottom bar / card grid | Page |
| Region/canton/route-type external buttons (index) | Page |
| CSS theme variables (`--panel-bg`, `--grade-t1-color`, …) consumed by engine CSS | Page (sets the variables; engine CSS reads them) |

## First-click popup regression guard

**Do not regress this.** When editing marker, tooltip, or popup code in `marker_factory.js`, `marker_pill.css`, or anywhere a page wires marker click handlers, all three pieces below must stay in place or the popup will need a second click (or Enter key) to open:

1. `interactive: false` on the permanent name tooltip (`marker.bindTooltip(..., { interactive: false })`).
2. `.leaflet-tooltip-pane { pointer-events: none; }` in `marker_pill.css`.
3. Re-opening an already-bound popup uses `marker.getPopup().setContent(...)` (or `setPopupContent`), never a fresh `bindPopup()` call on every click.

This invariant ported over verbatim from Command Center during Phase D and now lives entirely in the engine, so both pages inherit it automatically. Look for the `FIRST-CLICK REGRESSION GUARD` comment near the marker click-binding code before touching it. See also the `pages/hikes/CLAUDE.md` "Command center marker popups" key rule, which predates the engine unification and still applies verbatim.

## Always-on layers

The SLF avalanche layer (`AvalancheLayer.create({ map })`) is auto-created at boot on both pages — there is no toggle, no `av` URL key, and no bottom-bar/filter-bar control for it. Rationale: this is a safety-relevant layer (avalanche danger regions), and safety layers must never be hidden behind a click a user might not think to make. Off-season, the underlying SLF feed returns an empty `FeatureCollection`, so there's no summer clutter cost to being always-on.

Any future "danger segment" or similarly safety-critical layer should follow the same pattern: `create({ map })` called unconditionally at boot, no opt-out. This also keeps URL state simpler — one less key to encode, read, and reason about in the cross-page banner.
