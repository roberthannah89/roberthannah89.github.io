/* 3d-cc MapLibre renderer.
 *
 * Extended from 3d-trails.js: keeps the satellite + terrain base, SAC T1-T6
 * Overpass trails overlay, peak database + dots, summit tour. Adds a
 * hikes GeoJSON source with native MapLibre clustering (parameters match
 * Leaflet.markercluster's), weather-colored dot layers, and cluster
 * count/emoji symbol layers.
 *
 * No Leaflet-style first-click regression risk here: MapLibre's popup has
 * its own idempotency, and we route clicks through map.on('click', layer).
 *
 * Exposes: window.CCRenderer.createMapLibre() → Renderer
 */
(function () {
  'use strict';

  var CCR = window.CCRenderer;

  // Trails overlay config — identical to 3d-trails.js so behavior matches.
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

  var SAC_COLOR_EXPR = [
    'match', ['get', 'sac'],
    'hiking',                    '#F5C518',
    'mountain_hiking',           '#E4572E',
    'demanding_mountain_hiking', '#B02A1B',
    'alpine_hiking',             '#2E86DE',
    'demanding_alpine_hiking',   '#1B4F8C',
    'difficult_alpine_hiking',   '#7D3C98',
    '#888'
  ];

  // Sky-category tints for cluster icon (MapLibre variant — colors as text).
  var SKY_EMOJI = { clear: '☀️', cloudy: '⛅', rain: '🌧️', snow: '❄️', storm: '⛈️' };

  window.CCRenderer.createMapLibre = function createMapLibreRenderer() {
    var map = null;
    var mapReady = false;
    var trailsOn = true;
    var peaksOn = true;

    var pois = [];
    var filteredIds = null;
    var selection = null;

    var onSelect = null;
    var onEmpty = null;

    /* ── Trails tile math + fetch (from 3d-trails.js) ────────── */
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
    function clampToCH(bounds) {
      return {
        s: Math.max(bounds.getSouth(), CH_BBOX.s),
        w: Math.max(bounds.getWest(),  CH_BBOX.w),
        n: Math.min(bounds.getNorth(), CH_BBOX.n),
        e: Math.min(bounds.getEast(),  CH_BBOX.e)
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
        pending.push({ run: runFn, resolve: resolve, reject: reject });
        drain();
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
            var delay = RETRY_DELAYS_MS[retry++];
            epIdx = 0;
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
    function scheduleRefreshTrails() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refreshTrails, DEBOUNCE_MS);
    }
    function refreshTrails() {
      if (!trailsOn || !map || !mapReady) return;
      var z = map.getZoom();
      var src = map.getSource('trails');
      if (!src) return;
      if (z < MIN_ZOOM_FOR_TRAILS) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
      var tiles = tilesForBounds(map.getBounds(), CACHE_ZOOM);
      if (tiles.length === 0 || tiles.length > MAX_TILES_PER_FETCH) return;
      var gen = ++fetchGen;
      Promise.all(tiles.map(fetchTile))
        .then(function (arrs) {
          if (gen !== fetchGen) return;
          var features = arrs.reduce(function (acc, a) { return acc.concat(a); }, []);
          src.setData({ type: 'FeatureCollection', features: features });
        })
        .catch(function (err) { console.error('[trails]', err); });
    }

    /* ── Peaks side panel (from 3d-trails.js, minimal) ───────── */
    // For the 3d-cc prototype we render peak DOTS on the map but delegate
    // the peak-database side-panel HTML to the orchestrator (it lives outside
    // the map element and is renderer-agnostic — same as SidePanel).
    function tierFor(ele, notable) {
      ele = ele || 0;
      if (ele >= 4000 || (notable && ele >= 3500)) return 1;
      if (ele >= 3000 || (notable && ele >= 2500)) return 2;
      return 3;
    }
    function peakToFeature(p) {
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          id: p.id, name: p.name,
          ele: typeof p.ele === 'number' ? Math.round(p.ele) : null,
          tier: tierFor(p.ele, !!p.wikipedia)
        }
      };
    }

    /* ── Hike features (weather-tinted; no cluster tint yet — v1
          uses supercluster's default cluster styling.) ────────── */
    function hikeToFeature(poi) {
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [poi.lon, poi.lat] },
        properties: {
          id: CCR.poiId(poi),
          name: poi.name,
          color: CCR.gradeColor(Filters.bestGrade(poi)),
          alt: poi.alt || 0
        }
      };
    }

    function buildHikeFC() {
      var use = pois.filter(function (poi) {
        if (!poi.lat || !poi.lon) return false;
        if (filteredIds && !filteredIds.has(CCR.poiId(poi))) return false;
        return true;
      });
      return { type: 'FeatureCollection', features: use.map(hikeToFeature) };
    }
    function refreshHikeSource() {
      if (!map || !mapReady) return;
      var src = map.getSource('hikes');
      if (src) src.setData(buildHikeFC());
    }
    function refreshSelectionSource() {
      if (!map || !mapReady) return;
      var src = map.getSource('selection');
      if (!src) return;
      src.setData(selection && selection.lat && selection.lon ? {
        type: 'FeatureCollection',
        features: [{ type: 'Feature',
          geometry: { type: 'Point', coordinates: [selection.lon, selection.lat] },
          properties: { name: selection.name || '' } }]
      } : { type: 'FeatureCollection', features: [] });
    }

    /* ── Peak dots ────────────────────────────────────────── */
    function refreshPeakSource() {
      if (!map || !mapReady) return;
      var src = map.getSource('peaks');
      if (!src) return;
      if (!peaksOn) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
      var peaks = Array.isArray(window.CH_PEAKS) ? window.CH_PEAKS : [];
      src.setData({ type: 'FeatureCollection', features: peaks.map(peakToFeature) });
    }

    /* ── Interface ────────────────────────────────────────── */
    function init(container, initialViewport, opts) {
      return new Promise(function (resolve) {
        var v = CCR.normalizeViewport(initialViewport);
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
              { id: 'bg', type: 'background', paint: { 'background-color': '#8ba58c' } },
              { id: 'satellite', type: 'raster', source: 'swissimage' }
            ],
            terrain: { source: 'terrarium', exaggeration: 1.5 },
            sky: {
              'sky-color': '#9fc8ec', 'horizon-color': '#dfe7ed',
              'fog-color': '#dfe7ed', 'fog-ground-blend': 0.5
            }
          },
          center: [v.lng || CCR.HOME_VIEWPORT.lng, v.lat || CCR.HOME_VIEWPORT.lat],
          zoom: v.zoom || CCR.HOME_VIEWPORT.zoom,
          pitch: v.pitch, bearing: v.bearing,
          maxPitch: 85, hash: false
        });
        map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
        map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

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
              'line-color': SAC_COLOR_EXPR,
              'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 14, 2.6, 17, 4.6],
              'line-opacity': 0.95
            }
          });

          // Swiss border
          if (window.SWISS_BORDER) {
            map.addSource('swiss-border', { type: 'geojson', data: window.SWISS_BORDER });
            map.addLayer({
              id: 'swiss-border-line', type: 'line', source: 'swiss-border',
              paint: { 'line-color': '#8b4513', 'line-width': 1.4, 'line-opacity': 0.55 }
            });
          }

          // Peak dots (from 3d-trails)
          map.addSource('peaks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          var peakOpacity = ['step', ['zoom'],
                       ['case', ['==', ['get', 'tier'], 1], 1, 0],
            9.5,  ['case', ['<=', ['get', 'tier'], 2], 1, 0],
            11.5, 1
          ];
          map.addLayer({
            id: 'peaks-dot', type: 'circle', source: 'peaks',
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'],
                7, ['case', ['==', ['get', 'tier'], 1], 4, ['==', ['get', 'tier'], 2], 3, 2.4],
                13, ['case', ['==', ['get', 'tier'], 1], 7, ['==', ['get', 'tier'], 2], 6, 5.5]
              ],
              'circle-color': '#ffffff',
              'circle-stroke-color': '#171a1f', 'circle-stroke-width': 1.6,
              'circle-opacity': peakOpacity, 'circle-stroke-opacity': peakOpacity
            }
          });
          map.addLayer({
            id: 'peaks-label', type: 'symbol', source: 'peaks',
            layout: {
              'text-field': ['case',
                ['==', ['get', 'ele'], null], ['get', 'name'],
                ['concat', ['get', 'name'], '  ', ['to-string', ['get', 'ele']], ' m']
              ],
              'text-font': ['Open Sans Regular'],
              'text-size': ['case', ['==', ['get', 'tier'], 1], 13, ['==', ['get', 'tier'], 2], 11.5, 10.5],
              'text-anchor': 'bottom', 'text-offset': [0, -0.6],
              'text-allow-overlap': false, 'text-ignore-placement': false, 'text-padding': 3,
              'symbol-sort-key': ['-', 5000, ['coalesce', ['get', 'ele'], 0]]
            },
            paint: {
              'text-color': '#1a1a1a', 'text-halo-color': '#ffffff',
              'text-halo-width': 1.8, 'text-halo-blur': 0.4, 'text-opacity': peakOpacity
            }
          });

          // Hikes — native MapLibre cluster
          map.addSource('hikes', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            cluster: true,
            clusterMaxZoom: CCR.CLUSTER.clusterMaxZoom,
            clusterRadius: CCR.CLUSTER.maxClusterRadius
          });
          map.addLayer({
            id: 'hike-clusters', type: 'circle', source: 'hikes',
            filter: ['has', 'point_count'],
            paint: {
              'circle-color': '#eeece5',
              'circle-stroke-color': '#3a3428',
              'circle-stroke-width': 1.5,
              'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 22]
            }
          });
          map.addLayer({
            id: 'hike-cluster-count', type: 'symbol', source: 'hikes',
            filter: ['has', 'point_count'],
            layout: {
              'text-field': '{point_count_abbreviated}',
              'text-font': ['Open Sans Bold'], 'text-size': 12
            },
            paint: { 'text-color': '#1a1a1a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }
          });
          map.addLayer({
            id: 'hike-dot', type: 'circle', source: 'hikes',
            filter: ['!', ['has', 'point_count']],
            paint: {
              'circle-radius': 6,
              'circle-color': ['get', 'color'],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1.5
            }
          });
          map.addLayer({
            id: 'hike-label', type: 'symbol', source: 'hikes',
            filter: ['!', ['has', 'point_count']],
            minzoom: 11,
            layout: {
              'text-field': ['get', 'name'],
              'text-font': ['Open Sans Regular'], 'text-size': 12,
              'text-anchor': 'left', 'text-offset': [0.75, 0],
              'text-allow-overlap': false, 'text-padding': 3,
              'text-optional': true
            },
            paint: { 'text-color': '#1a1a1a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 }
          });

          // Selection halo
          map.addSource('selection', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addLayer({
            id: 'selection-halo', type: 'circle', source: 'selection',
            paint: {
              'circle-radius': 14, 'circle-color': '#c0392b',
              'circle-opacity': 0.22, 'circle-stroke-color': '#c0392b',
              'circle-stroke-width': 2, 'circle-stroke-opacity': 0.85
            }
          });

          // Click handlers
          map.on('click', 'hike-dot', function (e) {
            var f = e.features && e.features[0]; if (!f) return;
            var id = f.properties.id;
            var poi = pois.find(function (p) { return CCR.poiId(p) === id; });
            if (poi && onSelect) onSelect(poi);
          });
          map.on('click', 'hike-clusters', function (e) {
            var f = e.features && e.features[0]; if (!f) return;
            map.getSource('hikes').getClusterExpansionZoom(f.properties.cluster_id, function (err, zoom) {
              if (err) return;
              map.easeTo({ center: f.geometry.coordinates, zoom: zoom });
            });
          });
          map.on('click', 'peaks-dot', function (e) {
            var f = e.features && e.features[0]; if (!f) return;
            var pk = (window.CH_PEAKS || []).find(function (p) { return p.id === f.properties.id; });
            if (pk && onSelect) onSelect({ __peak: true, peak: pk, lat: pk.lat, lon: pk.lon, name: pk.name });
          });
          ['hike-dot', 'hike-clusters', 'peaks-dot'].forEach(function (l) {
            map.on('mouseenter', l, function () { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', l, function () { map.getCanvas().style.cursor = ''; });
          });
          map.on('click', function (e) {
            var feats = map.queryRenderedFeatures(e.point, {
              layers: ['hike-dot', 'hike-clusters', 'peaks-dot', 'trails-line']
            });
            if (!feats || !feats.length) { if (onEmpty) onEmpty(); }
          });

          map.on('moveend', scheduleRefreshTrails);
          mapReady = true;
          refreshHikeSource();
          refreshPeakSource();
          refreshSelectionSource();
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
    }

    function setHikes(newPois) { pois = newPois || []; refreshHikeSource(); }
    function setFilteredIds(idSet) { filteredIds = idSet; refreshHikeSource(); }
    function setSelection(poi) { selection = poi || null; refreshSelectionSource(); }

    function getViewport() {
      if (!map) return null;
      var c = map.getCenter();
      return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    }
    function setViewport(v) {
      if (!map || !v) return;
      map.jumpTo({
        center: [v.lng, v.lat], zoom: v.zoom,
        pitch: typeof v.pitch === 'number' ? v.pitch : CCR.HOME_VIEWPORT.pitch,
        bearing: typeof v.bearing === 'number' ? v.bearing : CCR.HOME_VIEWPORT.bearing
      });
    }
    function flyTo(target) {
      if (!map) return;
      var pad = 0.028;
      map.fitBounds([[target.lng - pad, target.lat - pad], [target.lng + pad, target.lat + pad]], {
        padding: 60, pitch: 65, bearing: 20, duration: 2000, maxZoom: 13.6, essential: true
      });
    }
    function setLayerVisible(layerId, on) {
      if (layerId === 'trails') {
        trailsOn = on;
        if (!on) {
          var src = map && map.getSource('trails');
          if (src) src.setData({ type: 'FeatureCollection', features: [] });
        } else {
          refreshTrails();
        }
      } else if (layerId === 'peaks-panel') {
        peaksOn = on; refreshPeakSource();
      }
      // 'slope' — 2D only; silent no-op
    }

    return {
      init: init, teardown: teardown,
      setHikes: setHikes, setFilteredIds: setFilteredIds,
      setSelection: setSelection,
      getViewport: getViewport, setViewport: setViewport, flyTo: flyTo,
      setLayerVisible: setLayerVisible,
      onSelectHike: function (cb) { onSelect = cb; },
      onEmptyClick: function (cb) { onEmpty = cb; },
      supports: { slope: false, trails: true, 'peaks-panel': true },
      refreshMarkerIcons: function () {
        // Weather-day change: color driven by grade, which is stable; no-op v1.
        // (Later: could re-render dots with a weather tint if display=weather.)
      },
      refreshMarkerTooltips: function () { /* no explicit tooltips in v1 */ }
    };
  };
})();
