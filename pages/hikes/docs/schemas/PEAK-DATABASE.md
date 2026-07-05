# Peak Database

`guides/peaks-db.json` is the single source of truth for every named peak in
Switzerland. All peak-carrying files on the site (the 3D-trails prototype's
database panel, command-center markers, per-hike proximity lists) are
derived projections of it — never independent copies.

- Canonical: **`guides/peaks-db.json`** (pretty-printed, ~5 MB)
- Browser build: **`guides/peaks-db.js`** — sets `window.PEAKS = {name, version, count, peaks: [...]}`
- Rebuild everything (uses caches): `make peaks`
- Force-refresh Wikidata + Wikipedia: `make peaks-refresh`
- Schema questions: this file
- Field-level history: `git log guides/peaks-db.json`

---

## Files at a glance

| Path | Global | Size | Consumers |
|---|---|---:|---|
| `guides/peaks-db.json` | — | ~5 MB | Every Python build script. |
| `guides/peaks-db.js` | `window.PEAKS` | ~5 MB | Any browser page that wants the full DB. |
| `guides/peaks-compact.js` | `window.SWISS_PEAKS` | ~500 KB | 3D map marker sets — short-key records for fast rendering. |
| `routes/<slug>/nearby-peaks.js` | `window.ROUTE_PEAKS` | ~30 KB | Per-hike 3D views — peaks within N km of the GPX. |
| `docs/prototypes/3d-trails/ch-peaks.js` | `window.CH_PEAKS` | ~2 MB | 3D Swiss Trails prototype's peak database panel (search / filter / sort / cards). |

Pick the smallest file that carries the fields you need. If you find yourself
loading the full DB *and* filtering client-side, add a new projection script
instead (see "Adding a projection" below).

---

## Consuming from a prototype (worked example)

Wire the 3D-trails prototype to the Peak Database in three steps.

### 1. Load the DB via `<script>` (works over `file://`)

Add ONE of the following, depending on how much data you need:

```html
<!-- Full Peak Database — every peak, every field. ~5 MB. -->
<script src="../../guides/peaks-db.js"></script>

<!-- OR: compact marker set — {n,e,y,x,w,p,s,q}. ~500 KB. -->
<script src="../../guides/peaks-compact.js"></script>

<!-- OR: this hike's proximity slice (full schema + dist_km). ~30 KB. -->
<script src="../../routes/zindlenspitz/nearby-peaks.js"></script>
```

Pages open over `file://` on GitHub Pages, so **do not** try to `fetch()` the
JSON — always use `<script>` tags. See CLAUDE.md: "Pages are opened via
`file://` protocol".

### 2. Access + filter + sort

The full `window.PEAKS.peaks` array is sorted by best-known elevation
descending. Every consumer needs its own filter/sort — do it once at load.

```js
// Full DB — filter to notable peaks, sort by prominence descending.
const all = window.PEAKS.peaks;

const shown = all
  .filter(p => p.notable)                       // drops ~4000 minor bumps
  .filter(p => p.prominence_m != null)          // must have a prominence value
  .sort((a, b) => b.prominence_m - a.prominence_m);
```

The hash `#s=prom-desc` on the prototype URL is a nice sort-by-hash pattern.
Read the fragment on load and pick a comparator:

```js
const COMPARATORS = {
  'ele-desc':  (a, b) => (b.ele_wikidata ?? b.ele ?? 0) - (a.ele_wikidata ?? a.ele ?? 0),
  'prom-desc': (a, b) => (b.prominence_m  ?? 0) - (a.prominence_m  ?? 0),
  'iso-desc':  (a, b) => (b.isolation_km  ?? 0) - (a.isolation_km  ?? 0),
  'name-asc':  (a, b) => a.name.localeCompare(b.name),
};

function parseSortHash() {
  const m = /[#&]s=([a-z0-9-]+)/i.exec(window.location.hash);
  return (m && COMPARATORS[m[1]]) ? m[1] : 'ele-desc';
}

const sortKey = parseSortHash();
const shown = all.slice().sort(COMPARATORS[sortKey]);
```

### 3. Convert to GeoJSON for MapLibre / Leaflet

```js
const features = shown.map(p => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  properties: {
    id: p.id,
    name: p.name,
    ele: p.ele_wikidata ?? p.ele,
    prominence_m: p.prominence_m,
    isolation_km: p.isolation_km,
    grade: p.sac?.grade,
    hasImage: !!p.image,
    tier: p.is_4000er ? 1 : (p.prominence_m >= 300 ? 2 : 3),
  },
}));

map.getSource('peaks').setData({ type: 'FeatureCollection', features });
```

### 4. Build a rich popup (with image + summary + first ascent)

```js
function peakPopupHTML(p) {
  const parts = [`<h3 style="margin:0 0 4px">${escape(p.name)}</h3>`];
  parts.push(`<div style="color:#666;font-size:12px">`);
  const bits = [];
  if (p.ele_wikidata ?? p.ele) bits.push(`${Math.round(p.ele_wikidata ?? p.ele)} m`);
  if (p.prominence_m)          bits.push(`P ${p.prominence_m} m`);
  if (p.isolation_km)          bits.push(`iso ${p.isolation_km} km`);
  if (p.canton)                bits.push(p.canton);
  parts.push(bits.join(' · '), `</div>`);

  if (p.summary?.thumbnail) {
    parts.push(`<img src="${p.summary.thumbnail}" alt=""`,
               ` style="width:100%;margin-top:8px;border-radius:4px">`);
  }
  if (p.summary?.extract) {
    parts.push(`<p style="margin:8px 0 0;font-size:13px;line-height:1.4">`,
               escape(p.summary.extract), `</p>`);
  }
  if (p.first_ascent?.date) {
    parts.push(`<div style="margin-top:6px;font-size:11.5px;color:#555">`,
               `First ascent: ${p.first_ascent.date}`,
               p.first_ascent.climbers ? ` — ${p.first_ascent.climbers.join(', ')}` : '',
               `</div>`);
  }
  if (p.sac?.route_title) {
    parts.push(`<div style="margin-top:6px;font-size:11.5px">`,
               `SAC ${p.sac.grade} · ${escape(p.sac.route_title)}`,
               p.sac.gain    ? ` · +${p.sac.gain} m`  : '',
               p.sac.time_up ? ` · ${p.sac.time_up} min` : '',
               `</div>`);
  }
  if (p.summary?.url) {
    parts.push(`<a href="${p.summary.url}" target="_blank" rel="noopener"`,
               ` style="display:inline-block;margin-top:8px;font-size:12px">Wikipedia →</a>`);
  }
  return parts.join('');
}
```

`p.image` is a raw Wikimedia Commons filename. To build a URL yourself:

```js
function commonsImageURL(filename, width = 800) {
  return 'https://commons.wikimedia.org/wiki/Special:FilePath/'
       + encodeURIComponent(filename)
       + '?width=' + width;
}
```

The `p.summary.thumbnail` field is a pre-sized Wikipedia thumbnail (~320 px)
and is a better default for popups.

---

## Schema (per peak)

Every field except `id`, `name`, `lat`, `lon` is optional — code defensively.

### Identity

| Field | Type | Source | Notes |
|---|---|---|---|
| `id` | string | OSM | `n<node_id>` — primary key, stable across sources. |
| `name` | string | OSM `name` | Primary display name. |
| `alt_names` | string[] | OSM `alt_name`, `old_name`, `name:*` | Only distinct-from-primary values. |

### Geography

| Field | Type | Source | Notes |
|---|---|---|---|
| `lat`, `lon` | float | OSM | WGS84, 6 decimals. |
| `ele` | float\|null | OSM `ele` | Spot height (metres). Nullable. |
| `ele_wikidata` | float\|null | Wikidata P2044 | Authoritative — prefer over `ele`. |

### Rankings

| Field | Type | Source | Notes |
|---|---|---|---|
| `prominence_m` | int\|null | Wikidata P2660 → OSM `prominence` | Topographic prominence, metres. |
| `isolation_km` | float\|null | Wikidata P2659 | Topographic isolation, kilometres. |

### Administrative & taxonomy

| Field | Type | Source | Notes |
|---|---|---|---|
| `canton` | string\|null | point-in-polygon vs `guides/cantons.geojson` | 2-letter code. |
| `region` | string\|null | point-in-polygon vs `guides/regions.geojson` | Site's hiking-region taxonomy. |
| `part_of` | string[] | Wikidata P361 | Parent range/massif labels (English). |

### Cross-references

| Field | Type | Source | Notes |
|---|---|---|---|
| `wikidata` | string\|null | OSM `wikidata` tag | Q-ID (e.g. `Q3403`). |
| `wikipedia` | object\|null | Wikidata sitelinks | `{en, de, fr, it, rm}` → article title. |
| `osm_wikipedia_tag` | string\|null | OSM `wikipedia` | Raw `lang:Title` (fallback). |
| `image` | string\|null | Wikidata P18 | Commons filename. |
| `summary` | object\|null | Wikipedia REST | `{lang, title, extract, url, thumbnail?}`. |
| `first_ascent` | object\|null | Wikidata P793 → Q1194369 | `{date, climbers[]}`. Coverage < 5 %. |

### Routes & huts

| Field | Type | Source | Notes |
|---|---|---|---|
| `sac` | object\|null | Fuzzy join to `guides/sac-routes.js` | `{sac_summit_id, route_id, route_title, grade, time_up, gain}` — easiest (lowest-T) route. |
| `nearest_hut` | object | Nearest by haversine over `guides/sac-routes.js` huts | `{name, dist_km, alt, sac_hut_id}`. |

### Derived flags (consumer conveniences)

| Field | Type | Notes |
|---|---|---|
| `notable` | bool | `prominence_m ≥ 100 OR ele ≥ 3000 OR has wikidata`. |
| `is_4000er` | bool | Best elevation ≥ 4000 m. |
| `sources` | string[] | Which sources contributed (`osm`, `wikidata`, `wikipedia`, `sac`). |

---

## Build pipeline

```
                       ┌────────────────────────┐
   Overpass OSM ──────▶│ overpass-peaks.json    │──┐
                       └────────────────────────┘  │
                                                    ▼
   Wikidata SPARQL ──▶ wikidata-peaks.json ─────▶ build_peak_db.py
                                                    ▲   │
   Wikipedia REST ───▶ wikipedia-peaks.json ────────┘   │
                                                        │
   guides/sac-routes.js ──────────────────────────────▶ │
   guides/cantons.geojson ────────────────────────────▶ │
   guides/regions.geojson ────────────────────────────▶ │
                                                        ▼
                                            guides/peaks-db.{json,js}
                                                        │
                        ┌───────────────────────────────┼──────────────────────────────┐
                        ▼                               ▼                              ▼
             build_ch_peaks.py               build_swiss_peaks.py            build_route_peaks.py
                        │                               │                              │
                        ▼                               ▼                              ▼
   docs/prototypes/3d-trails/           guides/peaks-compact.js       routes/<slug>/nearby-peaks.js
             ch-peaks.js
```

### Fetchers (each caches independently)

| Script | Cache | Notes |
|---|---|---|
| `scripts/fetch_osm_peaks.py` | `docs/prototypes/3d-trails/overpass-peaks.json` | Every Swiss `natural=peak` node via Overpass. ~60-90 s. |
| `scripts/fetch_wikidata_peaks.py` | `scripts/cache/wikidata-peaks.json` | Batched SPARQL for peaks with a Q-ID. ~60 s. |
| `scripts/fetch_wikipedia_peaks.py` | `scripts/cache/wikipedia-peaks.json` | REST summaries; `en > de > fr > it > rm`. ~5 min. |

### Refresh commands

```bash
# Re-project from existing caches — fast, no network:
make peaks

# Refresh individual sources:
python3 scripts/build_peak_db.py --refresh-osm
python3 scripts/build_peak_db.py --refresh-wikidata
python3 scripts/build_peak_db.py --refresh-wikipedia
python3 scripts/build_peak_db.py --refresh-all
make peaks-refresh          # equivalent to --refresh-wikidata --refresh-wikipedia
```

---

## Adding a projection

If a new consumer needs a specific slice or shape, add a `build_<name>.py`
script in `scripts/` that reads `guides/peaks-db.json` and writes its output.
Never rebuild peak data from scratch — always project.

Template:

```python
import json
from pathlib import Path
REPO_ROOT = Path(__file__).resolve().parent.parent
DB_JSON = REPO_ROOT / "guides" / "peaks-db.json"

def main():
    with DB_JSON.open() as f:
        db = json.load(f)
    filtered = [p for p in db["peaks"] if p.get("prominence_m", 0) >= 500]
    # ...write output...
```

Then add a wiring line to the `peaks:` target in the Makefile so
`make peaks` regenerates it alongside everything else.

---

## Design notes

- **OSM node ID as primary key** — Wikidata Q-IDs cover ~66 % of peaks and change occasionally when items merge. OSM node IDs are stable and universal.
- **Wikidata wins on prominence/elevation** — manually curated; OSM `ele` tags are often SRTM-derived.
- **Wikipedia language fallback** goes `en → de → fr → it → rm`. Change the order in `scripts/config.py` (`WIKIPEDIA_LANG_PREFERENCE`).
- **First-ascent coverage is thin** (< 5 %) — Wikidata's P793 modelling is inconsistent. Consumers should degrade gracefully.
- **Caches stay separate** so any one source can be refreshed independently.
- **CLAUDE.md rules apply.** Never hand-edit generated files. Never `fetch()` over `file://`. Route-specific files under `routes/<slug>/`, scripts in `scripts/`, docs in `docs/`.

## Extending with new data sources

Add a fetcher that writes a cache under `scripts/cache/`, then update
`build_peak_db.py` to load it in `[4/6]` and merge fields into `rec` in the
main loop. Document the new fields in the schema table above.

Ideas worth adding:
- **swissNAMES3D** — official Swiss gazetteer for canonical names + LK25 elevation.
- **MeteoSwiss station catalog** — nearest weather station per peak.
- **Rega landing zones** — nearest heli-rescue point.
- **camptocamp.org routes** — climbing-grade routes for higher-T peaks.
- **Wikimedia Commons categories** — many more photos than P18's single image.
