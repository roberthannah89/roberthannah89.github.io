/* Command Center — main orchestrator */
(function () {
  'use strict';

  var map, clusterGroup;
  var allMarkers = [];

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

    // Show always-on name labels at zoom 11+
    map.on('zoomend', function () {
      document.body.classList.toggle('zoom-labels', map.getZoom() >= 11);
    });
    // Set initial state in case current zoom already qualifies
    document.body.classList.toggle('zoom-labels', map.getZoom() >= 11);
  }

  /* ── Route markers ─────────────────────────────────── */

  function createMarkers(routes) {
    routes.forEach(function (poi) {
      if (!poi.lat || !poi.lon) return;

      var grade = Filters.bestGrade(poi);
      var color = gradeColor(grade);

      var marker = L.marker([poi.lat, poi.lon], {
        icon: makeHikeIcon(color, 'dot')
      });

      marker._poi = poi;
      marker._color = color;
      marker._filtered = false;

      // Tooltip content is rebuilt by refreshMarkerTooltips() based on the
      // current Display filter. Bind a placeholder so Leaflet keeps the
      // permanent label slot — actual content is set after creation.
      marker.bindTooltip('', {
        permanent: true,
        direction: 'bottom',
        offset: [0, 18],
        className: 'hike-tooltip'
      });

      marker.on('click', function () {
        openPopup(poi, marker);
      });

      allMarkers.push(marker);
    });

    refreshMarkerTooltips();
    refreshCluster();
  }

  // Three marker modes:
  //   'dot'     — small grade-colored dot (default, clean view)
  //   'weather' — larger ring with weather emoji + temp (when user opts in)
  function makeHikeIcon(color, mode, wxIcon, tempStr) {
    if (mode === 'weather' && wxIcon) {
      var temp = tempStr ? '<span class="hike-marker__temp">' + tempStr + '</span>' : '';
      return L.divIcon({
        className: '',
        html: '<div class="hike-marker hike-marker--wx" style="border-color:' + color + ';background:' + color + '22">'
          + '<span class="hike-marker__wx">' + wxIcon + '</span>' + temp + '</div>',
        iconSize: [40, 28],
        iconAnchor: [20, 14]
      });
    }
    return L.divIcon({
      className: '',
      html: '<div class="hike-marker hike-marker--dot" style="background:' + color + '"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });
  }

  // Re-render every marker's icon based on the currently selected weather day
  // and the Display filter. When 'weather' is in display, markers show the
  // weather pill (emoji + temp); when it isn't, every marker is a small
  // grade-colored dot regardless of forecast data.
  function refreshMarkerIcons() {
    var s = Filters.getState();
    var dayIdx = s.weatherDay;
    var showWeather = (s.display || []).indexOf('weather') !== -1;
    allMarkers.forEach(function (m) {
      var poi = m._poi;
      if (!showWeather) {
        m.setIcon(makeHikeIcon(m._color, 'dot'));
        return;
      }
      var wx = WeatherService.getForPeak(poi.lat, poi.lon, dayIdx);
      if (!wx) {
        m.setIcon(makeHikeIcon(m._color, 'dot'));
        return;
      }
      var emoji = WeatherService.weatherIcon(wx.code);
      var tempStr = wx.tempMax !== null && wx.tempMax !== undefined
        ? Math.round(wx.tempMax) + '°' : '';
      m.setIcon(makeHikeIcon(m._color, 'weather', emoji, tempStr));
    });
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

  // Rebuild every marker's tooltip content from the current Display filter.
  // Tooltip = optional name line + optional metadata line. If neither is
  // selected (or there's nothing to show), the tooltip is left empty.
  function refreshMarkerTooltips() {
    var display = Filters.getState().display || [];
    var showName = display.indexOf('name') !== -1;
    allMarkers.forEach(function (m) {
      var poi = m._poi;
      var lines = [];
      if (showName && poi.name) {
        lines.push('<span class="hike-tt__name">' + esc(poi.name) + '</span>');
      }
      var meta = buildPoiMetaLine(poi, display);
      if (meta) {
        lines.push('<span class="hike-tt__meta">' + esc(meta) + '</span>');
      }
      var tip = m.getTooltip();
      if (tip) tip.setContent(lines.join(''));
    });
  }

  function refreshCluster() {
    clusterGroup.clearLayers();
    allMarkers.forEach(function (m) {
      if (!m._filtered) clusterGroup.addLayer(m);
    });
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

  function openPopup(poi, marker) {
    var grade = Filters.bestGrade(poi);
    var gc = Filters.gradeNum(grade) <= 2 ? 't1' : 't' + Filters.gradeNum(grade);
    var dayIdx = Filters.getState().weatherDay;
    var wx = WeatherService.getForPeak(poi.lat, poi.lon, dayIdx);

    var html = '<div class="popup-name"><span class="grade-badge ' + gc + '">' + grade + '</span> ' + esc(poi.name) + '</div>';
    html += '<div class="popup-meta">' + (poi.alt || '—') + ' m';

    if (poi.routes && poi.routes.length > 0) {
      var r = poi.routes[0];
      if (r.gain) html += ' · ' + r.gain + ' m gain';
      if (r.time_up) html += ' · ↑ ' + formatTime(r.time_up);
    }
    html += '</div>';

    if (wx) {
      var dayLabel = WeatherService.formatDayLabel(wx.date);
      html += '<div class="popup-weather">';
      html += WeatherService.weatherIcon(wx.code) + ' ' + dayLabel + ': ';
      html += WeatherService.weatherLabel(wx.code);
      html += ', ' + Math.round(wx.tempMax) + '°C';
      if (wx.precip > 0) html += ', ' + wx.precip.toFixed(1) + 'mm';
      html += ', 💨 ' + Math.round(wx.windMax) + ' km/h';
      html += '</div>';
    }

    html += '<button class="popup-expand" onclick="SidePanel.open(window._lastPoi)">Expand details ▸</button>';

    window._lastPoi = poi;
    marker.bindPopup(html, { maxWidth: 300 }).openPopup();
  }

  /* ── Filter bar ────────────────────────────────────── */

  function buildFilterBar() {
    var bar = document.getElementById('filter-bar');

    // Grade — multi-select. No "Any" button: empty selection means any.
    bar.appendChild(filterGroup('Grade', [
      { label: 'T1-2', key: 'grade', value: ['T1-2'] },
      { label: 'T3', key: 'grade', value: ['T3'] },
      { label: 'T4', key: 'grade', value: ['T4'] },
      { label: 'T5', key: 'grade', value: ['T5'] },
      { label: 'T6', key: 'grade', value: ['T6'] }
    ], true));

    // Duration — single-select; click an active button again to clear (means any).
    bar.appendChild(filterGroup('Time', [
      { label: '≤3h', key: 'duration', value: 'short' },
      { label: '3-5h', key: 'duration', value: 'medium' },
      { label: '5h+', key: 'duration', value: 'long' }
    ]));

    // Peak elevation
    bar.appendChild(filterGroup('Elev', [
      { label: '≤2000', key: 'elevation', value: 'low' },
      { label: '2-2.5k', key: 'elevation', value: 'mid' },
      { label: '2.5k+', key: 'elevation', value: 'high' }
    ]));

    // Vertical gain
    bar.appendChild(filterGroup('Gain', [
      { label: '≤500', key: 'gain', value: 'easy' },
      { label: '500-1k', key: 'gain', value: 'mod' },
      { label: '1-1.5k', key: 'gain', value: 'hard' },
      { label: '1.5k+', key: 'gain', value: 'epic' }
    ]));

    // Display — multi-select pills controlling what shows on each POI.
    // 'weather' = marker pill (vs simple dot); others = tooltip metadata.
    bar.appendChild(displayFilterGroup());
  }

  // Multi-select pills controlling which fields each POI renders. Empty
  // selection = nothing shown. Toggling 'weather' swaps marker style;
  // toggling anything else rebuilds tooltips.
  function displayFilterGroup() {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--display';

    var lbl = document.createElement('span');
    lbl.className = 'filter-label';
    lbl.textContent = 'Show';
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

    options.forEach(function (opt) {
      var active = current.indexOf(opt.key) !== -1;
      var btn = document.createElement('button');
      btn.className = 'filter-btn filter-btn--display' + (active ? ' active' : '');
      btn.title = opt.title;
      btn.setAttribute('data-display', opt.key);
      btn.innerHTML = opt.label;
      btn.addEventListener('click', function () {
        btn.classList.toggle('active');
        var selected = [];
        group.querySelectorAll('.filter-btn--display.active').forEach(function (b) {
          selected.push(b.getAttribute('data-display'));
        });
        Filters.setState('display', selected);
        refreshMarkerIcons();
        refreshMarkerTooltips();
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

    // Temperature — single-select; click active button again to clear (means any).
    bar.appendChild(filterGroup('Temp', [
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

    var lbl = document.createElement('span');
    lbl.className = 'filter-label';
    lbl.textContent = 'Day';
    group.appendChild(lbl);

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

  // Multi-select icon buttons for sky conditions. No "Any" button —
  // empty selection means any. Clicking toggles each category.
  function skyFilterGroup() {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--sky';

    var lbl = document.createElement('span');
    lbl.className = 'filter-label';
    lbl.textContent = 'Sky';
    group.appendChild(lbl);

    var selectedSky = Filters.getState().sky || [];
    WeatherService.SKY_CATEGORIES.forEach(function (cat) {
      var btn = document.createElement('button');
      // Multi-select: each category active iff present in restored state.sky.
      var active = selectedSky.indexOf(cat.key) !== -1;
      btn.className = 'filter-btn filter-btn--sky' + (active ? ' weather-active' : '');
      btn.title = cat.label;
      btn.setAttribute('data-sky', cat.key);
      btn.innerHTML = '<span class="sky-icon">' + cat.icon + '</span>';
      btn.addEventListener('click', function () {
        btn.classList.toggle('weather-active');
        var selected = [];
        group.querySelectorAll('.filter-btn--sky.weather-active').forEach(function (b) {
          selected.push(b.getAttribute('data-sky'));
        });
        Filters.setState('sky', selected);
      });
      group.appendChild(btn);
    });

    return group;
  }

  function filterGroup(label, options, multiSelect, style) {
    var group = document.createElement('div');
    group.className = 'filter-group';

    var lbl = document.createElement('span');
    lbl.className = 'filter-label';
    lbl.textContent = label;
    group.appendChild(lbl);

    var activeClass = style === 'weather' ? 'weather-active' : 'active';
    var s = Filters.getState();

    // Decide whether a given option should start active based on restored state.
    // - Multi-select (grades): button active iff its value is in state.grades.
    // - Single-select: button active iff state[opt.key] equals opt.value.
    function isActive(opt) {
      if (multiSelect) {
        return s.grades && opt.value && s.grades.indexOf(opt.value[0]) !== -1;
      }
      return s[opt.key] === opt.value;
    }

    options.forEach(function (opt) {
      var btn = document.createElement('button');
      btn.className = 'filter-btn';
      btn.textContent = opt.label;
      if (isActive(opt)) btn.classList.add(activeClass);

      btn.addEventListener('click', function () {
        if (multiSelect) {
          // Multi-select: toggle this button, then collect all active values.
          // Empty selection = any (no Any button needed).
          btn.classList.toggle(activeClass);
          var active = [];
          group.querySelectorAll('.filter-btn').forEach(function (b, i) {
            if (b.classList.contains(activeClass)) {
              active.push(options[i].value[0]);
            }
          });
          Filters.setState('grades', active);
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
    // restored URL state. `webcams` and `names` aren't filter state — they
    // use defaultOn instead.
    var toggles = [
      { id: 'hikes',   icon: '⛰️', label: 'Hikes',    stateKey: 'showHikes', defaultOn: true },
      { id: 'huts',    icon: '🏚️', label: 'SAC huts', stateKey: 'showHuts',  defaultOn: true },
      { id: 'webcams', icon: '📷', label: 'Webcams' },
      // Permanent name labels (hidden via body class when off — avoids
      // re-binding tooltips on every marker which would be slow)
      { id: 'names',   icon: '🏷️', label: 'Names',   defaultOn: true }
    ];

    toggles.forEach(function (t) {
      // Prefer current Filters state when the toggle maps to a state field;
      // otherwise fall back to defaultOn.
      var on = t.stateKey ? !!s[t.stateKey] : !!t.defaultOn;
      var btn = document.createElement('button');
      btn.className = 'wx-toggle' + (on ? ' active' : '');
      btn.innerHTML = '<span class="icon">' + t.icon + '</span> ' + t.label;
      btn.addEventListener('click', function () {
        btn.classList.toggle('active');
        toggleWeatherLayer(t.id, btn.classList.contains('active'));
      });
      panel.appendChild(btn);
    });
  }

  // Reset button — clears the URL hash and reloads. Reloading is the cheapest
  // way to also reset the non-Filters toggles (webcams, names) and re-render
  // every button in its default-active state.
  function wireResetButton() {
    var btn = document.getElementById('filter-reset');
    if (!btn) return;
    // Show the button whenever a hash is present (i.e. at least one non-default
    // filter is active). Updated on every Filters.apply via the route-count
    // observer below.
    function refreshVisibility() {
      btn.hidden = !window.location.hash || window.location.hash === '#';
    }
    refreshVisibility();
    // Re-check after any filter change — UrlSync writes to the hash inside
    // Filters.setState, so by the next animation frame the hash is current.
    var countEl = document.getElementById('route-count');
    if (countEl && window.MutationObserver) {
      new MutationObserver(refreshVisibility).observe(countEl, { childList: true });
    }
    btn.addEventListener('click', function () {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      location.reload();
    });
  }

  var webcamLayer = null;

  function toggleWeatherLayer(id, show) {
    if (id === 'hikes') {
      Filters.setState('showHikes', show);
      return;
    }
    if (id === 'huts') {
      Filters.setState('showHuts', show);
      return;
    }
    if (id === 'names') {
      document.body.classList.toggle('names-off', !show);
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

    buildFilterBar();
    buildWeatherToggles();
    wireResetButton();

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
