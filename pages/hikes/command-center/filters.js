/* Filter engine — manages route + weather filter state and applies to markers */
(function () {
  'use strict';

  var state = {
    grades: [],        // [] = any, or ['T3','T4'] etc
    duration: null,    // null=any, 'short', 'medium', 'long'
    elevation: null,   // null=any, 'low', 'mid', 'high'
    weatherDay: 0,     // day index for weather filters
    conditions: null,  // null=any, 'dry', 'cloudy'
    tempMin: null,     // null=any, or number (°C threshold)
    wind: null         // null=any, 'calm', 'moderate'
  };

  var markers = [];
  var counterEl = null;
  var onFilterChange = null;

  function init(markerList, counterElement, changeCb) {
    markers = markerList;
    counterEl = counterElement;
    onFilterChange = changeCb;
  }

  function setState(key, value) {
    state[key] = value;
    apply();
  }

  function getState() { return state; }

  function bestGrade(poi) {
    var best = 'T1';
    if (!poi.routes) return best;
    poi.routes.forEach(function (r) {
      if (r.grade && r.grade > best) best = r.grade;
    });
    return best;
  }

  function gradeNum(g) {
    return parseInt((g || 'T1').replace('T', ''), 10) || 1;
  }

  function matchesGrade(poi) {
    if (state.grades.length === 0) return true;
    var bg = bestGrade(poi);
    var n = gradeNum(bg);
    return state.grades.some(function (g) {
      if (g === 'T1-2') return n <= 2;
      return gradeNum(g) === n;
    });
  }

  function matchesDuration(poi) {
    if (!state.duration) return true;
    var maxTime = 0;
    (poi.routes || []).forEach(function (r) {
      if (r.time_up && r.time_up > maxTime) maxTime = r.time_up;
    });
    if (maxTime === 0) return true;
    var hours = maxTime / 60;
    if (state.duration === 'short') return hours <= 3;
    if (state.duration === 'medium') return hours > 3 && hours <= 5;
    if (state.duration === 'long') return hours > 5;
    return true;
  }

  function matchesElevation(poi) {
    if (!state.elevation) return true;
    var alt = poi.alt || 0;
    if (state.elevation === 'low') return alt <= 2000;
    if (state.elevation === 'mid') return alt > 2000 && alt <= 2500;
    if (state.elevation === 'high') return alt > 2500;
    return true;
  }

  function matchesWeather(poi) {
    var wx = WeatherService.getForPeak(poi.lat, poi.lon, state.weatherDay);
    if (!wx) return true; // no data = don't filter out

    if (state.conditions === 'dry' && !WeatherService.isDry(wx.code)) return false;
    if (state.conditions === 'cloudy' && wx.code > 3) return false;

    if (state.tempMin !== null && wx.tempMax < state.tempMin) return false;

    if (state.wind === 'calm' && wx.windMax > 20) return false;
    if (state.wind === 'moderate' && wx.windMax > 40) return false;

    return true;
  }

  function matchesPoi(poi) {
    return matchesGrade(poi) && matchesDuration(poi) && matchesElevation(poi) && matchesWeather(poi);
  }

  function apply() {
    var visible = 0;
    var totalRoutes = 0;
    markers.forEach(function (m) {
      var poi = m._poi;
      var show = matchesPoi(poi);
      if (show) {
        visible++;
        totalRoutes += (poi.routes || []).length;
      }
      m._filtered = !show;
    });

    if (counterEl) {
      counterEl.innerHTML = '<strong>' + visible + '</strong> destinations · <strong>' + totalRoutes + '</strong> routes';
    }

    if (onFilterChange) onFilterChange();
  }

  window.Filters = {
    init: init,
    setState: setState,
    getState: getState,
    apply: apply,
    bestGrade: bestGrade,
    gradeNum: gradeNum,
    matchesPoi: matchesPoi
  };
})();
