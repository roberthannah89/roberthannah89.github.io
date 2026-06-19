# SAC Route Portal Extraction

Extract GPS tracks, metadata, and photo URLs from the SAC route portal.

> [!CAUTION]
> **SAC retired the old monolithic JSON endpoint between 2026-05-22 and 2026-06-01.** The old `?type=1567765346410` URL now 308-redirects to itself and serves HTML even with a valid session and the correct `cHash`. Every "Phase 1 / Phase 2" instruction below describes the **old** pipeline and applies only to **re-rendering hikes whose `sac-route-<ID>.json` was captured before the cutover**. New hikes must use the v2 path — see [Architecture migration (2026-06)](#architecture-migration-2026-06) for the replacement APIs and the v2 script.

---

## Architecture migration (2026-06)

SAC split the old monolithic route JSON into two halves living on different hosts:

| Half | New endpoint | Auth |
|---|---|---|
| **GPS geometry** | `GET https://www.suissealpine.sac-cas.ch/api/1/route/layer?bbox=<E1>,<N1>,<E2>,<N2>` (LV95) | **Public** — gated by `Origin: https://www.sac-cas.ch` header only, no cookies |
| **Rich metadata** (title, difficulty, photos, departure point, transit, teaser) | Embedded in the authenticated route page HTML at `www.sac-cas.ch` | `fe_typo_user` session cookie required |

### Geometry: layer API

The layer endpoint returns a GeoJSON `FeatureCollection`. Each feature is one trail segment:

```json
{
  "id": "non_climbing_716167",
  "type": "Feature",
  "geometry": {"type": "LineString", "coordinates": [[2725906.25, 1221805.16], ...]},
  "properties": {"id": 716167, "type": "mountain_hiking", "style": "plain", "route_id": 6819, "alternative": false}
}
```

- Coordinates are **LV95** (EPSG:2056), 2D only — no elevation. Enrich via the SwissTopo `height` API (same code path the old pipeline used).
- Filter features by `properties.route_id == <your route id>`. For a single bbox query you get hundreds of features for many routes; keep just the ones tagged with your route.
- `properties.style` is `plain` or `dashed`. Dashed appears to be variant/optional links.
- `properties.alternative` flags variant segments (skip these for the canonical track, same as the old `segments[].alternative`).
- Bbox sizing: 12 km half-width around the peak's LV95 coords covers any single-day hike with margin.

### Metadata: HTML scraping

The authenticated route page HTML contains all the rich data; it's just not in a clean JSON-LD block. Reliable hooks observed on Federispitz (route 6819):

- `og:title` — full route name
- `og:image` — peak hero image (replaces the old peak-page scrape)
- `og:description` — German teaser text
- Labels `Difficulty`, `Ascent`, `Descent`, `Walking time`, `Departure point` appear as plain text in the body — scrape with text-following-label patterns
- Difficulty value (e.g. `T4-`) appears immediately after a `Difficulty"... target="_blank">` anchor
- `https://www.sac-cas.ch/processed/...jpg` URLs are the photo CDN

### Authentication for the HTML side

- Cookie name: still `fe_typo_user`, but the **value is now a JWT** (`eyJ...`) rather than the classic 32-hex TYPO3 hex. The existing `fetch_sac_route.py --save-cookie '<value>'` flow continues to work — it just stores whatever the user pastes.
- OAuth flow: `https://www.sac-cas.ch/en/login/` → 302 → `https://portal.sac-cas.ch/oauth/authorize` → Rails Devise-style form at `https://portal.sac-cas.ch/de/users/sign_in?oauth=true` with `#person_login_identity`, `#person_password`, `button[type="submit"]`.
- Other cookies present in the browser but **not required** for the page fetch we tested: `__Secure-oidc_context`, `CookieConsent`. Sending just `fe_typo_user` was sufficient to render the authenticated route page HTML.
- **Bot detection on the OAuth callback**: Playwright Chromium (both headless and headed) consistently gets a 500 from `/typo3conf/ext/oidc/Resources/Public/callback.php`. The same flow in regular Chrome works fine. Anti-detection tweaks (User-Agent, `--disable-blink-features=AutomationControlled`, `navigator.webdriver` masking) are unverified — would need investigation. For now, treat `login_sac.py` automation as "didn't work, manual cookie copy is the reliable path."

### v2 pipeline status

- ✅ `scripts/fetch_sac_route_v2.py` — fetches the layer API by bbox (peak coords looked up in `guides/sac-routes.js`), filters features by `route_id`, and writes `routes/<slug>/<slug>.gpx`. By default emits **one `<trkseg>` per feature** (no stitching) — this is more accurate for routes whose features overlap or form figure-8 shapes. Pass `--stitch` to invoke the legacy greedy stitcher. Pass `--include-dashed` to keep `style=dashed` segments (default skips them; they're usually short markers/connectors). Raw GeoJSON saved as `sac-layer-<route-id>.json` for reproducibility.
- ✅ `scripts/scrape_sac_route_page.py` — reads the authenticated route page HTML (from a local file or via `--url` with the saved cookie) and extracts: `og:title`, `og:image`, `og:description`, difficulty, ascent/descent time + gain/drop, departure point name + elevation + transport mode, segment list, photo gallery (`/processed/…` URLs). `--apply --slug <slug>` patches `routes/<slug>/<slug>.data.json` in place, only replacing fields whose value still starts with `"TODO"`. Pass `--replace-non-todo` to overwrite existing values too. Photos are written as `{"url", "lightbox_url", "alt", "caption_html"}` to match the existing schema.
- ✅ Elevation enrichment via `new_hike.enrich_gpx_elevation` works against the v2 GPX — same SwissTopo API the old pipeline used. Sample call:
  ```python
  from pathlib import Path
  from new_hike import enrich_gpx_elevation
  enrich_gpx_elevation(Path("routes/federispitz/federispitz.gpx"))
  ```
- ✅ `new_hike.parse_gpx` was made segment-aware so it stops counting phantom jumps between disconnected trksegs as distance/gain. Single-trkseg hikes (everything pre-v2) are unaffected — verified Zindlenspitz/Rigi/Wiggis/Greina produce identical stats. For the v2 multi-trkseg output, descent now matches SAC closely (Federispitz: 1437 m computed vs. 1490 m claimed).
- ⚠️ **Known issue (remaining): GPX ascent is still inflated on figure-8 routes.** Even with segment-aware parsing, Federispitz comes out at ~2830 m ascent vs. SAC's 1490 m. The 4 GeoJSON features themselves cover overlapping ascending terrain (one of them appears to be a separate up-and-back arm of the figure-8 around the peak), so summing per-segment positive deltas still double-counts. The route page's `index_card.gain` shows the correct **scraped** value (1490 m), but the auto-generated **Elevation Profile** section uses GPX-derived stats and is wrong. Fixing this properly needs a route-aware stitcher that knows the intended traversal order (ascent half vs. descent half of a circuit) and emits one continuous trkseg representing that order — or a way to identify and drop the "summit spur" feature.
- ✅ Index entry — Federispitz now appears in the gallery with hero image, T4- pill, and scraped description. Some `TODO` fields remain (driving directions, day plan rows, weather season note, resource links).
- ✅ **Track orientation** — after enrichment and the HTML scrape, `add_sac_hike_v2.py` calls `new_hike.orient_gpx_to_trailhead` with the scraped `departure_elev_m` as anchor. Whichever GPX endpoint is closer to that elevation is forced to position 0; the GPX is reversed otherwise. This fixes the "elevation profile starts at the summit" bug — the smart stitcher has no notion of trail direction, so on routes where the lower-elev endpoint wasn't already at index 0 (e.g. Zindlenspitz, where it was the *last* point) the profile read backwards. Falls back to a "lower endpoint first" heuristic when scraping is skipped.
- ⚠️ **`--include-dashed` is required for T4+ ridge routes.** Default behaviour skips `style=dashed` features because on T1–T3 routes they're noise (short markers/connectors, e.g. Federispitz). But on alpine ridge routes the dashed segments are the *unmarked alpine terrain* between summits — exactly the part you need. Zindlenspitz (T5-, 5 features, 3 dashed) is the worst case: dropping dashed produces a 2-feature stub whose endpoints aren't at the trailhead at all and whose ascent is ~half the real value. Heuristic: if grade ≥ T4 or the non-dashed GPX has endpoints far from the scraped `departure_elev_m`, re-run with `--include-dashed`. A future improvement would scrape difficulty before building the GPX and flip the default accordingly.

### Quick reference for future sessions

**Adding a new hike** (post-2026-06) — one command, chains all five steps:

```bash
python scripts/add_sac_hike_v2.py \
    --url '<route-page-url>' --slug '<slug>' \
    --region '<Region>'   # canton auto-detects from peak coords
```

That does: GPX from the layer API → SwissTopo elevation → HTML scrape with the saved cookie → scaffold a data.json with all scraped fields → `make render`. Flags: `--no-elevation`, `--no-scrape`, `--no-render` (for iteration); `--grade`, `--canton`, `--trailhead` (to override scraped values); `--stitch`/`--include-dashed` (rare GPX tweaks).

Prerequisites: the peak ID embedded in the URL must already be in `guides/sac-routes.js`; the saved cookie at `~/.config/sac-hikes/cookie` must still be valid.

**Re-rendering an existing hike that has `sac-route-<ID>.json` already**: use the OLD pipeline (`make render`). The pre-cutover JSON files are frozen captures and remain valid for those hikes.

If you'd rather run the steps individually (debugging, partial regeneration, etc.):

```bash
# 1. Geometry only
python scripts/fetch_sac_route_v2.py --url '<route-url>' --slug '<slug>'

# 2. Scrape HTML and print what would be patched (no write)
python scripts/scrape_sac_route_page.py --url '<route-url>' --inspect

# 3. Scrape HTML and patch the slug's data.json (only TODO fields)
python scripts/scrape_sac_route_page.py --url '<route-url>' --slug '<slug>' --apply

# 4. Enrich an existing GPX with SwissTopo elevations
python -c "import sys; sys.path.insert(0,'scripts'); from pathlib import Path; \
           from new_hike import enrich_gpx_elevation; \
           enrich_gpx_elevation(Path('routes/<slug>/<slug>.gpx'))"
```

---

## Overview

The SAC route portal stores route data behind an authenticated API. The workflow has two phases:

1. **Scrape** — capture the route JSON and peak hero image URL (Playwright **or** `fetch_sac_route.py`)
2. **Extract** (one Python call) — GPX, scaffold, photos, metadata, render

**Data available in the route JSON:**

| Data | Field | Notes |
|------|-------|-------|
| GPS track segments | `segments[]` | LV95 coords, converted to WGS84 by extraction script |
| Waypoints | `waypoints[]`, `departure_point`, `destination_poi` | Named points with elevation |
| Photos | `photos[]` | Public CDN URLs at 8 sizes (160px–4000px), captions, copyright |
| Difficulty | `mountain_hiking_difficulty`, `main_difficulty` | SAC scale (T1–T6, with +/- modifiers) |
| Metadata | `climbing_ascent`, `climbing_descent`, `days`, `seriousness` | Route stats |
| Description | `teaser`, `teaser_title` | Short route summary |

---

## Quick Reference

Once you have the route JSON and peak hero URL, the entire pipeline is one command:

```bash
python scripts/extract_sac_route.py \
    --json routes/<slug>/sac-route-<ID>.json \
    --slug <slug> \
    --region "..." --canton "..." \
    --peak-hero "<peak-hero-url>" \
    --render
```

Multiple hikes at once:

```bash
python scripts/extract_sac_route.py \
    --route slug1:routes/slug1/sac-route-111.json \
    --route slug2:routes/slug2/sac-route-222.json \
    --peak-hero slug1=<url1> \
    --peak-hero slug2=<url2> \
    --render
```

The master script chains: GPX extraction → scaffold `data.json` → photo extraction → SAC metadata population → `make render`. Individual steps are skippable with `--no-scaffold`, `--no-photos`, `--no-elevation`, `--no-metadata`.

---

## Phase 1 — Scrape (Playwright)

### 1a. Navigate to the route page

Open the route detail page. The user must already be logged in to sac-cas.ch.

```
https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/<peak-slug>-<peak-id>/mountain-hiking/<route-slug>-<route-id>/
```

### 1b. Capture the route JSON

Use `browser_network_requests` to find the route data request:

```
filter: type=1567765346410
```

Save the response body to `routes/<slug>/sac-route-<ID>.json`.

> [!WARNING]
> If `segments` is empty in the JSON, the session isn't authenticated — stop and tell the user to log in.

### 1c. Capture the peak hero image

Navigate to the peak page:

```
https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/<peak-slug>-<peak-id>/
```

Extract the largest image URL from `.c-teaser-destination__image img` via `browser_evaluate`:

```js
() => {
    const imgs = document.querySelectorAll('.c-teaser-destination__image img');
    return Array.from(imgs).map(img => {
        const entries = (img.srcset || '').split(',').map(s => s.trim()).filter(Boolean);
        const widths = entries.map(e => {
            const parts = e.split(/\s+/);
            return { url: parts[0], w: parseInt(parts[1]) || 0 };
        });
        widths.sort((a, b) => b.w - a.w);
        return widths[0]?.url || img.src;
    }).filter(u => !u.startsWith('data:'));
}
```

Prefix relative URLs with `https://www.sac-cas.ch`.

---

## Phase 1 alternative — no Playwright (`fetch_sac_route.py`)

If you'd rather not drive a browser, `scripts/fetch_sac_route.py` fetches the same JSON over plain HTTPS using your `fe_typo_user` session cookie. Useful when sharing the workflow with others: they run the script with their own cookie, yours never leaves your machine.

### Easiest: headless login via `login_sac.py`

Save credentials once, refresh the cookie with one command whenever it expires:

```bash
# One-time: write ~/.config/sac-hikes/credentials (mode 0600, outside the repo)
python scripts/login_sac.py --save-credentials

# Each time the cookie expires (a few days):
python scripts/login_sac.py
```

The script drives Playwright Chromium headlessly, completes the OAuth flow, and writes `~/.config/sac-hikes/cookie` — the same file `fetch_sac_route.py` already reads from.

If headless ever breaks (SAC layout change, MFA prompt, captcha):

```bash
python scripts/login_sac.py --headed
```

A visible Chromium window opens at the login page; finish login manually. The script polls the browser's cookie store and saves as soon as `fe_typo_user` appears.

### Manual fallback: paste the cookie

If you'd rather not use Playwright at all:

1. Log in at https://www.sac-cas.ch in your browser.
2. Open DevTools → Application → Cookies → `www.sac-cas.ch`, copy the value of `fe_typo_user`.
3. `python scripts/fetch_sac_route.py --save-cookie '<value>'`
   (or pipe it: `pbpaste | python scripts/fetch_sac_route.py --save-cookie -`)

### Fetch

```bash
python scripts/fetch_sac_route.py \
    --url 'https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/<peak>/mountain-hiking/<route>/' \
    --slug <slug> \
    --peak-hero
```

This writes `routes/<slug>/sac-route-<ID>.json` and prints the peak hero URL. Chain straight into Phase 2 with `--extract --render` (forwards `--region`, `--canton`, hero, etc.):

```bash
python scripts/fetch_sac_route.py \
    --url '...' --slug '<slug>' --peak-hero \
    --extract --region "..." --canton "..." --render
```

> [!WARNING]
> If the script reports `JSON has no segments`, the cookie isn't authenticated for paid content — re-copy `fe_typo_user` from your browser. If it reports `Expected JSON, got text/html` even with a valid cookie, paste the full JSON request URL from DevTools → Network (including its `cHash`) as `--url`.

---

## Phase 2 — Extract (one command)

```bash
python scripts/extract_sac_route.py \
    --json routes/<slug>/sac-route-<ID>.json \
    --slug <slug> \
    --region "..." --canton "..." \
    --peak-hero "<peak-hero-url>" \
    --render
```

This runs the following steps automatically:

### Step 1 — GPX extraction

- Reads the SAC JSON
- Filters out alternative/variant segments (`alternative=True`)
- Stitches segments into a connected track (handles reversed direction, out-and-back spurs, gaps)
- Converts LV95 (EPSG:2056) to WGS84
- Enriches with SwissTopo elevation data (unless `--no-elevation`)
- Writes `routes/<slug>/<slug>.gpx`

### Step 2 — Scaffold data.json

- Auto-derives name, grade, trailhead, elevation from the SAC JSON
- Computes distance, gain, time from GPX stats
- Adds SAC source URLs

### Step 3 — Photo extraction

- Peak hero image placed first (hero banner + first gallery photo)
- Route JSON gallery photos follow
- Sets `photos_attrib_html` with photographer copyright

### Step 4 — Metadata population

- Fills intro text from SAC teaser + peak description
- Populates route segments as bullet points
- Fills transit/getting-there from departure point data
- Sets safety warnings from difficulty/seriousness
- Populates resource links

### Step 5 — Render

Runs `make render` to generate HTML pages.

---

## Scripts Reference

**v2 pipeline (current, post-2026-06):**

| Script | Purpose |
|---|---|
| `add_sac_hike_v2.py` | **Master pipeline** — chains layer-API GPX → SwissTopo elevation → HTML scrape → scaffold → render |
| `fetch_sac_route_v2.py` | SAC layer API → GPX (LV95→WGS84) + raw layer JSON for reproducibility |
| `scrape_sac_route_page.py` | SAC route HTML → patch `data.json` (difficulty, times, photos, departure point) |
| `login_sac.py` | **Cookie refresh** — Playwright headless (or `--headed`) login that writes `~/.config/sac-hikes/cookie` |
| `fetch_sac_route.py` | Legacy v1 fetcher (pre-cutover JSON only); also hosts shared cookie helpers |
| `inspect_sac_json.py` | Standalone diagnostic — print legacy SAC JSON structure |
| `check_gpx_gaps.py` | Standalone diagnostic — verify GPX track connectivity, flag gaps exceeding a threshold |
| `combine_gpx.py` | Standalone utility — stitch two GPX tracks for multi-route traverses |

> [!NOTE]
> The legacy `extract_sac_route.py` / `extract_sac_gpx.py` / `extract_sac_photos.py` trio (referenced in the pre-cutover phases below) has been removed; their behaviour is now folded into `add_sac_hike_v2.py` + `scrape_sac_route_page.py`. The phase-by-phase narrative below is retained for context on hikes captured before the 2026-06 cutover.

---

## Route Folder Contents

| File | Lifecycle |
|---|---|
| `<slug>.data.json` | Permanent — single source of truth |
| `<slug>.gpx` | Permanent — extracted from SAC JSON |
| `<slug>.html` | Generated — regenerated on `make render` |
| `<slug>.track.js` | Generated — regenerated on `make render` |
| `sac-route-<ID>.json` | Permanent — raw source data, kept for reproducibility (re-run extraction if scripts change) |

> [!NOTE]
> All route-specific files live in `routes/<slug>/` — never in the repo root.
