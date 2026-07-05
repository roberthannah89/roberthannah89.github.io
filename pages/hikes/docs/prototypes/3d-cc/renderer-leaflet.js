/* 3d-cc Leaflet renderer.
 *
 * Extracted from command-center.js (initMap, createMarkers, bindMarkerTooltips,
 * openPopup, refreshMarkerIcons, dominantClusterWeather, updateLabelVisibility)
 * with the FIRST-CLICK REGRESSION GUARD preserved verbatim. If you edit the
 * marker/tooltip/popup code, read the guard comment inside bindMarkerTooltips
 * first — three interlocking pieces must survive together or the popup
 * regression comes back.
 *
 * Exposes: window.CCRenderer.createLeaflet() → Renderer
 */
(function () {
  'use strict';

  var CCR = window.CCRenderer;
  var LABEL_ZOOM = 11;

  // Sky-category tints for cluster icon backgrounds. Kept in sync with
  // command-center.css / WeatherService.SKY_CATEGORIES.
  var SKY_TINTS = {
    clear:  { bg: '#fff6d5', border: '#e2c14c', color: '#8a6b1b' },
    cloudy: { bg: '#e6ecf2', border: '#a7b6c5', color: '#4a5a6b' },
    rain:   { bg: '#d5e2f0', border: '#5a83b8', color: '#25446e' },
    snow:   { bg: '#eaf1fa', border: '#89a7cc', color: '#3d5a80' },
    storm:  { bg: '#e2d9ee', border: '#8b6ba8', color: '#4b2f6b' }
  };

  window.CCRenderer.createLeaflet = function createLeafletRenderer() {
    var map = null;
    var clusterGroup = null;
    var slopeLayer = null;
    var borderLayer = null;
    var selectedHalo = null;
    var allMarkers = [];
    var poiMarkerIx = new Map();      // poiId → L.marker
    var filteredIds = null;           // null = show all
    var labelsBound = false;

    var onSelect = null;
    var onEmpty = null;

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    }); }

    /* ── Cluster weather aggregation ─────────────────────────── */
    function dominantClusterWeather(cluster) {
      if (!window.WeatherService || !WeatherService.skyCategory || !WeatherService.SKY_CATEGORIES) return null;
      var dayIdx = Filters.getState().weatherDay;
      var counts = {};
      var tempSum = 0, tempN = 0;
      cluster.getAllChildMarkers().forEach(function (m) {
        var poi = m._poi;
        if (!poi) return;
        var wx = WeatherService.getForPeak(poi.lat, poi.lon, dayIdx);
        if (!wx) return;
        var cat = WeatherService.skyCategory(wx.code);
        if (cat) counts[cat] = (counts[cat] || 0) + 1;
        if (typeof wx.tempMax === 'number') { tempSum += wx.tempMax; tempN++; }
      });
      var best = null, max = 0;
      Object.keys(counts).forEach(function (k) {
        if (counts[k] > max) { best = k; max = counts[k]; }
      });
      if (!best) return null;
      var defn = WeatherService.SKY_CATEGORIES.find(function (c) { return c.key === best; });
      return {
        tint: SKY_TINTS[best],
        emoji: defn ? defn.icon : '',
        temp: tempN > 0 ? (tempSum / tempN) : null
      };
    }

    /* ── Hike icon builders ──────────────────────────────────── */
    function makeHikeIcon(color, mode, wxIcon, tempStr, hasPage, aboveFreezing) {
      var pageCls = hasPage ? ' hike-marker--has-page' : '';
      var frzCls = aboveFreezing ? ' hike-marker--above-freezing' : '';
      if (mode === 'weather' && wxIcon) {
        var temp = tempStr ? '<span class="hike-marker__temp">' + tempStr + '</span>' : '';
        return L.divIcon({
          className: '',
          html: '<div class="hike-marker hike-marker--wx' + pageCls + frzCls + '" style="border-color:' + color + ';background:' + color + '22">'
            + '<span class="hike-marker__wx">' + wxIcon + '</span>' + temp + '</div>',
          iconSize: [40, 28],
          iconAnchor: [20, 14]
        });
      }
      return L.divIcon({
        className: '',
        html: '<div class="hike-marker hike-marker--dot' + pageCls + frzCls + '" style="background:' + color + '"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      });
    }

    /* ── Tooltip content builders ────────────────────────────── */
    function buildPoiMetaLine(poi, display) {
      var r = (poi.routes && poi.routes[0]) || null;
      var parts = [];
      if (display.indexOf('grade') !== -1) {
        var g = Filters.bestGrade(poi);
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

    /* ── Popup ───────────────────────────────────────────────── */
    function popupMetaLine(poi) {
      var parts = [];
      parts.push((poi.alt || '—') + ' m');
      if (poi.routes && poi.routes.length > 0) {
        var r = poi.routes[0];
        if (r.gain) parts.push(r.gain + ' m gain');
        if (r.time_up) parts.push('↑ ' + Math.round(r.time_up / 60) + 'h');
      }
      return parts.join(' · ');
    }
    function openPopup(poi, marker) {
      var html;
      if (window.HikePopup && HikePopup.build) {
        var dayIdx = Filters.getState().weatherDay;
        var wx = window.WeatherService && WeatherService.getForPeak
          ? WeatherService.getForPeak(poi.lat, poi.lon, dayIdx) : null;
        var hike = (window.SidePanel && SidePanel.matchingHike) ? SidePanel.matchingHike(poi) : null;
        var photos = hike && hike.photos && hike.photos.length
          ? hike.photos : (hike && hike.photo ? [hike.photo] : []);
        html = HikePopup.build({
          name: poi.name, grade: Filters.bestGrade(poi),
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
        // Fallback popup when HikePopup isn't loaded — happens in the
        // stand-alone prototype context after upstream refactored the shared
        // engine into hike_map/. Still useful; just plainer.
        html = '<div class="cc3d-popup">' +
               '<div style="font-weight:600;font-size:14px">' + esc(poi.name) + '</div>' +
               '<div style="color:#6b7078;font-size:12px;margin-top:4px">' + esc(popupMetaLine(poi)) + '</div>' +
               '</div>';
      }
      // Popup rebind pattern is load-bearing — see FIRST-CLICK REGRESSION GUARD
      // comment in bindMarkerTooltips(). Always reuse existing popup via
      // setPopupContent(); only bindPopup() on the first open.
      if (marker.getPopup()) marker.setPopupContent(html);
      else marker.bindPopup(html, { maxWidth: 300 });
      marker.openPopup();
    }

    /* ── Permanent tooltips + FIRST-CLICK REGRESSION GUARD ───── */
    function bindMarkerTooltips() {
      var display = Filters.getState().display || [];
      allMarkers.forEach(function (m) {
        if (m.getTooltip()) return;
        // ⚠️ FIRST-CLICK REGRESSION GUARD (do not change without reading):
        // Three things together prevent "popup needs Enter to open on first
        // click":
        //   1. `interactive: false` here so the permanent tooltip never eats
        //      the marker click.
        //   2. `.leaflet-tooltip-pane { pointer-events: none; }` in
        //      3d-cc.css (mirrors command-center.css) — belt-and-braces on
        //      the entire tooltip pane.
        //   3. `openPopup()` uses `getPopup() / setPopupContent()` instead of
        //      always calling `bindPopup()` so re-clicks reuse the existing
        //      popup instead of binding a new one mid-event.
        // If you remove any of the three, the popup will require a second
        // click (or Enter) to open.
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
      var show = map.getZoom() >= LABEL_ZOOM;
      document.body.classList.toggle('zoom-labels', show);
      if (show === labelsBound) return;
      if (show) bindMarkerTooltips(); else unbindMarkerTooltips();
      labelsBound = show;
    }

    /* ── Filter application ─────────────────────────────────── */
    function applyFilter() {
      if (!clusterGroup) return;
      clusterGroup.clearLayers();
      allMarkers.forEach(function (m) {
        var id = CCR.poiId(m._poi);
        var visible = filteredIds ? filteredIds.has(id) : true;
        m._filtered = !visible;
        if (visible) clusterGroup.addLayer(m);
      });
    }

    /* ── Interface implementation ───────────────────────────── */
    function init(container, initialViewport, opts) {
      return new Promise(function (resolve) {
        map = L.map(container, {
          center: [initialViewport.lat || CCR.HOME_VIEWPORT.lat,
                   initialViewport.lng || CCR.HOME_VIEWPORT.lng],
          zoom: initialViewport.zoom || CCR.HOME_VIEWPORT.zoom,
          zoomControl: false
        });
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // Plain SwissTopo topo tile layer — MapShared's fancy layer switcher
        // is skipped here to keep the prototype focused. Its layer bar
        // otherwise leaks into 3D mode across teardown (the DOM lives outside
        // the map container).
        L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
          maxZoom: 18, attribution: '&copy; swisstopo'
        }).addTo(map);

        clusterGroup = L.markerClusterGroup({
          maxClusterRadius: CCR.CLUSTER.maxClusterRadius,
          disableClusteringAtZoom: CCR.CLUSTER.disableClusteringAtZoom,
          spiderfyOnMaxZoom: true, showCoverageOnHover: false,
          chunkedLoading: true,
          iconCreateFunction: function (cluster) {
            var count = cluster.getChildCount();
            var info = dominantClusterWeather(cluster);
            var style = info && info.tint
              ? 'background:' + info.tint.bg + ';border-color:' + info.tint.border + ';color:' + info.tint.color
              : '';
            var emoji = info && info.emoji ? info.emoji : '';
            var tempStr = info && info.temp !== null ? Math.round(info.temp) + '°' : '';
            return L.divIcon({
              html: '<div style="' + style + '">'
                + '<span class="cl-n">' + count + '</span>'
                + (emoji ? '<span class="cl-wx">' + emoji + '</span>' : '')
                + (tempStr ? '<span class="cl-t">' + tempStr + '</span>' : '')
                + '</div>',
              className: 'marker-cluster', iconSize: L.point(64, 28)
            });
          }
        });
        map.addLayer(clusterGroup);

        map.on('zoomend', updateLabelVisibility);
        map.on('click', function () { if (onEmpty) onEmpty(); });

        resolve();
      });
    }

    function teardown() {
      if (map) { try { map.remove(); } catch (e) {} }
      map = null; clusterGroup = null; slopeLayer = null; borderLayer = null;
      selectedHalo = null; allMarkers = []; poiMarkerIx = new Map();
      filteredIds = null; labelsBound = false;
    }

    function setHikes(pois) {
      allMarkers.forEach(function (m) { try { clusterGroup.removeLayer(m); } catch (e) {} });
      allMarkers = []; poiMarkerIx = new Map();
      pois.forEach(function (poi) {
        if (!poi.lat || !poi.lon) return;
        var grade = Filters.bestGrade(poi);
        var color = CCR.gradeColor(grade);
        var hasPage = !!(window.SidePanel && SidePanel.matchingHike && SidePanel.matchingHike(poi));
        poi._hasPage = hasPage;
        var marker = L.marker([poi.lat, poi.lon], {
          icon: makeHikeIcon(color, 'dot', null, null, hasPage)
        });
        marker._poi = poi; marker._color = color;
        marker._hasPage = hasPage; marker._filtered = false;
        marker.on('click', function (e) {
          L.DomEvent.stopPropagation(e);
          if (onSelect) onSelect(poi);
          if (!window.SidePanel || !SidePanel.isOpen()) openPopup(poi, marker);
        });
        marker.on('popupopen', function (e) {
          if (window.SidePanel && SidePanel.isOpen()) { marker.closePopup(); return; }
          var el = e.popup.getElement(); if (!el) return;
          var btn = el.querySelector('.popup-expand');
          if (btn) btn.onclick = function () { marker.closePopup(); SidePanel.open(poi); };
          if (window.HikePopup && HikePopup.bindCarousel) HikePopup.bindCarousel(el);
        });
        allMarkers.push(marker);
        poiMarkerIx.set(CCR.poiId(poi), marker);
      });
      applyFilter();
      updateLabelVisibility();

      // Swiss border, drawn once
      if (window.SWISS_BORDER && !borderLayer) {
        borderLayer = L.geoJSON(window.SWISS_BORDER, {
          style: { color: '#8b4513', weight: 1.5, fill: false, opacity: 0.6 }
        }).addTo(map);
      }
    }

    function setFilteredIds(idSet) {
      filteredIds = idSet;
      applyFilter();
    }

    function setSelection(poi) {
      if (selectedHalo) { try { map.removeLayer(selectedHalo); } catch (e) {} selectedHalo = null; }
      if (!poi) return;
      selectedHalo = L.circleMarker([poi.lat, poi.lon], {
        radius: 14, color: '#c0392b', weight: 3, fill: false, opacity: 0.8
      }).addTo(map);
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
      map.flyTo([target.lat, target.lng], target.zoom || Math.max(map.getZoom(), 13), { duration: 1 });
    }

    function setLayerVisible(layerId, on) {
      if (layerId === 'slope') {
        if (on && !slopeLayer) {
          // Slope ≥ 30° — swisstopo WMTS
          slopeLayer = L.tileLayer(
            'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo-karto.hangneigung/default/current/3857/{z}/{x}/{y}.png',
            { maxZoom: 18, opacity: 0.55, attribution: '&copy; swisstopo' }
          ).addTo(map);
        } else if (!on && slopeLayer) {
          map.removeLayer(slopeLayer); slopeLayer = null;
        }
      }
      // 'trails', 'peaks-panel' — 3D-only; silent no-op in Leaflet
    }

    return {
      init: init, teardown: teardown,
      setHikes: setHikes, setFilteredIds: setFilteredIds,
      setSelection: setSelection,
      getViewport: getViewport, setViewport: setViewport, flyTo: flyTo,
      setLayerVisible: setLayerVisible,
      onSelectHike: function (cb) { onSelect = cb; },
      onEmptyClick: function (cb) { onEmpty = cb; },
      supports: { slope: true, trails: false, 'peaks-panel': false },
      // Called externally when weather day/display filter changes
      refreshMarkerIcons: function () {
        var s = Filters.getState();
        var dayIdx = s.weatherDay;
        var showWeather = (s.display || []).indexOf('weather') !== -1;
        allMarkers.forEach(function (m) {
          var poi = m._poi;
          var wx = WeatherService.getForPeak(poi.lat, poi.lon, dayIdx);
          var fl = wx ? wx.freezingLevel : null;
          var aboveFreezing = !!(poi.alt && fl != null && poi.alt > fl);
          m._aboveFreezing = aboveFreezing;
          if (!showWeather || !wx) {
            m.setIcon(makeHikeIcon(m._color, 'dot', null, null, m._hasPage, aboveFreezing));
            return;
          }
          var emoji = WeatherService.weatherIcon(wx.code);
          var tempStr = wx.tempMax != null ? Math.round(wx.tempMax) + '°' : '';
          m.setIcon(makeHikeIcon(m._color, 'weather', emoji, tempStr, m._hasPage, aboveFreezing));
        });
      },
      refreshMarkerTooltips: function () {
        var display = Filters.getState().display || [];
        allMarkers.forEach(function (m) {
          var tip = m.getTooltip();
          if (tip) tip.setContent(tooltipContent(m._poi, display));
        });
      }
    };
  };
})();
