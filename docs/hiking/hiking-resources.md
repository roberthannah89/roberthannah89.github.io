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

## Image sourcing — resolution requirements & quality standards

> [!IMPORTANT]
> **Minimum resolutions enforced:**
> - **Hero images** (index gallery): ≥1600px wide
> - **Lightbox images** (click-through): ≥2000px wide  
> - **Quality over quantity:** 4 sharp images > 10 blurry ones. If no images meet threshold, leave empty (placeholder hero applies)

> [!TIP]
> **Automatic validation:** Run `~/venvs/dev/bin/python scripts/validate_images.py` before committing to catch:
> - HTTP 404 errors (broken links)
> - Genuine image problems (not bot-blocking)
> - Use this to verify your selections

---

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

1. Open `https://www.hikr.org/dir/` (Geo portal) in web browser
2. Search for peak or route name
3. Click the main result → opens peak detail page
4. Scroll down to **Gallery** section → click **Gallery** link
   - Direct URL: `https://www.hikr.org/dir/<Peak>_<ID>/gallery/`
5. **Visual selection** (manual, browser-based - NOT scripted):
   - Prefer wide panoramas, clear weather, sharp focus
   - Reject: blurry, rain/fog, extreme close-ups of irrelevant objects
   - Select 4–5 best photos (aim for variety: summit, route, landmarks, wildlife)
6. **Extract photo IDs:**
   - Hover over photo → note URL in address bar changes to `/photo<PHOTOID>.html`
   - OR: Right-click → **Inspect Element** → find `photo<PHOTOID>`
   - Extract the **numeric PHOTOID**
7. **Construct URLs** (once you have ID, e.g., 3831865):
   - Display/thumbnail: `https://f.hikr.org/files/3831865l.jpg` (use for hero)
   - Full-resolution: `https://f.hikr.org/files/3831865.jpg` (use for lightbox)

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

### Quality checklist before committing

- [ ] **Resolution check:**
  - Hero image ≥1600px wide? (Inspect in browser: right-click → Inspect → check `<img>` dimensions)
  - Each photo ≥2000px wide? (Same check)
  - Reject if below threshold
- [ ] **Visual quality:**
  - 4+ high-quality, distinct images? (variety > quantity)
  - Clear weather & good lighting? (avoid rain/fog/night)
  - Sharp focus? (zoom in on browser to verify)
- [ ] **Variety:**
  - Summit/peak view ✓
  - Route/trail shot ✓
  - Landscape/context ✓
  - (Optional: wildlife, hut, wildflowers)
- [ ] **Attribution:**
  - Each photo has `caption_html` with source link?
  - Example: `<p>Photo via <a href="https://www.hikr.org/">hikr.org</a></p>`

### Validation (automated + manual)

**Before committing:**

1. **Browser verification** (quick manual check):
   ```
   - Open each URL in new browser tab
   - Verify image displays (not 404)
   - Check width in DevTools (Inspector > img element)
   ```

2. **Automated validation** (catches issues):
   ```bash
   cd /opt/code/website
   ~/venvs/dev/bin/python scripts/validate_images.py --slug <slug>
   ```
   Output:
   - ✅ = Image found + accessible
   - ❌ = Real 404 / broken link → fix before commit
   - ⚠️  = Wikimedia URL (bot-blocked) → validate manually in browser instead

3. **Important distinction:**
   - **Hikr URLs:** Fully automated validation works (`validate_images.py` catches errors)
   - **Wikimedia URLs:** Must manually verify in browser (bots get 403 bot-blocking)
   - **Wikipedia URLs:** Works like Wikimedia (test in browser first)

### Troubleshooting image sourcing

**Q: Hikr gallery returns 403 (bot-blocking)**
- A: This is Cloudflare blocking automated access. Use **browser** instead of script. The blocking is temporary; try again later if critical.
- Prevention: Browse galleries manually, extract IDs by hand, don't automate the search.

**Q: Image URL shows 404 after extraction**
- A: Photo may have been deleted from Hikr. Go back to gallery, select a different photo.
- Check: Does the gallery still exist? If gallery is gone, try a different source (Wikimedia, Wikipedia, or use placeholder).

**Q: Wikimedia Commons link fails validation**
- A: Normal. Wikimedia returns 403 to bots. **Test the URL in your web browser instead.**
- Validation script automatically skips Wikimedia (marks as ⚠️ not ❌)
- If it works in browser but fails in script, that's expected and fine.

**Q: Found a photo but it's <2000px**
- A: Reject it. **Quality over quantity.** Better 4 sharp images than 10 blurry ones.
- If no high-res images available: Leave `photos: []` empty, hike gets placeholder hero.

**Q: I found photos but no good hero shot**
- A: Set `hero.image_url: "TODO"` and the render script auto-populates from `photos[0]`.
- The first photo becomes the hero. **Order your photos array with best shot first.**

**Q: How do I know if an image is actually 2000px+?**
- A:
  ```
  Browser method (easiest):
  1. Open URL in browser
  2. Right-click → Inspect Element
  3. Find <img> tag
  4. Note width in DevTools or HTML (should show 2000+ px)
  
  Command-line (if you know Python):
  python3 -c "from PIL import Image; import requests; r = requests.get('https://...', stream=True); img = Image.open(r.raw); print(img.size)"
  ```

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
~/venvs/dev/bin/python scripts/validate_images.py
```

## Webcam sources

- **foto-webcam.eu** — primary source. URL: `/webcam/<id>/current/1200.jpg`
  Coverage is patchy outside high-traffic alpine areas.
- **Meteoblue webcam page** — use as fallback card when foto-webcam has no nearby camera.
