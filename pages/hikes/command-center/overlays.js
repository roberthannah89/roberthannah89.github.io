/* Map overlays — prototype layer factories for the command-center.

   Each overlay exposes  window.Overlays.<name>.create()  →  Promise<L.Layer>
   so command-center.js can lazy-instantiate it. For Slope/Transit/
   DrinkingWater/Parking/SnowGlaciers that happens the first time the user
   flips the toggle on (same pattern as WebcamLayer). Avalanche is the one
   exception: it's a safety-relevant hazard layer, so command-center.js
   auto-creates it at boot with no toggle (bootAvalancheLayer()) — the factory
   shape is identical, only the caller's timing differs.

   The factories return Leaflet layers (tile, layerGroup, geoJSON…) — never
   add to/remove from the map themselves; that's the caller's job.

   Layer sources:
   - Slope ≥30°        : WMTS tile from geo.admin.ch (ch.swisstopo.hangneigung-ueber_30)
   - Avalanche         : SLF bulletin (winter-only, via SlfLayer) + BAFU statutory
                         hazard zones WMS (ch.bafu.gefaehrdungskarte-lawinen).
                         Always-on, no toggle — SLF renders nothing May–Oct.
   - Transit stops     : WMS tile from geo.admin.ch (ch.bav.haltestellen-oev)
   - Drinking water    : Overpass API (OSM amenity=drinking_water)
   - Parking           : Overpass API (OSM amenity=parking, fee=no preferred)
   - Snow & glaciers   : WMS tile from geo.admin.ch
                         (ch.swisstopo.geologie-gletscherausdehnung).
                         Year-round permanent snow/ice extent (GLAMOS). The
                         per-peak ❄ badge driven by WeatherService gives the
                         day-aware snow-line signal.

   Pages open via file://, so this file uses plain IIFE + window globals (no
   ES modules) and Overpass calls go through XMLHttpRequest with a fixed
   timeout. Results are cached in localStorage per-day where it makes sense. */
(function () {
  'use strict';

  /* ── Shared utilities ──────────────────────────────── */

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function lsGet(key) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { /* quota / private mode — silently skip */ }
  }

  // Lazy-load the static OSM fallback (sample-data/osm-fallback.js). Used
  // only when Overpass is rate-limiting us; otherwise the file never loads.
  var fallbackPromise = null;
  function loadFallback() {
    if (window.OVERLAYS_OSM_FALLBACK) return Promise.resolve(window.OVERLAYS_OSM_FALLBACK);
    if (fallbackPromise) return fallbackPromise;
    fallbackPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'sample-data/osm-fallback.js';
      s.onload = function () { resolve(window.OVERLAYS_OSM_FALLBACK || { drinking_water: [], parking: [] }); };
      s.onerror = function () { reject(new Error('Failed to load osm-fallback.js')); };
      document.head.appendChild(s);
    });
    return fallbackPromise;
  }

  // Run a POST to Overpass via XHR (fetch is unreliable on file://). Returns
  // a Promise<object> resolving to the parsed JSON, or rejecting on error.
  function overpassQuery(query) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://overpass-api.de/api/interpreter', true);
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.timeout = 25000;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(new Error('Overpass: invalid JSON')); }
        } else {
          reject(new Error('Overpass HTTP ' + xhr.status));
        }
      };
      xhr.onerror = function () { reject(new Error('Overpass network error')); };
      xhr.ontimeout = function () { reject(new Error('Overpass timed out')); };
      xhr.send('data=' + encodeURIComponent(query));
    });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── 1. Slope ≥30° (avalanche-critical terrain) ────── */
  // SwissTopo classified slope-angle WMTS overlay. ≥30° is the standard
  // avalanche-critical threshold; SLF's three-by-three rules (Werner Munter)
  // build directly on it. Loads as transparent WMS-style tiles — Leaflet
  // streams them like any other tile layer, no CORS prep needed.
  var Slope = {
    create: function () {
      var layer = L.tileLayer(
        'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.hangneigung-ueber_30/default/current/3857/{z}/{x}/{y}.png',
        {
          maxZoom: 17,
          opacity: 0.55,
          attribution: '&copy; swisstopo (Hangneigung)'
        }
      );
      return Promise.resolve(layer);
    }
  };

  /* ── 2. Avalanche (SLF bulletin + statutory hazard zones) ── */
  // Always on, no toggle: the daily SLF bulletin (winter-only — empty
  // regions array May–Oct, so renders nothing) and the permanent BAFU
  // statutory hazard map (year-round). Both speak to the same safety
  // question ("is this terrain avalanche-exposed?") so they're one layer
  // group. In summer that's effectively just the statutory zones, which is
  // the right default for off-season planning.
  var Avalanche = {
    create: function () {
      var zones = L.tileLayer.wms('https://wms.geo.admin.ch/', {
        layers: 'ch.bafu.gefaehrdungskarte-lawinen',
        format: 'image/png',
        transparent: true,
        opacity: 0.5,
        version: '1.3.0',
        crs: L.CRS.EPSG3857,
        attribution: '&copy; BAFU (Lawinen-Gefährdungskarte)'
      });
      // SlfLayer.create() lazy-loads slf-cache.js via a dynamic <script> tag
      // and resolves to a Leaflet layer (empty in summer when the cache has
      // 0 regions). Wrap both in a layerGroup so the registry treats this
      // as a single overlay.
      var slfP = (window.SlfLayer && window.SlfLayer.create()) || Promise.resolve(L.layerGroup());
      return Promise.resolve(slfP).then(function (slfLayer) {
        return L.layerGroup([zones, slfLayer]);
      });
    }
  };

  /* ── 3. Public transport stops (SBB / PostBus / mountain lifts) ──── */
  // Federal Office of Transport's stop inventory. Renders as a tile overlay
  // so it scales to thousands of stops without per-marker DOM cost. At
  // command-center zoom (~9–12) it's mostly the major rail/PostBus nodes
  // visible — exactly the "can I get to this trailhead by transit?" signal
  // we want.
  var Transit = {
    create: function () {
      var layer = L.tileLayer.wms('https://wms.geo.admin.ch/', {
        layers: 'ch.bav.haltestellen-oev',
        format: 'image/png',
        transparent: true,
        opacity: 0.85,
        version: '1.3.0',
        crs: L.CRS.EPSG3857,
        attribution: '&copy; BAV (öV-Haltestellen)'
      });
      return Promise.resolve(layer);
    }
  };

  /* ── 4. Drinking water (OSM fountains / taps) ─────── */
  // Overpass query over the Swiss bbox: every node tagged amenity=drinking_water.
  // Cached in localStorage per-day so panning the map after the first load
  // is instant and we stay well inside the Overpass 10k req/day budget.
  // The Swiss bbox is approximate but covers all hike-relevant terrain.
  var DrinkingWater = (function () {
    var SWISS_BBOX = '45.7,5.8,47.9,10.6'; // south,west,north,east
    // Bump the cache key when the query/limit changes so stale localStorage
    // entries don't poison the next run.
    var CACHE_KEY = 'overlays:drinking_water:v2:' + todayKey();
    // Cap at a hiker-relevant subset: there are ~28k drinking-water nodes
    // in Switzerland and we don't need a fountain in every village square.
    // Overpass returns ascending OSM-id, which is roughly random across the
    // country, so slicing the first N is a fine spatial sample for a prototype.
    var FETCH_LIMIT = 2000;

    function fetchOnce() {
      var cached = lsGet(CACHE_KEY);
      if (cached) return Promise.resolve(cached);
      // Push the limit server-side so we don't transfer 28k payload-heavy
      // elements just to drop most of them client-side.
      var query = '[out:json][timeout:25];'
        + 'node["amenity"="drinking_water"](' + SWISS_BBOX + ');'
        + 'out body ' + FETCH_LIMIT + ';';
      return overpassQuery(query).then(function (json) {
        var elems = (json.elements || []).map(function (e) {
          return { lat: e.lat, lon: e.lon, name: (e.tags && e.tags.name) || '' };
        });
        lsSet(CACHE_KEY, elems);
        return elems;
      }).catch(function (err) {
        console.warn('DrinkingWater: Overpass failed (' + err.message + '), using sample fallback.');
        return loadFallback().then(function (f) { return f.drinking_water || []; });
      });
    }

    function popupHtml(p) {
      return '<div class="ovl-popup"><div class="ovl-popup__title">💧 Drinking water</div>'
        + (p.name ? '<div class="ovl-popup__sub">' + esc(p.name) + '</div>' : '')
        + '<div class="ovl-popup__hint">OSM amenity=drinking_water</div></div>';
    }

    function create() {
      return fetchOnce().then(function (points) {
        // OSM has tens of thousands of drinking-water nodes in Switzerland —
        // way too many to render as individual markers. Wrap them in the
        // markercluster plugin (already loaded by index.html for the route
        // markers) so they collapse to counts at low zooms and only expand
        // when the user zooms in to a specific valley.
        var group = L.markerClusterGroup({
          maxClusterRadius: 60,
          disableClusteringAtZoom: 14,
          showCoverageOnHover: false,
          chunkedLoading: true,
          iconCreateFunction: function (c) {
            return L.divIcon({
              html: '<div class="ovl-cluster ovl-cluster--water">💧<span>' + c.getChildCount() + '</span></div>',
              className: 'marker-cluster',
              iconSize: L.point(36, 22)
            });
          }
        });
        var icon = L.divIcon({
          className: '',
          html: '<div class="ovl-marker ovl-marker--water">💧</div>',
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        });
        points.forEach(function (p) {
          if (typeof p.lat !== 'number' || typeof p.lon !== 'number') return;
          var m = L.marker([p.lat, p.lon], { icon: icon, title: p.name || 'Drinking water' });
          m.bindPopup(popupHtml(p), { maxWidth: 220 });
          group.addLayer(m);
        });
        return group;
      }).catch(function (err) {
        console.warn('Drinking-water overlay failed:', err);
        return L.layerGroup();  // empty layer, toggle still works
      });
    }

    return { create: create };
  })();

  /* ── 5. Parking (OSM trailhead lots) ──────────────── */
  // Same Overpass + per-day cache pattern as DrinkingWater. Filtered down
  // to ways tagged amenity=parking with access≠private and a non-trivial
  // capacity — we only want lots, not every roadside layby.
  var Parking = (function () {
    var SWISS_BBOX = '45.7,5.8,47.9,10.6';
    var CACHE_KEY = 'overlays:parking:v2:' + todayKey();
    var FETCH_LIMIT = 2000;

    function fetchOnce() {
      var cached = lsGet(CACHE_KEY);
      if (cached) return Promise.resolve(cached);
      // Stick to nodes for cheap rendering — Overpass returns way centers
      // via "out center" if we expand to ways later. For now nodes only
      // (still ~hundreds of trailhead/mountain parkings nationwide).
      var query = '[out:json][timeout:25];'
        + 'node["amenity"="parking"]["access"!~"^(private|no)$"](' + SWISS_BBOX + ');'
        + 'out body ' + FETCH_LIMIT + ';';
      return overpassQuery(query).then(function (json) {
        var elems = (json.elements || []).map(function (e) {
          return {
            lat: e.lat,
            lon: e.lon,
            name: (e.tags && e.tags.name) || '',
            fee: e.tags && e.tags.fee || ''
          };
        });
        lsSet(CACHE_KEY, elems);
        return elems;
      }).catch(function (err) {
        console.warn('Parking: Overpass failed (' + err.message + '), using sample fallback.');
        return loadFallback().then(function (f) { return f.parking || []; });
      });
    }

    function popupHtml(p) {
      var feeLine = p.fee ? '<div class="ovl-popup__sub">Fee: ' + esc(p.fee) + '</div>' : '';
      return '<div class="ovl-popup"><div class="ovl-popup__title">🅿️ Parking</div>'
        + (p.name ? '<div class="ovl-popup__sub">' + esc(p.name) + '</div>' : '')
        + feeLine
        + '<div class="ovl-popup__hint">OSM amenity=parking</div></div>';
    }

    function create() {
      return fetchOnce().then(function (points) {
        // Same clustering rationale as DrinkingWater — thousands of parking
        // nodes nationwide need collapsing or the overview tanks.
        var group = L.markerClusterGroup({
          maxClusterRadius: 60,
          disableClusteringAtZoom: 14,
          showCoverageOnHover: false,
          chunkedLoading: true,
          iconCreateFunction: function (c) {
            return L.divIcon({
              html: '<div class="ovl-cluster ovl-cluster--parking">P<span>' + c.getChildCount() + '</span></div>',
              className: 'marker-cluster',
              iconSize: L.point(36, 22)
            });
          }
        });
        var icon = L.divIcon({
          className: '',
          html: '<div class="ovl-marker ovl-marker--parking">P</div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9]
        });
        points.forEach(function (p) {
          if (typeof p.lat !== 'number' || typeof p.lon !== 'number') return;
          var m = L.marker([p.lat, p.lon], { icon: icon, title: p.name || 'Parking' });
          m.bindPopup(popupHtml(p), { maxWidth: 220 });
          group.addLayer(m);
        });
        return group;
      }).catch(function (err) {
        console.warn('Parking overlay failed:', err);
        return L.layerGroup();
      });
    }

    return { create: create };
  })();

  /* ── 6a. Trail closures & reroutes (ASTRA / SchweizMobil) ────
     Live daily feed from the Federal Roads Office and Swiss Hiking
     Federation of what's closed / detoured on the national hiking network.
     No CI refresh needed — the WMS server publishes each day's state and
     Leaflet fetches the current tile on demand. */
  var TrailClosures = {
    create: function () {
      var layer = L.tileLayer.wms('https://wms.geo.admin.ch/', {
        layers: 'ch.astra.wanderland-sperrungen_umleitungen',
        format: 'image/png',
        transparent: true,
        opacity: 0.9,
        version: '1.3.0',
        crs: L.CRS.EPSG3857,
        attribution: '&copy; ASTRA / <a href="https://schweizmobil.ch/en/closures-detours" target="_blank" rel="noopener">SchweizMobil</a>'
      });
      return Promise.resolve(layer);
    }
  };

  /* ── 6b. Forest fire danger (BAFU) ────────────────────
     BAFU-produced fire-danger index (1–5). Live WMS; the tiles reflect
     whatever cantonal fire-ban level applies today. Especially load-bearing
     Jun–Aug when heat + wind push several cantons to level 4/5. */
  var FireRisk = {
    create: function () {
      var layer = L.tileLayer.wms('https://wms.geo.admin.ch/', {
        layers: 'ch.bafu.gefahren-waldbrand_warnung',
        format: 'image/png',
        transparent: true,
        opacity: 0.55,
        version: '1.3.0',
        crs: L.CRS.EPSG3857,
        attribution: '&copy; BAFU (Waldbrandgefahr)'
      });
      return Promise.resolve(layer);
    }
  };

  /* ── 6c. Wildlife rest zones (BAFU) ───────────────────
     Statutory + recommended Wildruhezonen. Some are seasonally binding
     (winter only), some year-round; the WMS returns whichever apply on
     the map date, so the layer reads the same in July and February —
     what you see is what's currently in force. */
  var WildlifeZones = {
    create: function () {
      var layer = L.tileLayer.wms('https://wms.geo.admin.ch/', {
        layers: 'ch.bafu.wrz-wildruhezonen_portal',
        format: 'image/png',
        transparent: true,
        opacity: 0.6,
        version: '1.3.0',
        crs: L.CRS.EPSG3857,
        attribution: '&copy; BAFU (Wildruhezonen)'
      });
      return Promise.resolve(layer);
    }
  };

  /* ── 6d. Rockfall trajectory hazard (BAFU SilvaProtect-CH) ────
     General hazard index of potential rockfall + rock-avalanche
     trajectories. Statutory static map, not a live-event feed — the tile
     changes when BAFU re-publishes SilvaProtect (~ every few years). */
  var RockfallHazard = {
    create: function () {
      var layer = L.tileLayer.wms('https://wms.geo.admin.ch/', {
        layers: 'ch.bafu.silvaprotect-sturz',
        format: 'image/png',
        transparent: true,
        opacity: 0.55,
        version: '1.3.0',
        crs: L.CRS.EPSG3857,
        attribution: '&copy; BAFU (SilvaProtect-CH)'
      });
      return Promise.resolve(layer);
    }
  };

  /* ── 7. Snow & glaciers (permanent snow extent) ──── */
  // swisstopo's glacier-extent inventory (GLAMOS). Year-round visualisation
  // of where there's permanent snow/ice — accurate in summer, conservative
  // in winter (everything outside the glaciers can also accumulate snow,
  // but the daily per-peak ❄ badge — driven by WeatherService.freezingLevel
  // — already covers that signal). Replaced the prototype's snow-line
  // ribbon, which was invisible in summer and confusing in winter.
  var SnowGlaciers = {
    create: function () {
      var layer = L.tileLayer.wms('https://wms.geo.admin.ch/', {
        layers: 'ch.swisstopo.geologie-gletscherausdehnung',
        format: 'image/png',
        transparent: true,
        opacity: 0.7,
        version: '1.3.0',
        crs: L.CRS.EPSG3857,
        attribution: '&copy; swisstopo (Gletscherausdehnung / GLAMOS)'
      });
      return Promise.resolve(layer);
    }
  };

  /* ── Export ──────────────────────────────────────── */

  window.Overlays = {
    Slope: Slope,
    Avalanche: Avalanche,
    Transit: Transit,
    DrinkingWater: DrinkingWater,
    Parking: Parking,
    SnowGlaciers: SnowGlaciers,
    TrailClosures: TrailClosures,
    FireRisk: FireRisk,
    WildlifeZones: WildlifeZones,
    RockfallHazard: RockfallHazard
  };
})();
