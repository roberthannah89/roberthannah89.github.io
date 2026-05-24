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
| `extract_sac_route.py` | **Master pipeline** — SAC JSON → GPX → scaffold → photos → metadata → render (supports multiple hikes) |
| `render_hike.py` | `data.json` + GPX → HTML (main workhorse); also renders index, regions, and difficulty guide pages |
| `new_hike.py` | Scaffold a new empty hike directory |
| `config.py` | Shared constants imported by other scripts (physical, algorithmic, display, defaults) |
| `validate_hike_files.py` | Check every hike has all required files |
| `extract_sac_gpx.py` | SAC route JSON → GPX track (LV95→WGS84, segment stitching); imported by `extract_sac_route.py` |
| `extract_sac_photos.py` | SAC route JSON + peak hero → photo URLs in `data.json`; imported by `extract_sac_route.py` |
| `fetch_geodata.py` | Fetch canton/region GeoJSON from SwissTopo; imported by `render_hike.py` for the regions guide |

### Standalone utilities (run directly, not in Makefile)

| Script | Purpose |
|---|---|
| `inspect_sac_json.py` | Print SAC JSON structure (photos, segments, waypoints, metadata) for debugging captures |
| `check_gpx_gaps.py` | Verify GPX track connectivity after extraction — flags gaps exceeding a threshold |
| `combine_gpx.py` | Stitch two GPX tracks end-to-end for multi-route traverses (e.g. Schynige Platte–First) |
| `make_swiss_boundary.py` | One-shot generator: download GADM boundary → simplify → write `swiss_border.js`. Re-run only if boundary data needs regenerating |

---

## Reference

| Topic | Document |
|---|---|
| Data field reference (every field in `data.json`) | [`docs/schemas/DATA-SCHEMA.md`](schemas/DATA-SCHEMA.md) |
| Adding a hike, end-to-end workflow | [`docs/workflows/HIKING-WORKFLOW.md`](workflows/HIKING-WORKFLOW.md) |
| Extracting data from SAC route portal | [`docs/workflows/SAC-EXTRACTION.md`](workflows/SAC-EXTRACTION.md) |
| Common errors and fixes | [`docs/workflows/TROUBLESHOOTING.md`](workflows/TROUBLESHOOTING.md) |
| Shared constants (physical, algorithmic, defaults) | [`scripts/config.py`](../scripts/config.py) |
| Golden reference (fully populated example) | [`routes/augstmatthorn/augstmatthorn.data.json`](../routes/augstmatthorn/augstmatthorn.data.json) |
