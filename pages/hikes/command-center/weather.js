/* Weather service — reads pre-baked forecasts from weather-cache.js */

var cache = {};
var ready = false;
var listeners = [];

function onReady(fn) {
  if (ready) return fn();
  listeners.push(fn);
}

function notifyReady() {
  ready = true;
  listeners.forEach(function (fn) { fn(); });
  listeners = [];
}

// Lazy-load a classic-script data file by injecting a <script> tag. Resolves
// once the script has executed (and its window globals are populated). We
// reuse this for weather-cache.js and webcams_windy_data.js so the ~500 KB /
// ~100 KB blobs don't block initial HTML parsing.
function loadDataScript(src) {
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('Failed to load ' + src)); };
    document.head.appendChild(s);
  });
}

function init(routes, statusCb) {
  // weather-cache.js is no longer a static <script> in index.html — load it
  // here so first paint of the map/markers doesn't wait for the ~500 KB blob.
  // Markers start as plain dots and upgrade to weather pills once this resolves.
  function adopt() {
    if (window.WEATHER_CACHE) {
      cache = window.WEATHER_CACHE;
      var count = Object.keys(cache).length;
      if (statusCb) statusCb('Weather loaded (' + count + ' peaks cached)');
    } else {
      if (statusCb) statusCb('No weather cache — run: make weather');
    }
    notifyReady();
  }

  if (window.WEATHER_CACHE) { adopt(); return Promise.resolve(); }

  if (statusCb) statusCb('Loading weather cache...');
  return loadDataScript('weather-cache.js').then(adopt, function (err) {
    console.warn(err);
    adopt();
  });
}

function getForPeak(lat, lon, dayIndex) {
  if (!lat || !lon) return null;
  var key = lat.toFixed(3) + ',' + lon.toFixed(3);
  var entry = cache[key];
  if (!entry || !entry.daily) return null;

  var d = entry.daily;
  var idx = dayIndex || 0;
  if (idx >= d.time.length) idx = d.time.length - 1;

  return {
    date: d.time[idx],
    tempMax: d.temperature_2m_max[idx],
    tempMin: d.temperature_2m_min[idx],
    precip: d.precipitation_sum[idx],
    windMax: d.windspeed_10m_max[idx],
    code: d.weathercode[idx],
    sunrise: d.sunrise ? d.sunrise[idx] : null,
    sunset: d.sunset ? d.sunset[idx] : null,
    elevation: entry.elevation
  };
}

function weatherIcon(code) {
  if (code === null || code === undefined) return '—';
  if (code <= 1) return '☀️';
  if (code <= 2) return '⛅';      // only code 2 = partly cloudy
  if (code <= 48) return '☁️';     // 3=overcast, 45/48=fog → cloudy
  if (code <= 57) return '🌧️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌧️';
  if (code <= 86) return '❄️';
  if (code >= 95) return '⛈️';
  return '🌤️';
}

function weatherLabel(code) {
  if (code === null || code === undefined) return 'Unknown';
  if (code <= 1) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 48) return 'Overcast';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Rain showers';
  if (code <= 86) return 'Snow showers';
  if (code >= 95) return 'Thunderstorm';
  return 'Mixed';
}

function isDry(code) {
  return code !== null && code !== undefined && code <= 48;
}

// Group WMO weather codes into 5 buckets for the sky-condition filter.
function skyCategory(code) {
  if (code === null || code === undefined) return null;
  if (code <= 1) return 'clear';           // 0=clear, 1=mainly clear
  if (code <= 2) return 'partly-cloudy';   // 2=partly cloudy
  if (code <= 48) return 'cloudy';         // 3=overcast, 45/48=fog
  if (code >= 95) return 'storm';          // 95-99=thunderstorm
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 85 && code <= 86) return 'snow';
  return 'rain';                            // 51-67 drizzle/rain, 80-82 showers
}

// Ordering matters: threshold filter ("X or better") treats lower indices
// as better weather, so this list must stay best→worst. Snow and Storm are
// hidden from the filter UI (`hidden: true`) because nobody filters "snow
// or better" — but they remain in the ordering so the rain threshold
// correctly excludes snowy/stormy peaks, and the marker icons can still
// display ❄️ / ⛈️ for snow/storm weather codes.
var SKY_CATEGORIES = [
  { key: 'clear',         icon: '☀️', label: 'Clear' },
  { key: 'partly-cloudy', icon: '⛅', label: 'Partly cloudy' },
  { key: 'cloudy',        icon: '☁️', label: 'Cloudy / fog' },
  { key: 'rain',          icon: '🌧️', label: 'Rain' },
  { key: 'snow',          icon: '❄️', label: 'Snow',  hidden: true },
  { key: 'storm',         icon: '⛈️', label: 'Storm', hidden: true }
];

function formatDayLabel(dateStr) {
  var d = new Date(dateStr + 'T12:00:00');
  var today = new Date();
  today.setHours(12, 0, 0, 0);
  var diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });
}

function getDayChoices() {
  var first = null;
  for (var key in cache) {
    first = cache[key];
    break;
  }
  if (!first || !first.daily) return [];
  // Cache is fetched with timezone=Europe/Zurich, so index 0 is always Switzerland-today,
  // index 1 is tomorrow, etc. Use index-based labels for 0/1 so user-browser timezone
  // (e.g. EDT) doesn't misalign "Today"/"Tomorrow" by a day.
  return first.daily.time.map(function (t, i) {
    var label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : formatDayLabel(t);
    return { index: i, date: t, label: label };
  });
}

// Returns "2h ago" / "3d ago" / "just now" for an ISO timestamp string.
function relativeTime(iso) {
  if (!iso) return '';
  var t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  var diff = Math.max(0, Date.now() - t);
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  return days + 'd ago';
}

function getMeta() {
  return window.WEATHER_CACHE_META || null;
}

export const WeatherService = {
  init: init,
  onReady: onReady,
  getForPeak: getForPeak,
  weatherIcon: weatherIcon,
  weatherLabel: weatherLabel,
  isDry: isDry,
  skyCategory: skyCategory,
  SKY_CATEGORIES: SKY_CATEGORIES,
  getDayChoices: getDayChoices,
  formatDayLabel: formatDayLabel,
  getMeta: getMeta,
  relativeTime: relativeTime
};
