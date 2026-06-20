# TODOs

Centralized list of features and improvements we've considered but haven't shipped.
Each entry should answer: **what**, **why we'd want it**, **what it'd cost** (setup, money, complexity, performance), and **why we haven't done it yet**.

Add new todos at the top of the relevant section. When one ships, move it to the changelog / delete it.

---

## 3D maps — higher-fidelity alternatives

Background: every hike page links to a per-hike 3D view powered by [MapLibre GL JS](prototypes/3d-maplibre.html) (swisstopo SWISSIMAGE + AWS Terrarium DEM, no API key). It works well and is free forever, but the terrain DEM is medium-resolution. If we want sharper alpine detail or photorealistic visuals later, here are the upgrade paths.

### CesiumJS + Cesium World Terrain

- **What:** Swap MapLibre for [CesiumJS](https://cesium.com/platform/cesiumjs/) with [Cesium World Terrain](https://cesium.com/platform/cesium-ion/content/cesium-world-terrain/) (quantized-mesh DEM, much sharper alpine ridges).
- **Why:** Visibly better terrain detail. Curved-earth rendering looks more natural at wide views. Same FATMAP-style feel.
- **Cost:**
  - Setup: 60-sec signup at [ion.cesium.com](https://ion.cesium.com) for a free access token; swap one library + rewrite the map init.
  - Money: free tier 5 GB/month bandwidth (~5k hike views), then ~$0.50/GB.
  - Mobile: ~3 MB JS bundle (vs ~1 MB MapLibre), more WebGL load. Works on modern phones but older iOS Safari can struggle on large scenes.
- **Why not yet:** MapLibre is good enough for v1 and has zero billing risk. Revisit if visual feedback says "terrain looks blurry" or if we want a marquee 3D experience.
- **Prototype:** [prototypes/3d-cesium.html](prototypes/3d-cesium.html) (needs an Ion token pasted into the script before it renders).

### CesiumJS + Google Photorealistic 3D Tiles

- **What:** CesiumJS again, but using [Google's Photorealistic 3D Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles-overview) as the terrain + imagery source — actual photogrammetric 3D mesh with buildings, vegetation, textures. This is the closest you can get to FATMAP/Google Earth quality in a browser.
- **Why:** Genuine "wow" factor. Coverage in Switzerland is dense (cities + Alps).
- **Cost:**
  - Setup: Google Maps Platform API key with Map Tiles API enabled, billing card on file, plus a Cesium Ion token.
  - Money: first 10k tile loads/month free, then **$5 per 1k loads** — easy to exceed if the page goes viral. Hard ceiling not free.
  - Mobile: heaviest option (real 3D meshes). Fine on flagship phones, may stutter on older ones.
- **Why not yet:** Billing-card-shaped risk. Worth doing once we're confident on traffic patterns or as a paywalled "premium" experience.
- **Reference demo:** [Cesium Sandcastle — Google Photorealistic 3D Tiles](https://sandcastle.cesium.com/?src=Google%20Photorealistic%203D%20Tiles.html).

### Mapbox GL JS v3 Standard Satellite

- **What:** Drop-in alternative to MapLibre using Mapbox's proprietary fork. Their "Standard Satellite" style has 3D terrain + atmosphere built in with more polished defaults.
- **Why:** Slightly nicer-looking out of the box; familiar API (MapLibre was forked from it).
- **Cost:** Free up to 50k map loads/month, then paid. Requires Mapbox access token.
- **Why not yet:** Provides little advantage over MapLibre for our use case and adds a paid-tier risk above the free quota. Park unless we hit a specific MapLibre limitation.
- **Prototype:** [prototypes/3d-mapbox.html](prototypes/3d-mapbox.html) (needs a Mapbox access token pasted in).

---

## How to use this doc

- Skim before starting a new feature — chances are it's been thought about.
- When closing a todo (shipped or rejected), record **what you decided and why** before deleting it.
- If you're considering something not listed here, add it — even half-formed ones. Future-you will thank present-you.
