# SAC Route Portal Extraction

Extract GPS tracks, metadata, and photo URLs from the SAC route portal.

> [!NOTE]
> Requires: Playwright browser tool (for JSON capture), an authenticated sac-cas.ch session, and `gpxpy`.

---

## Overview

The SAC route portal stores route data behind an authenticated API. The workflow has two phases:

1. **Scrape** (Playwright) — capture the route JSON and peak hero image URL
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
