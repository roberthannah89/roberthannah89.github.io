// Index page runtime. Reads hike data from window.HIKES (set inline by the template).
//
// Weather comes from window.WEATHER_CACHE (pre-baked by `make weather` →
// command-center/weather-cache.js), accessed through window.WeatherService.
// Same data source as Command Center — the two pages can't drift on forecast
// content, model, or schema.
(function () {
"use strict";
const HIKES = window.HIKES || [];
const WX = window.WeatherService;
/* Wire window.WEATHER_CACHE into WeatherService's module-private store now —
   getForPeak() / getDayChoices() return empty until this runs. The [] arg is
   the per-peak route list CC uses for warmup; we don't need it here, the
   cache is already keyed by lat,lon. */
if (WX) WX.init([]);

/* ------------- helpers ------------- */
function num(s) { const m = String(s).match(/-?[\d.]+/); return m ? parseFloat(m[0]) : NaN; }
function gradeNum(g) { const m = String(g).match(/T(\d)/); return m ? parseInt(m[1], 10) : 0; }
function parseNum(s) { const m = String(s || "").match(/([\d.]+)/); return m ? parseFloat(m[1]) : NaN; }
function parseHours(s) {
  if (!s) return NaN;
  if (/day/i.test(s)) return 12;
  const m = String(s).match(/([\d.]+)\s*[–-]\s*([\d.]+)/);
  if (m) return (parseFloat(m[1]) + parseFloat(m[2])) / 2;
  const m2 = String(s).match(/([\d.]+)/);
  return m2 ? parseFloat(m2[1]) : NaN;
}
function fmtDow(s) { return new Date(s + "T00:00").toLocaleDateString(undefined, { weekday: "short" }); }
function escAttr(s) { return String(s).replace(/"/g, "&quot;"); }

/* Grade colours — matches command-center.js GRADE_COLORS so markers on both
   pages tint identically. */
const GRADE_COLORS = {
  1: '#5cbf6a', 2: '#5cbf6a',
  3: '#e8a832',
  4: '#d97333',
  5: '#cc3333',
  6: '#8844cc',
};
function gradeColor(g) {
  const n = parseInt(String(g || 'T1').replace('T', ''), 10) || 1;
  return GRADE_COLORS[n] || GRADE_COLORS[1];
}

/* ------------- cards ------------- */
var grid = document.getElementById("grid");
HIKES.forEach(function (h, i) {
  var card = document.createElement("a");
  card.className = "card";
  card.href = h.href;
  card.dataset.idx = i;
  card.dataset.grade = gradeNum(h.grade);
  card.dataset.region = (h.region || "").toLowerCase();
  card.dataset.canton = (h.canton || "").toLowerCase();
  card.dataset.dist = parseNum(h.distance);
  card.dataset.gain = parseNum(h.gain);
  card.dataset.elev = parseNum(h.elev);
  card.dataset.timeH = parseHours(h.time);
  card.dataset.route = (h.route_type || "").toLowerCase();
  card.innerHTML =
    '<div class="photo-wrap">' +
      (h.photo ? '<img src="' + escAttr(h.photo) + '" alt="' + escAttr(h.name) + '" loading="lazy">' : '') +
      (h.region ? '<span class="region-badge">' + h.region + '</span>' : '') +
    '</div>' +
    '<div class="body">' +
      '<div class="title-row">' +
        '<span class="name">' + h.name + '</span>' +
        (h.elev ? '<span class="elev">' + h.elev + '</span>' : '') +
      '</div>' +
      '<div class="grade-row">' +
        (h.grade ? '<span class="pill ' + h.gradeClass + '">' + h.grade + '</span>' : '') +
        '<span class="stats">' +
          (h.distance ? '<span>' + h.distance + '</span>' : '') +
          (h.distance && h.gain ? '<span class="sep">·</span>' : '') +
          (h.gain ? '<span>' + h.gain + '</span>' : '') +
          ((h.distance || h.gain) && h.time ? '<span class="sep">·</span>' : '') +
          (h.time ? '<span>' + h.time + '</span>' : '') +
        '</span>' +
      '</div>' +
      (h.canton ? '<div class="canton-row"><span class="canton-tag">' + h.canton + '</span></div>' : '') +
      '<div class="weather-strip" data-hike="' + i + '"></div>' +
    '</div>';
  card.addEventListener("mouseenter", function () { highlightMarker(i, true); });
  card.addEventListener("mouseleave", function () { highlightMarker(i, false); });
  grid.appendChild(card);
});

/* ------------- region filter buttons ------------- */
var regionGroup = document.querySelector('.filter-group[data-filter="region"]');
var regions = [];
HIKES.forEach(function (h) { if (h.region && regions.indexOf(h.region) === -1) regions.push(h.region); });
regions.sort();
regions.forEach(function (r) {
  var b = document.createElement("button");
  b.className = "filter-btn";
  b.dataset.value = r.toLowerCase();
  b.textContent = r;
  regionGroup.appendChild(b);
});

/* ------------- canton filter buttons ------------- */
var cantonGroup = document.querySelector('.filter-group[data-filter="canton"]');
var cantons = [];
HIKES.forEach(function (h) { if (h.canton && cantons.indexOf(h.canton) === -1) cantons.push(h.canton); });
cantons.sort();
cantons.forEach(function (c) {
  var b = document.createElement("button");
  b.className = "filter-btn";
  b.dataset.value = c.toLowerCase();
  b.textContent = c;
  cantonGroup.appendChild(b);
});

/* ------------- filtering ------------- */
var activeFilters = { grade: "all", region: "all", canton: "all", weather: "all", dist: "all", gain: "all", temp: "all", elev: "all", time: "all", route: "all" };

/* Restore filter state from URL hash before wiring click handlers — so the
   initial render reflects #g=alpine&di=long etc. Day-picker restore happens
   later in boot, once buildMapDayBtns has materialized the buttons. */
var URL_STATE = (window.IndexUrlSync && window.IndexUrlSync.readFromUrl()) || {};
Object.keys(URL_STATE).forEach(function (k) {
  if (k === 'weatherDay') return;
  if (URL_STATE[k] && activeFilters.hasOwnProperty(k)) activeFilters[k] = URL_STATE[k];
});

function syncFilterButtons() {
  document.querySelectorAll(".filter-group").forEach(function (group) {
    var key = group.dataset.filter;
    var val = activeFilters[key] || 'all';
    group.querySelectorAll(".filter-btn").forEach(function (b) {
      b.classList.toggle('active', b.dataset.value === val);
    });
  });
}

function persistUrl() {
  if (window.IndexUrlSync) window.IndexUrlSync.writeToUrl(activeFilters, mapDayActive, layerState);
  updateResetVisibility();
}

/* Webcam + SLF avalanche overlay state (mirrors CC's bottom-bar toggles). */
var layerState = {
  webcams:   !!URL_STATE.webcams,
  avalanche: !!URL_STATE.avalanche,
};
var webcamLayerInstance = null;   /* lazily created on first activation */
var slfLayerInstance = null;
var slfPending = false;

document.querySelectorAll(".filter-group").forEach(function (group) {
  var key = group.dataset.filter;
  group.addEventListener("click", function (e) {
    var btn = e.target.closest(".filter-btn");
    if (!btn) return;
    group.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    activeFilters[key] = btn.dataset.value;
    persistUrl();
    applyFilters();
  });
});

function gradeMatch(g, filter) {
  if (filter === "all") return true;
  if (filter === "easy") return g >= 1 && g <= 2;
  if (filter === "demanding") return g === 3;
  if (filter === "alpine") return g >= 4;
  return true;
}
/* Sky → 3-bucket weather filter category. Uses WeatherService.skyCategory so
   the page stays consistent with CC's "Sky" filter buckets — this page's
   3-bucket good/ok/bad is a coarser collapse of the 6 CC categories. */
function wxCategory(code) {
  if (!WX) return null;
  var sky = WX.skyCategory(code);
  if (sky === 'clear') return 'good';
  if (sky === 'partly-cloudy' || sky === 'cloudy') return 'ok';
  return 'bad';  /* rain / snow / storm */
}
function updateCardWeather() {
  if (!WX) return;
  document.querySelectorAll(".card").forEach(function (card) {
    var idx = parseInt(card.dataset.idx, 10);
    var h = HIKES[idx];
    if (!h) return;
    var wx = WX.getForPeak(h.lat, h.lon, mapDayActive);
    if (!wx) return;
    card.dataset.wx = wxCategory(wx.code);
    if (wx.tempMax != null) card.dataset.temp = Math.round(wx.tempMax);
  });
}
function applyFilters() {
  var visible = 0;
  document.querySelectorAll(".card").forEach(function (card) {
    var g = parseInt(card.dataset.grade, 10) || 0;
    var region = card.dataset.region;
    var ok = gradeMatch(g, activeFilters.grade);
    if (ok && activeFilters.region !== "all") ok = region === activeFilters.region;
    if (ok && activeFilters.canton !== "all") ok = card.dataset.canton === activeFilters.canton;
    if (ok && activeFilters.weather !== "all") ok = card.dataset.wx === activeFilters.weather;
    if (ok && activeFilters.dist !== "all") {
      var d = parseFloat(card.dataset.dist);
      if (activeFilters.dist === "short") ok = !isNaN(d) && d <= 10;
      else if (activeFilters.dist === "medium") ok = !isNaN(d) && d > 10 && d <= 15;
      else if (activeFilters.dist === "long") ok = !isNaN(d) && d > 15;
    }
    if (ok && activeFilters.gain !== "all") {
      var g2 = parseFloat(card.dataset.gain);
      if (activeFilters.gain === "gentle") ok = !isNaN(g2) && g2 <= 700;
      else if (activeFilters.gain === "moderate") ok = !isNaN(g2) && g2 > 700 && g2 <= 1300;
      else if (activeFilters.gain === "strenuous") ok = !isNaN(g2) && g2 > 1300;
    }
    if (ok && activeFilters.temp !== "all") {
      var t = parseFloat(card.dataset.temp);
      if (activeFilters.temp === "cold") ok = !isNaN(t) && t < 5;
      else if (activeFilters.temp === "cool") ok = !isNaN(t) && t >= 5 && t <= 15;
      else if (activeFilters.temp === "warm") ok = !isNaN(t) && t > 15;
    }
    if (ok && activeFilters.elev !== "all") {
      var e = parseFloat(card.dataset.elev);
      if (activeFilters.elev === "low")  ok = !isNaN(e) && e <= 2000;
      else if (activeFilters.elev === "mid")  ok = !isNaN(e) && e > 2000 && e <= 2500;
      else if (activeFilters.elev === "high") ok = !isNaN(e) && e > 2500;
    }
    if (ok && activeFilters.time !== "all") {
      var h2 = parseFloat(card.dataset.timeH);
      if (activeFilters.time === "short")  ok = !isNaN(h2) && h2 <= 4;
      else if (activeFilters.time === "medium") ok = !isNaN(h2) && h2 > 4 && h2 <= 7;
      else if (activeFilters.time === "long")   ok = !isNaN(h2) && h2 > 7;
    }
    if (ok && activeFilters.route !== "all") ok = card.dataset.route === activeFilters.route;
    card.style.display = ok ? "" : "none";
    if (ok) visible++;
    var idx = parseInt(card.dataset.idx, 10);
    var m = markers[idx];
    if (m) {
      if (ok) clusterGroup.addLayer(m);
      else clusterGroup.removeLayer(m);
    }
  });
  document.getElementById("empty").style.display = visible ? "none" : "block";
}

/* ------------- map ------------- */
var map = L.map("map");
var MS = window.MapShared;
if (MS) MS.addLayerControl(map, { defaultLayer: "color" });

/* canton colour palette */
var CANTON_COLORS = {
  "appenzell innerrhoden": "#ff5c5c",
  "bern":                  "#4a9eff",
  "schwyz":                "#ff9b43",
  "appenzell ausserrhoden":"#c084fc",
  "st. gallen":            "#34d399",
  "glarus":                "#fbbf24",
  "uri":                   "#f87171",
  "obwalden":              "#60a5fa",
  "nidwalden":             "#a78bfa",
};
function cantonColor(canton) {
  return CANTON_COLORS[(canton || "").toLowerCase()] || "#8888aa";
}

var markers = [];
var latlngs = [];
var mapDayActive = 0;  /* default to Today — matches CC */

/* Cluster pill — count + dominant sky + average temp of contained markers.
   Mirrors command-center.js's dominantClusterWeather, but built off
   WeatherService instead of per-marker `_wx` so it stays correct after
   day-picker changes without needing manual recomputation. */
var SKY_TINTS = {
  'clear':         { bg: 'rgba(232, 168, 50, 0.85)',  border: '#e8a832', color: '#1a1810' },
  'partly-cloudy': { bg: 'rgba(168, 152, 120, 0.85)', border: '#a89878', color: '#1a1810' },
  'cloudy':        { bg: 'rgba(60, 60, 70, 0.85)',    border: '#6a6a78', color: '#f0e8d8' },
  'rain':          { bg: 'rgba(80, 130, 200, 0.85)',  border: '#5082c8', color: '#f0e8d8' },
  'snow':          { bg: 'rgba(220, 230, 240, 0.85)', border: '#dce6f0', color: '#1a1810' },
  'storm':         { bg: 'rgba(180, 60, 60, 0.85)',   border: '#b43c3c', color: '#f0e8d8' },
};

function dominantClusterWeather(cluster) {
  if (!WX || !WX.skyCategory || !WX.SKY_CATEGORIES) return null;
  var counts = {}, tempSum = 0, tempN = 0;
  cluster.getAllChildMarkers().forEach(function (m) {
    var h = m._hike;
    if (!h) return;
    var wx = WX.getForPeak(h.lat, h.lon, mapDayActive);
    if (!wx) return;
    var cat = WX.skyCategory(wx.code);
    if (cat) counts[cat] = (counts[cat] || 0) + 1;
    if (typeof wx.tempMax === 'number') { tempSum += wx.tempMax; tempN++; }
  });
  var best = null, max = 0;
  Object.keys(counts).forEach(function (k) {
    if (counts[k] > max) { best = k; max = counts[k]; }
  });
  if (!best) return null;
  var defn = WX.SKY_CATEGORIES.find(function (c) { return c.key === best; });
  return {
    tint: SKY_TINTS[best],
    emoji: defn ? defn.icon : '',
    temp: tempN ? (tempSum / tempN) : null,
  };
}

var clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 45,
  disableClusteringAtZoom: 13,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
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
      iconSize: L.point(64, 28),
    });
  },
});
map.addLayer(clusterGroup);

/* Marker icon — CC's two-mode style.
   Every hike here has a built page in this repo, so the ★ has-page badge
   would apply to 100% of markers — we drop it entirely (no information).
   The ❄ above-freezing pip is kept; it varies per peak/day. */
function makeMarkerIcon(color, wx, summitElev) {
  var aboveFreezing = !!(summitElev && wx && wx.freezingLevel != null && summitElev > wx.freezingLevel);
  var frzCls = aboveFreezing ? ' hike-marker--above-freezing' : '';
  if (wx && wx.code != null) {
    var emoji = WX ? WX.weatherIcon(wx.code) : '';
    var tempStr = (wx.tempMax != null) ? Math.round(wx.tempMax) + '°' : '';
    var temp = tempStr ? '<span class="hike-marker__temp">' + tempStr + '</span>' : '';
    return L.divIcon({
      className: '',
      html: '<div class="hike-marker hike-marker--wx' + frzCls + '" style="border-color:' + color + ';background:' + color + '22">'
          + '<span class="hike-marker__wx">' + emoji + '</span>' + temp + '</div>',
      iconSize: [40, 28],
      iconAnchor: [20, 14],
    });
  }
  return L.divIcon({
    className: '',
    html: '<div class="hike-marker hike-marker--dot' + frzCls + '" style="background:' + color + '"></div>',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

function refreshMarkerIcons() {
  HIKES.forEach(function (h, i) {
    var m = markers[i];
    if (!m) return;
    var wx = WX ? WX.getForPeak(h.lat, h.lon, mapDayActive) : null;
    m.setIcon(makeMarkerIcon(gradeColor(h.grade), wx, h.summitElev));
  });
}

function setMapDay(dayIdx) {
  mapDayActive = dayIdx;
  document.querySelectorAll('.map-day-btn').forEach(function (btn, i) {
    btn.classList.toggle('active', i === dayIdx);
  });
  refreshMarkerIcons();
  if (clusterGroup) clusterGroup.refreshClusters();
  renderCardStrips();
  updateCardWeather();
  persistUrl();
  applyFilters();
}

function buildMapDayBtns() {
  var bar = document.getElementById('mapDayBtns');
  if (!bar) return;
  bar.innerHTML = '';
  if (!WX) {
    var msg = document.createElement('button');
    msg.className = 'map-day-btn';
    msg.disabled = true;
    msg.style.opacity = '.5';
    msg.textContent = 'No forecast — run `make weather`';
    bar.appendChild(msg);
    return;
  }
  var choices = WX.getDayChoices();
  if (!choices.length) {
    var none = document.createElement('button');
    none.className = 'map-day-btn';
    none.disabled = true;
    none.style.opacity = '.5';
    none.textContent = 'No forecast available';
    bar.appendChild(none);
    return;
  }
  choices.forEach(function (c, i) {
    var btn = document.createElement('button');
    btn.className = 'map-day-btn' + (i === mapDayActive ? ' active' : '');
    btn.textContent = c.label;
    btn.onclick = function () { setMapDay(i); };
    bar.appendChild(btn);
  });
}

/* Per-card weather strip — one column per forecast day. Re-renders on
   day-picker change so the active day stays visually marked. */
function renderCardStrips() {
  if (!WX) {
    document.querySelectorAll('.weather-strip').forEach(function (strip) {
      strip.innerHTML = '<div class="wx" style="grid-column:1/-1">forecast unavailable</div>';
    });
    return;
  }
  var choices = WX.getDayChoices();
  HIKES.forEach(function (h, i) {
    var strip = document.querySelector('.weather-strip[data-hike="' + i + '"]');
    if (!strip) return;
    if (h.lat == null || h.lon == null) { strip.innerHTML = ''; return; }
    var html = '';
    var anyData = false;
    choices.forEach(function (c, dIdx) {
      var wx = WX.getForPeak(h.lat, h.lon, dIdx);
      if (wx) anyData = true;
      var icon = wx ? WX.weatherIcon(wx.code) : '·';
      var label = wx ? WX.weatherLabel(wx.code) : '';
      var tmax = (wx && wx.tempMax != null) ? Math.round(wx.tempMax) + '°' : '–';
      var activeCls = dIdx === mapDayActive ? ' active' : '';
      html += '<div class="wx' + activeCls + '" title="' + escAttr(label) + '">' +
        '<div class="dow">' + fmtDow(c.date) + '</div>' +
        '<div class="icon">' + icon + '</div>' +
        '<div class="tmax">' + tmax + '</div>' +
      '</div>';
    });
    strip.innerHTML = anyData ? html : '<div class="wx" style="grid-column:1/-1">forecast unavailable</div>';
  });
}

var missingForecast = [];
HIKES.forEach(function (h, i) {
  if (h.lat == null || h.lon == null) { markers.push(null); return; }
  var wx = WX ? WX.getForPeak(h.lat, h.lon, mapDayActive) : null;
  if (!wx) missingForecast.push(h.name);
  var m = L.marker([h.lat, h.lon], {
    icon: makeMarkerIcon(gradeColor(h.grade), wx, h.summitElev),
  });
  m._hike = h;
  m._idx = i;
  var popup =
    (h.photo ? '<img src="' + escAttr(h.photo) + '" alt="">' : '') +
    '<div class="pop-name">' + h.name + '</div>' +
    (h.canton ? '<div style="font-size:.78rem;color:#a0a4ad;margin:.1rem 0 .2rem;">' + h.canton + '</div>' : '') +
    (h.grade ? '<div style="margin:.2rem 0;"><span class="pill ' + h.gradeClass + '">' + h.grade + '</span></div>' : '') +
    '<a href="' + h.href + '">View plan →</a>';
  m.bindPopup(popup);
  clusterGroup.addLayer(m);
  markers.push(m);
  latlngs.push([h.lat, h.lon]);
});
if (latlngs.length) {
  map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 11 });
} else {
  map.setView([46.8, 8.2], 8);
}
window.addEventListener('resize', function () { map.invalidateSize(); });

if (missingForecast.length) {
  console.warn('[hikes] ' + missingForecast.length + ' hike(s) without forecast data:', missingForecast);
}

function highlightMarker(i, on) {
  var m = markers[i];
  if (!m) return;
  var el = m.getElement();
  if (el) el.classList.toggle('marker-hl', on);
  if (on) m.bringToFront();
}

/* ------------- boot ------------- */
/* Region/canton filter buttons are injected by JS earlier in this file —
   syncFilterButtons() needs to run AFTER them so the URL-restored "active"
   state actually lands on the right buttons. */
if (URL_STATE.weatherDay != null) mapDayActive = URL_STATE.weatherDay;
buildMapDayBtns();
syncFilterButtons();
renderCardStrips();
updateCardWeather();
/* If we restored a non-default weatherDay, the marker icons built above were
   for day 0 — refresh now that mapDayActive is correct. */
if (mapDayActive !== 0) refreshMarkerIcons();
mountToolbarButtons();
updateResetVisibility();
applyFilters();

/* ------------- Layer toggles (webcams / avalanche) ------------- */
function setWebcams(on) {
  layerState.webcams = !!on;
  if (on) {
    if (!webcamLayerInstance && window.WebcamLayer) {
      webcamLayerInstance = window.WebcamLayer.create();
    }
    if (webcamLayerInstance) map.addLayer(webcamLayerInstance);
  } else if (webcamLayerInstance) {
    map.removeLayer(webcamLayerInstance);
  }
  persistUrl();
}
function setAvalanche(on) {
  layerState.avalanche = !!on;
  if (on) {
    if (slfLayerInstance) {
      map.addLayer(slfLayerInstance);
    } else if (!slfPending && window.SlfLayer) {
      slfPending = true;
      window.SlfLayer.create().then(function (layer) {
        slfPending = false;
        slfLayerInstance = layer;
        /* User may have toggled off again while loading; respect current state. */
        if (layerState.avalanche) map.addLayer(slfLayerInstance);
      }).catch(function (err) {
        slfPending = false;
        console.warn('[hikes] SLF layer failed to load:', err);
      });
    }
  } else if (slfLayerInstance) {
    map.removeLayer(slfLayerInstance);
  }
  persistUrl();
}

/* ------------- Reset / Share / Layer toolbar buttons ------------- */
function mountToolbarButtons() {
  var filtersEl = document.getElementById('filters');
  if (!filtersEl || filtersEl.querySelector('.toolbar-actions')) return;
  var wrap = document.createElement('div');
  wrap.className = 'toolbar-actions';
  wrap.style.cssText = 'display:flex; gap:.5rem; align-items:center; margin-left:auto;';

  function makeToggle(label, title, on, handler) {
    var b = document.createElement('button');
    b.className = 'filter-btn' + (on ? ' active' : '');
    b.textContent = label;
    b.title = title;
    b.onclick = function () {
      var nowOn = !b.classList.contains('active');
      b.classList.toggle('active', nowOn);
      handler(nowOn);
    };
    return b;
  }

  var webcamBtn = makeToggle('📷 Webcams', 'Show Windy webcams', layerState.webcams, setWebcams);
  var slfBtn    = makeToggle('❄️ Avalanche', 'Show SLF avalanche bulletin (winter only)', layerState.avalanche, setAvalanche);

  var resetBtn = document.createElement('button');
  resetBtn.id = 'resetBtn';
  resetBtn.className = 'filter-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.title = 'Clear filters';
  resetBtn.style.display = 'none';
  resetBtn.onclick = function () {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    window.location.reload();
  };

  var shareBtn = document.createElement('button');
  shareBtn.className = 'filter-btn';
  shareBtn.textContent = 'Share';
  shareBtn.title = 'Copy this view’s URL';
  shareBtn.onclick = function () {
    var url = window.location.href;
    var done = function () {
      var orig = shareBtn.textContent;
      shareBtn.textContent = 'Copied';
      setTimeout(function () { shareBtn.textContent = orig; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      done();
    }
  };

  wrap.appendChild(webcamBtn);
  wrap.appendChild(slfBtn);
  wrap.appendChild(resetBtn);
  wrap.appendChild(shareBtn);
  filtersEl.appendChild(wrap);

  /* If URL state had layers on, materialise them now that the map exists. */
  if (layerState.webcams)   setWebcams(true);
  if (layerState.avalanche) setAvalanche(true);
}

function updateResetVisibility() {
  var btn = document.getElementById('resetBtn');
  if (!btn) return;
  btn.style.display = (window.IndexUrlSync && window.IndexUrlSync.hasHash()) ? '' : 'none';
}
})();
