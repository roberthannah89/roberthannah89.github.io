# TODO

## SAC Extraction Overhaul

- [ ] Generalize `extract_sac_gpx.py` → `extract_sac.py` that pulls everything from the route JSON in one pass: GPX track, waypoints, photos, route metadata (difficulty, times, descriptions, departure/destination info)
- [ ] Rename `docs/workflows/GPX-EXTRACTION.md` → `SAC-EXTRACTION.md` to reflect broader scope
- [ ] Auto-populate `data.json` photos array from SAC JSON (11 photos available for Zindlenspitz with public CDN URLs, captions, copyright, multiple thumbnail sizes)
- [ ] Consider also scraping peak page photos — peak pages may have different/additional images vs route pages

## Zindlenspitz

- [ ] Populate photos from SAC JSON (photo URLs are public: `static.www.suissealpine.sac-cas.ch`)
- [ ] Fill remaining TODOs: webcams, trip reports (hikr.org), hero image
- [ ] Verify page renders correctly in browser with photos and fullscreen map
