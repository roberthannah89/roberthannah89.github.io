// Index page runtime. Reads hike data from window.HIKES (set inline by the template).
//
// Weather comes from window.WEATHER_CACHE (pre-baked by `make weather` →
// hike_map/weather-cache.js), accessed through window.WeatherService.
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

/* WeatherService.getForPeak keys the cache by `lat.toFixed(3),lon.toFixed(3)`,
   so a hike whose summit coords are even ~110 m from the cached SAC peak
   misses. That's how 16 hikes ended up forecast-less and produced count-only
   clusters that read like overflow next to weather-pill neighbors.
   WxLookup's fuzzy mode matches each hike to the nearest cache entry within
   ~1 km, memoized per (lat, lon) — same fallback, now shared with CC.
   (Named wxLookup, not wx — several functions below already use a local
   `var wx` for the resolved forecast object; reusing the name would shadow
   this wrapper and break `wx.get(...)`.) */
var wxLookup = window.HikeMap.WxLookup({ fuzzy: true });

/* Every hike here has a built page (HIKES only contains rendered hikes), so
   the ★ has-page badge would be on 100% of markers — showHasPage: false
   drops it entirely (no information). The ❄ above-freezing badge is kept. */
var markerFactory = window.HikeMap.MarkerFactory({
  wxLookup: wxLookup,
  showHasPage: false,
  showFreezing: true,
});

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
   later in boot, once HikeMap.DayPicker.mount() has materialized the buttons. */
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
    var wx = wxLookup.get(h, mapDayActive);
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

/* Cluster pill — count + dominant sky + average temp of contained markers. */
var clusterGroup = window.HikeMap.ClusterGroupFactory({
  wxLookup: wxLookup,
  dayIndexGetter: function () { return mapDayActive; },
});
map.addLayer(clusterGroup);

function refreshMarkerIcons() {
  HIKES.forEach(function (h, i) {
    var m = markers[i];
    if (!m) return;
    m.setIcon(markerFactory.makeIcon(h, mapDayActive));
  });
}

function setMapDay(dayIdx) {
  mapDayActive = dayIdx;
  refreshMarkerIcons();
  if (clusterGroup) clusterGroup.refreshClusters();
  renderCardStrips();
  updateCardWeather();
  persistUrl();
  applyFilters();
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
      var wx = wxLookup.get(h, dIdx);
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

/* Compose the popup meta line ("2136 m · 1622 m gain · 21.0 km · ~7h") from
   whichever HIKES fields are populated. Kept short — the popup is a peek,
   not the full spec. */
function buildHikeMetaLine(h) {
  var parts = [];
  if (h.elev) parts.push(h.elev);
  if (h.gain) parts.push(h.gain + ' gain');
  if (h.distance) parts.push(h.distance);
  if (h.time) parts.push(h.time);
  return parts.join(' · ');
}

/* Build popup HTML for a hike using the currently selected forecast day.
   Called on every marker click (rather than at bind time) so the weather
   block reflects mapDayActive after the user switches days. */
function buildHikePopupHtml(h) {
  var wx = WX ? wxLookup.get(h, mapDayActive) : null;
  var photos = (h.photos && h.photos.length) ? h.photos : (h.photo ? [h.photo] : []);
  return window.HikePopup.build({
    name: h.name,
    grade: h.grade,
    metaLine: buildHikeMetaLine(h),
    photos: photos,
    weather: wx ? {
      code: wx.code,
      tempMax: wx.tempMax,
      precip: wx.precip,
      windMax: wx.windMax,
      freezingLevel: wx.freezingLevel,
      date: wx.date,
      peakAlt: h.summitElev,
    } : null,
    hikeHref: h.href,
    showExpand: false,
  });
}

var missingForecast = [];
HIKES.forEach(function (h, i) {
  if (h.lat == null || h.lon == null) { markers.push(null); return; }
  var wx = WX ? wxLookup.get(h, mapDayActive) : null;
  if (!wx) missingForecast.push(h.name);
  var m = L.marker([h.lat, h.lon], {
    icon: markerFactory.makeIcon(h, mapDayActive),
  });
  m._poi = h;
  m._idx = i;
  /* Every marker on this page has a built page (HIKES only contains rendered
     hikes) — the popup links to it directly. No expand button: there's no
     side panel here, so the popup is the peek and the hike page is the
     deep-dive.

     Bind the popup on click rather than up-front so the weather block picks
     up the currently selected forecast day. Mirrors CC's openPopup pattern
     (getPopup/setPopupContent for re-clicks). */
  m.on('click', function () {
    var html = buildHikePopupHtml(h);
    if (m.getPopup()) m.setPopupContent(html);
    else m.bindPopup(html);
    m.openPopup();
  });
  m.on('popupopen', function (e) {
    var el = e.popup.getElement();
    if (el && window.HikePopup && HikePopup.bindCarousel) {
      HikePopup.bindCarousel(el);
    }
  });
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
var mapDayPicker = window.HikeMap.DayPicker.mount({
  container: '#mapDayBtns',
  initial: mapDayActive,
  onChange: function (i) { setMapDay(i); },   // existing function handles refreshMarkerIcons, cards, URL, filters
});
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
