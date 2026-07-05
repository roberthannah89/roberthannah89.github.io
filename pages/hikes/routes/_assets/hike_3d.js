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

      addSummitTour(map, containerId, SUMMIT, PEAK_NAME);
    });

    return map;
  }

  // Injects a 🎥 button that flies to the summit and pans 360° around it,
  // then eases back to the previous camera. Reusable across every hike —
  // takes SUMMIT coords + PEAK_NAME and uses no other route-specific state.
  //
  // Design notes and why this shape:
  // - map.easeTo({bearing: 360}) is a no-op because MapLibre normalises the
  //   value back to 0. The rotation is driven by a rAF loop calling
  //   map.setBearing(start + t·360) so we can walk the value past 360°.
  // - We tried "camera AT the summit looking outward" via setFreeCameraOptions,
  //   which MapLibre GL JS (4.7.1, 5.7.0) does not expose publicly. Faking it
  //   with a computed center offset ran into terrain auto-elevation clamping.
  //   Wide orbit at pitch:68 zoom:14.2 stays above every neighbouring peak.
  function addSummitTour(map, containerId, SUMMIT, PEAK_NAME) {
    var FLY_MS = 2200;
    var ROTATE_MS = 25000;
    var RETURN_MS = 2000;
    var TOUR_ZOOM = 14.2;
    var TOUR_PITCH = 68;
    var ICON_PLAY = '🎥';       // 🎥
    var ICON_STOP = '⏹️';       // ⏹️
    var TITLE_PLAY = 'Fly to ' + PEAK_NAME + ' and pan 360°';
    var TITLE_STOP = 'Stop tour';

    var container = document.getElementById(containerId);
    if (!container) return;
    // Ensure the map container can host absolutely-positioned children.
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hike3d-tour-btn';
    btn.innerHTML = ICON_PLAY;
    btn.title = TITLE_PLAY;
    btn.setAttribute('aria-label', TITLE_PLAY);
    btn.style.cssText = [
      'position:absolute', 'top:12px', 'right:12px', 'z-index:5',
      'width:44px', 'height:44px',
      'border:0', 'border-radius:50%',
      'background:rgba(255,255,255,0.94)',
      'font:inherit', 'font-size:22px', 'line-height:1', 'color:#1a1a1a',
      'cursor:pointer',
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'box-shadow:0 2px 8px rgba(0,0,0,0.18)',
      'transition:transform 0.15s, background 0.15s'
    ].join(';');
    btn.addEventListener('mouseenter', function () {
      if (TOUR_STATE === 'idle') btn.style.background = '#ffffff';
    });
    btn.addEventListener('mouseleave', function () {
      if (TOUR_STATE === 'idle') btn.style.background = 'rgba(255,255,255,0.94)';
    });
    container.appendChild(btn);

    var TOUR_STATE = 'idle';   // idle | flying | rotating | returning
    var pendingFlyTimeout = null;
    var pendingReturnTimeout = null;
    var rotateRaf = null;
    var rotateStartMs = 0;
    var rotateStartBearing = 0;
    var savedView = null;

    function setPlaying(playing) {
      btn.innerHTML = playing ? ICON_STOP : ICON_PLAY;
      btn.title = playing ? TITLE_STOP : TITLE_PLAY;
      btn.style.background = playing ? '#c0392b' : 'rgba(255,255,255,0.94)';
      btn.style.color = playing ? '#ffffff' : '#1a1a1a';
    }

    function beginTour() {
      if (TOUR_STATE !== 'idle') return;
      TOUR_STATE = 'flying';
      setPlaying(true);

      savedView = {
        lng: map.getCenter().lng,
        lat: map.getCenter().lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing()
      };

      map.easeTo({
        center: SUMMIT,
        zoom: TOUR_ZOOM,
        pitch: TOUR_PITCH,
        bearing: 0,
        duration: FLY_MS
      });

      pendingFlyTimeout = setTimeout(function () {
        pendingFlyTimeout = null;
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
      if (t < 1) {
        rotateRaf = requestAnimationFrame(rotateStep);
      } else {
        rotateRaf = null;
        endTour();
      }
    }

    function endTour() {
      if (TOUR_STATE === 'idle' || TOUR_STATE === 'returning') return;
      if (pendingFlyTimeout) { clearTimeout(pendingFlyTimeout); pendingFlyTimeout = null; }
      if (rotateRaf)         { cancelAnimationFrame(rotateRaf);  rotateRaf = null; }
      TOUR_STATE = 'returning';

      map.easeTo({
        center: [savedView.lng, savedView.lat],
        zoom: savedView.zoom,
        pitch: savedView.pitch,
        bearing: savedView.bearing % 360,
        duration: RETURN_MS
      });

      pendingReturnTimeout = setTimeout(function () {
        pendingReturnTimeout = null;
        TOUR_STATE = 'idle';
        setPlaying(false);
      }, RETURN_MS);
    }

    btn.addEventListener('click', function () {
      if (TOUR_STATE === 'idle') beginTour();
      else endTour();
    });
  }

  root.initHike3DMap = initHike3DMap;
})(window);
