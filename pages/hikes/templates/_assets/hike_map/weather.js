/* Weather service — reads pre-baked forecasts from weather-cache.js */
(function () {
  'use strict';

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

  function init(routes, statusCb) {
    if (window.WEATHER_CACHE) {
      cache = window.WEATHER_CACHE;
      var count = Object.keys(cache).length;
      if (statusCb) statusCb('Weather loaded (' + count + ' peaks cached)');
      notifyReady();
      return Promise.resolve();
    }

    if (statusCb) statusCb('No weather cache — run: make weather');
    notifyReady();
    return Promise.resolve();
  }

  function getForPeak(lat, lon, dayIndex) {
    if (!lat || !lon) return null;
    var key = lat.toFixed(3) + ',' + lon.toFixed(3);
    var entry = cache[key];
    if (!entry || !entry.daily) return null;

    var d = entry.daily;
    var idx = dayIndex || 0;
    if (idx >= d.time.length) idx = d.time.length - 1;

    // freezing_level_max is the schema=2 addition (see fetch_weather.py); old
    // caches won't have it, so guard the access. Per-day None values are
    // possible too (rolled up from sparse hourly samples).
    var fl = (d.freezing_level_max && d.freezing_level_max[idx] != null)
      ? d.freezing_level_max[idx] : null;

    return {
      date: d.time[idx],
      tempMax: d.temperature_2m_max[idx],
      tempMin: d.temperature_2m_min[idx],
      precip: d.precipitation_sum[idx],
      windMax: d.windspeed_10m_max[idx],
      code: d.weathercode[idx],
      sunrise: d.sunrise ? d.sunrise[idx] : null,
      sunset: d.sunset ? d.sunset[idx] : null,
      freezingLevel: fl,
      elevation: entry.elevation
    };
  }

  // Standalone accessor for "snow line" (max forecast freezing-level height in
  // metres) on a given day. Returns null if the cache predates schema=2 or the
  // peak's hourly samples were all missing.
  function freezingLevel(lat, lon, dayIndex) {
    var wx = getForPeak(lat, lon, dayIndex);
    return wx ? wx.freezingLevel : null;
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

  // Compact form "Thu 4" — weekday-abbrev + day-of-month. Always renders the
  // actual date so a stale cache can't disguise itself as "Today"; the
  // day-picker relies on this so users can spot when the pre-baked forecast
  // hasn't refreshed.
  function formatDayLabel(dateStr) {
    var d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en', { weekday: 'short' }) + ' ' + d.getDate();
  }

  // Days between today and the given cache date string (YYYY-MM-DD). Positive
  // when the cache date is in the past (stale), 0 when it's today, negative
  // when it's in the future.
  function _dayDelta(dateStr) {
    var d = new Date(dateStr + 'T12:00:00');
    var today = new Date();
    today.setHours(12, 0, 0, 0);
    return Math.round((today - d) / 86400000);
  }

  function getDayChoices() {
    var first = null;
    for (var key in cache) {
      first = cache[key];
      break;
    }
    if (!first || !first.daily) return [];
    // Label is ALWAYS the compact date form (e.g. "Sun 5"). The .isToday /
    // .isTomorrow booleans are computed against the browser's real calendar
    // so callers can render badges or highlights if desired, but the pill
    // label itself never hides the underlying date — that's the whole point
    // of this bug fix, since a stale cache used to be labelled "Today".
    return first.daily.time.map(function (t, i) {
      var delta = _dayDelta(t);
      return {
        index: i,
        date: t,
        label: formatDayLabel(t),
        isToday: delta === 0,
        isTomorrow: delta === -1
      };
    });
  }

  // How many days stale the cache's first (day-0) entry is versus today's
  // real calendar date. 0 means fresh (cache day-0 == today), 1 means the
  // cache's "today" is actually yesterday, etc. Negative if the cache's
  // day-0 is in the future (shouldn't normally happen). Returns null if the
  // cache is empty.
  function cacheAgeDays() {
    var first = null;
    for (var key in cache) {
      first = cache[key];
      break;
    }
    if (!first || !first.daily || !first.daily.time || !first.daily.time.length) return null;
    return _dayDelta(first.daily.time[0]);
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

  window.WeatherService = {
    init: init,
    onReady: onReady,
    getForPeak: getForPeak,
    freezingLevel: freezingLevel,
    weatherIcon: weatherIcon,
    weatherLabel: weatherLabel,
    isDry: isDry,
    skyCategory: skyCategory,
    SKY_CATEGORIES: SKY_CATEGORIES,
    getDayChoices: getDayChoices,
    formatDayLabel: formatDayLabel,
    cacheAgeDays: cacheAgeDays,
    getMeta: getMeta,
    relativeTime: relativeTime
  };
})();
