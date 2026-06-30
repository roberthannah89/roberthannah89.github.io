// hike_3d_photoreal.js — drop-in replacement for hike_3d.js.
//
// Same initHike3DMap(containerId, opts) signature, but renders Google
// Photorealistic 3D Tiles via CesiumJS instead of MapLibre + swisstopo.
// Reads window.TRACK (set by per-hike .track.js) for the GPX overlay,
// and window.HIKING_CONFIG.googleMapsApiKey for the Map Tiles key
// (CI-injected into local-config.js from GOOGLE_MAPS_EMBED_KEY).
//
// Quality: default Fast preset — useBrowserRecommendedResolution=false
// for native HiDPI, resolutionScale capped at ~4K render width to spare
// high-DPR displays, SSE=12 for balanced tile load, FXAA on.

(function (root) {
  async function initHike3DMap(containerId, opts) {
    var apiKey = root.HIKING_CONFIG && root.HIKING_CONFIG.googleMapsApiKey;
    var container = document.getElementById(containerId);
    if (!apiKey) {
      container.innerHTML =
        '<div style="padding:1.5rem;text-align:center;color:#9aa;font-size:.9rem">' +
        'Photorealistic 3D needs a Google Maps Platform API key.<br>' +
        '<small>(window.HIKING_CONFIG.googleMapsApiKey is not set)</small></div>';
      return;
    }

    var TRAILHEAD = opts.trailhead;             // [lon, lat]
    var SUMMIT    = opts.summit;
    var TRAIL_NAME = opts.trailheadName || 'Trailhead';
    var PEAK_NAME  = opts.peakName || 'Summit';
    var PEAK_ELEV  = opts.peakElev;

    var viewer = new Cesium.Viewer(containerId, {
      baseLayer: false, baseLayerPicker: false,
      timeline: false, animation: false, geocoder: false,
      sceneModePicker: false, navigationHelpButton: false,
      homeButton: false, infoBox: false, selectionIndicator: false,
      globe: false
    });
    viewer.scene.skyAtmosphere.show = true;

    // FXAA — cheap, helps ridge edges.
    if (viewer.scene.postProcessStages && viewer.scene.postProcessStages.fxaa) {
      viewer.scene.postProcessStages.fxaa.enabled = true;
    }

    // Quality: native HiDPI, capped at ~4K render width (5K Retina otherwise
    // pays 7× the GPU cost of a 1080p monitor for negligible visual benefit).
    viewer.useBrowserRecommendedResolution = false;
    var dpr = window.devicePixelRatio || 1;
    var targetMaxWidth = 3840;
    var fullWidth = window.innerWidth * dpr;
    if (fullWidth > targetMaxWidth) {
      viewer.resolutionScale = targetMaxWidth / fullWidth;
    }

    try {
      var tileset = await Cesium.createGooglePhotorealistic3DTileset(apiKey);
      tileset.maximumScreenSpaceError = 12;
      viewer.scene.primitives.add(tileset);
    } catch (err) {
      container.innerHTML =
        '<div style="padding:1.5rem;text-align:center;color:#a44">' +
        'Could not load Google Photorealistic 3D Tiles<br>' +
        '<small>' + (err && err.message ? err.message : String(err)) + '</small></div>';
      return;
    }

    // GPX track overlay — track.js sets window.TRACK = [[lat, lon, ele], ...]
    var trackCoords = (root.TRACK || []).flatMap(function (p) { return [p[1], p[0]]; });
    if (trackCoords.length) {
      viewer.entities.add({
        name: 'GPX Track',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(trackCoords),
          width: 4,
          material: new Cesium.PolylineOutlineMaterialProperty({
            color: Cesium.Color.fromCssColorString('#e74c3c'),
            outlineWidth: 1.5,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6)
          }),
          clampToGround: true
        }
      });
    }

    // Trailhead + summit pins, with labels.
    var pinLabel = function (text) {
      return {
        text: text, font: '12px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -18),
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      };
    };
    viewer.entities.add({
      name: 'Trailhead',
      position: Cesium.Cartesian3.fromDegrees(TRAILHEAD[0], TRAILHEAD[1]),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#27ae60'),
        outlineColor: Cesium.Color.WHITE, outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
      },
      label: pinLabel(TRAIL_NAME)
    });
    viewer.entities.add({
      name: 'Summit',
      position: Cesium.Cartesian3.fromDegrees(SUMMIT[0], SUMMIT[1]),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#c0392b'),
        outlineColor: Cesium.Color.WHITE, outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
      },
      label: pinLabel(PEAK_NAME + (PEAK_ELEV ? ' ' + PEAK_ELEV + ' m' : ''))
    });

    // Auto-frame the whole hike. Bounding sphere over track + endpoints,
    // 5× radius pull-back at a -50° pitch keeps the entire track on screen
    // with margin. Floor of 5000 m for short hikes.
    var framingPoints = ((root.TRACK || []).map(function (p) {
      return Cesium.Cartesian3.fromDegrees(p[1], p[0]);
    })).concat([
      Cesium.Cartesian3.fromDegrees(TRAILHEAD[0], TRAILHEAD[1]),
      Cesium.Cartesian3.fromDegrees(SUMMIT[0], SUMMIT[1])
    ]);
    var sphere = Cesium.BoundingSphere.fromPoints(framingPoints);
    viewer.camera.flyToBoundingSphere(sphere, {
      duration: 0,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(35),
        Cesium.Math.toRadians(-50),
        Math.max(sphere.radius * 5, 5000)
      )
    });
  }

  root.initHike3DMap = initHike3DMap;
})(window);
