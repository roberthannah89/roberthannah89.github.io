/* Command Center — main orchestrator */
(function () {
  'use strict';

  var map, clusterGroup;
  var allMarkers = [];
  var weatherLayers = {};
  var rainTimestamps = [];
  var currentRainIdx = 0;
  var playing = false;
  var playInterval = null;

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
      zoom: 8,
      zoomControl: false
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Base layers
    var layers = window.MapShared ? MapShared.makeLayers() : null;
    if (layers) {
      L.layerGroup([layers.color, layers.trails]).addTo(map);
      if (MapShared.addSwissBorder) MapShared.addSwissBorder(map);
    } else {
      L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
        maxZoom: 18,
        attribution: '&copy; swisstopo'
      }).addTo(map);
    }

    // Cluster group
    clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 45,
      disableClusteringAtZoom: 13,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      iconCreateFunction: function (cluster) {
        var count = cluster.getChildCount();
        return L.divIcon({
          html: '<div>' + count + '</div>',
          className: 'marker-cluster',
          iconSize: L.point(36, 36)
        });
      }
    });
    map.addLayer(clusterGroup);
  }

  /* ── Route markers ─────────────────────────────────── */

  function createMarkers(routes) {
    routes.forEach(function (poi) {
      if (!poi.lat || !poi.lon) return;

      var grade = Filters.bestGrade(poi);
      var color = gradeColor(grade);

      var marker = L.circleMarker([poi.lat, poi.lon], {
        radius: 6,
        fillColor: color,
        fillOpacity: 0.9,
        color: '#000',
        weight: 1,
        opacity: 0.5
      });

      marker._poi = poi;
      marker._filtered = false;

      marker.on('click', function () {
        openPopup(poi, marker);
      });

      allMarkers.push(marker);
    });

    refreshCluster();
  }

  function refreshCluster() {
    clusterGroup.clearLayers();
    allMarkers.forEach(function (m) {
      if (!m._filtered) clusterGroup.addLayer(m);
    });
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

    // Grade
    bar.appendChild(filterGroup('Grade', [
      { label: 'Any', key: 'grade', value: [] },
      { label: 'T1-2', key: 'grade', value: ['T1-2'] },
      { label: 'T3', key: 'grade', value: ['T3'] },
      { label: 'T4', key: 'grade', value: ['T4'] },
      { label: 'T5', key: 'grade', value: ['T5'] },
      { label: 'T6', key: 'grade', value: ['T6'] }
    ], true));

    // Duration
    bar.appendChild(filterGroup('Time', [
      { label: 'Any', key: 'duration', value: null },
      { label: '≤3h', key: 'duration', value: 'short' },
      { label: '3-5h', key: 'duration', value: 'medium' },
      { label: '5h+', key: 'duration', value: 'long' }
    ]));

    // Elevation
    bar.appendChild(filterGroup('Elev', [
      { label: 'Any', key: 'elevation', value: null },
      { label: '≤2000', key: 'elevation', value: 'low' },
      { label: '2-2.5k', key: 'elevation', value: 'mid' },
      { label: '2.5k+', key: 'elevation', value: 'high' }
    ]));
  }

  function buildWeatherFilters() {
    var bar = document.getElementById('filter-bar');

    // Day picker
    var days = WeatherService.getDayChoices();
    if (days.length === 0) return;

    var dayOpts = days.map(function (d) {
      return { label: d.label, key: 'weatherDay', value: d.index };
    });
    bar.appendChild(filterGroup('Day', dayOpts, false, 'weather'));

    // Conditions
    bar.appendChild(filterGroup('Sky', [
      { label: 'Any', key: 'conditions', value: null },
      { label: 'Dry', key: 'conditions', value: 'dry' },
      { label: 'Clear', key: 'conditions', value: 'cloudy' }
    ], false, 'weather'));

    // Temperature
    bar.appendChild(filterGroup('Temp', [
      { label: 'Any', key: 'tempMin', value: null },
      { label: '>0°', key: 'tempMin', value: 0 },
      { label: '>5°', key: 'tempMin', value: 5 },
      { label: '>10°', key: 'tempMin', value: 10 },
      { label: '>15°', key: 'tempMin', value: 15 }
    ], false, 'weather'));

    // Wind
    bar.appendChild(filterGroup('Wind', [
      { label: 'Any', key: 'wind', value: null },
      { label: 'Calm', key: 'wind', value: 'calm' },
      { label: 'Mod', key: 'wind', value: 'moderate' }
    ], false, 'weather'));
  }

  function filterGroup(label, options, multiSelect, style) {
    var group = document.createElement('div');
    group.className = 'filter-group';

    var lbl = document.createElement('span');
    lbl.className = 'filter-label';
    lbl.textContent = label;
    group.appendChild(lbl);

    var activeClass = style === 'weather' ? 'weather-active' : 'active';

    options.forEach(function (opt, idx) {
      var btn = document.createElement('button');
      btn.className = 'filter-btn';
      btn.textContent = opt.label;
      if (idx === 0) btn.classList.add(activeClass);

      btn.addEventListener('click', function () {
        if (multiSelect && opt.value && opt.value.length > 0) {
          // Toggle multi-select for grades
          btn.classList.toggle(activeClass);
          var anyBtn = group.querySelectorAll('.filter-btn')[0];
          if (btn.classList.contains(activeClass)) {
            anyBtn.classList.remove(activeClass);
          }
          // Collect active grades
          var active = [];
          group.querySelectorAll('.filter-btn').forEach(function (b, i) {
            if (i > 0 && b.classList.contains(activeClass)) {
              active.push(options[i].value[0]);
            }
          });
          if (active.length === 0) anyBtn.classList.add(activeClass);
          Filters.setState('grades', active);
        } else {
          // Single select
          group.querySelectorAll('.filter-btn').forEach(function (b) {
            b.classList.remove(activeClass);
          });
          btn.classList.add(activeClass);
          Filters.setState(opt.key, opt.value);
        }
      });

      group.appendChild(btn);
    });

    return group;
  }

  /* ── Weather tile layers ───────────────────────────── */

  function initWeatherLayers() {
    // RainViewer radar
    fetchRainViewerTimestamps();

    // MeteoSwiss cloud cover (geo.admin.ch WMS)
    weatherLayers.clouds = L.tileLayer.wms('https://wms.geo.admin.ch/', {
      layers: 'ch.meteoschweiz.messwerte-niederschlag-10min',
      format: 'image/png',
      transparent: true,
      opacity: 0.5,
      attribution: 'MeteoSwiss'
    });
  }

  function fetchRainViewerTimestamps() {
    fetch('https://api.rainviewer.com/public/weather-maps.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        rainTimestamps = (data.radar && data.radar.past) ? data.radar.past : [];
        if (data.radar && data.radar.nowcast) {
          rainTimestamps = rainTimestamps.concat(data.radar.nowcast);
        }
        currentRainIdx = rainTimestamps.length > 0 ? rainTimestamps.length - 1 : 0;
        if (rainTimestamps.length > 0) {
          weatherLayers.rain = L.tileLayer(
            'https://tilecache.rainviewer.com' + rainTimestamps[currentRainIdx].path + '/256/{z}/{x}/{y}/2/1_1.png',
            { opacity: 0.5, zIndex: 400 }
          );
        }
      })
      .catch(function () {
        console.warn('RainViewer unavailable');
      });
  }

  function buildWeatherToggles() {
    var panel = document.getElementById('weather-toggles');
    var toggles = [
      { id: 'rain', icon: '🌧️', label: 'Rain radar' },
      { id: 'clouds', icon: '☁️', label: 'Precipitation' },
      { id: 'regions', icon: '🌡️', label: 'Region temp' }
    ];

    toggles.forEach(function (t) {
      var btn = document.createElement('button');
      btn.className = 'wx-toggle';
      btn.innerHTML = '<span class="icon">' + t.icon + '</span> ' + t.label;
      btn.addEventListener('click', function () {
        btn.classList.toggle('active');
        toggleWeatherLayer(t.id, btn.classList.contains('active'));
      });
      panel.appendChild(btn);
    });
  }

  var regionLayer = null;

  function toggleWeatherLayer(id, show) {
    if (id === 'rain' && weatherLayers.rain) {
      if (show) map.addLayer(weatherLayers.rain);
      else map.removeLayer(weatherLayers.rain);
    }
    if (id === 'clouds' && weatherLayers.clouds) {
      if (show) map.addLayer(weatherLayers.clouds);
      else map.removeLayer(weatherLayers.clouds);
    }
    if (id === 'regions') {
      if (show) loadRegionOverlay();
      else if (regionLayer) { map.removeLayer(regionLayer); regionLayer = null; }
    }
  }

  function loadRegionOverlay() {
    if (regionLayer) { map.removeLayer(regionLayer); regionLayer = null; }

    var geojson = window.CANTONS_GEOJSON;
    if (!geojson) { console.warn('No CANTONS_GEOJSON loaded'); return; }

    var dayIdx = Filters.getState().weatherDay;

    regionLayer = L.geoJSON(geojson, {
      style: function (feature) {
        var temp = regionAvgTemp(feature, dayIdx);
        return {
          fillColor: tempColor(temp),
          fillOpacity: 0.35,
          color: '#3a3428',
          weight: 1,
          opacity: 0.6
        };
      },
      onEachFeature: function (feature, layer) {
        var temp = regionAvgTemp(feature, dayIdx);
        if (temp !== null) {
          layer.bindTooltip(
            (feature.properties.name || feature.properties.NAME || '?') + ': ' + Math.round(temp) + '°C',
            { sticky: true, className: 'region-tooltip' }
          );
        }
      }
    });

    regionLayer.addTo(map);
  }

  function regionAvgTemp(feature, dayIdx) {
    // Find SAC peaks within this region polygon and average their temps
    var temps = [];
    var bounds = null;
    try {
      var layer = L.geoJSON(feature);
      bounds = layer.getBounds();
    } catch (e) { return null; }

    allMarkers.forEach(function (m) {
      var ll = m.getLatLng();
      if (bounds.contains(ll)) {
        var wx = WeatherService.getForPeak(m._poi.lat, m._poi.lon, dayIdx);
        if (wx && wx.tempMax !== null) temps.push(wx.tempMax);
      }
    });

    if (temps.length === 0) return null;
    var sum = temps.reduce(function (a, b) { return a + b; }, 0);
    return sum / temps.length;
  }

  function tempColor(temp) {
    if (temp === null) return '#3a3428';
    if (temp < 0) return '#3366cc';
    if (temp < 5) return '#5599dd';
    if (temp < 10) return '#77bbee';
    if (temp < 15) return '#88cc88';
    if (temp < 20) return '#bbdd55';
    if (temp < 25) return '#ddaa33';
    return '#cc4422';
  }

  /* ── Time slider (RainViewer) ──────────────────────── */

  function initTimeSlider() {
    var slider = document.getElementById('forecast-slider');
    var valueEl = document.getElementById('slider-value');
    var playBtn = document.getElementById('play-btn');

    if (rainTimestamps.length === 0) {
      document.getElementById('time-slider').classList.add('hidden');
      return;
    }

    slider.min = 0;
    slider.max = rainTimestamps.length - 1;
    slider.value = currentRainIdx;
    updateSliderLabel(valueEl);

    slider.addEventListener('input', function () {
      currentRainIdx = parseInt(slider.value, 10);
      updateRainLayer();
      updateSliderLabel(valueEl);
    });

    playBtn.addEventListener('click', function () {
      playing = !playing;
      playBtn.textContent = playing ? '⏸' : '▶';
      if (playing) {
        playInterval = setInterval(function () {
          currentRainIdx = (currentRainIdx + 1) % rainTimestamps.length;
          slider.value = currentRainIdx;
          updateRainLayer();
          updateSliderLabel(valueEl);
        }, 800);
      } else {
        clearInterval(playInterval);
      }
    });
  }

  function updateRainLayer() {
    if (!weatherLayers.rain || rainTimestamps.length === 0) return;
    var isOnMap = map.hasLayer(weatherLayers.rain);
    if (isOnMap) map.removeLayer(weatherLayers.rain);
    weatherLayers.rain = L.tileLayer(
      'https://tilecache.rainviewer.com' + rainTimestamps[currentRainIdx].path + '/256/{z}/{x}/{y}/2/1_1.png',
      { opacity: 0.5, zIndex: 400 }
    );
    if (isOnMap) map.addLayer(weatherLayers.rain);
  }

  function updateSliderLabel(el) {
    if (rainTimestamps.length === 0) return;
    var ts = rainTimestamps[currentRainIdx].time * 1000;
    var d = new Date(ts);
    el.textContent = d.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' })
      + ' · ' + d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
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
    createMarkers(routes);

    buildFilterBar();
    buildWeatherToggles();
    initWeatherLayers();

    SidePanel.init(document.getElementById('side-panel'));

    status('Fetching weather forecasts...');
    WeatherService.init(routes, status).then(function () {
      buildWeatherFilters();
      Filters.apply();
      initTimeSlider();

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
