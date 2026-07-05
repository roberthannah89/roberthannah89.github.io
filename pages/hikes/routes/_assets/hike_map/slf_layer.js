// GENERATED FROM ../../templates/_assets/hike_map/slf_layer.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

/* SLF avalanche danger overlay — Leaflet layer of region polygons coloured
   by the EAWS 1–5 danger scale.

   Reads pre-baked data from window.SLF_CACHE / window.SLF_CACHE_META written
   by scripts/fetch_slf_avalanche.py. Off-season the cache is empty and the
   layer simply renders nothing.

   Exposes:  window.SlfLayer.create()  →  Promise<L.LayerGroup>
             window.SlfLayer.getMeta() →  meta object (or null)

   Loads as a plain <script> tag (no ES modules — pages are opened via file://
   where `type="module"` breaks). Same IIFE/window-globals pattern as
   webcams.js and weather.js. */
(function () {
  'use strict';

  // Official EAWS / SLF danger-level colours. Match scripts/config.py
  // (SLF_DANGER_COLORS) and WhiteRisk's CSS custom properties.
  var DANGER_COLORS = {
    1: '#ccff66', // Low
    2: '#ffff00', // Moderate
    3: '#ff9900', // Considerable
    4: '#ff0000', // High
    5: '#640000'  // Very High
  };

  var DANGER_LABELS = {
    1: 'Low',
    2: 'Moderate',
    3: 'Considerable',
    4: 'High',
    5: 'Very High'
  };

  // Fill opacity: low enough that the SwissTopo base map (and route markers)
  // stay readable underneath, high enough that danger is immediately obvious.
  var FILL_OPACITY = 0.4;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Lazy <script>-tag loader so the ~50 KB winter blob is only paid for when the
  // user opens the layer. Same pattern as webcams.js / weather.js.
  var dataPromise = null;
  function ensureData() {
    if (window.SLF_CACHE) return Promise.resolve();
    if (dataPromise) return dataPromise;
    dataPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'slf-cache.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load slf-cache.js')); };
      document.head.appendChild(s);
    }).catch(function (err) {
      console.warn(err);
      dataPromise = null;
    });
    return dataPromise;
  }

  function popupHtml(region) {
    var color = DANGER_COLORS[region.danger] || '#888';
    var levelLabel = esc(DANGER_LABELS[region.danger] || 'Unknown');
    var fullLabel = esc(region.label || levelLabel);
    var nameLine = region.name
      ? esc(region.name) + (region.regionCount > 3 ? ' <span class="slf-popup__count">(+' + (region.regionCount - 3) + ' more)</span>' : '')
      : (region.regionCount + ' region' + (region.regionCount === 1 ? '' : 's'));
    var validLine = '';
    var vt = region.validTime || {};
    if (vt.startTime) {
      var start = new Date(vt.startTime);
      if (!isNaN(start)) {
        validLine = '<div class="slf-popup__valid">Valid ' + esc(start.toUTCString().slice(0, 16)) + '</div>';
      }
    }
    return (
      '<div class="slf-popup">' +
        '<div class="slf-popup__head">' +
          '<span class="slf-popup__badge" style="background:' + color + '">' + region.danger + '</span>' +
          '<span class="slf-popup__level">' + fullLabel + '</span>' +
        '</div>' +
        '<div class="slf-popup__regions">' + nameLine + '</div>' +
        validLine +
        '<a class="slf-popup__link" href="https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/" ' +
          'target="_blank" rel="noopener">Full SLF bulletin &rarr;</a>' +
      '</div>'
    );
  }

  function styleFor(region) {
    var color = DANGER_COLORS[region.danger] || '#888';
    return {
      color: color,
      weight: 1,
      opacity: 0.8,
      fillColor: color,
      fillOpacity: FILL_OPACITY,
      // Keep the avalanche polygons below the route/webcam markers so popups
      // and clusters remain interactable. Default L.GeoJSON pane is overlayPane.
      pane: 'overlayPane'
    };
  }

  function create() {
    return ensureData().then(function () {
      var group = L.layerGroup();
      var data = window.SLF_CACHE || { regions: [] };
      var regions = data.regions || [];
      if (!regions.length) return group;

      // Render highest-danger regions on top so they're clickable even when
      // overlapped by lower-danger neighbours (SLF features don't overlap in
      // practice — this is defensive only).
      var sorted = regions.slice().sort(function (a, b) {
        return (a.danger || 0) - (b.danger || 0);
      });

      sorted.forEach(function (region) {
        if (!region.geometry) return;
        var feature = {
          type: 'Feature',
          properties: region,
          geometry: region.geometry
        };
        var layer = L.geoJSON(feature, {
          style: styleFor(region)
        });
        layer.bindPopup(popupHtml(region), {
          maxWidth: 280,
          minWidth: 220,
          className: 'slf-popup-wrapper',
          closeButton: true
        });
        group.addLayer(layer);
      });

      return group;
    });
  }

  function getMeta() {
    return window.SLF_CACHE_META || null;
  }

  window.SlfLayer = {
    create: create,
    getMeta: getMeta,
    DANGER_COLORS: DANGER_COLORS,
    DANGER_LABELS: DANGER_LABELS
  };
})();
