---
applyTo: "**"
---

# Hike page workflow & data.json schema

All per-hike content lives in `hikes/<slug>/<slug>.data.json`. The rendered HTML is generated
by `skills/hiking/scripts/render_hike.py` from `skills/hiking/templates/hike_page.j2.html`.
**Never hand-edit a generated `<slug>.html` or `hikes/index.html`.**

## Scripts

```bash
cd /opt/code/website

# Validate all image URLs (skips Wikimedia bot-blocking, catches real 404s):
~/venvs/dev/bin/python skills/hiking/scripts/validate_images.py
~/venvs/dev/bin/python skills/hiking/scripts/validate_images.py --slug <slug>  # single hike
~/venvs/dev/bin/python skills/hiking/scripts/validate_images.py --fix          # auto-fix wiki URLs

# Fast path for agents / batch work:
~/venvs/dev/bin/python skills/hiking/scripts/add_hike.py \
  --spec /abs/path/to/<slug>.spec.json

# Scaffold a new hike:
~/venvs/dev/bin/python skills/hiking/scripts/new_hike.py \
  --slug <slug> --name <Name> --region <Region> --canton <Canton> \
  --grade T3 --elev <elev> --trailhead <Village>

# Build GPX + track.js (once per hike):
~/venvs/dev/bin/python skills/hiking/scripts/build_hike_gpx.py \
  --slug <slug> --peak <Peak> --trailhead <Village> \
  --via <Wpt1> --via <Wpt2> \
  --bbox <s,w,n,e> --out-dir hikes/<slug>/

# Render (all hikes + index.html):
~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py
~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py --slug <slug>   # single
~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py --probe         # + URL checks
~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py --jobs 1        # serial
```

### Preferred fast path (`add_hike.py`)

Use `add_hike.py` when parallel agents are researching multiple hikes at once.
It does three things in one command:

1. Generates `hikes/<slug>/<slug>.data.json` from the normal template.
2. Merges the provided JSON spec on top of the template.
3. Runs `build_hike_gpx.py` and `render_hike.py --slug <slug>`.

Supported flags:

- `--overwrite` — replace an existing `<slug>.data.json`
- `--skip-gpx` — write data only
- `--skip-render` — write data (and maybe GPX) only
- `--probe` — pass `--probe` through to `render_hike.py`
- `--print-spec-template` — emit an example spec JSON

Spec examples live in `skills/hiking/spec-examples/`.

- `eiger-trail.spec.json` — straightforward route with named waypoints only
- `kreuzberge.spec.json` — explicit waypoint coordinates for ambiguous OSM names

Required spec keys:

- `slug`, `name`, `region`, `canton`, `grade`, `elev`
- `peak.{name?,lat,lon}`
- `trailhead.{name,lat,lon}`

All other top-level keys are merged directly into the generated `data.json`.
That means agents can fill only the sections they already know (for example
`index_card`, `hero`, `intro_html`, `photos`, `trip_reports`) and leave the
rest as template TODOs.

### Image sourcing — reliable process

**POLICY: No generic images allowed.**

Every hike must have a **specific, distinctive photo** of that peak or route.
Generic Alpine or Swiss mountain photos are not acceptable — they undermine the quality and uniqueness of each hike entry.

**If you cannot find a specific image, leave the hero field as a TODO placeholder** rather than using a generic substitute.

**Critical:** Image URLs fail silently. Always validate before committing.

#### Reliable image sources (tested order)

**1. Hikr.org — PREFERRED for reliability & bot-friendliness (PROVEN STABLE)**

Hikr is the **primary recommended source** for Swiss hiking images. It is:
- **Bot-friendly:** robots.txt explicitly allows crawling (search=yes, only ai-train=no)
- **Rate-limit friendly:** No aggressive throttling or 429 errors
- **Stable URLs:** Photo IDs use consistent CDN pattern `f.hikr.org/files/<id>`
- **High quality:** Authentic user trip reports with galleries of 20+ photos per hike
- **CC-licensed:** Photos are user-uploaded, typically CC-BY or site TOS allows use

**Step-by-step Hikr sourcing:**

1. Go to: `https://www.hikr.org/dir/` (Geo portal)
2. Search for peak or hike name (e.g., "Gornergrat", "Eiger", "Säntis")
3. Click the **main peak/hike link** → opens `/dir/<PeakName>_<ID>/`
4. Click **Gallery** link → `/dir/<PeakName>_<ID>/gallery/`
5. Browse photos; identify 4–5 best shots (summit view, route, glaciers, panorama)
6. Right-click photo → inspect **href** attribute of the link
   - Format: `/dir/<PeakName>_<ID>/gallery/photo<PHOTOID>.html`
   - Extract the numeric **PHOTOID**

**URL construction:**
- **Thumbnail (display in gallery):** `https://f.hikr.org/files/<PHOTOID>l.jpg` (large preview, sharp)
- **Lightbox (full-resolution click):** `https://f.hikr.org/files/<PHOTOID>.jpg` (original, highest quality)

**Example (Gornergrat):**
```json
{
  "url": "https://f.hikr.org/files/3831865l.jpg",
  "lightbox_url": "https://f.hikr.org/files/3831865.jpg",
  "alt": "Matterhorn and glaciers from Gornergrat",
  "caption_html": "<p>Photo via hikr.org</p>"
}
```

**Advantages over alternatives:**
- No 429 rate-limiting (unlike Wikimedia Commons)
- No bot-blocking (unlike Wikimedia Commons)
- Authentic hike photos (not generic stock)
- Consistent URL structure across all photos
- Direct CDN access (no session cookies needed)
- Volume: Most popular peaks have 50–200 photos available

**2. Wikimedia Commons — Manual browsing (LEGACY, use for hero images)**
- Go to: `https://commons.wikimedia.org/`
- Search for peak name or hike name (e.g., "Eiger", "Gornergrat", "Hardergrat")
- Filter: **File type** → **Images** → Look for landscape photos ≥1280px wide
- Right-click image → **Open image in new tab** → copy full URL
- **Verify in browser (not with `curl`)** — Wikimedia blocks automated requests with 403
- Use format: `https://commons.wikimedia.org/wiki/Special:FilePath/<Filename>?width=1600`
- **Caveat:** Subject to 429 rate-limiting and bot-blocking; validate before committing

**3. Direct browsing (Hikr trip reports as secondary fallback)**
- When Hikr gallery doesn't have enough photos
- Visit individual trip reports on: `https://www.hikr.org/tour/` (search results)
- Photos embedded in reports may have working URLs
- Extract photo IDs and construct f.hikr.org URLs as above

**3. Google Images + CC License filter**
- Go to: `https://google.com/images`
- Search: `"<peak-name>" Switzerland hiking` or `<peak-name> <canton>`
- Click **Tools** (bottom-left) → **Usage rights** → **Creative Commons licenses**
- Click image → **View Image** → copy URL
- **Verify license in image details** (must be CC-BY, CC-BY-SA, or public domain)
- Test URL before using

**4. Tourism board sites (authority, official license)**
- **Regional tourism:** `<region>.ch` (e.g., `verbier.ch`, `zermatt.ch`)
- **Official bodies:** `swisstopo.admin.ch`, `jungfrau.swiss`
- Usually have free-to-use licensing for non-commercial
- Look for **Gallery** or **Media** sections
- Copy image URLs and validate

**5. ~~Pexels / Unsplash~~ — DO NOT USE**
- Generic Alpine images are explicitly prohibited
- If you cannot source a specific hike photo, **leave hero as TODO placeholder** instead

#### Validation checklist (MUST pass all)

Before saving a URL to `data.json`:

```bash
# 1. Test accessibility (HTTP 200)
# NOTE: Wikimedia Commons returns HTTP 403 to automated HEAD requests (bot detection).
# This is expected behavior. Browser GET requests work fine. Use the automated
# validator below which skips Wikimedia URLs. For manual testing:
curl -I "https://example.com/image.jpg"
# Expected: "HTTP/2 200" or "HTTP/1.1 200 OK"
# For Wikimedia URLs, skip automated testing and verify in a browser instead.

# 2. Check dimensions (inspect in browser or with `identify`)
# Required: ≥ 1280px wide for hero image, ≥ 600px for thumbnails

# 3. Verify attribution
# Document artist/photographer name and license (CC-BY, CC-BY-SA, public domain, or site TOS)

# 4. Visual check
# Open URL in browser to confirm:
#   - Landscape orientation (wider than tall, ideally)
#   - Shows distinctive feature of peak/hike (not generic)
#   - No watermarks or paywalls
#   - No obvious low quality/noise
```

#### Automated validation (`validate_images.py`)

Run this to check all image URLs for broken links across all hikes:

```bash
cd /opt/code/website

# Check all hikes
~/venvs/dev/bin/python skills/hiking/scripts/validate_images.py

# Check single hike
~/venvs/dev/bin/python skills/hiking/scripts/validate_images.py --slug <slug>

# Auto-fix convertible wiki-page URLs (converts to Special:FilePath format)
~/venvs/dev/bin/python skills/hiking/scripts/validate_images.py --fix
```

**How it works:**
- Skips Wikimedia URLs (they block bots with 403, but work fine in browsers)
- Reports actual 404s and network errors from other CDNs
- Returns exit code 0 if all images are valid
- Safe to run in CI without false positives

**Important:** Wikimedia URLs are assumed valid automatically. If you need to verify a
Wikimedia image before committing, open the URL in a web browser (not `curl`).

#### Store in spec as:

```json
"photos": [{
     "url": "https://VALIDATED.url/image.jpg",
     "lightbox_url": "https://VALIDATED.url/image-hires.jpg",
     "alt": "Short description of image content",
     "caption_html": "<p>Photo credit & context.</p>"
   }],
   "hero": {
     "image_url": "https://VALIDATED.url/hero-image.jpg",
     "subtitle_html": "Photo © Attribution Name"
   }
   ```

4. **Common gotchas:**
   - Wikimedia thumbnail URLs often 404 if filename or format is wrong; **always test**
   - Google Images links may be direct or may require referrer headers
   - Hikr photos often need session cookies (use web browser to verify first)
   - Check image dimensions: hero images should be landscape (1600+ width); thumbnails 600+ width

`route_build` controls GPX generation:

- `via` and `descend_via` may contain either strings or objects with
  `{ "name", "lat", "lon" }`
- `end_name` / `end_ll` are optional
- `bbox` is optional when `peak.lat/lon` and `trailhead.lat/lon` are present

`--slug` implicitly skips the index regen. Use `--no-index` to skip explicitly on full runs.
The summary table prints per-hike stage timings and GPX stats for sanity-checking.

## data.json — full schema

| Field | Required | Notes |
|-------|----------|-------|
| `slug` | recommended | Inferred from filename if omitted |
| `page` | yes | `{ title, generated, reports_updated, year? }` (ISO dates) |
| `peak` | yes | `{ name, elev, lat, lon }` |
| `trailhead` | yes | `{ name, lat, lon, transit_dest }` |
| `hero` | yes | `{ image_url, subtitle_html, grade }` — `grade` highlights the SAC table row |
| `intro_html` | optional | Free HTML block under the hero |
| `quick_facts` | yes | List of `[label, value_html]` pairs |
| `photos` | yes | List of `{ url, alt, caption_html, lightbox_url? }` |
| `waypoints` | yes | `{ lat, lon, label, kind }` — kind ∈ `start`/`summit`/`way` |
| `routes_subtitle` | optional | Suffix after the Routes heading |
| `routes` | yes | `{ title_html, grade, grade_label?, pill_class?, bullets_html }` |
| `getting_there` | yes | `{ by_car_html, by_pt_html, by_pt_heading? }` |
| `day_plans` | yes | `{ title?, subheading?, rows: [[time, step], …], footer_html? }` |
| `weather` | yes | `{ lapse_rate: { valley_ref, summit_above_ref_m, temp_drop_c, example_html }, sources_html: [...], season_html }` |
| `webcams` | yes | `{ url, label, fallback }` — fallback=true renders a Meteoblue link card |
| `elev_chart_attrib_html` | optional | Footnote under elevation chart |
| `trip_reports` | yes | `{ hikr_index_url, takeaways_html: [...], reports: [{ url, title, season, grade, grade_label?, pill_class?, bullets_html }] }` |
| `gear` | yes | `{ title, items_html }` |
| `safety_html` | yes | List of bullet HTML strings |
| `resources_html` | yes | List of bullet HTML strings (typically `<a>` tags) |
| `disclaimer_html` | yes | Closing-section HTML |
| `index_card` | yes | Fields for the auto-generated hikes index page (see below) |

### index_card fields

The index page (`hikes/index.html`) reads from each `data.json`:

| Source | Used for |
|--------|----------|
| `peak.name` | Hike name |
| `peak.elev` | Elevation |
| `peak.lat` / `peak.lon` | Open-Meteo weather lookup |
| `hero.grade` | Grade pill colour |
| `photos[0].url` | Thumbnail (auto-rewritten `width=600` → `width=400`) |
| `index_card.canton` | Map marker colour + filter button |

Required `index_card` keys: `region`, `canton`, `time`.
Optional: `distance`, `gain` (override GPX-derived), `pill_class` (e.g. `"t4"` for orange), `photo_url`.

All `*_html` fields render with `| safe` — escape untrusted content yourself.

### Auto-derivation

- `hero.auto_subtitle: true` → generates subtitle string from GPX (Naismith's rule for time).
- Empty `waypoints` list → parsed from `<slug>.gpx` `<wpt>` entries (matched by name to set `kind`).

### Optional sections

- **SLF / avalanche banner** — fold into `intro_html` or `safety_html` for shoulder-season hikes.
- **Cable-car operating hours** — add as a row in a `day_plans` table.
- **Hut booking** — add to `resources_html`.

## Staleness warning

Pages render a freshness warning automatically once `page.reports_updated` is older than
6 months. Regenerate the trip-report digest each season.

## Gotchas

- **WIKIMEDIA COMMONS BLOCKS BOTS** — All Wikimedia URLs return HTTP 403 to automated
  HEAD requests (curl, requests.head(), etc.) but display fine in browsers (GET requests).
  This is intentional bot detection. Use the `validate_images.py` script which skips
  Wikimedia validation automatically. For manual verification of Wikimedia images, open
  the URL in a web browser, not on the command line.
- **FOTO-WEBCAM URL sizes**: use `/current/1200.jpg` or `/current/1920.jpg` — never `/current/1024.jpg` (404).
- **SRTM under-reads sharp summits** by ~50–100 m. Use catalog elevation (SAC/Wikipedia)
  for `peak.elev`; SRTM is fine for the elevation chart.
- **Hikr is behind Cloudflare** — direct fetches fail. Use a web search for snippets.

## `_config.js` (optional per-hike)

Each `hikes/<slug>/` folder may contain a `_config.js` with a referrer-restricted
Google Maps Embed API key and a default transit origin:

```js
window.HIKE_CONFIG = {
  gmaps_key: "YOUR_KEY",  // Maps Embed API; restrict to localhost:* + file:///*
  transit_origin: "Zurich HB",
};
```

Pages work without it — the embedded transit iframe disappears, but deep-link buttons remain.
