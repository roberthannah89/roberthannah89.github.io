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

- ✅ `scripts/fetch_sac_route_v2.py` — fetches the layer API by bbox (peak coords looked up in `guides/sac-routes.js`), filters by `route_id`, stitches via the existing `extract_sac_gpx._stitch_segments`, and writes `routes/<slug>/<slug>.gpx`. Verified on Federispitz (route 6819, peak 601): 23.75 km, 4180 points. Stitching has known issues for circuits — the spatially-queried features come in arbitrary order and the greedy stitcher makes wrong guesses (e.g. ends at the peak instead of the actual finish). **TODO:** implement a graph/loop-aware stitcher in this script or `extract_sac_gpx.py`.
- ✅ Raw GeoJSON saved alongside (`sac-layer-<route-id>.json`) for reproducibility — same role as the old `sac-route-<id>.json`.
- ❌ HTML metadata scraper — not built yet. Should land as a sibling function/script and feed `scaffold_hike` + the same patching `extract_sac_route.py::_populate_sac_metadata` does today.
- ❌ Photos — extractable from the same authenticated HTML; the old `extract_sac_photos.py` reads `data["photos"]` from the now-defunct JSON and needs to be rewritten against scraped `<img>` tags or processed-image URLs.
- ❌ Elevation enrichment — the existing SwissTopo path in the GPX module already handles 2D-to-3D, just wire it through `fetch_sac_route_v2.py`.
- ❌ Index entry — Federispitz has a GPX but no `data.json`, so it doesn't appear in the gallery yet.

### Quick reference for future sessions

1. **Re-rendering an existing hike that has `sac-route-<ID>.json` already**: use the OLD pipeline (`make render` or `python scripts/render_hike.py`). The JSON files are frozen captures and remain valid.
2. **Adding a NEW hike**: the v2 pipeline isn't finished. For geometry only: `python scripts/fetch_sac_route_v2.py --url '<route-url>' --slug '<slug>' --title '<title>'`. Everything else (data.json, photos, metadata) currently has to be authored by hand — copy from a similar existing hike and edit.

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

| Script | Purpose |
|---|---|
| `login_sac.py` | **Cookie refresh** — Playwright headless (or `--headed`) login that writes `~/.config/sac-hikes/cookie` |
| `fetch_sac_route.py` | **Phase 1 alternative** — fetch JSON + peak hero via HTTPS using `$SAC_COOKIE` |
| `extract_sac_route.py` | **Master pipeline** — chains all steps below |
| `extract_sac_gpx.py` | SAC JSON → GPX (LV95→WGS84, segment stitching) |
| `extract_sac_photos.py` | SAC JSON + peak hero → photo URLs in data.json |
| `inspect_sac_json.py` | Standalone diagnostic — print SAC JSON structure for debugging captures |
| `check_gpx_gaps.py` | Standalone diagnostic — verify GPX track connectivity, flag gaps exceeding a threshold |
| `combine_gpx.py` | Standalone utility — stitch two GPX tracks for multi-route traverses |

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
