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

### Mapbox GL JS v3 Standard Satellite

- **What:** Drop-in alternative to MapLibre using Mapbox's proprietary fork. Their "Standard Satellite" style has 3D terrain + atmosphere built in with more polished defaults.
- **Why:** Slightly nicer-looking out of the box; familiar API (MapLibre was forked from it).
- **Cost:** Free up to 50k map loads/month, then paid. Requires Mapbox access token.
- **Why not yet:** Provides little advantage over MapLibre for our use case and adds a paid-tier risk above the free quota. Park unless we hit a specific MapLibre limitation.
- **Prototype:** [prototypes/3d-mapbox.html](prototypes/3d-mapbox.html) (needs a Mapbox access token pasted in).

---

## 3D command center

- **What:** A 3D-terrain version of [`command-center/`](../command-center/index.html) — the current Leaflet 2D view (hikes, cantons, cities, webcams, weather stations, SLF avy stations, season filter) rendered on tilted swisstopo terrain via MapLibre GL, same stack as [`prototypes/3d-trails.html`](prototypes/3d-trails.html).
- **Why:** Would give the map a "planning-from-above" feel — you can actually see which hikes sit on which ridges, why one canton's terrain differs from its neighbor, and where webcams point. The 3D peaks prototype already proves swisstopo raster + Terrarium DEM renders Swiss terrain well enough.
- **Cost:**
  - Setup: everything Leaflet-specific gets rewritten — marker clustering, layer toggles, first-click popup fix, `url-sync`, `side-panel` wiring. MapLibre has native `Marker`/`Popup`/`NavigationControl` equivalents but the wiring is different.
  - Perf: mobile GPU cost is meaningfully higher with hundreds of markers on tilted terrain. Label collision on 3D is much harder than on 2D — the peaks prototype gets away with it because it's ~50 labels for one route.
  - Money: none (MapLibre + swisstopo + Terrarium DEM are all free).
- **Why not yet:** Full port is a lot of surface area for a "nice to have". A hybrid path is probably better: keep 2D as default, add a "3D view" pill that swaps to a MapLibre canvas with a reduced marker set (hikes + summits only, no webcams/stations). Ship that first, see if anyone uses it.

---

## Mobile / offline (PWA finish work)

The site already has a working service worker (`service-worker.js`), a `manifest.webmanifest`, and shell caching that's version-pinned by `make render`. The remaining work is what turns "installable static site" into "usable hiking app that works without signal." See [`docs/design/offline.md`](design/offline.md) §8 for the phased plan the entries below map to.

### SwissTopo tile caching

- **What:** Turn on the runtime-cache pattern for SwissTopo WMTS tiles in `service-worker.js`. The URL matcher is already commented out — flipping it on gives you cache-on-visit for whatever tiles the user pans over.
- **Why:** Right now the SW caches HTML/JS/CSS/data but not tiles, so opening a hike page offline shows a blank Leaflet grid. Cache-on-visit is the smallest change that fixes this for the "I looked at this hike yesterday" case.
- **Cost:** ~30 lines in the SW. Storage: unbounded unless we add an LRU cap (a few hundred tiles per hike bbox × zooms 10–15 ≈ 20–50 MB, which is fine but should have a ceiling).
- **Why not yet:** Needs a tile-budget decision (LRU size, per-origin cap) and a way for users to see cache size. Also blocked on deciding whether to ship this together with the "Save for offline" button below or as a smaller first PR.

### "Save for offline" button (per hike)

- **What:** Add a button to each hike page that pre-warms the SW cache for that hike: SwissTopo tiles across the track's bounding box (± ~5 km buffer) at zooms 10–15, plus the GPX, weather snapshot, and photos. Show a progress bar during warm-up and a "Saved (48 MB) [Remove]" chip after.
- **Why:** Cache-on-visit alone is passive — users have to remember to pan around while still in coverage. An explicit button matches how people actually plan ("I'm hiking Zindlenspitz Saturday, save it Friday night"). Turns hike pages into genuine trail-ready references.
- **Cost:** Bounding-box → tile-URL enumeration (~50 lines), progress UI, storage estimate. Typical hike is 20–50 MB. Needs a matching "Remove offline copy" flow (see below).
- **Why not yet:** Only makes sense after tile caching is on in the SW. Also want to decide: does the "Save" button also freeze the weather cache for that hike, or always network-first even in saved mode?

### Cache-size + eviction UI

- **What:** A small panel (probably on a guide page or in the manifest install prompt) listing saved hikes with their storage cost and a Remove button. Also a "clear all cached tiles" nuke.
- **Why:** Without this, users have no visibility into how much of their phone the site is eating, and no way to reclaim it short of clearing browser data.
- **Cost:** ~100 lines. Reads from `caches.keys()` + `estimate()`, filters by hike slug key.
- **Why not yet:** Needs both of the above shipped first — nothing to display until there are saved hikes.

### Install prompt / homescreen UX

- **What:** On mobile Chrome, listen for `beforeinstallprompt` and surface a dismissible "Install Hikes app" banner. On iOS Safari (which doesn't fire that event), show a static "Install: tap Share → Add to Home Screen" hint on first mobile visit.
- **Why:** The manifest is already correct, so installation works — but discovery is zero unless the browser decides to prompt on its own. iOS never does. A one-time hint doubles install rate on other PWAs.
- **Cost:** ~50 lines JS + a small dismissible banner component. Persist dismissal in localStorage.
- **Why not yet:** Nice-to-have, not blocking. Do this last, once the offline story actually justifies "install this app."

### Mobile UX polish

- **What:** Pass over the site with a phone. Concretely: (a) Command Center filter bar → bottom sheet on narrow screens (currently wraps and eats vertical space), (b) tap targets bumped to ≥44 px on filter pills / day buttons / marker popups, (c) consider a bottom nav bar (Hikes · Command Center · Guides) replacing the top nav on phone widths, (d) hike-page elevation chart + stats table pass — last audited desktop-first.
- **Why:** Everything renders on mobile today but wasn't designed for it. The unification refactor is a good moment to also revisit widths/tap targets since the shared engine drives both filter bars.
- **Cost:** CSS-heavy, incremental. A day of focused work + real-device testing.
- **Why not yet:** Should happen *after* the CC↔index engine unification lands — otherwise you polish the same bar twice.

### Native wrapper (Capacitor)

- **What:** Wrap the PWA in [Capacitor](https://capacitorjs.com) for App Store + Play Store distribution.
- **Why:** Discoverability via app stores, native install experience, potential future access to background GPS.
- **Cost:** Ongoing: developer account fees (Apple $99/yr, Google one-time $25), build pipeline, App Store review each release. One-time: ~1 day to wire up.
- **Why not yet:** Nothing in the app currently justifies leaving the PWA — no background GPS, no push, no in-app purchase. Revisit if the site actually gets used enough that store presence matters.

---

## How to use this doc

- Skim before starting a new feature — chances are it's been thought about.
- When closing a todo (shipped or rejected), record **what you decided and why** before deleting it.
- If you're considering something not listed here, add it — even half-formed ones. Future-you will thank present-you.
