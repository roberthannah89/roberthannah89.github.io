# Hikes Index — Design Spec

**Status:** Live. Page-specific concerns only — the map/filter/panel engine is documented in [`_assets/hike_map/DESIGN.md`](_assets/hike_map/DESIGN.md), which is the sole source of truth for that behavior.

## Purpose

`index.j2.html` (rendered from `index.j2.html` + `render_hike.py`) is the portfolio landing page: a gallery of every documented hike in this repo, with a map and a card grid, filterable by grade/region/canton/distance/etc. It answers "which of my documented hikes fits X criteria?" — a different question from Command Center's "where should I hike this weekend given the weather?" (CC also covers undocumented SAC POIs; the index only ever shows hikes with a built page).

## Architecture

Same engine as Command Center (`templates/_assets/hike_map/`), different composition preset. `templates/_assets/index_page.js` is the thin composition script — it builds a `matchablePoi` adapter (`hikeToMatchable` / `hikeToPoi`), constructs `HikeMap.FilterStore`, mounts `HikeMap.DayPicker` + `HikeMap.SidePanel`, and creates markers via `HikeMap.MarkerFactory` / `HikeMap.ClusterGroupFactory` — same as CC's `command-center.js`, just wired to index-native data (`HIKES`) instead of `SAC_ROUTES`.

Differences from CC's composition:
- Fewer filter keys are exposed, and none of them mount `HikeMap.FilterBar` — the index renders its filters as page-native buttons/cards instead of the engine's filter-bar UI.
- Region and canton are index-only concerns (SAC POIs on CC aren't grouped by region/canton in the UI).
- The card grid is entirely index-only chrome — CC has no equivalent.
- `WxLookup({ fuzzy: true })` — index hike summit coordinates sometimes drift slightly from the weather cache's peak coordinates, so lookups fall back to the nearest cached point within ~1 km. CC uses `fuzzy: false` since SAC POI coordinates are the same ones the cache was built from.

## Filter subset

Store keys: `['g', 'r', 'c', 'rt', 'di', 'tm', 'el', 'gn', 'd', 'wc']` (canonical key meanings in [`hike_map/DESIGN.md`](_assets/hike_map/DESIGN.md#canonical-url-keys); `wc` is the webcam toggle, not a filter).

| Key | Where it renders |
|---|---|
| `g` (grade) | Grade buttons in the page header |
| `r` (region) | Region buttons above the card grid |
| `c` (canton) | Canton buttons above the card grid |
| `rt` (route type) | Route-type buttons above the card grid |
| `di` (distance) | Bucket buttons above the card grid |
| `tm` (time) | Bucket buttons above the card grid |
| `el` (elev) | Bucket buttons above the card grid |
| `gn` (gain) | Bucket buttons above the card grid |
| `d` (forecast day) | `HikeMap.DayPicker.mount()` into `#mapDayBtns` |

No `sk`/`t`/`sn`/`h`/`u`/`dp` — those are CC-only (sky/temp thresholds, season toggle, hike/hut show toggles, display-field pills). No `av` — avalanche has no toggle on either page (see the engine doc's "Always-on layers").

## Card grid

One card per hike, rendered by `index_page.js` from `HIKES`. Each card links to its hike page (`card.href = h.href`) and shows the grade pill, key stats, and a per-card weather strip (one column per forecast day, driven by the same `d` store key that drives the map). Filtering hides non-matching cards (`card.style.display = ok ? "" : "none"`) using the same `HikeMap.FilterMatcher.match()` call the map markers use, so cards and markers never disagree about what's visible.

**Hover-to-highlight:** hovering a card (`mouseenter`/`mouseleave`) calls `highlightMarker(idx, true|false)`, which visually emphasizes the corresponding map marker — lets a reader scanning the card grid see where a hike sits without leaving the list.

## Panel entry

Clicking a marker opens a popup (built by the shared marker/popup wiring) with an "Expand details" button. That button calls `panel.open(h)` directly — the `HikeMap.SidePanel` instance mounted at init — rather than the popup itself trying to render forecast details. This mirrors CC's pattern where the popup is a lightweight peek and the side panel is the canonical detail surface. Once open, the panel re-renders live as the `d` (day) filter changes, same as on CC.
