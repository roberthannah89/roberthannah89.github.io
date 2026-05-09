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
- **hikr.org** — Cloudflare 403. Use web search for snippets instead.
- **SAC Route Portal GPX** — requires SAC member login.
- **Komoot / Wikiloc / AllTrails GPX** — login required for export.
- **Google search** — blocks JS-less fetches. Use `https://html.duckduckgo.com/html/?q=...`

## Webcam sources

- **foto-webcam.eu** — primary source. URL: `/webcam/<id>/current/1200.jpg`
  Coverage is patchy outside high-traffic alpine areas.
- **Meteoblue webcam page** — use as fallback card when foto-webcam has no nearby camera.
