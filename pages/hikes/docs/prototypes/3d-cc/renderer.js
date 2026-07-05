/* 3d-cc renderer interface + shared helpers.
 *
 * Both renderer-leaflet.js and renderer-maplibre.js expose a factory that
 * returns an object matching this interface. The orchestrator (3d-cc.js)
 * holds a single active renderer and coordinates state.
 *
 *   Renderer = {
 *     init(container, initialViewport, opts),       // returns Promise<void>
 *     teardown(),                                   // synchronous
 *     setHikes(pois),                               // full POI array (window.HIKES)
 *     setFilteredIds(idSet),                        // Set<string> of poi.name (or poi.href)
 *     setSelection(poi | null),                     // selection halo + fly-to
 *     getViewport(),                                // → {lng, lat, zoom, pitch, bearing}
 *     setViewport(v),                               // apply saved viewport
 *     flyTo({lng, lat, zoom?}),                     // camera transition
 *     setLayerVisible(layerId, on),                 // 'slope', 'trails', 'peaks-panel', ...
 *     onSelectHike(cb),                             // cb(poi) when a hike is clicked
 *     onEmptyClick(cb)                              // cb() when the map background is clicked
 *   }
 *
 * Layer IDs a renderer may accept in setLayerVisible():
 *   'slope'        — 2D-only (Leaflet WMS); 3D no-ops
 *   'trails'       — 3D-only (SAC T1–T6 Overpass overlay); 2D no-ops
 *   'peaks-panel'  — 3D-only (peak database side panel + dots on the map)
 * Layers a renderer doesn't support are silently no-ops. The orchestrator
 * uses each layer's declared availability to show a "N/A in <mode>" hint.
 *
 * Layer support declared by both renderers via a `.supports` property:
 *   { slope: bool, trails: bool, 'peaks-panel': bool }
 */
(function () {
  'use strict';

  window.CCRenderer = window.CCRenderer || {};

  // Grade colors — shared by both renderers so a hike keeps the same color
  // across the swap. Mirrors command-center.js's GRADE_COLORS.
  var GRADE_COLORS = {
    1: '#2d8a4e', 2: '#2d8a4e',
    3: '#c8a020',
    4: '#d07030',
    5: '#cc3333',
    6: '#8844cc'
  };

  function gradeColor(grade) {
    var n = parseInt((grade || 'T1').replace('T', ''), 10) || 1;
    return GRADE_COLORS[n] || GRADE_COLORS[1];
  }

  // Stable identity for a POI — the href (per hike) beats name (there are
  // occasional duplicate names in HIKES). Falls back to name if no href.
  function poiId(poi) {
    return (poi && (poi.href || poi.name)) || null;
  }

  // Cluster-radius tuning shared between renderers so cluster boundaries
  // don't visibly re-shuffle across the swap (they will subtly because
  // Leaflet.markercluster and MapLibre's supercluster use different
  // algorithms, but the params match).
  var CLUSTER = {
    maxClusterRadius: 45,
    disableClusteringAtZoom: 13,
    clusterMaxZoom: 12
  };

  // Fixed home viewport — used when the URL hash has no viewport keys.
  // Roughly centered on Central Switzerland with a moderate framing.
  var HOME_VIEWPORT = {
    lng: 8.2, lat: 46.8, zoom: 9,
    pitch: 62,     // ignored by Leaflet
    bearing: 20    // ignored by Leaflet
  };

  // Normalize a viewport shape so both renderers accept the same object.
  // MapLibre uses all fields; Leaflet drops pitch/bearing silently.
  function normalizeViewport(v) {
    if (!v) return {};
    return {
      lng: typeof v.lng === 'number' ? v.lng : (v.lon || null),
      lat: typeof v.lat === 'number' ? v.lat : null,
      zoom: typeof v.zoom === 'number' ? v.zoom : null,
      pitch: typeof v.pitch === 'number' ? v.pitch : HOME_VIEWPORT.pitch,
      bearing: typeof v.bearing === 'number' ? v.bearing : HOME_VIEWPORT.bearing
    };
  }

  window.CCRenderer.gradeColor = gradeColor;
  window.CCRenderer.poiId = poiId;
  window.CCRenderer.CLUSTER = CLUSTER;
  window.CCRenderer.HOME_VIEWPORT = HOME_VIEWPORT;
  window.CCRenderer.normalizeViewport = normalizeViewport;
})();
