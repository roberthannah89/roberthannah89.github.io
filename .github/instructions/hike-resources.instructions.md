---
applyTo: "**"
---

# Swiss hiking — authoritative resources & tools

## Authoritative Swiss sources

- **SAC Route Portal** — routes, huts, warnings: https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/
- **SAC Interactive Map** (SwissTopo-based): https://map.sac-cas.ch/
- **SwissTopo map viewer**: https://map.geo.admin.ch/
- **MeteoSwiss** (official weather): https://www.meteoswiss.admin.ch/
- **Switzerland Mobility / Wanderland**: https://www.wanderland.ch/en/

## Planning tools

- **Komoot** (route building + GPX): https://www.komoot.com/
- **Outdooractive**: https://www.outdooractive.com/
- **Meteoblue** (hourly forecast + webcams): https://www.meteoblue.com/

## Transport

- **SBB timetable**: https://www.sbb.ch/en
- **PostBus mountain routes**: https://www.postauto.ch/en

## Hazard pages (important in shoulder season)

- MeteoSwiss hazards map: https://www.meteoswiss.admin.ch/services-and-publications/applications/hazards.html
- SLF WhiteRisk avalanche conditions: https://whiterisk.ch/en/conditions
- Federal natural hazards portal: https://www.natural-hazards.ch/home.html?tab=actualdanger
- MeteoSwiss snow map: https://www.meteoswiss.admin.ch/services-and-publications/applications/snow.html

## SAC map legend

- Red trails → T1–T3 (mountain hiking)
- Blue trails → T4–T6 (alpine hiking)
- Red house icons → alpine huts
- Green peaks → hiking peaks; blue = ski-tour; purple = alpine; multicolor = multiple options

## SAC T-grade scale

| Grade | Name | Notes |
|-------|------|-------|
| T1 | Hiking | Easy; well-marked paths |
| T2 | Mountain hiking | Basic terrain awareness |
| T3 | Demanding mountain hiking | Exposure possible; sure-footedness required |
| T4 | Alpine hiking | Hands sometimes needed; route-finding skill required |
| T5 | Demanding alpine hiking | Exposed scrambling; excellent fitness + experience |
| T6 | Difficult alpine hiking | Near-technical; guidebook or guide recommended |

## Sources that don't work for scripted fetching

- **Wikimedia Commons** — Returns HTTP 403 to automated HEAD requests (bot detection).
  Images work fine in browsers. Browse manually and verify URLs in a web browser.
  The `validate_images.py` script skips Wikimedia validation automatically.
  **Caveat:** Also subject to 429 rate-limiting during batch operations.

- **hikr.org search** — Cloudflare may block. Instead, once you've found a peak,
  navigate directly to `/dir/<PeakName>_<ID>/gallery/` to access photo galleries.
  URLs in format `https://f.hikr.org/files/<PHOTOID>.jpg` are stable and accessible.

- **SAC Route Portal GPX** — requires SAC member login.

- **Komoot / Wikiloc / AllTrails GPX** — login required for export.

- **Google search** — blocks JS-less fetches. Use `https://html.duckduckgo.com/html/?q=...`

## Image sourcing workflow — detailed guide

### Primary source: Hikr.org galleries

Hikr galleries are the **most reliable** source for Swiss hiking photos:

**Why Hikr?**
- **Large volume:** Popular peaks have 50+ photos from user trip reports
- **Authentic:** User-uploaded images, not stock photos
- **Stable:** CDN URLs with consistent format: `https://f.hikr.org/files/<ID>l.jpg` (thumbnail), `https://f.hikr.org/files/<ID>.jpg` (full)
- **No rate-limiting:** Unlike Wikimedia (which enforces 429 throttling)
- **No bot-blocking:** robots.txt explicitly allows bots (except ai-train)
- **CC-licensed:** User content under site TOS; suitable for website use with attribution

**Step-by-step:**

1. Open `https://www.hikr.org/dir/` (Geo portal)
2. Search for peak or route name
3. Click the main result → opens peak detail page
4. Scroll down to **Gallery** section → click **Gallery** link (or navigate to `/dir/<Peak>_<ID>/gallery/`)
5. Browse thumbnail gallery; identify 4–5 best photos
6. Right-click any photo → **Inspect** or **Inspect Element**
7. Look for `<a href="/dir/<Peak>_<ID>/gallery/photo<PHOTOID>.html">` 
8. Extract numeric **PHOTOID**
9. Construct URLs:
   - Thumbnail: `https://f.hikr.org/files/<PHOTOID>l.jpg`
   - Full-res: `https://f.hikr.org/files/<PHOTOID>.jpg`

**Example gallery link from browser:**
```
https://www.hikr.org/dir/Gornergrat_2872/gallery/
```

**Photos in this gallery:** photo3831865, photo3831864, photo2806308, photo2806307, etc.

**Resulting URLs:**
```
https://f.hikr.org/files/3831865l.jpg    (thumbnail)
https://f.hikr.org/files/3831865.jpg     (full-resolution)
```

### Secondary source: Wikimedia Commons (legacy, hero images)

Use Wikimedia for **hero images** when Hikr lacks good summit shots:

1. Go to `https://commons.wikimedia.org/`
2. Search peak name + "Switzerland" or peak name + canton
3. Filter results: **File type** → **Images** only
4. Click image → copy URL from address bar
5. Format: `https://commons.wikimedia.org/wiki/Special:FilePath/<Filename>`
6. Add width parameter: `?width=1600` for consistent sizing

**Caveat:** Wikimedia aggressively throttles bots:
- Multiple requests trigger HTTP 429 ("Too many requests")
- Automated validation skips Wikimedia URLs
- Always verify in a web browser before committing
- Batch operations may fail; use Hikr as primary

### Validation

**Before committing:**

```bash
# Hikr URLs (always valid):
curl -I "https://f.hikr.org/files/3831865.jpg"
# Expected: HTTP 200

# Wikimedia URLs (bot-proof in browser, skip automation):
# Manually verify in web browser only. validate_images.py skips these automatically.
```

**Automated validation (skips Wikimedia, catches real 404s):**
```bash
cd /opt/code/website
~/venvs/dev/bin/python skills/hiking/scripts/validate_images.py
```

## Webcam sources

- **foto-webcam.eu** — primary source. URL: `/webcam/<id>/current/1200.jpg`
  Coverage is patchy outside high-traffic alpine areas.
- **Meteoblue webcam page** — use as fallback card when foto-webcam has no nearby camera.
