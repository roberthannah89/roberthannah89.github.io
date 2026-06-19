/* Filter engine — manages route + weather filter state and applies to markers */
(function () {
  'use strict';

  var state = {
    grades: [],        // [] = any, or ['T3','T4'] etc
    duration: null,    // null=any, 'short', 'medium', 'long'
    elevation: null,   // null=any, 'low', 'mid', 'high'  (peak altitude)
    gain: [],          // [] = any, or any subset of ['easy','mod','hard','epic']  (vertical ascent)
    hasPage: null,     // null=any (default), true=only POIs with a built hike page in this repo
    showHikes: true,   // include peaks/summits/traverses
    showHuts: true,    // include SAC huts
    weatherDay: 0,     // day index for weather filters
    sky: null,         // null = any; or one of 'clear'|'partly-cloudy'|'cloudy'|'rain'|'snow'|'storm' (threshold — "this weather or better")
    tempMin: null,     // null=any, or number (°C threshold)
    inSeasonNow: null, // null=any, true=only show POIs whose heuristic season includes the current month (see season.js)
    // Display state — which fields to render on each POI's marker/tooltip.
    // 'weather' controls the marker pill (vs simple dot). All others are
    // tooltip-only metadata lines. Empty array = nothing shown. Name labels
    // are off by default to keep the map uncluttered; user can opt in.
    display: ['weather']
  };

  var markers = [];
  var counterEl = null;
  var onFilterChange = null;
  var subscribers = [];

  function subscribe(cb) {
    if (typeof cb === 'function') subscribers.push(cb);
  }

  function init(markerList, counterElement, changeCb) {
    markers = markerList;
    counterEl = counterElement;
    onFilterChange = changeCb;
  }

  function setState(key, value) {
    state[key] = value;
    // `display` is presentation-only (marker style + tooltip lines) — it
    // doesn't change which POIs match, so skip the filter pass.
    if (key !== 'display') apply();
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

  // Each bucket's predicate. Centralised so the matcher loop stays trivial
  // and adding/removing a bucket only changes one place.
  var GAIN_BUCKETS = {
    easy: function (g) { return g <= 500; },
    mod:  function (g) { return g > 500 && g <= 1000; },
    hard: function (g) { return g > 1000 && g <= 1500; },
    epic: function (g) { return g > 1500; }
  };

  function matchesGain(poi) {
    // gain is multi-select: empty selection = any, otherwise the POI passes
    // if ANY of the selected buckets contains its gain. Legacy single-string
    // state.gain is tolerated transparently for URL-sync back-compat.
    var sel = state.gain;
    if (!sel || (sel.length === 0)) return true;
    var g = maxGain(poi);
    if (g === 0) return true; // no gain data = don't filter out
    if (typeof sel === 'string') sel = [sel];
    for (var i = 0; i < sel.length; i++) {
      var fn = GAIN_BUCKETS[sel[i]];
      if (fn && fn(g)) return true;
    }
    return false;
  }

  function matchesHasPage(poi) {
    if (!state.hasPage) return true;
    return !!poi._hasPage;
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

  function matchesSeason(poi) {
    // null = any (default). true = only show POIs in season for the current month.
    // Season window is computed heuristically from peak altitude + best grade
    // (see season.js). POIs with no altitude data are treated as in-season so
    // the filter never silently drops them — the signal isn't strong enough.
    if (!state.inSeasonNow) return true;
    if (!window.Season) return true;
    return window.Season.isInSeason(poi);
  }

  function matchesPoi(poi) {
    return matchesType(poi) && matchesGrade(poi) && matchesDuration(poi)
        && matchesElevation(poi) && matchesGain(poi) && matchesHasPage(poi)
        && matchesSeason(poi) && matchesWeather(poi);
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
      counterEl.innerHTML =
        '<span title="Destinations"><span class="bb-icon">📍</span><strong>' + visible + '</strong></span>'
        + ' · '
        + '<span title="Routes"><span class="bb-icon">🥾</span><strong>' + totalRoutes + '</strong></span>';
    }

    if (onFilterChange) onFilterChange();
    subscribers.forEach(function (cb) {
      try { cb(state); } catch (e) { console.error('Filters subscriber failed:', e); }
    });
  }

  window.Filters = {
    init: init,
    setState: setState,
    loadState: loadState,
    getState: getState,
    apply: apply,
    subscribe: subscribe,
    bestGrade: bestGrade,
    gradeNum: gradeNum,
    matchesPoi: matchesPoi
  };
})();
