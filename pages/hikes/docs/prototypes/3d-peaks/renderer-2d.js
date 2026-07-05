/* 3d-peaks — 2D renderer (Leaflet).
 *
 * Mirrors command-center's Leaflet pipeline exactly: MapShared base layers,
 * hike_map ClusterGroupFactory + MarkerFactory, lazy permanent tooltips
 * with the FIRST-CLICK REGRESSION GUARD. Nothing here is new logic — it's
 * the same code path CC takes today. When we productionize this prototype,
 * this file collapses back into command-center.js's initMap/createMarkers.
 *
 * Exposes: window.CC3DPeaks.Renderer2D
 */
(function () {
  'use strict';

  var LABEL_ZOOM = 11;

  window.CC3DPeaks = window.CC3DPeaks || {};

  window.CC3DPeaks.Renderer2D = function createRenderer2D(deps) {
    var store = deps.store;
    var matcher = deps.matcher;
    var wxLookup = deps.wxLookup;
    var markerFactory = deps.markerFactory;
    var panel = deps.panel;                     // may be null until orchestrator mounts SidePanel
    var matchingHike = deps.matchingHike;
    var toMatchable = deps.toMatchable;
    var bestGrade = deps.bestGrade;

    var map = null;
    var clusterGroup = null;
    var allMarkers = [];
    var labelsBound = false;
    var lastPois = [];

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    }); }
    function formatTime(min) {
      var h = Math.floor(min / 60), m = min % 60;
      return h + 'h' + (m ? ' ' + m + 'm' : '');
    }

    function popupMetaLine(poi) {
      var parts = [];
      parts.push((poi.alt || '—') + ' m');
      if (poi.routes && poi.routes.length > 0) {
        var r = poi.routes[0];
        if (r.gain) parts.push(r.gain + ' m gain');
        if (r.time_up) parts.push('↑ ' + formatTime(r.time_up));
      }
      return parts.join(' · ');
    }

    function buildPoiMetaLine(poi, display) {
      var r = (poi.routes && poi.routes[0]) || null;
      var parts = [];
      if (display.indexOf('grade') !== -1) {
        var g = bestGrade(poi);
        if (g) parts.push(g);
      }
      if (display.indexOf('gain') !== -1 && r && r.gain) parts.push(r.gain + 'm');
      if (display.indexOf('time') !== -1 && r && r.time_up) {
        var h = r.time_up / 60;
        parts.push(((h % 1 === 0) ? h + 'h' : h.toFixed(1) + 'h') + ' ↑');
      }
      if (display.indexOf('alt') !== -1 && poi.alt) parts.push(Math.round(poi.alt) + 'm');
      return parts.join(' · ');
    }
    function tooltipContent(poi, display) {
      var lines = [];
      if (poi.name) lines.push('<span class="hike-tt__name">' + esc(poi.name) + '</span>');
      var meta = buildPoiMetaLine(poi, display);
      if (meta) lines.push('<span class="hike-tt__meta">' + esc(meta) + '</span>');
      return lines.join('');
    }

    function openPopup(poi, marker) {
      var html;
      if (window.HikePopup && HikePopup.build) {
        var dayIdx = store.get('d');
        var wx = wxLookup.get(poi.lat, poi.lon, dayIdx);
        var hike = matchingHike ? matchingHike(poi) : null;
        var photos = hike && hike.photos && hike.photos.length
          ? hike.photos : (hike && hike.photo ? [hike.photo] : []);
        html = HikePopup.build({
          name: poi.name, grade: bestGrade(poi),
          metaLine: popupMetaLine(poi), photos: photos,
          weather: wx ? {
            code: wx.code, tempMax: wx.tempMax, precip: wx.precip,
            windMax: wx.windMax, freezingLevel: wx.freezingLevel,
            date: wx.date, peakAlt: poi.alt
          } : null,
          hikeHref: hike ? '../../' + hike.href : null,
          showExpand: true
        });
      } else {
        html = '<div><b>' + esc(poi.name) + '</b><br>' + esc(popupMetaLine(poi)) + '</div>';
      }
      // FIRST-CLICK REGRESSION GUARD (see engine DESIGN.md § popup guard):
      // reuse the existing popup via setPopupContent() rather than binding
      // a fresh one on every re-click.
      if (marker.getPopup()) marker.setPopupContent(html);
      else marker.bindPopup(html, { maxWidth: 300 });
      marker.openPopup();
    }

    function bindMarkerTooltips() {
      var display = store.get('dp') || [];
      allMarkers.forEach(function (m) {
        if (m.getTooltip()) return;
        // interactive:false — part of the first-click guard (see DESIGN.md).
        m.bindTooltip(tooltipContent(m._poi, display), {
          permanent: true, interactive: false, direction: 'right',
          offset: [22, 0], className: 'hike-tooltip'
        });
      });
    }
    function unbindMarkerTooltips() {
      allMarkers.forEach(function (m) { if (m.getTooltip()) m.unbindTooltip(); });
    }
    function updateLabelVisibility() {
      if (!map) return;
      var show = map.getZoom() >= LABEL_ZOOM;
      document.body.classList.toggle('zoom-labels', show);
      if (show === labelsBound) return;
      if (show) bindMarkerTooltips(); else unbindMarkerTooltips();
      labelsBound = show;
    }

    function refreshCluster() {
      if (!clusterGroup) return;
      clusterGroup.clearLayers();
      allMarkers.forEach(function (m) {
        if (!m._filtered) clusterGroup.addLayer(m);
      });
    }

    function createMarkers(pois) {
      // Wipe any existing markers first (mode-switch case)
      allMarkers.forEach(function (m) { try { clusterGroup.removeLayer(m); } catch (e) {} });
      allMarkers = [];

      pois.forEach(function (poi) {
        if (!poi.lat || !poi.lon) return;

        poi.grade = bestGrade(poi);
        var hasPage = !!(matchingHike && matchingHike(poi));
        poi._hasPage = hasPage;
        poi.hasPage = hasPage;

        var marker = L.marker([poi.lat, poi.lon], {
          icon: markerFactory.makeIcon(poi, store.get('d'))
        });
        marker._poi = poi;
        marker._filtered = false;

        marker.on('click', function () {
          if (panel && panel.isOpen()) {
            panel.open(poi);
          } else {
            openPopup(poi, marker);
          }
        });
        marker.on('popupopen', function (e) {
          if (panel && panel.isOpen()) { marker.closePopup(); return; }
          var el = e.popup.getElement(); if (!el) return;
          var btn = el.querySelector('.popup-expand');
          if (btn) btn.onclick = function () { marker.closePopup(); if (panel) panel.open(poi); };
          if (window.HikePopup && HikePopup.bindCarousel) HikePopup.bindCarousel(el);
        });

        allMarkers.push(marker);
      });

      updateLabelVisibility();
      refreshCluster();
    }

    function init(container, viewport) {
      return new Promise(function (resolve) {
        var v = viewport || { lng: 8.2, lat: 46.8, zoom: 9 };
        map = L.map(container, {
          center: [v.lat, v.lng], zoom: v.zoom || 9,
          zoomControl: false
        });
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // MapShared base-layer switcher — same as CC. If it's not on the page,
        // fall back to plain SwissTopo topo tiles.
        if (window.MapShared && MapShared.addLayerControl) {
          MapShared.addLayerControl(map, { defaultLayer: 'hike' });
          var lbar = document.querySelector('.ms-layer-bar');
          var bbar = document.getElementById('bottom-bar');
          if (lbar && bbar) bbar.insertBefore(lbar, bbar.firstChild);
        } else {
          L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
            maxZoom: 18, attribution: '&copy; swisstopo'
          }).addTo(map);
        }

        clusterGroup = window.HikeMap.ClusterGroupFactory({
          wxLookup: wxLookup,
          dayIndexGetter: function () { return store.get('d'); }
        });
        map.addLayer(clusterGroup);
        map.on('zoomend', updateLabelVisibility);

        resolve();
      });
    }

    function teardown() {
      if (map) {
        try { map.remove(); } catch (e) {}
        map = null;
      }
      clusterGroup = null; allMarkers = []; labelsBound = false;
      // MapShared inserts .ms-layer-bar into #bottom-bar; strip it so 3D mode
      // doesn't inherit a stray Leaflet-only chrome element.
      var lbar = document.querySelector('.ms-layer-bar');
      if (lbar && lbar.parentNode) lbar.parentNode.removeChild(lbar);
    }

    function setPois(pois) {
      lastPois = pois;
      if (!map || !clusterGroup) return;
      createMarkers(pois);
    }

    function applyVisibility(state) {
      allMarkers.forEach(function (m) {
        var poi = m._poi;
        var show = matcher.match(toMatchable(poi), state);
        m._filtered = !show;
      });
      refreshCluster();
    }

    function refreshIcons() {
      var dayIdx = store.get('d');
      allMarkers.forEach(function (m) { m.setIcon(markerFactory.makeIcon(m._poi, dayIdx)); });
    }
    function refreshTooltips() {
      var display = store.get('dp') || [];
      allMarkers.forEach(function (m) {
        var tip = m.getTooltip();
        if (tip) tip.setContent(tooltipContent(m._poi, display));
      });
    }

    function getViewport() {
      if (!map) return null;
      var c = map.getCenter();
      return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: 0, bearing: 0 };
    }
    function setViewport(v) {
      if (!map || !v) return;
      map.setView([v.lat, v.lng], v.zoom, { animate: false });
    }
    function flyTo(target) {
      if (!map) return;
      map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 13), { duration: 1 });
    }

    return {
      init: init, teardown: teardown,
      setPois: setPois,
      // CH_PEAKS + the `peaks` toggle are 3D-only concepts — 2D silently
      // ignores them. Showing 7,500 dots on a Leaflet map isn't valuable
      // and would trash the CC-parity feel.
      setChPeaks: function () {},
      setLayerVisibility: function () {},
      applyVisibility: applyVisibility,
      refreshIcons: refreshIcons,
      refreshTooltips: refreshTooltips,
      getViewport: getViewport, setViewport: setViewport, flyTo: flyTo,
      supports: { trails: false, tour: false, peaks: false },
      // Called by the orchestrator's async avalanche/webcam boot to hand us
      // a Leaflet layer to add. In 3D these no-op.
      addLayer: function (layer) { if (map && layer) map.addLayer(layer); },
      removeLayer: function (layer) { if (map && layer) map.removeLayer(layer); }
    };
  };
})();
