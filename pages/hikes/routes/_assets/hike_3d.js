// GENERATED FROM ../../templates/_assets/hike_3d.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

/* MapLibre 3D map init shared by the inline section on each hike page and
   the standalone <slug>.3d.html page. Free tiles only: swisstopo SWISSIMAGE
   (satellite) + AWS Open Data Terrarium DEM (terrain). No API key. */

(function (root) {
  function initHike3DMap(containerId, opts) {
    if (!root.maplibregl) {
      console.error('hike_3d: maplibregl not loaded');
      return null;
    }
    var TRAILHEAD = opts.trailhead;             // [lon, lat]
    var SUMMIT    = opts.summit;                // [lon, lat]
    var PEAK_NAME = opts.peakName  || 'Summit';
    var PEAK_ELEV = opts.peakElev  || null;
    var TRAIL_NAME = opts.trailheadName || 'Trailhead';
    var initialPitch = opts.pitch != null ? opts.pitch : 70;
    var initialBearing = opts.bearing != null ? opts.bearing : 35;
    var initialExag = opts.exaggeration != null ? opts.exaggeration : 1.5;

    var map = new maplibregl.Map({
      container: containerId,
      style: {
        version: 8,
        sources: {
          swissimage: {
            type: 'raster',
            tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'],
            tileSize: 256, maxzoom: 19,
            attribution: '© swisstopo'
          },
          terrarium: {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            tileSize: 256, maxzoom: 15, encoding: 'terrarium',
            attribution: 'Terrain: Mapzen / AWS Open Data'
          }
        },
        layers: [{ id: 'satellite', type: 'raster', source: 'swissimage' }],
        terrain: { source: 'terrarium', exaggeration: initialExag },
        sky: { 'sky-color': '#9fc8ec', 'horizon-color': '#dfe7ed', 'fog-color': '#dfe7ed', 'fog-ground-blend': 0.5 }
      },
      center: [(TRAILHEAD[0] + SUMMIT[0]) / 2, (TRAILHEAD[1] + SUMMIT[1]) / 2],
      zoom: 13, pitch: initialPitch, bearing: initialBearing, maxPitch: 85, hash: false
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
    map.addControl(new maplibregl.FullscreenControl(), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    map.on('load', function () {
      var src = root.TRACK || [];
      var coords = src.map(function (p) { return [p[1], p[0]]; });  // [lat,lon,elev] -> [lon,lat]
      if (coords.length) {
        map.addSource('track', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
        });
        map.addLayer({
          id: 'track-casing', type: 'line', source: 'track',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#1a1a1a', 'line-width': 6, 'line-opacity': 0.45 }
        });
        map.addLayer({
          id: 'track-line', type: 'line', source: 'track',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#e74c3c', 'line-width': 3.5 }
        });
        var lons = coords.map(function (c) { return c[0]; });
        var lats = coords.map(function (c) { return c[1]; });
        var bounds = [[Math.min.apply(null, lons), Math.min.apply(null, lats)],
                      [Math.max.apply(null, lons), Math.max.apply(null, lats)]];
        map.fitBounds(bounds, { padding: 60, pitch: 65, bearing: map.getBearing(), duration: 0 });
      }
      new maplibregl.Marker({ color: '#27ae60' }).setLngLat(TRAILHEAD)
        .setPopup(new maplibregl.Popup().setText('Trailhead — ' + TRAIL_NAME))
        .addTo(map);
      var summitText = PEAK_NAME + (PEAK_ELEV ? ' — ' + PEAK_ELEV + ' m' : '');
      new maplibregl.Marker({ color: '#c0392b' }).setLngLat(SUMMIT)
        .setPopup(new maplibregl.Popup().setText(summitText))
        .addTo(map);
    });

    return map;
  }

  root.initHike3DMap = initHike3DMap;
})(window);
