/* Filter engine — manages route + weather filter state and applies to markers */
(function () {
  'use strict';

  var state = {
    grades: [],        // [] = any, or ['T3','T4'] etc
    duration: null,    // null=any, 'short', 'medium', 'long'
    elevation: null,   // null=any, 'low', 'mid', 'high'  (peak altitude)
    gain: null,        // null=any, 'easy', 'mod', 'hard', 'epic'  (vertical ascent)
    showHikes: true,   // include peaks/summits/traverses
    showHuts: true,    // include SAC huts
    weatherDay: 0,     // day index for weather filters
    sky: null,         // null = any; or one of 'clear'|'partly-cloudy'|'cloudy'|'rain'|'snow'|'storm' (threshold — "this weather or better")
    tempMin: null,     // null=any, or number (°C threshold)
    // Display state — which fields to render on each POI's marker/tooltip.
    // 'weather' controls the marker pill (vs simple dot). All others are
    // tooltip-only metadata lines. Empty array = nothing shown.
    display: ['weather', 'name']
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
    if (window.UrlSync) window.UrlSync.syncToUrl(state);
  }

  // Bulk-apply state from URL on boot. Skips unknown keys.
  function loadState(obj) {
    if (!obj) return;
    Object.keys(obj).forEach(function (k) {
      if (k in state) state[k] = obj[k];
    });
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

  function maxGain(poi) {
    var g = 0;
    (poi.routes || []).forEach(function (r) {
      if (r.gain && r.gain > g) g = r.gain;
    });
    return g;
  }

  function matchesGain(poi) {
    if (!state.gain) return true;
    var g = maxGain(poi);
    if (g === 0) return true; // no gain data = don't filter out
    if (state.gain === 'easy') return g <= 500;
    if (state.gain === 'mod')  return g > 500 && g <= 1000;
    if (state.gain === 'hard') return g > 1000 && g <= 1500;
    if (state.gain === 'epic') return g > 1500;
    return true;
  }

  function matchesWeather(poi) {
    var wx = WeatherService.getForPeak(poi.lat, poi.lon, state.weatherDay);
    if (!wx) return true; // no data = don't filter out

    // Threshold semantics: SKY_CATEGORIES is ordered best→worst, so a POI matches
    // iff its category index is ≤ the selected threshold's index.
    if (state.sky) {
      var cat = WeatherService.skyCategory(wx.code);
      if (cat) {
        var keys = WeatherService.SKY_CATEGORIES.map(function (c) { return c.key; });
        var threshold = keys.indexOf(state.sky);
        var poiIdx = keys.indexOf(cat);
        if (threshold !== -1 && poiIdx !== -1 && poiIdx > threshold) return false;
      }
    }

    if (state.tempMin !== null && wx.tempMax < state.tempMin) return false;

    return true;
  }

  function matchesType(poi) {
    var isHut = poi.type === 'hut';
    if (isHut) return state.showHuts;
    return state.showHikes;
  }

  function matchesPoi(poi) {
    return matchesType(poi) && matchesGrade(poi) && matchesDuration(poi)
        && matchesElevation(poi) && matchesGain(poi) && matchesWeather(poi);
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
    loadState: loadState,
    getState: getState,
    apply: apply,
    bestGrade: bestGrade,
    gradeNum: gradeNum,
    matchesPoi: matchesPoi
  };
})();
