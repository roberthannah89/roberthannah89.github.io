/* 3d-peaks — 3D renderer (MapLibre).
 *
 * SWISSIMAGE + Terrarium terrain, peaks colored by the MINIMUM SAC T-grade
 * needed to summit (from each POI's routes[]), huts as a distinct hut
 * marker, SAC T1–T6 trails overlay from Overpass (identical machinery to
 * 3d-trails.html — z11 tile cache + concurrency limiter + retry/failover).
 *
 * Wired through the same store/matcher/panel as the 2D renderer so a
 * filter change updates 3D visibility identically, and clicking a peak
 * calls panel.open(poi) — same code path.
 *
 * Exposes: window.CC3DPeaks.Renderer3D
 */
(function () {
  'use strict';

  // Trails overlay — copied verbatim from 3d-trails.js (same tuning).
  var OVERPASS_ENDPOINTS = [
    'https://overpass.osm.ch/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ];
  var CACHE_ZOOM = 11;
  var MIN_ZOOM_FOR_TRAILS = 12;
  var MAX_TILES_PER_FETCH = 15;
  var DEBOUNCE_MS = 400;
  var MAX_CONCURRENT = 2;
  var RETRY_DELAYS_MS = [1500, 4000];
  var CH_BBOX = { s: 45.75, w: 5.85, n: 47.85, e: 10.55 };

  var SAC_TRAIL_COLOR_EXPR = [
    'match', ['get', 'sac'],
    'hiking',                    '#F5C518',
    'mountain_hiking',           '#E4572E',
    'demanding_mountain_hiking', '#B02A1B',
    'alpine_hiking',             '#2E86DE',
    'demanding_alpine_hiking',   '#1B4F8C',
    'difficult_alpine_hiking',   '#7D3C98',
    '#888'
  ];

  // Peak coloring by MIN grade — reads pre-computed poi._minGrade (1..6 or
  // null) injected by the orchestrator via computeMinGrade().
  var PEAK_COLOR_EXPR = [
    'match', ['get', 'minGrade'],
    1, '#5cbf6a',   // T1 · Hiking
    2, '#5cbf6a',   // T2 · Mountain (Wanderland groups T1-T2 into the green)
    3, '#e8a832',   // T3 · Demanding mtn
    4, '#d97333',   // T4 · Alpine
    5, '#cc3333',   // T5 · Demanding alpine
    6, '#8844cc',   // T6 · Difficult alpine
    '#c8b892'       // fallback — no matched SAC route (warm tan, reads on dark satellite)
  ];

  window.CC3DPeaks = window.CC3DPeaks || {};

  window.CC3DPeaks.Renderer3D = function createRenderer3D(deps) {
    var store = deps.store;
    var matcher = deps.matcher;
    var panel = deps.panel;
    var toMatchable = deps.toMatchable;

    var map = null;
    var mapReady = false;
    var lastPois = [];
    var lastChPeaks = [];
    var chPeaksOn = true;
    var trailsOn = true;
    var visibleIds = null;      // set of poi identifiers that pass filters; null = show all

    function poiId(poi) { return poi.id || poi.name; }
    function isHut(poi) { return poi.type === 'hut'; }

    function poiToFeature(poi) {
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [poi.lon, poi.lat] },
        properties: {
          id: poiId(poi),
          name: poi.name,
          alt: typeof poi.alt === 'number' ? Math.round(poi.alt) : null,
          minGrade: (poi._minGrade == null) ? -1 : poi._minGrade,
          isHut: isHut(poi),
          hasPage: !!poi._hasPage
        }
      };
    }
    function buildPeakFC() {
      var use = lastPois.filter(function (poi) {
        if (!poi.lat || !poi.lon || isHut(poi)) return false;
        if (visibleIds && !visibleIds.has(poiId(poi))) return false;
        return true;
      });
      return { type: 'FeatureCollection', features: use.map(poiToFeature) };
    }
    function buildHutFC() {
      var use = lastPois.filter(function (poi) {
        if (!poi.lat || !poi.lon || !isHut(poi)) return false;
        if (visibleIds && !visibleIds.has(poiId(poi))) return false;
        return true;
      });
      return { type: 'FeatureCollection', features: use.map(poiToFeature) };
    }
    function buildChPeakFC() {
      if (!chPeaksOn) return { type: 'FeatureCollection', features: [] };
      return { type: 'FeatureCollection', features: lastChPeaks.map(poiToFeature) };
    }
    function refreshSources() {
      if (!map || !mapReady) return;
      var peakSrc = map.getSource('peaks');
      var hutSrc = map.getSource('huts');
      var chPeakSrc = map.getSource('ch-peaks');
      if (peakSrc) peakSrc.setData(buildPeakFC());
      if (hutSrc) hutSrc.setData(buildHutFC());
      if (chPeakSrc) chPeakSrc.setData(buildChPeakFC());
    }

    /* ── Trails overlay ─────────────────────────────────── */
    function lng2tile(lng, z) { return Math.floor(((lng + 180) / 360) * Math.pow(2, z)); }
    function lat2tile(lat, z) {
      var rad = lat * Math.PI / 180;
      return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z));
    }
    function tile2lng(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
    function tile2lat(y, z) {
      var n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
      return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }
    function tileBbox(x, y, z) {
      return [tile2lat(y + 1, z), tile2lng(x, z), tile2lat(y, z), tile2lng(x + 1, z)];
    }
    function clampToCH(b) {
      return {
        s: Math.max(b.getSouth(), CH_BBOX.s), w: Math.max(b.getWest(), CH_BBOX.w),
        n: Math.min(b.getNorth(), CH_BBOX.n), e: Math.min(b.getEast(), CH_BBOX.e)
      };
    }
    function tilesForBounds(bounds, z) {
      var c = clampToCH(bounds);
      if (c.n <= c.s || c.e <= c.w) return [];
      var x0 = lng2tile(c.w, z), x1 = lng2tile(c.e, z);
      var y0 = lat2tile(c.n, z), y1 = lat2tile(c.s, z);
      var tiles = [];
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) tiles.push({ x: x, y: y, z: z });
      return tiles;
    }

    var tileCache = new Map();
    var tileInflight = new Map();
    var fetchGen = 0;
    var running = 0, pending = [];
    function withSlot(runFn) {
      return new Promise(function (resolve, reject) {
        pending.push({ run: runFn, resolve: resolve, reject: reject }); drain();
      });
    }
    function drain() {
      while (running < MAX_CONCURRENT && pending.length > 0) {
        var job = pending.shift(); running++;
        Promise.resolve().then(job.run).then(
          function (v) { running--; drain(); job.resolve(v); },
          function (e) { running--; drain(); job.reject(e); }
        );
      }
    }
    function overpassPost(endpoint, query) {
      return fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      }).then(function (res) {
        if (!res.ok) { var err = new Error('Overpass ' + res.status); err.status = res.status; throw err; }
        return res.json();
      });
    }
    function overpassWithRetry(query) {
      var epIdx = 0, retry = 0;
      function tryOnce() {
        var endpoint = OVERPASS_ENDPOINTS[epIdx];
        return overpassPost(endpoint, query).catch(function (err) {
          var retryable = err.status === 429 || err.status === 406 || err.status === 504 || !err.status;
          if (!retryable) throw err;
          if (epIdx < OVERPASS_ENDPOINTS.length - 1) { epIdx++; return tryOnce(); }
          if (retry < RETRY_DELAYS_MS.length) {
            var delay = RETRY_DELAYS_MS[retry++]; epIdx = 0;
            return new Promise(function (r) { setTimeout(r, delay); }).then(tryOnce);
          }
          throw err;
        });
      }
      return tryOnce();
    }
    function overpassWayToFeature(way) {
      if (!way.geometry || way.geometry.length < 2) return null;
      return {
        type: 'Feature',
        properties: {
          sac: (way.tags && way.tags.sac_scale) || 'hiking',
          name: (way.tags && (way.tags.name || way.tags.ref)) || null,
          id: way.id
        },
        geometry: { type: 'LineString', coordinates: way.geometry.map(function (p) { return [p.lon, p.lat]; }) }
      };
    }
    function tileKey(t) { return t.z + '/' + t.x + '/' + t.y; }
    function fetchTile(t) {
      var key = tileKey(t);
      if (tileCache.has(key)) return Promise.resolve(tileCache.get(key));
      if (tileInflight.has(key)) return tileInflight.get(key);
      var b = tileBbox(t.x, t.y, t.z);
      var q = '[out:json][timeout:25];way["sac_scale"](' + b[0] + ',' + b[1] + ',' + b[2] + ',' + b[3] + ');out geom;';
      var p = withSlot(function () { return overpassWithRetry(q); })
        .then(function (data) {
          var feats = (data.elements || []).map(overpassWayToFeature).filter(function (f) { return !!f; });
          tileCache.set(key, feats);
          return feats;
        })
        .finally(function () { tileInflight.delete(key); });
      tileInflight.set(key, p);
      return p;
    }
    var debounceTimer = null;
    function scheduleTrails() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refreshTrails, DEBOUNCE_MS);
    }
    function refreshTrails() {
      if (!trailsOn || !map || !mapReady) return;
      var src = map.getSource('trails'); if (!src) return;
      var z = map.getZoom();
      var countEl = document.getElementById('trails-count');
      if (z < MIN_ZOOM_FOR_TRAILS) {
        src.setData({ type: 'FeatureCollection', features: [] });
        if (countEl) countEl.textContent = '—';
        return;
      }
      var tiles = tilesForBounds(map.getBounds(), CACHE_ZOOM);
      if (!tiles.length || tiles.length > MAX_TILES_PER_FETCH) return;
      var gen = ++fetchGen;
      var ring = document.getElementById('trails-ring');
      var uncached = tiles.filter(function (t) { return !tileCache.has(tileKey(t)); }).length;
      if (uncached > 0 && ring) ring.classList.remove('hidden');
      Promise.all(tiles.map(fetchTile))
        .then(function (arrs) {
          if (gen !== fetchGen) return;
          var features = arrs.reduce(function (acc, a) { return acc.concat(a); }, []);
          src.setData({ type: 'FeatureCollection', features: features });
          if (countEl) countEl.textContent = features.length.toLocaleString();
        })
        .catch(function (err) { console.error('[trails]', err); })
        .finally(function () { if (gen === fetchGen && ring) ring.classList.add('hidden'); });
    }

    /* ── Hike GPX track draping ─────────────────────────────────── */
    // .track.js files are simple `window.TRACK = [[lat, lng, ele], ...]`
    // globals. We load them via dynamic <script> tag rather than fetch()
    // so the prototype works under file:// too. Each new load overwrites
    // window.TRACK — we capture it into the source immediately then null
    // it out to avoid stale-read races on the next click.
    var trackLoadGen = 0;
    function trackUrlForHike(hike) {
      if (!hike || !hike.href) return null;
      // hike.href looks like "routes/augstmatthorn/augstmatthorn.html";
      // the sibling GPX-as-JS file is the same path with .track.js.
      var base = hike.href.replace(/\.html$/, '');
      return '../../' + base + '.track.js';
    }
    function showHikeTrack(hike) {
      if (!map || !mapReady) return;
      var url = trackUrlForHike(hike);
      if (!url) return;
      var gen = ++trackLoadGen;
      window.TRACK = null;
      var s = document.createElement('script');
      s.src = url + '?t=' + Date.now();   // cache-bust in case the last hike had a stale global
      s.onload = function () {
        if (gen !== trackLoadGen) return;   // superseded by a newer click
        var pts = window.TRACK;
        window.TRACK = null;
        if (!pts || !pts.length) return;
        var coords = pts.map(function (p) { return [p[1], p[0]]; });
        var src = map.getSource('hike-track');
        if (!src) return;
        src.setData({
          type: 'Feature', properties: {},
          geometry: { type: 'LineString', coordinates: coords }
        });
      };
      s.onerror = function () { /* silent — some hikes may not have .track.js */ };
      document.head.appendChild(s);
    }
    function clearHikeTrack() {
      if (!map || !mapReady) return;
      var src = map.getSource('hike-track');
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
      trackLoadGen++;
    }

    /* ── Summit tour ─────────────────────────────────── */
    var FLY_MS = 2200, ROTATE_MS = 25000, RETURN_MS = 2000;
    var TOUR_STATE = 'idle';
    var pendingFly = null, pendingReturn = null, rotateRaf = null;
    var rotateStartMs = 0, rotateStartBearing = 0, savedView = null;

    function currentSelection() {
      // Orchestrator sets window.CC3DPeaks._selected on selection.
      return window.CC3DPeaks._selected;
    }
    function beginTour() {
      if (TOUR_STATE !== 'idle' || !map) return;
      var target = currentSelection();
      if (!target) return;
      TOUR_STATE = 'flying';
      var btn = document.getElementById('tour-btn');
      if (btn) { btn.textContent = '⏹'; btn.classList.add('playing'); }
      savedView = {
        lng: map.getCenter().lng, lat: map.getCenter().lat,
        zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()
      };
      map.easeTo({ center: [target.lon, target.lat], zoom: 14.2, pitch: 68, bearing: 0, duration: FLY_MS });
      pendingFly = setTimeout(function () {
        pendingFly = null;
        if (TOUR_STATE !== 'flying') return;
        TOUR_STATE = 'rotating';
        rotateStartMs = performance.now();
        rotateStartBearing = map.getBearing();
        rotateRaf = requestAnimationFrame(rotateStep);
      }, FLY_MS);
    }
    function rotateStep(now) {
      if (TOUR_STATE !== 'rotating') return;
      var t = Math.min(1, (now - rotateStartMs) / ROTATE_MS);
      map.setBearing(rotateStartBearing + t * 360);
      if (t < 1) rotateRaf = requestAnimationFrame(rotateStep);
      else { rotateRaf = null; endTour(); }
    }
    function endTour() {
      if (TOUR_STATE === 'idle' || TOUR_STATE === 'returning') return;
      if (pendingFly) { clearTimeout(pendingFly); pendingFly = null; }
      if (rotateRaf) { cancelAnimationFrame(rotateRaf); rotateRaf = null; }
      TOUR_STATE = 'returning';
      map.easeTo({
        center: [savedView.lng, savedView.lat],
        zoom: savedView.zoom, pitch: savedView.pitch, bearing: savedView.bearing % 360,
        duration: RETURN_MS
      });
      pendingReturn = setTimeout(function () {
        pendingReturn = null;
        TOUR_STATE = 'idle';
        var btn = document.getElementById('tour-btn');
        if (btn) { btn.textContent = '🎥'; btn.classList.remove('playing'); }
      }, RETURN_MS);
    }

    /* ── Interface ─────────────────────────────────── */
    function init(container, viewport) {
      return new Promise(function (resolve) {
        var v = viewport || { lng: 8.2, lat: 46.8, zoom: 9, pitch: 62, bearing: 20 };
        map = new maplibregl.Map({
          container: container,
          style: {
            version: 8,
            glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
            sources: {
              swissimage: {
                type: 'raster',
                tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'],
                tileSize: 256, minzoom: 8, maxzoom: 19, attribution: '&copy; swisstopo'
              },
              terrarium: {
                type: 'raster-dem',
                tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
                tileSize: 256, maxzoom: 15, encoding: 'terrarium',
                attribution: 'Terrain: Mapzen / AWS Open Data'
              }
            },
            layers: [
              { id: 'bg', type: 'background', paint: { 'background-color': '#1a1810' } },
              { id: 'satellite', type: 'raster', source: 'swissimage' }
            ],
            terrain: { source: 'terrarium', exaggeration: 1.5 },
            sky: {
              'sky-color': '#3a3428', 'horizon-color': '#242118',
              'fog-color': '#242118', 'fog-ground-blend': 0.5
            }
          },
          center: [v.lng, v.lat], zoom: v.zoom || 9,
          pitch: typeof v.pitch === 'number' ? v.pitch : 62,
          bearing: typeof v.bearing === 'number' ? v.bearing : 20,
          maxPitch: 85, hash: false
        });
        map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

        map.on('load', function () {
          // Trails
          map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addLayer({
            id: 'trails-casing', type: 'line', source: 'trails',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': '#0a0a0a',
              'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 4.5, 17, 8],
              'line-opacity': 0.55
            }
          });
          map.addLayer({
            id: 'trails-line', type: 'line', source: 'trails',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': SAC_TRAIL_COLOR_EXPR,
              'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 14, 2.6, 17, 4.6],
              'line-opacity': 0.95
            }
          });

          // GPX track for the currently-clicked hike (drawn above the SAC
          // trails so it stands out). Empty until a peak with a matching
          // built page is clicked.
          map.addSource('hike-track', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addLayer({
            id: 'hike-track-casing', type: 'line', source: 'hike-track',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#0a0a0a', 'line-width': 6, 'line-opacity': 0.55 }
          });
          map.addLayer({
            id: 'hike-track-line', type: 'line', source: 'hike-track',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#e8a832', 'line-width': 3.2, 'line-opacity': 0.95 }
          });

          // Swiss border
          if (window.SWISS_BORDER) {
            map.addSource('swiss-border', { type: 'geojson', data: window.SWISS_BORDER });
            map.addLayer({
              id: 'swiss-border-line', type: 'line', source: 'swiss-border',
              paint: { 'line-color': '#8b4513', 'line-width': 1.4, 'line-opacity': 0.55 }
            });
          }

          // Peaks — colored by min SAC grade to summit
          map.addSource('peaks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addLayer({
            id: 'peaks-hit', type: 'circle', source: 'peaks',
            paint: { 'circle-radius': 12, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 0 }
          });
          map.addLayer({
            id: 'peaks-dot', type: 'circle', source: 'peaks',
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 13, 6.5],
              'circle-color': PEAK_COLOR_EXPR,
              'circle-stroke-color': '#f0e8d8',
              'circle-stroke-width': 1.6
            }
          });
          map.addLayer({
            id: 'peaks-label', type: 'symbol', source: 'peaks',
            layout: {
              // ★ prefix on peaks whose POI matches a built hike page in this
              // repo — same intent as CC's amber-ring "has-page" badge, just
              // rendered as a leading glyph so it survives at label-only zoom
              // levels where the dot is small.
              'text-field': ['concat',
                ['case', ['get', 'hasPage'], '★ ', ''],
                ['get', 'name'],
                ['case',
                  ['==', ['get', 'alt'], null], '',
                  ['concat', '  ', ['to-string', ['get', 'alt']], ' m']
                ]
              ],
              'text-font': ['Open Sans Regular'], 'text-size': 12,
              'text-anchor': 'bottom', 'text-offset': [0, -0.6],
              'text-allow-overlap': false, 'text-padding': 3,
              'text-optional': true,
              'symbol-sort-key': ['-', 5000, ['coalesce', ['get', 'alt'], 0]]
            },
            paint: {
              'text-color': PEAK_COLOR_EXPR,
              'text-halo-color': '#1a1810',
              'text-halo-width': 1.8, 'text-halo-blur': 0.4
            }
          });

          // Bare peaks (CH_PEAKS) — 7,512 named Swiss peaks, most of them
          // without a matched SAC route. Smaller and de-emphasized vs. the
          // SAC "peaks" layer so the actionable, route-having summits stay
          // prominent. Labels only above zoom 11 to keep the country view
          // legible with all peaks on.
          map.addSource('ch-peaks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addLayer({
            id: 'ch-peaks-hit', type: 'circle', source: 'ch-peaks',
            paint: { 'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 0 }
          });
          map.addLayer({
            id: 'ch-peaks-dot', type: 'circle', source: 'ch-peaks',
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 1.8, 13, 4],
              'circle-color': PEAK_COLOR_EXPR,
              'circle-stroke-color': '#1a1810',
              'circle-stroke-width': 0.8,
              'circle-opacity': 0.85
            }
          });
          map.addLayer({
            id: 'ch-peaks-label', type: 'symbol', source: 'ch-peaks',
            minzoom: 11,
            layout: {
              'text-field': ['case',
                ['==', ['get', 'alt'], null], ['get', 'name'],
                ['concat', ['get', 'name'], '  ', ['to-string', ['get', 'alt']], ' m']
              ],
              'text-font': ['Open Sans Regular'], 'text-size': 10.5,
              'text-anchor': 'bottom', 'text-offset': [0, -0.6],
              'text-allow-overlap': false, 'text-padding': 2,
              'text-optional': true,
              'symbol-sort-key': ['-', 5000, ['coalesce', ['get', 'alt'], 0]]
            },
            paint: {
              'text-color': PEAK_COLOR_EXPR,
              'text-halo-color': '#1a1810',
              'text-halo-width': 1.4, 'text-halo-blur': 0.4
            }
          });

          // Huts — brown filled markers, distinct silhouette
          map.addSource('huts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addLayer({
            id: 'huts-dot', type: 'circle', source: 'huts',
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3.5, 13, 7],
              'circle-color': '#8b4513',
              'circle-stroke-color': '#f0e8d8',
              'circle-stroke-width': 1.8
            }
          });
          map.addLayer({
            id: 'huts-label', type: 'symbol', source: 'huts',
            minzoom: 10,
            layout: {
              'text-field': ['get', 'name'],
              'text-font': ['Open Sans Bold'], 'text-size': 11,
              'text-anchor': 'top', 'text-offset': [0, 0.6],
              'text-allow-overlap': false, 'text-padding': 3,
              'text-optional': true
            },
            paint: {
              'text-color': '#f0e8d8', 'text-halo-color': '#5a2d0d',
              'text-halo-width': 1.5, 'text-halo-blur': 0.4
            }
          });

          // Click a peak/hut → fly to it and open the side panel. Panel calls
          // the shared HikeMap.SidePanel so the interaction is identical to
          // CC's 2D behavior; the fly-to is the 3D-specific bit. When the
          // clicked POI matches a built hike page, drape its GPX track on the
          // terrain so the actual route reads at a glance.
          function clickPoi(e) {
            var f = e.features && e.features[0]; if (!f) return;
            var id = f.properties.id;
            var poi = lastPois.find(function (p) { return poiId(p) === id; });
            if (!poi) poi = lastChPeaks.find(function (p) { return poiId(p) === id; });
            if (!poi) return;
            window.CC3DPeaks._selected = poi;
            flyTo({ lat: poi.lat, lon: poi.lon });
            if (panel) panel.open(poi);
            // GPX draping — only when this POI has a matching built hike page.
            var hike = deps.matchingHike ? deps.matchingHike(poi) : null;
            if (hike && hike.href) showHikeTrack(hike);
            else clearHikeTrack();
          }
          ['peaks-hit', 'peaks-dot', 'peaks-label',
           'huts-dot', 'huts-label',
           'ch-peaks-hit', 'ch-peaks-dot', 'ch-peaks-label'].forEach(function (l) {
            map.on('click', l, clickPoi);
            map.on('mouseenter', l, function () { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', l, function () { map.getCanvas().style.cursor = ''; });
          });

          map.on('moveend', scheduleTrails);
          mapReady = true;
          refreshSources();
          refreshTrails();
          resolve();
        });

        window.map = map;
      });
    }

    function teardown() {
      if (map) { try { map.remove(); } catch (e) {} }
      map = null; mapReady = false;
      tileCache.clear(); tileInflight.clear(); fetchGen++;
      running = 0; pending = [];
      if (pendingFly) { clearTimeout(pendingFly); pendingFly = null; }
      if (pendingReturn) { clearTimeout(pendingReturn); pendingReturn = null; }
      if (rotateRaf) { cancelAnimationFrame(rotateRaf); rotateRaf = null; }
      TOUR_STATE = 'idle';
    }

    function setPois(pois) { lastPois = pois; refreshSources(); }
    function setChPeaks(peaks) { lastChPeaks = peaks || []; refreshSources(); }
    function setLayerVisibility(layerId, on) {
      if (layerId === 'peaks') {   // "peaks" toggle controls the CH_PEAKS layer
        chPeaksOn = !!on;
        refreshSources();
      } else if (layerId === 'trails') {
        trailsOn = !!on;
        if (!trailsOn) {
          var src = map && map.getSource('trails');
          if (src) src.setData({ type: 'FeatureCollection', features: [] });
          var countEl = document.getElementById('trails-count');
          if (countEl) countEl.textContent = 'off';
        } else refreshTrails();
      }
    }
    function applyVisibility(state) {
      var set = new Set();
      lastPois.forEach(function (poi) {
        if (matcher.match(toMatchable(poi), state)) set.add(poiId(poi));
      });
      // CH_PEAKS aren't matched by the CC filter matcher (they're a separate
      // geographic layer, controlled only by the `pk` toggle). Always include
      // them in visibleIds so the source builder includes them.
      lastChPeaks.forEach(function (poi) { set.add(poiId(poi)); });
      visibleIds = set;
      refreshSources();
    }
    function refreshIcons() { /* no icon variant in 3D — dots are grade-colored constants */ }
    function refreshTooltips() { /* labels are MapLibre-managed */ }

    function getViewport() {
      if (!map) return null;
      var c = map.getCenter();
      return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    }
    function setViewport(v) {
      if (!map || !v) return;
      map.jumpTo({
        center: [v.lng, v.lat], zoom: v.zoom,
        pitch: typeof v.pitch === 'number' ? v.pitch : 62,
        bearing: typeof v.bearing === 'number' ? v.bearing : 20
      });
    }
    function flyTo(target) {
      if (!map) return;
      var pad = 0.028;
      // Preserve the user's current camera orientation across the fly-to.
      // Snapping bearing/pitch to a fixed north-up view every click was
      // disorienting when panning around the range. Only the center + zoom
      // move; how you were looking stays how you look.
      map.fitBounds([[target.lon - pad, target.lat - pad], [target.lon + pad, target.lat + pad]], {
        padding: 60,
        pitch: map.getPitch(),
        bearing: map.getBearing(),
        duration: 2000, maxZoom: 13.6, essential: true
      });
    }
    function toggleTrails() {
      trailsOn = !trailsOn;
      var btn = document.getElementById('trails-btn');
      if (btn) btn.classList.toggle('off', !trailsOn);
      if (!trailsOn) {
        var src = map && map.getSource('trails');
        if (src) src.setData({ type: 'FeatureCollection', features: [] });
        var countEl = document.getElementById('trails-count');
        if (countEl) countEl.textContent = 'off';
      } else {
        refreshTrails();
      }
    }
    function toggleTour() {
      if (TOUR_STATE === 'idle') beginTour(); else endTour();
    }

    return {
      init: init, teardown: teardown,
      setPois: setPois,
      setChPeaks: setChPeaks,
      setLayerVisibility: setLayerVisibility,
      applyVisibility: applyVisibility,
      refreshIcons: refreshIcons,
      refreshTooltips: refreshTooltips,
      getViewport: getViewport, setViewport: setViewport, flyTo: flyTo,
      supports: { trails: true, tour: true, peaks: true },
      toggleTrails: toggleTrails,
      toggleTour: toggleTour,
      // MapLibre can render WMS/raster overlays but Leaflet layers coming from
      // the shared engine (SlfLayer / WebcamLayer) can't attach here. Silent
      // no-ops so the orchestrator can call add/remove uniformly across modes.
      addLayer: function () {},
      removeLayer: function () {}
    };
  };
})();
