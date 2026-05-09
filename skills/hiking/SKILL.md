---
name: hiking
description: 'Use when the user asks about hiking in Switzerland or the Swiss Alps — picking a route or peak, SAC trail difficulty (T1-T6), alpine huts, GPX/Komoot/SwissTopo planning, generating a topo map with a route overlay, checking mountain weather (MeteoSwiss/Meteoblue), or producing a hike README. Also produces a rich interactive Hike Plan HTML page with embedded transit, weather, trip reports, elevation profile, and webcams. Summer hiking only — not winter, ski touring, or technical mountaineering.'
---

# Hiking in the Swiss Alps

A practical planning guide for summer day hikes and hut-to-hut trips in the
Swiss Alps, using authoritative Swiss sources first.

## Canonical instruction files

All workflow details, schema, and script references are maintained in
`.github/instructions/` inside the website repo. These files are **auto-loaded**
in every conversation when working in `/opt/code/website`. When working outside
that workspace, load them with `read_file`:

| File | Content |
|------|---------|
| `hike-workflow.instructions.md` | data.json schema, script commands, render workflow |
| `hike-resources.instructions.md` | SAC grades, Swiss sources, tool notes, webcam sources |
| `hike-gpx.instructions.md` | OSM routing, SwissTopo WMTS tiles, elevation API |

Absolute paths: `/opt/code/website/.github/instructions/<filename>`

For the alternative Markdown README deliverable, see [readme-template.md](./readme-template.md).

## Safety Disclaimer (state to user when relevant)

- This skill is an informal introduction, not professional mountain-safety advice.
- Conditions change rapidly; even easy routes can become dangerous due to weather,
  snowmelt, or exposure.
- Always check official sources before setting out: **MeteoSwiss**, **SAC Route Portal**,
  and local tourism offices.
- New to alpine hiking or unsure about a route? Consider hiring a qualified guide.
- This guide is **summer hiking only**. Winter hiking, ski touring, and avalanche
  terrain require different knowledge and are out of scope.

## When to Use

- User wants to plan a hike in Switzerland / the Swiss Alps.
- User asks about a specific peak, route, hut, or region.
- User asks how to read SAC trail difficulty (T1-T6).
- User wants help interpreting MeteoSwiss / Meteoblue forecasts for a hike.
- User wants help building or evaluating a Komoot / GPX route.

## SAC Mountain & Alpine Hiking Scale

| Grade | Name | Notes |
|-------|------|-------|
| T1 | Hiking | Easy; well-marked paths. |
| T2 | Mountain hiking | Some basic terrain awareness. |
| T3 | Demanding mountain hiking | Exposure possible; sure-footedness needed. |
| T4 | Alpine hiking | Stressful; **not for beginners**. |
| T5 | Demanding alpine hiking | Exposure, scrambling, route-finding. |
| T6 | Difficult alpine hiking | Near-mountaineering; serious experience required. |

Rule of thumb: **T4 is where hikes become stressful and unsuitable for beginners.**
SAC time estimates are reasonably accurate for a fit hiker.

## Planning Procedure

Use this sequence when a user wants to plan a specific hike.

1. **Select region and objective.** Start in SAC Route Portal or Wanderland.
2. **Shortlist 2-3 routes.** Collect distance, elevation gain, SAC grade, route time,
   and escape options.
3. **Filter by ability.** Default to T1-T3 unless user explicitly has alpine
   experience. Treat T4+ as serious.
4. **Review route details.** Check waypoints, technical sections, condition warnings,
   closures, and protected-area restrictions.
5. **Plan logistics.** Validate access with SBB/PostBus and, if needed, cable-car hours.
6. **Build navigation stack.** Keep official route in SAC/SwissTopo; optionally create
   a Komoot variant; export GPX; download offline maps.
7. **Weather pass (48-24h).** Check MeteoSwiss forecast + hazards map + precipitation
   radar; estimate summit temperature using lapse-rate rule.
8. **Ground-truth pass (morning of hike).** Check Meteoblue webcams and latest radar.
9. **Set turnaround rules.** Time-based turnaround and storm cutoff.
10. **Final go/no-go.** If thunderstorm risk, poor visibility, or strong wind on exposed
    terrain, downgrade objective or cancel.

## Practical Weather Checklist

Use this when user asks "is this safe today?"

- Check MeteoSwiss local forecast for nearest valley and update time.
- Check MeteoSwiss hazards map for severe-weather alerts.
- Check radar for incoming afternoon convection.
- Estimate summit temperature: valley temp minus about **6.5 C per 1000 m** gain.
- Cross-check webcams near objective for cloud base and lingering snow.
- If route reaches snow terrain in shoulder season, check SLF WhiteRisk.
- If any of these are unfavorable, propose a lower and shorter alternative.

## Logistics Checklist (hut-to-hut or remote trailheads)

- Confirm hut opening dates and booking status in SAC.
- Save hut contact numbers for day-of confirmation.
- Validate first/last SBB and PostBus connections.
- Check cable-car seasonal operation days.
- Download offline maps and GPX before leaving cell coverage.

## Image Sourcing Checklist (for agents adding hikes)

When adding a hike to the website, always source and **validate** images before committing.
**Automated API approaches fail** (403 blocking from Wikimedia/Wikipedia). Use manual browsing instead.

### Reliable sources (tested order)

**1. Wikimedia Commons — Manual browsing (most reliable)**
- Go to: `https://commons.wikimedia.org/`
- Search for peak name or hike name
- Filter for **Images** ≥1280px wide, landscape orientation
- Right-click → **Open image in new tab** → copy full URL
- **Validate with `curl -I "<URL>"` — must return HTTP 200 OK**

**2. Hikr.org — Direct browsing (authentic user photos)**
- Search: `https://hikr.org/` for peak/route name
- Open trip reports → galleries
- Right-click photo → check URL
- Most photos are CC-licensed by users
- **Test URL with `curl -I` before using**

**3. Google Images + CC License filter**
- Search: `"<peak-name>" Switzerland` or `<peak-name> <canton>`
- Click **Tools** → **Usage rights** → **Creative Commons licenses**
- **Verify license** (CC-BY, CC-BY-SA, or public domain required)
- Test URL with `curl -I` before using

**4. Tourism board sites**
- **Regional:** `<region>.ch` (e.g., `verbier.ch`, `zermatt.ch`)
- **Official:** `swisstopo.admin.ch`, `jungfrau.swiss`
- Look for Media / Gallery sections
- Usually free-to-use for non-commercial

**5. Pexels / Unsplash (generic Alpine fallback)**
- Go to: `https://unsplash.com/` or `https://pexels.com/`
- Search: `Switzerland`, `Alps`, or peak name
- All are CC0 (free); use only as placeholder

### Validation (MUST pass all)

```bash
# 1. Test accessibility
curl -I "https://example.com/image.jpg"
# Expected: HTTP 200 OK (not 404/403)

# 2. Check dimensions
# Hero: ≥ 1280px wide
# Thumbnails: ≥ 600px wide

# 3. Visual check (open in browser)
# - Landscape (wider than tall)
# - Shows distinctive peak/hike feature (not generic)
# - No watermarks or paywalls
```

### Store in spec or data.json:

```json
"hero": {
  "image_url": "https://TESTED-URL/image.jpg",
  "subtitle_html": "Photo © Artist Name"
},
"photos": [{
  "url": "https://TESTED-URL/image.jpg",
  "lightbox_url": "https://TESTED-URL/image-hires.jpg",
  "alt": "View of Peak Name",
  "caption_html": "<p>Caption with credit.</p>"
}]
```

### If no valid image found

- Leave hero as `"TODO: Wikimedia Commons URL"` (renders placeholder)
- Document search attempts in code comment
- Do **not** use broken links or guessed URLs

## Language and Scope Notes

- Many SAC pages are multilingual (DE/FR/IT/EN), but route details may still be
  best in German/French. Offer concise translation when helpful.
- Keep responses in **summer hiking scope**. If sustained snow, glacier travel,
  ski touring, or technical mountaineering is involved, explicitly state this is
  out of scope and recommend a qualified guide.

## Output Style

When helping a user plan:

- Lead with the **safety disclaimer** if the user is new to alpine hiking.
- Give concrete numbers: distance, elevation gain, SAC grade, expected times,
  estimated summit temperature.
- Always recommend **MeteoSwiss + Meteoblue webcam** checks.
- Recommend downloading **offline maps (SwissTopo/SAC/Komoot)** and a **GPX** file.
- Flag T4+ routes explicitly as not for beginners.
- Do not invent route specifics; if unknown, point the user to the SAC Route
  Portal entry for that peak.

## Lookup Gotchas (learned)

- **Peak names have spelling variants.** Always check several: e.g.
  *Zindlenspitz* (SAC), *Zindelspitz*, *Zindelnspitz*. Search Wikipedia (DE),
  hikr.org, and SAC slugs in parallel.
- **SAC URL slugs use an internal numeric ID, not elevation.** A URL like
  `.../zindlenspitz-2260/...` does not mean the peak is 2260 m — always
  confirm elevation from the page body, Wikipedia, or SwissTopo.
- **The SAC Route Portal map is a JS app**: free-text search, region filters,
  and grade filters cannot be queried by simple page fetch. Reach individual
  routes by direct slug URL: `/en/huts-and-tours/sac-route-portal/<slug>-<id>/<activity>/`
  where activity ∈ {`mountain-hiking`, `alpine-hiking`, `ski-tour`,
  `snowshoe-tour`, `alpine-climbing`}.
- **Bypass Google when researching** — use DuckDuckGo HTML
  (`https://html.duckduckgo.com/html/?q=...`) which renders without JS.
- **hikr.org returns 403 to most fetchers.** Cite the URL but expect to read
  it manually; German trip reports there are often the best route info.
