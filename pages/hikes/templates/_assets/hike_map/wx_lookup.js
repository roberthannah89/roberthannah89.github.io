/* Weather-lookup wrapper. Both pages construct one:
     var wx = HikeMap.WxLookup({ fuzzy: false });  // CC — SAC coords match cache exactly
     var wx = HikeMap.WxLookup({ fuzzy: true });   // index — hike summit coords may drift ≤ ~1 km
   Downstream (marker factory, cluster group, side panel) only sees wx.get(...) — never touches
   WeatherService directly. */
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};

  var WX_FUZZY_MAX_DEG2 = 0.000081;  // ≈ 1 km² in deg² at Swiss latitudes

  function fuzzyKey(cache, lat, lon) {
    var bestKey = null, bestD2 = Infinity;
    var cosLat = Math.cos(lat * Math.PI / 180);
    Object.keys(cache).forEach(function (k) {
      var p = k.split(',');
      var la = parseFloat(p[0]), lo = parseFloat(p[1]);
      var dLat = la - lat;
      var dLon = (lo - lon) * cosLat;
      var d2 = dLat * dLat + dLon * dLon;
      if (d2 < bestD2) { bestD2 = d2; bestKey = [la, lo]; }
    });
    return (bestKey && bestD2 < WX_FUZZY_MAX_DEG2) ? bestKey : null;
  }

  window.HikeMap.WxLookup = function (opts) {
    opts = opts || {};
    var fuzzy = !!opts.fuzzy;
    var WS = window.WeatherService;
    // Cache the fuzzy resolution per (lat, lon) so we don't scan on every day change.
    var fuzzyCache = new Map();

    function get(latOrPoi, lonMaybe, dayIndex) {
      if (!WS) return null;
      var lat, lon;
      if (typeof latOrPoi === 'object' && latOrPoi !== null) {
        lat = latOrPoi.lat; lon = latOrPoi.lon; dayIndex = lonMaybe;
      } else {
        lat = latOrPoi; lon = lonMaybe;
      }
      var wx = WS.getForPeak(lat, lon, dayIndex);
      if (wx || !fuzzy) return wx;
      var mapKey = lat + ',' + lon;
      if (!fuzzyCache.has(mapKey)) {
        fuzzyCache.set(mapKey, fuzzyKey(window.WEATHER_CACHE || {}, lat, lon));
      }
      var k = fuzzyCache.get(mapKey);
      return k ? WS.getForPeak(k[0], k[1], dayIndex) : null;
    }

    function freezingLevel(lat, lon, dayIndex) {
      var wx = get(lat, lon, dayIndex);
      return wx ? wx.freezingLevel : null;
    }

    return { get: get, freezingLevel: freezingLevel };
  };
})();
