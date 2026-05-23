# Agent Instructions — hikes

**Before starting any task, read all documents linked from [docs/README.md](docs/README.md).** This includes the data schema, workflows, and troubleshooting guide — not just the top-level README.

## Key rules

- **Never make up or approximate data.** All coordinates, elevations, times, and other factual values must come from an authoritative source (SAC JSON, GPX, SwissTopo, the route page). If the data isn't available, leave the field as `"TODO"` rather than guessing.
- **Never directly ingest data files (GPX, JSON, CSV, etc.) into conversation context.** Always use project scripts to process them (`parse_gpx`, `compute_gpx_stats`, `make new-gpx`, `make render`). Reading data files inline wastes time and tokens — the scripts exist so you don't have to.
- **Never pass inline Python to Bash for data processing.** If a script doesn't exist for what you need, create one in `scripts/` first, then call it. All data transformations should be maintainable, reusable scripts.
- **Keep files organized.** Route-specific files (SAC JSON, GPX, data.json, HTML) go in `routes/<slug>/`. Scripts go in `scripts/`. Docs go in `docs/`. Never dump files in the repo root. If you see misplaced files, move them proactively.
- Never hand-edit generated `.html` or `.track.js` — re-run `make render`.
- **Never hardcode shared constants in individual scripts.** Physical constants (earth radius, lapse rate), algorithm parameters (Naismith's rule, elevation smoothing), default text (disclaimer, weather sources), and lookup tables (source URLs, difficulty blurbs) all live in `scripts/config.py`. Import from there — do not duplicate values across files.

## Generated pages

`make render` produces all of these from templates + hike data. Never hand-edit them:

| Output | Template | What it contains |
|---|---|---|
| `routes/<slug>/<slug>.html` | `hike_page.j2.html` | Individual hike page |
| `routes/<slug>/<slug>.track.js` | *(generated from GPX)* | Leaflet track data |
| `index.html` | `index.j2.html` | Gallery landing page with filters and map |
| `guides/regions.html` | `regions.j2.html` | Hikes grouped by region/canton |
| `guides/difficulty.html` | `difficulty.j2.html` | SAC grade guide with auto-populated hike examples |

The remaining guide pages (`guides/planning.html`, `guides/weather.html`, `guides/gear.html`, `guides/index.html`) are static HTML — edit them directly.

## Shared constants — `scripts/config.py`

All pipeline constants live here. Scripts import from `config.py` instead of defining their own values:

- **Physical:** `EARTH_RADIUS_M`, `LAPSE_RATE_C_PER_KM`
- **GPX processing:** `ELEV_SMOOTH_M`, `LOOP_THRESHOLD_M`
- **Time estimation:** `NAISMITH_SPEED_KMH`, `NAISMITH_ASCENT_MH`
- **Display:** `INDEX_PHOTO_WIDTH`, `DIFFICULTY_BLURBS`, `SOURCE_URL_MAP`
- **Scaffold defaults:** `DEFAULT_WEATHER_SOURCES`, `DEFAULT_DISCLAIMER`

When adding a new constant or lookup table, put it in `config.py` rather than inline in a script.

## SAC Route Portal Structure

SAC organises content as **peak pages** containing one or more **route pages**:

- **Peak page:** `sac-cas.ch/.../zindlenspitz-2260/mountain-hiking/` — lists all routes for a peak
- **Route page:** `sac-cas.ch/.../zindlenspitz-2260/mountain-hiking/bruennelistock-rossaelplispitz-and-zindlenspitz-4567/` — a specific route with GPX geometry

**Hike pages in this repo are based on routes, not peaks.** Each `data.json` corresponds to one specific route. If the user provides a peak URL instead of a route URL, check how many routes exist. If there's only one route, use it. If there are multiple, ask which one before proceeding. In the `sources` array, list the route URL first (primary object), then the peak URL (so readers can find alternative routes):

```json
"sources": [
  { "name": "SAC Route Portal (route)", "url": "https://www.sac-cas.ch/.../route-slug/" },
  { "name": "SAC Route Portal (peak)",  "url": "https://www.sac-cas.ch/.../peak-slug/mountain-hiking/" }
]
```

## Extracting Data from SAC Route Portal

When creating a hike from an SAC route portal URL, follow **[`docs/workflows/SAC-EXTRACTION.md`](docs/workflows/SAC-EXTRACTION.md)**.

### Phase 1 — Scrape (Playwright, 2-3 tool calls)

1. Navigate to the **route page** in Playwright (user must be logged in)
2. Capture the route JSON via `browser_network_requests` (filter: `type=1567765346410`)
3. Save to `routes/<slug>/sac-route-<ID>.json`
4. Navigate to the **peak page** and extract the hero image URL via `browser_evaluate`

### Phase 2 — Extract (one command)

```bash
python scripts/extract_sac_route.py \
    --json routes/<slug>/sac-route-<ID>.json \
    --slug <slug> \
    --region "..." --canton "..." \
    --peak-hero "<url>" \
    --render
```

This single command runs: GPX extraction → scaffold data.json → photo extraction → SAC metadata population → render. For multiple hikes use `--route slug:json` (repeat).

**Do not delete the intermediate JSON until `data.json` is fully populated.** Re-authenticating to SAC is manual and costly.
