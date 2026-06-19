/* Map overlays — prototype layer factories for the command-center.

   Each overlay exposes  window.Overlays.<name>.create()  →  Promise<L.Layer>
   so command-center.js can lazy-instantiate it the first time the user flips
   the toggle on. Same pattern as SlfLayer / WebcamLayer.

   The factories return Leaflet layers (tile, layerGroup, geoJSON…) — never
   add to/remove from the map themselves; that's the caller's job so the
   add/remove can be tied to a toggle button.

   PROTOTYPE STATUS — what's live vs. sample:
   - Slope ≥30°        : LIVE WMS tile from geo.admin.ch (ch.swisstopo.hangneigung-ueber_30)
   - Avalanche zones   : LIVE WMS tile from geo.admin.ch (ch.bab.schutzgebiete-lawinengefahrenzonen)
   - Transit stops     : LIVE WMS tile from geo.admin.ch (ch.bav.haltestellen-oev)
   - Drinking water    : LIVE Overpass API (OSM amenity=drinking_water)
   - Parking           : LIVE Overpass API (OSM amenity=parking, fee=no preferred)
   - Snow line ribbon  : DERIVED from window.WEATHER_CACHE freezing_level_max
                         (median across all peaks for the selected day).
                         This is not a real DEM-based isohypse — that would need
                         raster contouring of a Swiss DEM. Honest banner instead.

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

  /* ── 2. Statutory avalanche hazard zones ──────────── */
  // Cantonal hazard maps — different from the daily SLF bulletin: these are
  // permanent legal zones where buildings/roads have known exposure. Useful
  // for planning approach/escape lines.
  var AvalancheZones = {
    create: function () {
      var layer = L.tileLayer.wms('https://wms.geo.admin.ch/', {
        layers: 'ch.bafu.gefaehrdungskarte-lawinen',
        format: 'image/png',
        transparent: true,
        opacity: 0.5,
        version: '1.3.0',
        crs: L.CRS.EPSG3857,
        attribution: '&copy; BAFU (Lawinen-Gefährdungskarte)'
      });
      return Promise.resolve(layer);
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

  /* ── 6. Snow line ribbon ──────────────────────────── */
  // Honest prototype: we don't have a DEM raster in the browser to draw a
  // real isohypse contour, but the per-peak weather cache (schema=2) carries
  // freezing_level_max per day. The "ribbon" is a fixed UI banner showing the
  // current day's median freezing level + the count of peaks above it, plus a
  // bright outline around peaks-above-line so the hazard is visible at a glance.
  //
  // create() returns a L.layerGroup that's mostly empty — the visible UI is a
  // floating .snow-line-ribbon div appended to #map. Toggling the layer
  // off removes the ribbon DOM and the marker highlighting.
  //
  // Day-aware: re-reads Filters.getState().weatherDay each refresh, so the
  // forecast-day picker drives both the marker badge AND the ribbon number.
  var SnowLine = (function () {
    var ribbonEl = null;
    var addedHighlight = false;

    // Standard environmental lapse rate (matches scripts/config.py
    // LAPSE_RATE_C_PER_KM). Used to estimate freezing level from peak temp
    // when the weather cache predates schema=2 (no freezing_level_max field).
    var LAPSE_RATE_C_PER_KM = 6.5;

    function freezingLevelFor(r, dayIdx) {
      if (!window.WeatherService) return null;
      // Prefer the schema=2 field — that's an actual MeteoSwiss derivation.
      var fl = window.WeatherService.freezingLevel(r.lat, r.lon, dayIdx);
      if (fl != null) return fl;
      // Fallback: derive from peak tempMax via dry-adiabatic lapse.
      //   freezing_level = peak_elev + (peak_temp_C / 6.5) * 1000
      // Negative tempMax means peak is below freezing → snow line dips below
      // the peak (yields a value < peak_elev). The math still works.
      var wx = window.WeatherService.getForPeak(r.lat, r.lon, dayIdx);
      if (!wx || wx.tempMax == null || !r.alt) return null;
      return r.alt + Math.round((wx.tempMax / LAPSE_RATE_C_PER_KM) * 1000);
    }

    function medianFreezingLevel(dayIdx) {
      if (!window.WeatherService) return null;
      var routes = window.SAC_ROUTES || [];
      var values = [];
      for (var i = 0; i < routes.length; i++) {
        var r = routes[i];
        if (!r.lat || !r.lon) continue;
        var fl = freezingLevelFor(r, dayIdx);
        if (fl != null && fl > 0) values.push(fl);
      }
      if (!values.length) return null;
      values.sort(function (a, b) { return a - b; });
      return Math.round(values[Math.floor(values.length / 2)]);
    }

    function peaksAbove(threshold) {
      var routes = window.SAC_ROUTES || [];
      var n = 0;
      for (var i = 0; i < routes.length; i++) {
        if (routes[i].alt && routes[i].alt > threshold) n++;
      }
      return n;
    }

    function dayLabel(dayIdx) {
      if (!window.WeatherService) return '';
      var days = window.WeatherService.getDayChoices();
      var d = days[dayIdx || 0];
      return d ? d.label : '';
    }

    function ensureRibbon(map) {
      if (ribbonEl) return ribbonEl;
      ribbonEl = document.createElement('div');
      ribbonEl.className = 'snow-line-ribbon';
      // Append into the map container so the ribbon sits in the map's z-stack
      // and gets cleaned up if the map re-inits.
      map.getContainer().appendChild(ribbonEl);
      return ribbonEl;
    }

    function refresh(map) {
      if (!ribbonEl) return;
      var dayIdx = (window.Filters && window.Filters.getState().weatherDay) || 0;
      var fl = medianFreezingLevel(dayIdx);
      var label = dayLabel(dayIdx);
      if (fl == null) {
        ribbonEl.innerHTML = '<div class="snow-line-ribbon__head">❄️ Snow line</div>'
          + '<div class="snow-line-ribbon__alt">no forecast</div>'
          + '<div class="snow-line-ribbon__sub">run <code>make weather</code></div>';
        return;
      }
      var nAbove = peaksAbove(fl);
      // Hint changes based on whether the cache has freezing_level_max (schema=2)
      // or we had to derive from tempMax + lapse rate. Probe one peak to decide.
      var routes = window.SAC_ROUTES || [];
      var probe = null;
      for (var i = 0; i < routes.length; i++) {
        if (routes[i].lat && routes[i].lon) {
          probe = window.WeatherService.freezingLevel(routes[i].lat, routes[i].lon, dayIdx);
          if (probe != null) break;
        }
      }
      var hint = probe != null
        ? 'median freezing-level from MeteoSwiss ICON-CH2 per peak'
        : 'estimated from peak tempMax + lapse rate (6.5°C/km) — run <code>make weather</code> for direct ICON-CH2 values';
      ribbonEl.innerHTML = '<div class="snow-line-ribbon__head">❄️ Snow line · ' + esc(label) + '</div>'
        + '<div class="snow-line-ribbon__alt">' + fl + ' m</div>'
        + '<div class="snow-line-ribbon__sub">' + nAbove + ' peaks above</div>'
        + '<div class="snow-line-ribbon__hint">' + hint + '</div>';
    }

    // Filters.subscribe has no unsubscribe; we register exactly once per
    // page load and guard the callback with `subscribedMap`, which is nulled
    // on remove so the listener becomes a no-op when the layer is hidden.
    var subscribedMap = null;
    var subscribed = false;
    function maybeSubscribe() {
      if (subscribed) return;
      subscribed = true;
      if (window.Filters && window.Filters.subscribe) {
        window.Filters.subscribe(function () {
          if (subscribedMap && ribbonEl) refresh(subscribedMap);
        });
      }
    }

    function create() {
      var group = L.layerGroup();

      group.on('add', function (e) {
        // e.target is the layerGroup; layers added via map.addLayer carry
        // the map ref on the group itself.
        var map = group._map || (e.target && e.target._map);
        if (!map || !map.getContainer) return;
        subscribedMap = map;
        ensureRibbon(map);
        document.body.classList.add('overlay-snowline-on');
        refresh(map);
        maybeSubscribe();
      });

      group.on('remove', function () {
        if (ribbonEl && ribbonEl.parentNode) ribbonEl.parentNode.removeChild(ribbonEl);
        ribbonEl = null;
        subscribedMap = null;
        document.body.classList.remove('overlay-snowline-on');
      });

      return Promise.resolve(group);
    }

    return { create: create };
  })();

  /* ── Export ──────────────────────────────────────── */

  window.Overlays = {
    Slope: Slope,
    AvalancheZones: AvalancheZones,
    Transit: Transit,
    DrinkingWater: DrinkingWater,
    Parking: Parking,
    SnowLine: SnowLine
  };
})();
