// GENERATED FROM ../../templates/_assets/hike_map/filter_matcher.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

/* Filter matcher. One function that answers "does this matchablePoi pass the
   current filter state?" for every canonical filter key. Pages set only the
   keys their UI exposes; the matcher applies whatever it finds.

   matchablePoi shape (both pages produce this via a page-owned adapter):
     { name, lat, lon, grade, region, canton, routeType, alt, gain, timeH,
       distance, hasPage: bool, poiKind: 'hike'|'hut', raw }
*/
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};

  function inSet(v, sel) {
    if (!sel || (Array.isArray(sel) && sel.length === 0)) return true;
    // v === null means the concept doesn't exist for this POI's page (e.g.
    // CC's matchablePoi sets region/canton/routeType to null since SAC data
    // carries none of them) — never filter those out just because a
    // cross-page URL happens to set that key. An empty string ('' — a POI
    // that DOES have the concept but with no value, e.g. an index hike with
    // no region) still fails the check, same as before.
    if (v === null) return true;
    if (!Array.isArray(sel)) sel = [sel];
    return sel.indexOf(v) !== -1;
  }

  // Bucket membership. `sel` is normally a single bucket key (e.g. 'short'),
  // but CC's gain filter is multi-select (several buckets active at once), so
  // this also accepts an array and passes if ANY selected bucket contains v.
  // An unrecognized bucket key is treated as "don't filter" (matches the
  // pre-unification per-page matchers' behavior for unknown/legacy values).
  function inBucket(v, sel, buckets) {
    if (!sel || (Array.isArray(sel) && sel.length === 0)) return true;
    var sels = Array.isArray(sel) ? sel : [sel];
    return sels.some(function (key) {
      var b = buckets[key];
      return b ? (v >= b[0] && v < b[1]) : true;
    });
  }

  // Buckets used by the matcher. Keep in sync with the labels in FilterBar
  // (and index's external buttons where they overlap).
  var BUCKETS = {
    tm:  { 'short': [0, 3], 'mid': [3, 5], 'long': [5, 99] },
    el:  { 'low': [0, 2000], 'mid': [2000, 2500], 'high': [2500, 9999] },
    gn:  { 'easy': [0, 500], 'mod': [500, 1000], 'hard': [1000, 1500], 'epic': [1500, 9999] },
    di:  { 'short': [0, 8], 'mid': [8, 15], 'long': [15, 999] },
  };

  var SKY_ORDER = ['clear', 'partly-cloudy', 'cloudy', 'rain', 'snow', 'storm'];

  window.HikeMap.FilterMatcher = {
    factory: function (cfg) {
      cfg = cfg || {};
      var wxLookup = cfg.wxLookup;
      var WS       = window.WeatherService;

      function match(poi, s) {
        s = s || {};

        // POI kind — showHikes / showHuts
        if (poi.poiKind === 'hike' && s.h === false) return false;
        if (poi.poiKind === 'hut'  && s.u === false) return false;

        // hasPage — canonical short key `hp` (was `hasPage`).
        if (s.hp === true && !poi.hasPage) return false;

        // Grade (multi-select)
        if (s.g && s.g.length && !inSet(poi.grade, s.g)) return false;

        // Region / canton / route_type (multi-select)
        if (s.r  && s.r.length  && !inSet(poi.region,    s.r))  return false;
        if (s.c  && s.c.length  && !inSet(poi.canton,    s.c))  return false;
        if (s.rt && s.rt.length && !inSet(poi.routeType, s.rt)) return false;

        // Buckets
        if (!inBucket(poi.timeH, s.tm, BUCKETS.tm)) return false;
        if (!inBucket(poi.alt,   s.el, BUCKETS.el)) return false;
        if (!inBucket(poi.gain,  s.gn, BUCKETS.gn)) return false;
        if (poi.distance != null && !inBucket(poi.distance, s.di, BUCKETS.di)) return false;

        // Weather-based: sky (threshold), temp min, season
        if (s.sk || s.t != null || s.sn === true) {
          if (!wxLookup) return true;
          var day = s.d || 0;
          var wx  = wxLookup.get(poi.lat, poi.lon, day);
          if (!wx) return true;   // no forecast → never filter out
          if (s.sk) {
            var thr = SKY_ORDER.indexOf(s.sk);
            var cat = WS.skyCategory(wx.code);
            var idx = SKY_ORDER.indexOf(cat);
            if (idx < 0 || idx > thr) return false;   // worse than threshold
          }
          if (s.t != null && wx.tempMax != null && wx.tempMax < s.t) return false;
          // Season heuristic (season.js) reads poi.routes/poi.alt off the
          // page-native object, not the flattened matchablePoi — use .raw.
          if (s.sn === true && window.Season && !window.Season.isInSeason(poi.raw)) return false;
        }

        return true;
      }

      return { match: match };
    },
  };
})();
