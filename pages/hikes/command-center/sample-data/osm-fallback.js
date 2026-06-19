/* Fallback sample for OSM-backed overlays when Overpass is rate-limited
   (HTTP 429) or unreachable.

   Tiny hand-picked subset of well-known Swiss trailheads / fountains so the
   prototype demo always shows *something* on the map. A live Overpass call
   (when allowed) returns ~2000 points each; this fallback is just enough to
   prove the rendering and toggle wiring work without a network round-trip.

   To regenerate at scale, run Overpass via the UI:
     https://overpass-turbo.eu/  with the same queries from overlays.js
   then export GeoJSON.

   Loaded ONLY when overlays.js falls back; otherwise stays at 0 KB cost. */
window.OVERLAYS_OSM_FALLBACK = {
  drinking_water: [
    { lat: 46.8167, lon: 9.8333, name: 'St. Moritz fountain' },
    { lat: 46.6230, lon: 8.0354, name: 'Grindelwald village' },
    { lat: 46.5197, lon: 6.6323, name: 'Lausanne Ouchy' },
    { lat: 46.0207, lon: 7.7491, name: 'Zermatt Bahnhofstrasse' },
    { lat: 46.5530, lon: 7.9847, name: 'Lauterbrunnen' },
    { lat: 46.6862, lon: 7.8632, name: 'Mürren village' },
    { lat: 46.4944, lon: 9.8419, name: 'Davos Platz' },
    { lat: 46.4900, lon: 8.5550, name: 'Andermatt Gotthardstrasse' },
    { lat: 47.0502, lon: 8.3093, name: 'Luzern Schwanenplatz' },
    { lat: 46.8782, lon: 9.6359, name: 'Klosters' },
    { lat: 46.6877, lon: 9.5510, name: 'Lenzerheide' },
    { lat: 46.3260, lon: 7.6280, name: 'Crans-Montana' }
  ],
  parking: [
    { lat: 46.5870, lon: 7.9089, name: 'Stechelberg Talstation', fee: 'yes' },
    { lat: 46.5550, lon: 7.9844, name: 'Lauterbrunnen Bahnhof', fee: 'yes' },
    { lat: 46.7833, lon: 9.0667, name: 'Flims Waldhaus', fee: 'no' },
    { lat: 46.4940, lon: 8.5660, name: 'Andermatt Gemsstock', fee: 'yes' },
    { lat: 46.6230, lon: 8.0490, name: 'Grindelwald Grund', fee: 'yes' },
    { lat: 46.6862, lon: 7.8980, name: 'Mürren Talstation Stechelberg', fee: 'yes' },
    { lat: 47.0830, lon: 9.0570, name: 'Sargans Pizolbahn', fee: 'yes' },
    { lat: 46.9120, lon: 9.0830, name: 'Vättis Tamina', fee: 'no' },
    { lat: 46.5760, lon: 9.5340, name: 'Splügen', fee: 'no' },
    { lat: 46.5160, lon: 9.8810, name: 'Tiefencastel', fee: 'no' },
    { lat: 47.1300, lon: 8.9710, name: 'Amden Niederschlag', fee: 'no' },
    { lat: 47.1410, lon: 9.1860, name: 'Weisstannen', fee: 'no' }
  ]
};
