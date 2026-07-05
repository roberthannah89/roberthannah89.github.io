# Peak Viewer — prototype design

**Status:** design, 2026-07-05
**Location (planned):** `docs/prototypes/peak-viewer.html`
**Reference layout mockup:** [artifact link](https://claude.ai/code/artifact/4f05dfd9-5ffd-4c25-b23b-5d85f0b437ef)

## Purpose

A single-page prototype that combines:

1. A **photorealistic 3D view** of Switzerland (Cesium + Google Photorealistic 3D Tiles).
2. A **filterable database of every named peak in Switzerland** (from OpenStreetMap `natural=peak`, enriched with canton, prominence, Wikipedia, and SAC route data where available).
3. **Click a peak → camera flies to it in 3D.**

The goal is exploratory: a peak-first way of browsing Swiss mountains, in contrast to the existing hike-first index page. Peak Viewer is the terrain-and-metadata companion to the route pages.

## Non-goals

- Route rendering. The GPX track for hikeable peaks stays on the hike pages, not here.
- Weather. The command center already covers that.
- Editing peak data. Read-only.
- Mobile-first design. Desktop-first, but the layout gracefully stacks on narrow screens (see Layout § Mobile).

## Layout

Side-by-side split, with a minimizable right panel. See the mockup artifact for a click-through prototype.

```
┌─────────────────────────────────────────────┬─────────────────────┐
│                                             │ Peaks   [Minimize]  │
│                                             │─────────────────────│
│           CESIUM 3D                         │ [🔍 search]         │
│      (Google Photorealistic tiles)          │ [elev range] chips  │
│                                             │─────────────────────│
│  ┌──────────────┐                           │  Dufourspitze 4634m │
│  │ Selected     │                           │  Weisshorn    4506m │
│  │ Eiger  3967m │                           │  Matterhorn   4478m │
│  │ Bern · T5    │           ◐ compass       │ ▶Eiger        3967m │
│  └──────────────┘                           │  Schilthorn   2970m │
│                                             │  …                  │
└─────────────────────────────────────────────┴─────────────────────┘
```

### Split proportions

- Right panel default width: **440 px** (fixed).
- 3D fills the remaining width.
- Minimize collapses the right panel to **0 px** with a **`◀ Peaks · 1,842`** edge tab pinned to the top-right of the 3D pane.

### Transitions

- Panel collapse/expand: 320 ms `cubic-bezier(.4,.14,.3,1)` on the grid columns.
- Overlays (selected-peak card, compass) reflow so they don't sit behind the edge tab when collapsed.
- Keyboard shortcuts: `[` minimize, `]` expand, `Esc` deselect current peak.

### Mobile / narrow screens

Below ~860 px width: the split becomes stacked (3D on top ~300 px, list below). Minimize keeps the same semantics — collapses the list section to 0, floating "Peaks" pill in the corner brings it back.

### Overlays inside the 3D pane

- **Peak Viewer status card** (top-left): total peaks + filtered count.
- **Selected peak card** (top-right): name, elevation, canton, prominence, SAC info (grade + gain + time), nearest hut, Wikipedia link, "Fly here" primary action.
- **Compass** (bottom-right, 46 px round): shows camera heading; click to reset heading to north.
- **Edge tab** (top-right, only when panel collapsed): re-opens the list.

## Data model

One record per peak. Stored as a single static JS file that assigns to `window.CH_PEAKS`.

```js
{
  id: "n12345678",           // OSM node id, prefixed with "n"
  name: "Eiger",
  ele: 3967,                 // metres; null if unknown (~5% of OSM peaks)
  lat: 46.5775,
  lon: 8.0055,
  canton: "BE",              // ISO code, derived from geo.admin.ch identify
  region: "Northern Alps",   // biogeographical region
  prominence: 361,           // metres; omitted when unknown
  wikipedia: "de:Eiger",     // OSM wikipedia tag; omitted when absent
  wikidata: "Q182089",       // omitted when absent
  sac: {                     // omitted when no SAC match
    route_id: 12345,
    route_title: "Mittellegigrat",
    grade: "T5",
    time_up: 420,            // minutes
    gain: 1443               // metres
  },
  nearest_hut: {             // always present (nearest hut across CH)
    name: "Mittellegihütte SAC",
    dist_km: 1.2,
    alt: 3355
  }
}
```

Derived flags computed at render time in JS (not stored):

- `notable = wikipedia != null`
- `hikeable = sac != null`

### Field sources

| Field | Source | Coverage |
|---|---|---|
| `name`, `lat`, `lon` | OSM `natural=peak` via Overpass | 100% |
| `ele` | OSM `ele` tag | ~95% |
| `wikipedia`, `wikidata` | OSM tags | ~15% notable peaks |
| `prominence` | OSM `prominence` tag | Sparse — famous peaks only |
| `canton`, `region` | geo.admin.ch identify (`MapServer/identify`, batched) | 100% |
| `sac.*` | fuzzy name match + <100 m proximity against `guides/sac-routes.js` | ~15% of peaks (the hikeable ones) |
| `nearest_hut` | nearest neighbour among `type=="hut"` in `guides/sac-routes.js` | 100% |

**Prominence policy:** show when known, hide otherwise. No backfill for the prototype.

## Data pipeline

One-time build. Produces `docs/prototypes/peak-viewer/ch-peaks.js` (roughly 800 KB gzipped estimate for ~5–10 k peaks).

`scripts/build_ch_peaks.py`:

1. **Overpass fetch** — country-wide query for `natural=peak` in Switzerland, restricted to the Swiss admin boundary area (Overpass QL: `area["ISO3166-1"="CH"]->.ch; node["natural"="peak"]["name"](area.ch); out;`). Cache raw response to `docs/prototypes/peak-viewer/overpass-peaks.json` for reproducibility. Skip unnamed peaks (there's no point listing them).
2. **Canton / region enrichment** — call `api3.geo.admin.ch/rest/services/api/MapServer/identify` for each peak, batched with rate-limit friendly sleep. Cache in `overpass-peaks-enriched.json` so re-runs are cheap.
3. **SAC join** — for each SAC `type=="summit"` in `guides/sac-routes.js`, find the nearest OSM peak within 100 m. If the names fuzzy-match (Levenshtein ratio ≥ 0.7 after normalising ü/ue, é/e, etc.), attach the SAC record. When a peak has multiple SAC routes (common — routes are per-approach), pick the one with the lowest grade as the "best route" for display. Log unmatched SAC summits to `stderr` — they usually indicate name variants worth fixing.
4. **Nearest hut** — spatial nearest-neighbour against SAC huts, no distance cap. Store name + km + alt.
5. **Serialize** as `window.CH_PEAKS = [...]` to `ch-peaks.js`. Sorted by elevation descending so the top of the list renders instantly.

Follows the CLAUDE.md rule "Derive from primary data, don't guess": every field is either from OSM or reproducibly computed. Raw OSM caches stay checked in.

Runs once (not on every render). Refresh when SAC POI data updates or when we want to pull in new OSM edits.

### Constants live in `scripts/config.py`

Add to `scripts/config.py` (per project convention):

- `CH_BBOX` — bounding box for Overpass query
- `SAC_JOIN_DISTANCE_M = 100`
- `SAC_JOIN_NAME_THRESHOLD = 0.7`
- `OVERPASS_ENDPOINT` (already implied — factor from `3d-peaks.html` if hardcoded)

## Filters + sort

All controls live in the right panel header area. Filter state is stored in `window.location.hash` so the URL is shareable.

### Filters

| Control | Default | Notes |
|---|---|---|
| Name search | empty | Substring, case + diacritic insensitive |
| Elevation range | 1000 – 4634 m | Two-handled slider |
| Canton chips (multi-select) | all off = all shown | 26 chips; scroll horizontally on small screens |
| Notable ★ | off | Filters to `wikipedia != null` |
| Hikeable | off | Filters to `sac != null` |
| SAC grade chips (T1–T6) | all off | Only visible when Hikeable is on |

### Sort (dropdown in panel header, right of "Peaks" title)

- Elevation ↓ (**default**)
- Name A–Z
- Prominence ↓ (only shows entries with known prominence at the top, then hides unknowns via `notable` filter or shows them last)
- Canton

### Card content (per row)

- Line 1: **Name** (14 px, weight 600) · elevation right-aligned in mono (14.5 px, weight 600)
- Line 2 (meta, 12 px muted): `canton · Prom Xm · [grade badge] · ★`
  - Prominence omitted when unknown
  - Grade badge omitted when not hikeable
  - Star omitted when not notable
- Selected row: `--accent-soft` background + 1 px accent border
- Hover: `--surface-alt` background

## 3D behaviour

### Base tiles

- **Primary:** Google Photorealistic 3D Tiles via Cesium `createGooglePhotorealistic3DTileset`, using the API key from `local-config.js` (reuse the pattern from `3d-photorealistic.html`, including the CDN fallback chain for Cesium itself).
- **Fallback:** if the key is missing or the tileset fails to load, initialize with Cesium World Terrain + Bing satellite (the `3d-cesium.html` setup) so the prototype still opens without setup. Show a small banner: "Photorealistic tiles unavailable — set `googleMapsApiKey` in `local-config.js` for better imagery."

### Default camera (home)

Oblique view of the central Alps from the northwest:

```js
destination: Cartesian3.fromDegrees(7.5, 47.4, 150_000),
orientation: { heading: toRadians(140), pitch: toRadians(-45), roll: 0 }
```

This frames Bern → Wallis → Graubünden nicely.

### Marker rendering

5,000+ peaks is too many to label at once. Render density scales with camera altitude and filter state:

| Camera altitude | What's rendered |
|---|---|
| > 50 km | Only peaks matching `notable OR ele >= 3500`; all labelled. ~300 items. |
| 20 – 50 km | Same set, plus peaks in current view frustum with `ele >= 2500`. Labels only on top 60 by elevation. |
| < 20 km | All peaks in view frustum. Labels only on top 30 by elevation. Others render as small dots. |

Filter state further restricts what's rendered — filtered-out peaks disappear from 3D entirely, so the list and the terrain stay in sync.

### Selected peak

- 6 px red dot (`--accent`), 16 px translucent halo.
- Always-on label with name and elevation.
- `disableDepthTestDistance: Infinity` so the marker stays visible even when behind terrain.
- Optional short "pulse" animation on selection (2 s scale-up-and-fade of the halo).

### Fly-to behaviour

Triggered by:
- Click a card in the list panel
- Click a marker in 3D
- URL hash including `?peak=<osmid>` on page load

Camera flight parameters:
- Camera position: 2 km south of the summit, at (summit elevation + 800 m)
- Heading: 0° (due north — so the camera looks at the peak)
- Pitch: −25°
- Duration: 2.5 s, cubic ease

Uses `viewer.camera.flyTo(...)` with `duration: 2.5`.

### Deselect

- Clicking empty terrain, pressing `Esc`, or clearing the URL hash removes the selection.
- Selected-peak overlay hides; marker returns to normal styling.

### Interactions

- Cesium defaults for pan / orbit / tilt / zoom.
- Left-drag: pan
- Right-drag: tilt (Cesium default)
- Scroll / pinch: zoom
- Click compass: reset heading to north (keeping altitude and pitch).

## File layout

```
docs/prototypes/
  peak-viewer.html           ← the page
  peak-viewer/
    peak-viewer.js           ← app logic (Cesium wiring, panel, filters, sort)
    peak-viewer.css          ← styles (tokens shared with other 3D prototypes if possible)
    ch-peaks.js              ← generated: window.CH_PEAKS = [...]
    overpass-peaks.json      ← raw Overpass cache (checked in for reproducibility)
    overpass-peaks-enriched.json  ← raw + canton/region cache

scripts/
  build_ch_peaks.py          ← one-shot pipeline described above

pages/hikes/prototypes/index (proto-meta)
  Add proto-title / proto-desc / proto-order metas to peak-viewer.html so it
  auto-registers in `docs/prototypes/index.html` per render_proto_index.py.
```

Follows CLAUDE.md rules:
- Peak-specific derived data (`ch-peaks.js`, raw caches) sits under `docs/prototypes/peak-viewer/`, not the repo root.
- The build script goes in `scripts/`.
- Shared constants go in `scripts/config.py`.
- `ch-peaks.js` is generated — carries a `GENERATED FROM overpass-peaks-enriched.json — do not edit` banner.
- Runtime loads data via `<script>` tag setting a global, not `fetch()` (site opens via `file://`).

## Interactions summary

| Action | Result |
|---|---|
| Type in search | List filters live |
| Adjust elevation slider | List + 3D markers filter live |
| Toggle canton chip | List + 3D markers filter live |
| Toggle Notable / Hikeable | List + 3D markers filter live; grade chips appear |
| Click card | Camera flies; card becomes selected; URL hash updates |
| Click marker | Same as click card |
| Click empty terrain / `Esc` | Deselect |
| Click **Minimize** or `[` | Panel collapses; edge tab appears |
| Click edge tab or `]` | Panel expands |
| Click compass | Camera heading resets to north |

## Open questions (defer to implementation)

1. **Panel width** — fixed 440 px, or draggable divider? Prototype ships with fixed; add drag later if needed.
2. **Live count in edge tab** — currently shows filtered count. Should it also indicate loading state during a big filter change?
3. **Sort by prominence** — how to display peaks with unknown prominence? Group at bottom, or hide when this sort is active? Ship with "sort places unknowns at end, muted".
4. **Peak clustering at very low zoom** — if 300+ labelled markers still feel cluttered from a country-wide view, add cluster bubbles ("14 peaks here"). Punt until we see it.
5. **URL structure** — `?peak=<osmid>` for a selection, plus filter state in the hash. Confirm URL scheme when we wire filters.
