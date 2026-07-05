// GENERATED FROM ../../templates/_assets/index_page.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

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

/* Canonical shared filter store + matcher (hike_map/filter_store.js,
   filter_matcher.js, url_sync.js). Index doesn't mount CC's Filters shim —
   region/canton/grade/etc. buttons are page-owned and write to `store`
   directly. Weather (sk) and temperature (t) have no UI here (design intent:
   see docs/superpowers/specs/2026-07-05-cc-index-engine-unification-design.md)
   but still apply if replayed via a cross-page URL from Command Center. */
var store = window.HikeMap.FilterStore({
  keys: ['g', 'r', 'c', 'rt', 'di', 'tm', 'el', 'gn', 'd', 'wc'],
  initial: window.HikeMap.UrlSync.readFromUrl(),
});
var matcher = window.HikeMap.FilterMatcher.factory({ wxLookup: wxLookup });
window.HikeMap.UrlSync.bind({ store: store });

/* HIKES entry → the canonical poi shape HikeMap.SidePanel renders (Route +
   Forecast sections). Unlike hikeToMatchable() above (used for filtering),
   this doesn't need every display field — just enough for the panel to look
   up weather (lat/lon), draw the grade badge, and link out to SAC (id +
   routes[].id). The hero + "Getting There & Back" sections read the full
   HIKES entry directly via matchingHike below, not this adapter. */
function hikeToPoi(h) {
  return {
    name: h.name, lat: h.lat, lon: h.lon,
    alt: h.summitElev,
    id: h.sac_peak_id || null,
    routes: h.sac_route_id ? [{ id: h.sac_route_id, grade: h.grade }] : [],
  };
}

/* Every marker on this page already IS a built hike — pageNative passed to
   panel.open() is the HIKES entry itself, so "matching" it to a built hike
   is the identity function (mirrors CC's matchingHike(), which instead
   searches window.HIKES because CC's markers are SAC POIs, not hikes). */
var panel = window.HikeMap.SidePanel.mount({
  container: '#index-side-panel',
  wxLookup: wxLookup,
  dataAdapter: hikeToPoi,
  matchingHike: function (h) { return h; },
  store: store,
});

/* ------------- helpers ------------- */
function num(s) { const m = String(s).match(/-?[\d.]+/); return m ? parseFloat(m[0]) : NaN; }
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

/* HIKES entry → matchablePoi. Every hike here has a built page (this page
   only ever lists rendered hikes) and is always poiKind 'hike' (no huts on
   the index page). summitElev is the raw numeric peak elevation (h.elev is
   the pre-formatted "2136 m" display string). */
function hikeToMatchable(h) {
  return {
    name: h.name, lat: h.lat, lon: h.lon,
    // Grades can carry a +/- modifier ('T4+', 'T3-', ...) that the grade
    // filter buttons don't expose individually (only bare T1-2/T3/T4/T5/T6)
    // — strip it so a T4+/T4- hike still matches the T4 button. Display
    // elsewhere (card pill, popup) still reads h.grade directly.
    grade: h.grade ? h.grade.replace(/[+-]$/, "") : h.grade,
    region: (h.region || "").toLowerCase(),
    canton: (h.canton || "").toLowerCase(),
    routeType: (h.route_type || "").toLowerCase(),
    alt: h.summitElev,
    gain: parseNum(h.gain),
    timeH: parseHours(h.time),
    distance: parseNum(h.distance),
    hasPage: true,
    poiKind: "hike",
    raw: h,
  };
}

/* ------------- cards ------------- */
var grid = document.getElementById("grid");
HIKES.forEach(function (h, i) {
  var card = document.createElement("a");
  card.className = "card";
  card.href = h.href;
  card.dataset.idx = i;
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
var regionGroup = document.querySelector('.filter-group[data-filter="r"]');
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
var cantonGroup = document.querySelector('.filter-group[data-filter="c"]');
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

// Restore button active-classes from URL-seeded store state, now that every
// filter-group (including the JS-injected region/canton buttons) exists.
//
// Single-select groups (r, c, rt, di, tm, el, gn) all render one active
// button at a time, but the *store* doesn't treat them uniformly: r/c/rt are
// csv-typed in hike_map/url_sync.js's KEYS (so a URL-restored value arrives
// as an array, e.g. `#r=bern` -> ['bern']), while di/tm/el/gn are plain
// str-typed scalars. Comparing `b.dataset.value === val` unconditionally
// used to silently fail to highlight r/c/rt buttons on URL restore even
// though the shared matcher (which already tolerates both shapes via
// inSet()) filtered the cards correctly — see Finding 1, Phase F review.
// Checking Array.isArray(val) here (rather than consulting UrlSync.KEYS)
// makes restore agree with whatever shape the click handler below actually
// wrote, for either representation.
function restoreFilterButtons() {
  document.querySelectorAll(".filter-group").forEach(function (group) {
    var key = group.dataset.filter;
    if (group.dataset.multi === "true") {
      var sel = store.get(key) || [];
      group.querySelectorAll(".filter-btn").forEach(function (b) {
        var vals = b.dataset.value.split(",");
        b.classList.toggle("active", vals.every(function (v) { return sel.indexOf(v) !== -1; }));
      });
      return;
    }
    var val = store.get(key);
    var isArrayVal = Array.isArray(val);
    var hasVal = isArrayVal ? val.length > 0 : !!val;
    group.querySelectorAll(".filter-btn").forEach(function (b) {
      var active = !hasVal
        ? b.dataset.value === "all"
        : (isArrayVal ? val.indexOf(b.dataset.value) !== -1 : b.dataset.value === val);
      b.classList.toggle("active", active);
    });
  });
}

// Wire filter-group clicks. Multi-select groups (grade) toggle their own
// button and collect every active button's value(s) into an array. Single-
// select groups keep the existing "All" button idiom: clicking any button
// (including "All") clears every sibling's active state first.
//
// r/c/rt are csv-typed (see url_sync.js KEYS), so their single-select click
// handler must also write an array of one — matching what a URL-restored
// value looks like — instead of a bare string (Finding 1). di/tm/el/gn are
// str-typed and keep writing a scalar.
var UrlSyncKeys = window.HikeMap.UrlSync.KEYS;
document.querySelectorAll(".filter-group").forEach(function (group) {
  var key = group.dataset.filter;
  var multi = group.dataset.multi === "true";
  var isCsv = !!(UrlSyncKeys[key] && UrlSyncKeys[key].type === "csv");
  group.addEventListener("click", function (e) {
    var btn = e.target.closest(".filter-btn");
    if (!btn) return;
    if (multi) {
      btn.classList.toggle("active");
      var active = [];
      group.querySelectorAll(".filter-btn.active").forEach(function (b) {
        active = active.concat(b.dataset.value.split(","));
      });
      store.set(key, active);
    } else {
      group.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      var val = btn.dataset.value === "all" ? null : btn.dataset.value;
      store.set(key, isCsv && val !== null ? [val] : val);
    }
    applyFilters();
  });
});

function applyFilters() {
  var visible = 0;
  var state = store.state();
  document.querySelectorAll(".card").forEach(function (card) {
    var idx = parseInt(card.dataset.idx, 10);
    var h = HIKES[idx];
    var ok = !!h && matcher.match(hikeToMatchable(h), state);
    card.style.display = ok ? "" : "none";
    if (ok) visible++;
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
var mapDayActive = store.get("d") || 0;  /* default to Today — matches CC */

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
  store.set("d", dayIdx);
  refreshMarkerIcons();
  if (clusterGroup) clusterGroup.refreshClusters();
  renderCardStrips();
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
    showExpand: true,
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
     hikes) — the popup links to it directly, and its "Expand details" button
     opens the side panel (forecast-first deep-dive; the card grid is the
     photo-first path to the same page — see the 2026-07-05 unification spec).

     Mirrors CC's marker click handler: if the panel is already open, route
     straight to panel.open() instead of popping up a popup on top of it.

     Bind the popup on click rather than up-front so the weather block picks
     up the currently selected forecast day. Mirrors CC's openPopup pattern
     (getPopup/setPopupContent for re-clicks). */
  m.on('click', function () {
    if (panel && panel.isOpen()) {
      panel.open(h);
      return;
    }
    var html = buildHikePopupHtml(h);
    if (m.getPopup()) m.setPopupContent(html);
    else m.bindPopup(html);
    m.openPopup();
  });
  m.on('popupopen', function (e) {
    if (panel && panel.isOpen()) {
      m.closePopup();
      return;
    }
    var el = e.popup.getElement();
    if (!el) return;
    var btn = el.querySelector('.popup-expand');
    if (btn) {
      btn.onclick = function () {
        m.closePopup();
        if (panel) panel.open(h);
      };
    }
    if (window.HikePopup && HikePopup.bindCarousel) {
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

/* ------------- Layer toggles (webcams) ------------- */
/* Declared before boot() runs — mountToolbarButtons() (called from boot,
   below) reads layerState and calls setWebcams. */
var layerState = {
  webcams: !!store.get("wc"),
};
var webcamLayerInstance = null;   /* lazily created on first activation */

function setWebcams(on) {
  layerState.webcams = !!on;
  store.set("wc", layerState.webcams);
  if (on) {
    if (!webcamLayerInstance && window.WebcamLayer) {
      webcamLayerInstance = window.WebcamLayer.create();
    }
    if (webcamLayerInstance) map.addLayer(webcamLayerInstance);
  } else if (webcamLayerInstance) {
    map.removeLayer(webcamLayerInstance);
  }
}

/* Avalanche / SLF danger layer — always on, no toggle (safety-relevant hazard
   layers must never be hidden by default; may extend to future "danger
   segments" layers the same way). Auto-created at boot instead of on first
   toggle click. SlfLayer.create() still lazy-loads slf_cache.js internally
   (empty May–Oct) — only the add-to-map moment moved from click-time to
   boot-time, the cache stays lazy. */
function bootAvalancheLayer() {
  if (!window.SlfLayer) return;
  window.SlfLayer.create().then(function (layer) {
    map.addLayer(layer);
  }).catch(function (err) {
    console.warn('[hikes] SLF layer failed to load:', err);
  });
}

/* ------------- boot ------------- */
/* Region/canton filter buttons are injected by JS earlier in this file —
   restoreFilterButtons() needs to run AFTER them so the URL-restored "active"
   state actually lands on the right buttons. */
var mapDayPicker = window.HikeMap.DayPicker.mount({
  container: '#mapDayBtns',
  initial: mapDayActive,
  onChange: function (i) { setMapDay(i); },   // existing function handles refreshMarkerIcons, cards, URL, filters
});
restoreFilterButtons();
renderCardStrips();
/* If we restored a non-default weatherDay, the marker icons built above were
   for day 0 — refresh now that mapDayActive is correct. */
if (mapDayActive !== 0) refreshMarkerIcons();
mountToolbarButtons();
bootAvalancheLayer();
updateResetVisibility();
applyFilters();
store.subscribe(updateResetVisibility);
window.HikeMap.UrlSync.mountCrossPageBanner({
  store: store,
  uiKeys: store.keys,
  container: '#hm-cross-page-banner',
});

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

  var resetBtn = document.createElement('button');
  resetBtn.id = 'resetBtn';
  resetBtn.className = 'filter-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.title = 'Clear filters';
  resetBtn.style.display = 'none';
  resetBtn.onclick = function () {
    window.HikeMap.UrlSync.reset();
  };

  var shareBtn = document.createElement('button');
  shareBtn.className = 'filter-btn';
  shareBtn.textContent = 'Share';
  shareBtn.title = 'Copy this view’s URL';
  shareBtn.onclick = function () {
    window.HikeMap.UrlSync.copyLink(shareBtn, 'Copied');
  };

  wrap.appendChild(webcamBtn);
  wrap.appendChild(resetBtn);
  wrap.appendChild(shareBtn);
  filtersEl.appendChild(wrap);

  /* If URL state had webcams on, materialise it now that the map exists. */
  if (layerState.webcams) setWebcams(true);
}

function updateResetVisibility() {
  var btn = document.getElementById('resetBtn');
  if (!btn) return;
  btn.style.display = (window.location.hash && window.location.hash !== '#') ? '' : 'none';
}
})();
