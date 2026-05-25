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
    if (code <= 3) return '⛅';
    if (code <= 48) return '☁️';
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
    return first.daily.time.map(function (t, i) {
      return { index: i, date: t, label: formatDayLabel(t) };
    });
  }

  window.WeatherService = {
    init: init,
    onReady: onReady,
    getForPeak: getForPeak,
    weatherIcon: weatherIcon,
    weatherLabel: weatherLabel,
    isDry: isDry,
    getDayChoices: getDayChoices,
    formatDayLabel: formatDayLabel
  };
})();
