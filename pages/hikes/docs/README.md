# Agent Docs — hikes

Swiss Alpine hike pages. You supply GPX + photos; scripts validate and render HTML.

---

## Guardrails

- Do **not** auto-generate GPX via routing APIs (Swisstopo, OSM, etc.)
- Do **not** auto-download or scrape photos
- Do **not** generate topo map images
- Do **not** restore `build_hike_gpx.py`, `download_images.py`, `make_topo_map.py`, `add_hike.py`, or `check_hiking_docs.py`
- Do **not** hand-edit generated `.html` or `.track.js` files — re-run `make render`
- Do **not** directly ingest data files (GPX, JSON, CSV, etc.) into conversation context — always use project scripts to process them. The scripts exist so you don't have to read data inline; doing so wastes time and tokens.
- Do **not** pass inline Python to Bash for data processing — if a script doesn't exist, create one in `scripts/` first, then call it
- **Keep files organized:** all route-specific files go in `routes/<slug>/`, scripts in `scripts/`, docs in `docs/`. Never dump files in the repo root.
- **Keep `AGENTS.md` and `README.md` in sync.** Any change to scripts, workflow, targets, or repo structure must be reflected in both files before committing.

---

## Scripts

### Pipeline scripts (called by Makefile or imported by other scripts)

| Script | Purpose |
|---|---|
| `add_sac_hike_v2.py` | **Master pipeline (v2)** — SAC layer API → GPX → scaffold → metadata → render. Supports multiple hikes via repeated `--route slug:id`. |
| `render_hike.py` | `data.json` + GPX → HTML (main workhorse); also renders index, regions, and difficulty guide pages |
| `new_hike.py` | Scaffold a new empty hike directory |
| `config.py` | Shared constants imported by other scripts (physical, algorithmic, display, defaults) |
| `validate_hike_files.py` | Check every hike has all required files |
| `fetch_sac_route_v2.py` | SAC layer API → GPX track (LV95→WGS84) + raw layer JSON; imported by `add_sac_hike_v2.py` |
| `scrape_sac_route_page.py` | Scrape SAC route HTML page → patch `data.json` with metadata (difficulty, times, departure/destination); imported by `add_sac_hike_v2.py` |
| `fetch_sac_route.py` | Legacy v1 fetcher; still hosts the SAC cookie helpers (`_load_cookie`, `save_cookie`, `DEFAULT_COOKIE_FILE`) imported by the v2 scripts |
| `fetch_geodata.py` | Fetch canton/region GeoJSON from SwissTopo; imported by `render_hike.py` for the regions guide |
| `fetch_weather.py` | Open-Meteo (MeteoSwiss ICON-CH2) → `command-center/weather-cache.js`. Run via `make weather` before opening the command center |

### Standalone utilities (run directly, not in Makefile)

| Script | Purpose |
|---|---|
| `inspect_sac_json.py` | Print SAC JSON structure (photos, segments, waypoints, metadata) for debugging captures |
| `scrape_sac_pois.py` | Paginate the SAC suissealpine POI search API → `guides/sac-routes.js`. Re-run to refresh the peak/hut lookup table that powers the command center markers + the v2 pipeline |
| `backfill_sac_credits.py` | Walk all hikes and re-scrape SAC route pages for any with `sac-cas.ch/processed/` photos missing `copyright`. Dry-run by default; pass `--apply` to fetch + patch |
| `check_gpx_gaps.py` | Verify GPX track connectivity after extraction — flags gaps exceeding a threshold |
| `combine_gpx.py` | Stitch two GPX tracks end-to-end for multi-route traverses (e.g. Schynige Platte–First) |
| `make_swiss_boundary.py` | One-shot generator: download GADM boundary → simplify → write `swiss_border.js`. Re-run only if boundary data needs regenerating |
| `fetch_windy_webcams.py` | Windy Webcams API → `command-center/webcams_windy_data.js`. Re-run when refreshing the webcam list |
| `render_proto_index.py` | Auto-generate `docs/prototypes/index.html` from `proto-*` meta tags in each prototype HTML |
| `build_peak_db.py` | **Peak Database** — canonical single source of truth for every named Swiss peak. Merges OSM Overpass + Wikidata + Wikipedia + SAC routes/huts + cantons/regions polygons into `guides/peaks-db.{json,js}`. See [`docs/schemas/PEAK-DATABASE.md`](schemas/PEAK-DATABASE.md) for schema + consumer examples. |
| `fetch_osm_peaks.py`, `fetch_wikidata_peaks.py`, `fetch_wikipedia_peaks.py` | Cache builders that feed `build_peak_db.py`. Each caches independently under `scripts/cache/` (Wikidata / Wikipedia) or `docs/prototypes/3d-trails/overpass-peaks.json` (OSM). Safe to delete + refetch. |
| `build_ch_peaks.py`, `build_swiss_peaks.py`, `build_route_peaks.py` | **Projections** of the Peak Database — emit `docs/prototypes/3d-trails/ch-peaks.js`, `guides/peaks-compact.js`, and per-route `routes/<slug>/nearby-peaks.js`. Never touch the source data; add a new projector to add a new consumer file. |

---

## Architecture

The map surfaces on both `index.html` (portfolio + gallery) and `command-center/index.html` (full-screen discovery) share one engine: `templates/_assets/hike_map/`. See its [DESIGN.md](../templates/_assets/hike_map/DESIGN.md) for the module list, matchable-POI contract, canonical URL keys, and first-click popup regression guard.

Page-specific docs:
- [command-center/DESIGN.md](../command-center/DESIGN.md) — CC's shell + bottom bar + filter subset.
- [templates/index.DESIGN.md](../templates/index.DESIGN.md) — index gallery's card grid + external filter chrome.

---

## Reference

| Topic | Document |
|---|---|
| Data field reference (every field in `data.json`) | [`docs/schemas/DATA-SCHEMA.md`](schemas/DATA-SCHEMA.md) |
| **Peak Database** — schema, sources, projection scripts, prototype consumer example | [`docs/schemas/PEAK-DATABASE.md`](schemas/PEAK-DATABASE.md) |
| Adding a hike, end-to-end workflow | [`docs/workflows/HIKING-WORKFLOW.md`](workflows/HIKING-WORKFLOW.md) |
| Extracting data from SAC route portal | [`docs/workflows/SAC-EXTRACTION.md`](workflows/SAC-EXTRACTION.md) |
| SAC suissealpine API reference | [`docs/SAC-API.md`](SAC-API.md) |
| Swiss APIs & data layers (all external services + prototypes) | [`docs/APIS.md`](APIS.md) |
| Common errors and fixes | [`docs/workflows/TROUBLESHOOTING.md`](workflows/TROUBLESHOOTING.md) |
| Shared constants (physical, algorithmic, defaults) | [`scripts/config.py`](../scripts/config.py) |
| Golden reference (fully populated example) | [`routes/augstmatthorn/augstmatthorn.data.json`](../routes/augstmatthorn/augstmatthorn.data.json) |
| Command Center design spec | [`command-center/DESIGN.md`](../command-center/DESIGN.md) |
| Offline / PWA support — design memo | [`docs/design/offline.md`](design/offline.md) |
