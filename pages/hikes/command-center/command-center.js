/* Command Center — main orchestrator */
(function () {
  'use strict';

  var map, clusterGroup;
  var allMarkers = [];
  // Reference-city markers — not hikes, not filtered, not clustered. Added
  // directly to the map in their own layer group so the toggle simply
  // add/removes the group without touching the hike pipeline.
  var cityMarkers = [];
  var cityLayer = null;

  // Zoom at/above which permanent name labels show. Below it the tooltips are
  // unbound entirely (not just CSS-hidden) so Leaflet does zero per-marker
  // tooltip repositioning while panning/zooming the overview. See
  // updateLabelVisibility().
  var LABEL_ZOOM = 11;
  var labelsBound = false;

  // Grade colors
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

  /* ── Map setup ─────────────────────────────────────── */

  function initMap() {
    map = L.map('map', {
      center: [46.8, 8.2],
      zoom: 9,
      zoomControl: false
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Base layer switcher (Topo+Trails / Topo / Aerial / OSM) + Swiss border + fullscreen
    if (window.MapShared && MapShared.addLayerControl) {
      MapShared.addLayerControl(map, { defaultLayer: 'hike' });
      // Relocate the layer bar into the bottom-bar so it sits in a horizontal
      // strip alongside the route counter and forecast meta.
      var lbar = document.querySelector('.ms-layer-bar');
      var bbar = document.getElementById('bottom-bar');
      if (lbar && bbar) bbar.insertBefore(lbar, bbar.firstChild);
    } else {
      L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
        maxZoom: 18,
        attribution: '&copy; swisstopo'
      }).addTo(map);
    }

    // Cluster group — tinted by dominant weather of contained markers
    clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 45,
      disableClusteringAtZoom: 13,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      // Time-slice marker add/remove so a pan that brings hundreds of markers
      // into view doesn't block a single frame.
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
          className: 'marker-cluster',
          iconSize: L.point(64, 28)
        });
      }
    });
    map.addLayer(clusterGroup);

    // Bind/unbind permanent name labels around LABEL_ZOOM. Markers are
    // created after initMap, so the first real bind happens from
    // createMarkers; this keeps labels in sync on every later zoom.
    map.on('zoomend', updateLabelVisibility);
  }

  /* ── Route markers ─────────────────────────────────── */

  function createMarkers(routes) {
    routes.forEach(function (poi) {
      if (!poi.lat || !poi.lon) return;

      var grade = Filters.bestGrade(poi);
      var color = gradeColor(grade);
      // Subtle amber ring on markers whose hike has a built page in this repo.
      // Reuses SidePanel.matchingHike so we don't drift from the panel's link logic.
      var hasPage = !!(window.SidePanel && SidePanel.matchingHike && SidePanel.matchingHike(poi));
      poi._hasPage = hasPage;

      var marker = L.marker([poi.lat, poi.lon], {
        icon: makeHikeIcon(color, 'dot', null, null, hasPage)
      });

      marker._poi = poi;
      marker._color = color;
      marker._hasPage = hasPage;
      marker._filtered = false;

      // Permanent name tooltips are bound lazily by updateLabelVisibility()
      // once the user zooms past LABEL_ZOOM — not here — so the overview
      // doesn't carry ~960 tooltip DOM nodes. The first-click regression
      // guard lives with the bindTooltip call in bindMarkerTooltips().

      marker.on('click', function () {
        if (window.SidePanel && SidePanel.isOpen()) {
          SidePanel.open(poi);
        } else {
          openPopup(poi, marker);
        }
      });

      marker.on('popupopen', function (e) {
        // Once a popup has been bound, Leaflet auto-toggles it on every marker
        // click. When the side panel is already open we want clicks to act as
        // pure panel updates with no popup at all — so suppress the popup the
        // moment it opens. Keep this *and* the click-handler branch above:
        // the click handler also routes directly to SidePanel.open so the
        // panel updates immediately without waiting for the popup-then-close.
        if (window.SidePanel && SidePanel.isOpen()) {
          marker.closePopup();
          return;
        }
        var el = e.popup.getElement();
        if (!el) return;
        var btn = el.querySelector('.popup-expand');
        if (btn) {
          btn.onclick = function () {
            marker.closePopup();
            SidePanel.open(poi);
          };
        }
      });

      allMarkers.push(marker);
    });

    updateLabelVisibility();
    refreshCluster();
  }

  // Three marker modes:
  //   'dot'     — small grade-colored dot (default, clean view)
  //   'weather' — larger ring with weather emoji + temp (when user opts in)
  // Extras:
  //   hasPage        → amber ★ at top-right (built hike page exists in repo)
  //   aboveFreezing  → ❄️ at bottom-right (peak's elev > forecast snow line)
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

  // Re-render every marker's icon based on the currently selected weather day
  // and the Display filter. When 'weather' is in display, markers show the
  // weather pill (emoji + temp); when it isn't, every marker is a small
  // grade-colored dot regardless of forecast data.
  //
  // The ❄️ "above freezing line" badge is computed here so it tracks the
  // selected forecast day — Today might have a 3500 m snow line, Friday might
  // drop to 2200 m. POIs without an `alt` or without forecast freezing data
  // never get the badge.
  function refreshMarkerIcons() {
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
      var tempStr = wx.tempMax !== null && wx.tempMax !== undefined
        ? Math.round(wx.tempMax) + '°' : '';
      m.setIcon(makeHikeIcon(m._color, 'weather', emoji, tempStr, m._hasPage, aboveFreezing));
    });
    // Reference-city pills track the same Day selection so they're directly
    // comparable to the hike markers around them.
    refreshCityMarkers();
  }

  // Build the metadata line for a POI ("T3 · 800m · 3h ↑ · 2700m") based on
  // which non-name fields are currently in the Display filter. Returns an
  // empty string if no metadata fields are selected or no data is available.
  function buildPoiMetaLine(poi, display) {
    var r = (poi.routes && poi.routes[0]) || null;
    var parts = [];
    if (display.indexOf('grade') !== -1) {
      var g = Filters.bestGrade(poi);
      if (g) parts.push(g);
    }
    if (display.indexOf('gain') !== -1 && r && r.gain) {
      parts.push(r.gain + 'm');
    }
    if (display.indexOf('time') !== -1 && r && r.time_up) {
      var h = r.time_up / 60;
      // Whole hours when clean, else one decimal place
      var label = (h % 1 === 0) ? h + 'h' : h.toFixed(1) + 'h';
      parts.push(label + ' ↑');
    }
    if (display.indexOf('alt') !== -1 && poi.alt) {
      parts.push(Math.round(poi.alt) + 'm');
    }
    return parts.join(' · ');
  }

  // Build the tooltip HTML for a POI. The name span is always emitted (its
  // visibility is the O(1) `body.display-name-off` CSS toggle, not a rebuild);
  // the meta line depends on which grade/gain/time/alt fields are selected.
  function tooltipContent(poi, display) {
    var lines = [];
    if (poi.name) {
      lines.push('<span class="hike-tt__name">' + esc(poi.name) + '</span>');
    }
    var meta = buildPoiMetaLine(poi, display);
    if (meta) {
      lines.push('<span class="hike-tt__meta">' + esc(meta) + '</span>');
    }
    return lines.join('');
  }

  // Rebuild content for markers that currently HAVE a tooltip bound. Below
  // LABEL_ZOOM nothing is bound, so this is a cheap no-op; the current Display
  // state is applied when bindMarkerTooltips() runs on zoom-in.
  function refreshMarkerTooltips() {
    var display = Filters.getState().display || [];
    allMarkers.forEach(function (m) {
      var tip = m.getTooltip();
      if (tip) tip.setContent(tooltipContent(m._poi, display));
    });
  }

  /* ── Lazy permanent labels ─────────────────────────── */
  // Permanent tooltips are costly: Leaflet repositions every on-map tooltip on
  // each pan/zoom, and with ~960 markers that dominates overview interaction.
  // So we only bind them at/above LABEL_ZOOM (where they're actually shown) and
  // unbind below it, leaving the overview as plain markers with no tooltip DOM.

  function bindMarkerTooltips() {
    var display = Filters.getState().display || [];
    allMarkers.forEach(function (m) {
      if (m.getTooltip()) return;
      // ⚠️ FIRST-CLICK REGRESSION GUARD (do not change without reading):
      // Three things together prevent "popup needs Enter to open on first
      // click":
      //   1. `interactive: false` here so the permanent tooltip never eats the
      //      marker click (it sits to the right of the marker and would
      //      otherwise absorb the pointer event).
      //   2. `.leaflet-tooltip-pane { pointer-events: none; }` in
      //      command-center.css — belt-and-braces on the entire tooltip pane.
      //   3. `openPopup()` uses `getPopup() / setPopupContent()` instead of
      //      always calling `bindPopup()` (see openPopup) so re-clicks reuse
      //      the existing popup instead of binding a new one mid-event.
      // Original fix: commit c61debf. If you remove any of the three, the
      // popup will require a second click (or Enter) to open.
      m.bindTooltip(tooltipContent(m._poi, display), {
        permanent: true,
        interactive: false,
        direction: 'right',
        offset: [22, 0],
        className: 'hike-tooltip'
      });
    });
  }

  function unbindMarkerTooltips() {
    allMarkers.forEach(function (m) {
      if (m.getTooltip()) m.unbindTooltip();
    });
  }

  // Keep label binding in sync with zoom. body.zoom-labels still drives CSS
  // visibility (and the display-name-off / empty-tooltip rules); the binding
  // state mirrors it so we never pay for tooltip DOM below the threshold.
  function updateLabelVisibility() {
    var show = map.getZoom() >= LABEL_ZOOM;
    document.body.classList.toggle('zoom-labels', show);
    if (show === labelsBound) return;
    if (show) bindMarkerTooltips();
    else unbindMarkerTooltips();
    labelsBound = show;
  }

  function refreshCluster() {
    clusterGroup.clearLayers();
    allMarkers.forEach(function (m) {
      if (!m._filtered) clusterGroup.addLayer(m);
    });
  }

  /* ── Reference cities ──────────────────────────────── */
  // Major Swiss cities rendered as a separate, non-clustered, non-filtered
  // layer purely so the user can eyeball forecast cache values against
  // MeteoSwiss/Google for a known location.

  function makeCityIcon(wxIcon, tempStr) {
    var temp = tempStr ? '<span class="city-marker__temp">' + tempStr + '</span>' : '';
    var wx = wxIcon ? '<span class="city-marker__wx">' + wxIcon + '</span>' : '<span class="city-marker__wx">—</span>';
    return L.divIcon({
      className: '',
      html: '<div class="city-marker">' + wx + temp + '</div>',
      iconSize: [44, 24],
      iconAnchor: [22, 12]
    });
  }

  function createCityMarkers() {
    var cities = window.CITIES || [];
    if (!cities.length) return;
    cityLayer = L.layerGroup();
    cities.forEach(function (city) {
      var marker = L.marker([city.lat, city.lon], {
        icon: makeCityIcon(null, null),
        // Render above hike markers so the reference pill is never buried
        // by a same-cell hike — cities are sparse enough that this is fine.
        zIndexOffset: 1000
      });
      marker._city = city;
      marker.bindTooltip(city.name, {
        permanent: true,
        interactive: false,
        direction: 'top',
        offset: [0, -10],
        className: 'city-tooltip'
      });
      marker.on('click', function () { openCityPopup(city, marker); });
      cityMarkers.push(marker);
      cityLayer.addLayer(marker);
    });
  }

  function refreshCityMarkers() {
    if (!cityMarkers.length) return;
    var dayIdx = Filters.getState().weatherDay;
    cityMarkers.forEach(function (m) {
      var c = m._city;
      var wx = WeatherService.getForPeak(c.lat, c.lon, dayIdx);
      var emoji = wx ? WeatherService.weatherIcon(wx.code) : null;
      var tempStr = wx && wx.tempMax != null ? Math.round(wx.tempMax) + '°' : '';
      m.setIcon(makeCityIcon(emoji, tempStr));
    });
  }

  function openCityPopup(city, marker) {
    var dayIdx = Filters.getState().weatherDay;
    var wx = WeatherService.getForPeak(city.lat, city.lon, dayIdx);
    var html = '<div class="popup-name">🏙️ ' + esc(city.name) + '</div>';
    html += '<div class="popup-meta">' + (city.alt || '—') + ' m · reference point</div>';
    if (wx) {
      var dayLabel = WeatherService.formatDayLabel(wx.date);
      html += '<div class="popup-weather">';
      html += WeatherService.weatherIcon(wx.code) + ' ' + dayLabel + ': ';
      html += WeatherService.weatherLabel(wx.code);
      html += ', ' + Math.round(wx.tempMax) + '°C';
      if (wx.precip > 0) html += ', ' + wx.precip.toFixed(1) + 'mm';
      html += ', 💨 ' + Math.round(wx.windMax) + ' km/h';
      html += '</div>';
    } else {
      html += '<div class="popup-weather">No forecast cached — run <code>make weather</code></div>';
    }
    // Direct link to MeteoSwiss's location forecast so the user can verify the
    // cached value against the source they actually trust.
    var meteo = 'https://www.meteoswiss.admin.ch/#tab=forecast-map'
      + '&lat=' + city.lat + '&lon=' + city.lon + '&zoom=9';
    html += '<div class="popup-links">'
      + '<a href="' + meteo + '" target="_blank" rel="noopener">MeteoSwiss ↗</a>'
      + '</div>';
    if (marker.getPopup()) marker.setPopupContent(html);
    else marker.bindPopup(html, { maxWidth: 280 });
    marker.openPopup();
  }

  // Mapping from sky category to cluster fill/border/text colors.
  var SKY_TINTS = {
    'clear':         { bg: 'rgba(232, 168, 50, 0.85)',  border: '#e8a832', color: '#1a1810' },
    'partly-cloudy': { bg: 'rgba(168, 152, 120, 0.85)', border: '#a89878', color: '#1a1810' },
    'cloudy':        { bg: 'rgba(60, 60, 70, 0.85)',    border: '#6a6a78', color: '#f0e8d8' },
    'rain':          { bg: 'rgba(80, 130, 200, 0.85)',  border: '#5082c8', color: '#f0e8d8' },
    'snow':          { bg: 'rgba(220, 230, 240, 0.85)', border: '#dce6f0', color: '#1a1810' },
    'storm':         { bg: 'rgba(180, 60, 60, 0.85)',   border: '#b43c3c', color: '#f0e8d8' }
  };

  function dominantClusterWeather(cluster) {
    if (!WeatherService || !WeatherService.skyCategory) return null;
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

  /* Build the metadata line shown under the name in the popup. Kept short —
     the popup is a peek; the side panel is the deep-dive. */
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

  function openPopup(poi, marker) {
    var dayIdx = Filters.getState().weatherDay;
    var wx = WeatherService.getForPeak(poi.lat, poi.lon, dayIdx);
    /* If a built hike page matches this POI, surface a direct link in the
       popup so users can jump straight to it without opening the side panel
       first. Reuses SidePanel.matchingHike so we stay in sync with the
       panel-hero link logic. */
    var hike = (window.SidePanel && SidePanel.matchingHike)
      ? SidePanel.matchingHike(poi) : null;

    var html = window.HikePopup.build({
      name: poi.name,
      grade: Filters.bestGrade(poi),
      metaLine: popupMetaLine(poi),
      weather: wx ? {
        code: wx.code,
        tempMax: wx.tempMax,
        precip: wx.precip,
        windMax: wx.windMax,
        freezingLevel: wx.freezingLevel,
        date: wx.date,
        peakAlt: poi.alt,
      } : null,
      hikeHref: hike ? '../' + hike.href : null,
      showExpand: true,
    });

    /* Popup rebind pattern is load-bearing — see the FIRST-CLICK REGRESSION
       GUARD comment above bindMarkerTooltips(). Always reuse the existing
       popup via setPopupContent(); only bindPopup() on the first open. */
    if (marker.getPopup()) {
      marker.setPopupContent(html);
    } else {
      marker.bindPopup(html, { maxWidth: 300 });
    }
    marker.openPopup();
  }

  /* ── Filter bar ────────────────────────────────────── */

  // Swiss trail-marker icon for SAC grade buttons.
  //   T1-2  → solid yellow (Wanderweg)
  //   T3    → white-red-white horizontal stripe (Bergwanderweg)
  //   T4-T6 → white-blue-white horizontal stripe (Alpinwanderweg)
  // The TX grade label is overlaid centered in the colored band.
  function sacGradeIcon(label) {
    var w = 22, h = 22;
    var bg, band, textFill;
    if (label === 'T1-2') {
      bg = '#f2c800'; band = null; textFill = '#1a1810';
    } else if (label === 'T3') {
      bg = '#ffffff'; band = '#d72030'; textFill = '#ffffff';
    } else {
      bg = '#ffffff'; band = '#3388ff'; textFill = '#ffffff';
    }
    // T1-2 is 4 chars so it needs a smaller font than the single-digit labels.
    var fontSize = label.length > 2 ? 6.5 : 9;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" class="grade-icon">';
    svg += '<rect width="' + w + '" height="' + h + '" fill="' + bg + '" rx="2"/>';
    if (band) {
      svg += '<rect y="6" width="' + w + '" height="10" fill="' + band + '"/>';
    }
    svg += '<text x="' + (w/2) + '" y="' + (h/2 + 3) + '" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="' + fontSize + '" font-weight="700" fill="' + textFill + '">' + label + '</text>';
    svg += '</svg>';
    return svg;
  }

  function buildFilterBar() {
    var bar = document.getElementById('filter-bar');

    // Grade — multi-select. Icon-only (SAC trail markers); no label needed.
    // No "Any" button: empty selection means any.
    bar.appendChild(filterGroup('', [
      { label: 'T1-2', icon: sacGradeIcon('T1-2'), key: 'grades', value: ['T1-2'] },
      { label: 'T3',   icon: sacGradeIcon('T3'),   key: 'grades', value: ['T3'] },
      { label: 'T4',   icon: sacGradeIcon('T4'),   key: 'grades', value: ['T4'] },
      { label: 'T5',   icon: sacGradeIcon('T5'),   key: 'grades', value: ['T5'] },
      { label: 'T6',   icon: sacGradeIcon('T6'),   key: 'grades', value: ['T6'] }
    ], true));

    // Duration — single-select; "h" suffix carries the meaning, no label.
    bar.appendChild(filterGroup('', [
      { label: '≤3h', key: 'duration', value: 'short' },
      { label: '3-5h', key: 'duration', value: 'medium' },
      { label: '5h+', key: 'duration', value: 'long' }
    ]));

    // Peak elevation
    bar.appendChild(filterGroup('elev', [
      { label: '≤2000', key: 'elevation', value: 'low' },
      { label: '2-2.5k', key: 'elevation', value: 'mid' },
      { label: '2.5k+', key: 'elevation', value: 'high' }
    ]));

    // Vertical gain
    bar.appendChild(filterGroup('gain', [
      { label: '≤500', key: 'gain', value: 'easy' },
      { label: '500-1k', key: 'gain', value: 'mod' },
      { label: '1-1.5k', key: 'gain', value: 'hard' },
      { label: '1.5k+', key: 'gain', value: 'epic' }
    ], /* multiSelect */ true));

    // Season — single toggle. Hides routes whose heuristic season window
    // doesn't include the current month (see season.js). Icon-only with a
    // tooltip explaining the heuristic — the data is estimated, not
    // authoritative.
    bar.appendChild(seasonFilterGroup());

    // Display — multi-select pills controlling what shows on each POI.
    // 'weather' = marker pill (vs simple dot); others = tooltip metadata.
    bar.appendChild(displayFilterGroup());
  }

  // Single-button "in season now" toggle. Same click-active-to-clear idiom as
  // the rest of the single-select filters but rendered as one button (no group
  // label, no value pills) because the only meaningful state is on/off.
  function seasonFilterGroup() {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--season';

    var btn = document.createElement('button');
    btn.className = 'filter-btn filter-btn--icon';
    var monthLabel = (window.Season && Season.currentMonthLabel()) || '';
    btn.title = 'In season now (' + monthLabel
              + ') · estimated from altitude + grade';
    btn.innerHTML = '<span class="season-icon">🍂</span>';

    if (Filters.getState().inSeasonNow === true) btn.classList.add('active');

    btn.addEventListener('click', function () {
      var was = btn.classList.contains('active');
      btn.classList.toggle('active');
      Filters.setState('inSeasonNow', was ? null : true);
    });
    group.appendChild(btn);
    return group;
  }

  // Multi-select pills controlling which fields each POI renders. Empty
  // selection = nothing shown. Toggling 'weather' swaps marker style;
  // toggling anything else rebuilds tooltips.
  function displayFilterGroup() {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--display';

    var lbl = document.createElement('span');
    lbl.className = 'filter-label filter-label--icon';
    lbl.title = 'Show';
    lbl.innerHTML = LABEL_ICONS.show;
    group.appendChild(lbl);

    var options = [
      { key: 'weather', label: '⛅' , title: 'Weather (marker)' },
      { key: 'name',    label: 'Name', title: 'Name' },
      { key: 'grade',   label: 'T', title: 'Grade (T1-T6)' },
      { key: 'gain',    label: '↑m', title: 'Vertical gain' },
      { key: 'time',    label: 'h',  title: 'Time up' },
      { key: 'alt',     label: 'alt',title: 'Peak altitude' }
    ];

    var current = (Filters.getState().display || []).slice();
    // Initialise the CSS-driven name visibility from restored state. The
    // name span lives in every tooltip; this class hides it instantly.
    document.body.classList.toggle('display-name-off', current.indexOf('name') === -1);

    options.forEach(function (opt) {
      var active = current.indexOf(opt.key) !== -1;
      var btn = document.createElement('button');
      btn.className = 'filter-btn filter-btn--display' + (active ? ' active' : '');
      btn.title = opt.title;
      btn.setAttribute('data-display', opt.key);
      btn.innerHTML = opt.label;
      btn.addEventListener('click', function () {
        btn.classList.toggle('active');
        var nowActive = btn.classList.contains('active');
        var selected = [];
        group.querySelectorAll('.filter-btn--display.active').forEach(function (b) {
          selected.push(b.getAttribute('data-display'));
        });
        Filters.setState('display', selected);
        if (opt.key === 'name') {
          // Pure CSS toggle — no per-marker work.
          document.body.classList.toggle('display-name-off', !nowActive);
        } else if (opt.key === 'weather') {
          // Only the marker icon depends on this; tooltips unaffected.
          refreshMarkerIcons();
        } else {
          // grade / gain / time / alt — changes the meta line text.
          refreshMarkerTooltips();
        }
      });
      group.appendChild(btn);
    });

    return group;
  }

  function buildWeatherFilters() {
    var bar = document.getElementById('filter-bar');

    // Day picker with summary subtitle
    var days = WeatherService.getDayChoices();
    if (days.length === 0) return;

    bar.appendChild(buildDayPicker(days));

    // Sky condition — multi-select icon buttons
    bar.appendChild(skyFilterGroup());

    // Temperature — single-select; "°" suffix carries the meaning, no label.
    bar.appendChild(filterGroup('', [
      { label: '>0°', key: 'tempMin', value: 0 },
      { label: '>5°', key: 'tempMin', value: 5 },
      { label: '>10°', key: 'tempMin', value: 10 },
      { label: '>15°', key: 'tempMin', value: 15 }
    ], false, 'weather'));
  }

  // Day picker — horizontal row of buttons selecting which forecast day
  // drives the weather filter / marker icons.
  function buildDayPicker(days) {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--day';

    // No "Day" label — day buttons say "Today / Tomorrow / Sun 31 May".
    var currentDay = Filters.getState().weatherDay;
    days.forEach(function (d, idx) {
      // Mark active if this day's index matches the restored state.
      var active = d.index === currentDay;
      var btn = document.createElement('button');
      btn.className = 'filter-btn' + (active ? ' weather-active' : '');
      btn.textContent = d.label;
      btn.addEventListener('click', function () {
        group.querySelectorAll('.filter-btn').forEach(function (b) {
          b.classList.remove('weather-active');
        });
        btn.classList.add('weather-active');
        Filters.setState('weatherDay', d.index);
        refreshMarkerIcons();
      });
      group.appendChild(btn);
    });

    return group;
  }

  // Threshold icon buttons for sky conditions: clicking a category means
  // "this weather or better". null = any. Clicking the current threshold clears.
  function skyFilterGroup() {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--sky';

    // No "Sky" label — weather emoji buttons are self-explanatory.
    var keys = WeatherService.SKY_CATEGORIES.map(function (c) { return c.key; });

    function refresh() {
      var sel = Filters.getState().sky;
      var threshold = sel ? keys.indexOf(sel) : -1;
      group.querySelectorAll('.filter-btn--sky').forEach(function (b, idx) {
        b.classList.toggle('weather-active', threshold !== -1 && idx <= threshold);
      });
    }

    WeatherService.SKY_CATEGORIES.forEach(function (cat) {
      // Hidden categories (snow, storm) remain in SKY_CATEGORIES so the
      // threshold filter still excludes them, but aren't shown as buttons.
      if (cat.hidden) return;
      var btn = document.createElement('button');
      btn.className = 'filter-btn filter-btn--sky';
      btn.title = cat.label + ' or better';
      btn.setAttribute('data-sky', cat.key);
      btn.innerHTML = '<span class="sky-icon">' + cat.icon + '</span>';
      btn.addEventListener('click', function () {
        var current = Filters.getState().sky;
        Filters.setState('sky', current === cat.key ? null : cat.key);
        refresh();
      });
      group.appendChild(btn);
    });

    refresh();
    return group;
  }

  // Group label glyphs. Emoji for the topographic ones (mountain peak, gain
  // chart) so they read as colored hints; mono SVG for the eye (no good
  // emoji equivalent). The CSS rule .filter-label--icon bumps font-size so
  // emoji render at a visible size against the small label slot.
  var LABEL_ICONS = {
    elev: '🏔️',
    gain: '📈',
    show: '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1 6 Q6 1.5 11 6 Q6 10.5 1 6 Z"/><circle cx="6" cy="6" r="1.6" fill="currentColor"/></svg>'
  };

  function filterGroup(label, options, multiSelect, style) {
    var group = document.createElement('div');
    group.className = 'filter-group';

    // Label is optional — pass '' (or null/undefined) to render an icon-only
    // group where the buttons are self-evident (e.g. Grade, Time, Sky, Temp).
    // Pass a key from LABEL_ICONS (e.g. 'elev') to render an inline SVG glyph
    // instead of text.
    if (label) {
      var lbl = document.createElement('span');
      lbl.className = 'filter-label';
      if (LABEL_ICONS[label]) {
        lbl.classList.add('filter-label--icon');
        lbl.title = label.charAt(0).toUpperCase() + label.slice(1);
        lbl.innerHTML = LABEL_ICONS[label];
      } else {
        lbl.textContent = label;
      }
      group.appendChild(lbl);
    }

    var activeClass = style === 'weather' ? 'weather-active' : 'active';
    var s = Filters.getState();

    // The multi-select state field is the shared `key` across the option list
    // (every option in a multi-select group writes into the same state slot,
    // so we read the first option's key once).
    var multiKey = multiSelect && options.length ? options[0].key : null;
    // Some multi-select groups (grades) carry the bucket label in opt.value[0]
    // instead of opt.value. Detect once.
    function valueOf(opt) {
      return Array.isArray(opt.value) ? opt.value[0] : opt.value;
    }

    // Decide whether a given option should start active based on restored state.
    // - Multi-select: button active iff its value is in state[multiKey].
    // - Single-select: button active iff state[opt.key] equals opt.value.
    function isActive(opt) {
      if (multiSelect) {
        var arr = s[multiKey];
        if (!arr) return false;
        if (typeof arr === 'string') arr = [arr];  // tolerate legacy single-string state from old URLs
        return arr.indexOf(valueOf(opt)) !== -1;
      }
      return s[opt.key] === opt.value;
    }

    options.forEach(function (opt) {
      var btn = document.createElement('button');
      btn.className = 'filter-btn';
      if (opt.icon) {
        btn.innerHTML = opt.icon;
        btn.title = opt.label;
        btn.classList.add('filter-btn--icon');
      } else {
        btn.textContent = opt.label;
      }
      if (isActive(opt)) btn.classList.add(activeClass);

      btn.addEventListener('click', function () {
        if (multiSelect) {
          // Multi-select: toggle this button, then collect all active values
          // and write them to state[multiKey] (e.g. 'grades' or 'gain').
          // Empty selection = any (no Any button needed).
          btn.classList.toggle(activeClass);
          var active = [];
          group.querySelectorAll('.filter-btn').forEach(function (b, i) {
            if (b.classList.contains(activeClass)) {
              active.push(valueOf(options[i]));
            }
          });
          Filters.setState(multiKey, active);
        } else {
          // Single select: clicking the already-active button clears the
          // filter (state = null = any). Otherwise select just this one.
          var wasActive = btn.classList.contains(activeClass);
          group.querySelectorAll('.filter-btn').forEach(function (b) {
            b.classList.remove(activeClass);
          });
          if (wasActive) {
            Filters.setState(opt.key, null);
          } else {
            btn.classList.add(activeClass);
            Filters.setState(opt.key, opt.value);
          }
          // Re-render marker icons when the weather day changes
          if (opt.key === 'weatherDay') refreshMarkerIcons();
        }
      });

      group.appendChild(btn);
    });

    return group;
  }

  /* ── Map overlay toggles ───────────────────────────── */

  function buildWeatherToggles() {
    var panel = document.getElementById('weather-toggles');
    var s = Filters.getState();
    // `stateKey` ties the toggle to a Filters state field so we can reflect
    // restored URL state. `webcams` isn't filter state — it uses defaultOn.
    // Tooltip visibility is handled entirely by the filter-bar "Show" pills
    // (display-name-off + meta presence collapse) — no separate Names toggle.
    var toggles = [
      { id: 'hikes',     icon: '⛰️', label: 'Hikes',    stateKey: 'showHikes', defaultOn: true },
      { id: 'huts',      icon: '🏚️', label: 'SAC huts', stateKey: 'showHuts',  defaultOn: true },
      { id: 'haspage',   icon: '⭐', label: 'Has page', stateKey: 'hasPage',   defaultOn: false },
      { id: 'cities',    icon: '🏙️', label: 'Reference cities (sanity-check forecast)', defaultOn: true },
      { id: 'webcams',   icon: '📷', label: 'Webcams', defaultOn: true },
      // Hazard overlays
      { id: 'avalanche', icon: '⚠️', label: 'Avalanche (SLF bulletin + statutory hazard zones)' },
      { id: 'slope',     icon: '📐', label: 'Slope ≥30° (avalanche-critical)' },
      { id: 'snow',      icon: '❄️', label: 'Snow & glaciers (permanent extent)' },
      // Planning / approach overlays
      { id: 'transit',   icon: '🚌', label: 'Public transport stops (SBB / PostBus)' },
      { id: 'parking',   icon: '🅿️', label: 'Trailhead parking (OSM)' },
      { id: 'water',     icon: '💧', label: 'Drinking water (OSM)' }
    ];

    toggles.forEach(function (t) {
      // Prefer current Filters state when the toggle maps to a state field;
      // otherwise fall back to defaultOn.
      var on = t.stateKey ? !!s[t.stateKey] : !!t.defaultOn;
      var btn = document.createElement('button');
      btn.className = 'wx-toggle' + (on ? ' active' : '');
      btn.innerHTML = '<span class="icon">' + t.icon + '</span>';
      btn.title = t.label;
      btn.addEventListener('click', function () {
        btn.classList.toggle('active');
        toggleWeatherLayer(t.id, btn.classList.contains('active'));
      });
      panel.appendChild(btn);
    });
  }

  // Reset button — clears the URL hash and reloads. Reloading is the cheapest
  // way to also reset non-Filters toggles (webcams) and re-render every button
  // in its default-active state.
  function wireResetButton() {
    var btn = document.getElementById('filter-reset');
    if (!btn) return;
    // Show the button whenever the URL hash carries filter state. UrlSync
    // writes to the hash inside Filters.setState, so by the time our
    // subscriber fires the hash is already current.
    function refreshVisibility() {
      btn.hidden = !window.location.hash || window.location.hash === '#';
    }
    refreshVisibility();
    if (window.Filters && Filters.subscribe) {
      Filters.subscribe(refreshVisibility);
    }
    btn.addEventListener('click', function () {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      location.reload();
    });
  }

  // Share button — copy current URL (including hash state) to clipboard.
  // file:// pages don't get navigator.clipboard, so fall back to a textarea+execCommand.
  function wireShareButton() {
    var btn = document.getElementById('share-link');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var url = window.location.href;
      var done = function () {
        var prev = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = prev;
          btn.classList.remove('copied');
        }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { fallbackCopy(url); done(); });
      } else {
        fallbackCopy(url);
        done();
      }
    });
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* swallow */ }
    document.body.removeChild(ta);
  }

  var webcamLayer = null;

  // Generic lazy-loaded overlay registry. Each entry has a factory returning
  // Promise<L.Layer>; the layer is cached on first activation and wantedById
  // tracks intent in case the user toggles off before the layer resolves.
  // Avalanche, slope, snow/glaciers, transit, drinking water, parking — all
  // share this single add/remove machinery.
  var overlayLayers = {};   // id → L.Layer (resolved)
  var overlayWanted = {};   // id → boolean (latest user intent)
  var overlayFactories = {
    avalanche: function () { return window.Overlays && window.Overlays.Avalanche.create(); },
    slope:     function () { return window.Overlays && window.Overlays.Slope.create(); },
    snow:      function () { return window.Overlays && window.Overlays.SnowGlaciers.create(); },
    transit:   function () { return window.Overlays && window.Overlays.Transit.create(); },
    parking:   function () { return window.Overlays && window.Overlays.Parking.create(); },
    water:     function () { return window.Overlays && window.Overlays.DrinkingWater.create(); }
  };

  function toggleLazyOverlay(id, show) {
    overlayWanted[id] = show;
    if (show) {
      if (overlayLayers[id]) {
        map.addLayer(overlayLayers[id]);
      } else {
        var factory = overlayFactories[id];
        if (!factory) return;
        var p = factory();
        if (!p || !p.then) return;
        p.then(function (layer) {
          overlayLayers[id] = layer;
          if (overlayWanted[id]) map.addLayer(layer);
        }).catch(function (err) {
          console.warn('Overlay "' + id + '" failed to load:', err);
        });
      }
    } else if (overlayLayers[id]) {
      map.removeLayer(overlayLayers[id]);
    }
  }

  function toggleWeatherLayer(id, show) {
    if (id === 'hikes') {
      Filters.setState('showHikes', show);
      return;
    }
    if (id === 'huts') {
      Filters.setState('showHuts', show);
      return;
    }
    if (id === 'haspage') {
      // Off-state is null (no filter), not false — see hasPage state semantics.
      Filters.setState('hasPage', show ? true : null);
      return;
    }
    if (id === 'cities') {
      if (!cityLayer) return;
      if (show) map.addLayer(cityLayer);
      else map.removeLayer(cityLayer);
      return;
    }
    if (id === 'webcams') {
      if (show) {
        if (!webcamLayer && window.WebcamLayer) webcamLayer = window.WebcamLayer.create();
        if (webcamLayer) map.addLayer(webcamLayer);
      } else if (webcamLayer) {
        map.removeLayer(webcamLayer);
      }
      return;
    }
    if (overlayFactories[id]) {
      toggleLazyOverlay(id, show);
      return;
    }
  }

  /* ── Forecast meta (last-updated) ──────────────────── */

  var MODEL_LABELS = {
    'meteoswiss_icon_ch1': 'MeteoSwiss ICON-CH1',
    'meteoswiss_icon_ch2': 'MeteoSwiss ICON-CH2',
    'ecmwf_ifs025':        'ECMWF IFS',
    'icon_eu':             'ICON-EU'
  };

  function renderForecastMeta() {
    var el = document.getElementById('forecast-meta');
    if (!el) return;
    var meta = WeatherService.getMeta();
    if (!meta) { el.textContent = ''; return; }
    var modelLabel = MODEL_LABELS[meta.model] || meta.model;
    el.innerHTML = '<strong>' + modelLabel + '</strong> · updated ' + WeatherService.relativeTime(meta.updated);
  }

  /* ── Utilities ─────────────────────────────────────── */

  function formatTime(minutes) {
    if (!minutes) return '—';
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    if (h === 0) return m + 'min';
    if (m === 0) return h + 'h';
    return h + 'h ' + m + 'min';
  }

  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ── Boot ──────────────────────────────────────────── */

  function boot() {
    var routes = window.SAC_ROUTES || [];
    var loadingText = document.getElementById('loading-text');
    var loadingOverlay = document.getElementById('loading-overlay');

    function status(msg) {
      if (loadingText) loadingText.textContent = msg;
    }

    status('Initializing map...');
    initMap();

    status('Creating ' + routes.length + ' route markers...');
    Filters.init(allMarkers, document.getElementById('route-count'), refreshCluster);
    // Restore filter state from URL hash BEFORE building the filter UI so the
    // buttons reflect the restored state instead of all showing "Any" active.
    if (window.UrlSync && Filters.loadState) {
      Filters.loadState(window.UrlSync.readFromUrl());
    }
    createMarkers(routes);
    createCityMarkers();
    if (cityLayer) map.addLayer(cityLayer);

    buildFilterBar();
    buildWeatherToggles();
    wireResetButton();
    wireShareButton();

    SidePanel.init(document.getElementById('side-panel'));

    status('Fetching weather forecasts...');
    WeatherService.init(routes, status).then(function () {
      buildWeatherFilters();
      refreshMarkerIcons();
      renderForecastMeta();
      Filters.apply();

      setTimeout(function () {
        loadingOverlay.classList.add('hidden');
      }, 400);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
