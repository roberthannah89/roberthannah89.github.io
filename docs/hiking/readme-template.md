# Hike README — Deliverable Template

When asked to write a README/plan for a specific hike, use this structure.

## Structure

1. **Title + hero photo** (Wikimedia Commons hot-link, recipe below)
2. **Quick Facts table** — elevation, range, cantons, coordinates (WGS84 *and* CH1903/LV95),
   SAC grade, nearest village, valley
3. **Photo grid** (2x2) of the peak from different angles
4. **Topographic Route Map** — generated PNG (see [topo-map-recipe.md](./topo-map-recipe.md)),
   not ASCII
5. **Routes** — every documented variant from SAC with grade and source
6. **Getting There** — by car and by SBB/PostBus (link sbb.ch)
7. **Suggested Day Plan** — timetable for a fit hiker
8. **Weather Planning** — apply 6.5 °C/1000 m lapse rate from a named valley reference
   station; link MeteoSwiss + Meteoblue webcam
9. **Gear Checklist** — split into mandatory / recommended / route-specific
10. **Safety & Hazards** — exposure, rock condition, livestock, reception, Rega 1414
11. **Resources & Links** — SAC route page, archive docs, nearby hut, hikr.org, Wikipedia,
    MeteoSwiss, Meteoblue, SBB, Rega
12. **Disclaimer** — always re-check sources day-of

Save the README under `hikes/<peak-slug>.md` and the map alongside as
`hikes/<peak-slug>_map.png`.

## Wikimedia Commons photo hot-link

Once you find a file name on Commons (e.g. `Zindlenspitz01.jpg`), embed it via:

```
https://commons.wikimedia.org/wiki/Special:FilePath/<File%20Name>.jpg?width=900
```

`Special:FilePath` always serves the latest revision and supports a `?width=` parameter
for thumbnails. URL-encode spaces as `%20`.
