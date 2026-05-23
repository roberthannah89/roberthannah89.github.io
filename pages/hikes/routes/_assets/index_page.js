// Index page runtime. Reads hike data from window.HIKES (set inline by the template).
(function () {
"use strict";
const HIKES = window.HIKES || [];

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
function isMultiDay(t) {
  const s = String(t).toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*day/);
  return !!(m && parseFloat(m[1]) > 1);
}
function wmoIcon(code) {
  if (code === 0) return ["☀️", "Clear"];
  if (code === 1) return ["🌤️", "Mostly clear"];
  if (code === 2) return ["⛅", "Partly cloudy"];
  if (code === 3) return ["☁️", "Overcast"];
  if (code === 45 || code === 48) return ["🌫️", "Fog"];
  if (code >= 51 && code <= 57) return ["🌦️", "Drizzle"];
  if (code >= 61 && code <= 67) return ["🌧️", "Rain"];
  if (code >= 71 && code <= 77) return ["🌨️", "Snow"];
  if (code >= 80 && code <= 82) return ["🌧️", "Showers"];
  if (code === 85 || code === 86) return ["🌨️", "Snow showers"];
  if (code >= 95) return ["⛈️", "Thunderstorm"];
  return ["·", ""];
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
  card.dataset.multi = isMultiDay(h.time) ? "1" : "0";
  card.dataset.canton = (h.canton || "").toLowerCase();
  card.dataset.dist = parseNum(h.distance);
  card.dataset.gain = parseNum(h.gain);
  card.dataset.elev = parseNum(h.elev);
  card.dataset.timeH = parseHours(h.time);
  card.dataset.route = (h.route_type || "").toLowerCase();
  card.dataset.transit = (h.transit || "").toLowerCase();
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
      '<div class="weather-strip loading" data-hike="' + i + '"></div>' +
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
var activeFilters = { grade: "all", duration: "all", region: "all", canton: "all", weather: "all", dist: "all", gain: "all", temp: "all", elev: "all", time: "all", route: "all", transit: "all" };
document.querySelectorAll(".filter-group").forEach(function (group) {
  var key = group.dataset.filter;
  group.addEventListener("click", function (e) {
    var btn = e.target.closest(".filter-btn");
    if (!btn) return;
    group.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    activeFilters[key] = btn.dataset.value;
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
function wxCategory(icon) {
  if (icon === "☀️" || icon === "🌤️") return "good";
  if (icon === "⛅" || icon === "☁️" || icon === "🌫️") return "ok";
  return "bad";
}
function updateCardWeather() {
  document.querySelectorAll(".card").forEach(function (card) {
    var idx = parseInt(card.dataset.idx, 10);
    var wd = weatherByHike[idx];
    if (wd && wd[mapDayActive]) {
      card.dataset.wx = wxCategory(wd[mapDayActive].icon);
      card.dataset.temp = wd[mapDayActive].tmax;
    }
  });
}
function applyFilters() {
  var visible = 0;
  document.querySelectorAll(".card").forEach(function (card) {
    var g = parseInt(card.dataset.grade, 10) || 0;
    var region = card.dataset.region;
    var multi = card.dataset.multi === "1";
    var ok = gradeMatch(g, activeFilters.grade);
    if (ok && activeFilters.duration === "day") ok = !multi;
    if (ok && activeFilters.duration === "multi") ok = multi;
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
    if (ok && activeFilters.transit !== "all") ok = card.dataset.transit === activeFilters.transit;
    card.style.display = ok ? "" : "none";
    if (ok) visible++;
    var idx = parseInt(card.dataset.idx, 10);
    var m = markers[idx];
    if (m) {
      if (ok) m.addTo(map);
      else map.removeLayer(m);
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
var weatherByHike = [];
var mapDayActive = 1;

function makeWeatherPin(emoji, temp) {
  var inner = (emoji && emoji !== '·')
    ? '<span class="hm-icon">' + emoji + '</span><span class="hm-temp">' + temp + '°</span>'
    : '<span class="hm-icon" style="opacity:.3">📍</span>';
  return L.divIcon({
    className: '',
    html: '<div class="hm-pin">' + inner + '</div>',
    iconSize: null, iconAnchor: [28, 20], popupAnchor: [0, -26],
  });
}

function setMapDay(dayIdx) {
  mapDayActive = dayIdx;
  document.querySelectorAll('.map-day-btn').forEach(function (btn, i) {
    btn.classList.toggle('active', i === dayIdx);
  });
  HIKES.forEach(function (h, i) {
    var m = markers[i];
    if (!m) return;
    var wd = weatherByHike[i];
    if (!wd || !wd[dayIdx]) return;
    m.setIcon(makeWeatherPin(wd[dayIdx].icon, wd[dayIdx].tmax));
  });
  updateCardWeather();
  applyFilters();
}

function updateMapDayBtns(dates) {
  var bar = document.getElementById('mapDayBtns');
  if (!bar) return;
  bar.innerHTML = '';
  dates.forEach(function (date, i) {
    var btn = document.createElement('button');
    btn.className = 'map-day-btn' + (i === mapDayActive ? ' active' : '');
    var label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmtDow(date);
    btn.textContent = label + ' · ' + new Date(date + 'T00:00').toLocaleDateString(undefined, {month:'short', day:'numeric'});
    btn.onclick = function () { setMapDay(i); };
    bar.appendChild(btn);
  });
}

HIKES.forEach(function (h, i) {
  if (h.lat == null || h.lon == null) { markers.push(null); return; }
  var m = L.marker([h.lat, h.lon], {
    icon: makeWeatherPin('·', ''),
  });
  var popup =
    (h.photo ? '<img src="' + escAttr(h.photo) + '" alt="">' : '') +
    '<div class="pop-name">' + h.name + '</div>' +
    (h.canton ? '<div style="font-size:.78rem;color:#a0a4ad;margin:.1rem 0 .2rem;">' + h.canton + '</div>' : '') +
    (h.grade ? '<div style="margin:.2rem 0;"><span class="pill ' + h.gradeClass + '">' + h.grade + '</span></div>' : '') +
    '<a href="' + h.href + '">View plan →</a>';
  m.bindPopup(popup);
  m.addTo(map);
  markers.push(m);
  latlngs.push([h.lat, h.lon]);
});
if (latlngs.length) {
  map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 11 });
} else {
  map.setView([46.8, 8.2], 8);
}
window.addEventListener('resize', function () { map.invalidateSize(); });

function highlightMarker(i, on) {
  var m = markers[i];
  if (!m) return;
  var el = m.getElement();
  if (el) el.classList.toggle('marker-hl', on);
  if (on) m.bringToFront();
}

/* ------------- weather ------------- */
var WX_CACHE_KEY = "hikes_wx_v1";
var WX_CACHE_TTL = 60 * 60 * 1000;

function wxCacheLoad() {
  try {
    var raw = sessionStorage.getItem(WX_CACHE_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > WX_CACHE_TTL) return null;
    return parsed.data;
  } catch(e) { return null; }
}
function wxCacheSave(data) {
  try { sessionStorage.setItem(WX_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data })); } catch(e) {}
}

function applyWeatherData(allDays) {
  var datesSet = false;
  allDays.forEach(function (days, i) {
    var strip = document.querySelector('.weather-strip[data-hike="' + i + '"]');
    if (!strip) return;
    if (!days) {
      strip.classList.remove("loading");
      strip.innerHTML = '<div class="wx" style="grid-column:1/-1">forecast unavailable</div>';
      return;
    }
    var html = "";
    for (var d = 0; d < 7; d++) {
      var code = days.weather_code[d];
      var tmax = Math.round(days.temperature_2m_max[d]);
      var iconLabel = wmoIcon(code);
      var icon = iconLabel[0], label = iconLabel[1];
      var date = days.time[d];
      html += '<div class="wx" title="' + label + '">' +
        '<div class="dow">' + fmtDow(date) + '</div>' +
        '<div class="icon">' + icon + '</div>' +
        '<div class="tmax">' + tmax + '°</div>' +
      '</div>';
      if (!weatherByHike[i]) weatherByHike[i] = {};
      weatherByHike[i][d] = { icon: icon, label: label, tmax: tmax };
      if (d === mapDayActive && markers[i]) markers[i].setIcon(makeWeatherPin(icon, tmax));
    }
    strip.classList.remove("loading");
    strip.innerHTML = html;
    if (!datesSet) { updateMapDayBtns(days.time); datesSet = true; }
  });
  updateCardWeather();
  applyFilters();
}

function loadWeather() {
  var cached = wxCacheLoad();
  if (cached) { applyWeatherData(cached); return; }

  var indexed = [];
  HIKES.forEach(function (h, i) { if (h.lat != null && h.lon != null) indexed.push({ h: h, i: i }); });
  if (!indexed.length) return;

  var lats = indexed.map(function (x) { return x.h.lat; }).join(",");
  var lons = indexed.map(function (x) { return x.h.lon; }).join(",");
  var elevs = indexed.map(function (x) { return x.h.summitElev || ""; }).join(",");
  var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lats + "&longitude=" + lons
    + "&elevation=" + elevs
    + "&daily=weather_code,temperature_2m_max&timezone=Europe%2FZurich&forecast_days=7";

  HIKES.forEach(function (h, i) {
    if (h.lat == null || h.lon == null) {
      var strip = document.querySelector('.weather-strip[data-hike="' + i + '"]');
      if (strip) { strip.classList.remove("loading"); strip.innerHTML = ""; }
    }
  });

  fetch(url)
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var results = Array.isArray(j) ? j : [j];
      var allDays = HIKES.map(function () { return null; });
      results.forEach(function (res, ri) { allDays[indexed[ri].i] = res.daily; });
      wxCacheSave(allDays);
      applyWeatherData(allDays);
    })
    .catch(function () {
      indexed.forEach(function (x) {
        var strip = document.querySelector('.weather-strip[data-hike="' + x.i + '"]');
        if (strip) { strip.classList.remove("loading"); strip.innerHTML = '<div class="wx" style="grid-column:1/-1">forecast unavailable</div>'; }
      });
    });
}
loadWeather();
})();
