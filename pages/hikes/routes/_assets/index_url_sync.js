/* URL state sync for the Hikes index page — persists filter state to the URL
 * hash so views are bookmarkable and shareable. Mirrors command-center/url-sync
 * but with the Hikes-page filter keys.
 *
 * Sets window.IndexUrlSync = {
 *   readFromUrl(): { grade, region, canton, ... },   // partial — only keys present in hash
 *   writeToUrl(activeFilters, mapDayActive),
 *   hasHash(),                                       // true if location.hash non-empty
 * }
 */
(function () {
  'use strict';

  /* state key → short URL key. Same compactness rationale as CC's url-sync:
     short keys keep URLs share-friendly and tolerant of future state additions. */
  var KEY_MAP = {
    grade:      'g',
    region:     'r',
    canton:     'c',
    weather:    'wx',
    dist:       'di',
    gain:       'gn',
    temp:       't',
    elev:       'el',
    time:       'tm',
    route:      'rt',
    weatherDay: 'd',
    /* Layer toggles — encoded as 1 when on; absent when off. */
    webcams:    'wc',
    avalanche:  'av',
  };
  var REV_MAP = {};
  Object.keys(KEY_MAP).forEach(function (k) { REV_MAP[KEY_MAP[k]] = k; });

  function encode(activeFilters, mapDayActive, layers) {
    var parts = [];
    Object.keys(KEY_MAP).forEach(function (k) {
      if (k === 'weatherDay' || k === 'webcams' || k === 'avalanche') return;
      var v = activeFilters[k];
      if (v && v !== 'all') parts.push(KEY_MAP[k] + '=' + encodeURIComponent(v));
    });
    if (typeof mapDayActive === 'number' && mapDayActive !== 0) {
      parts.push(KEY_MAP.weatherDay + '=' + mapDayActive);
    }
    if (layers && layers.webcams)  parts.push(KEY_MAP.webcams   + '=1');
    if (layers && layers.avalanche) parts.push(KEY_MAP.avalanche + '=1');
    return parts.join('&');
  }

  function decode(hash) {
    var out = {};
    if (!hash || hash.length < 2) return out;
    hash.replace(/^#/, '').split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq < 0) return;
      var short = pair.slice(0, eq);
      var raw = decodeURIComponent(pair.slice(eq + 1));
      var key = REV_MAP[short];
      if (!key) return;
      if (key === 'weatherDay') {
        var n = parseInt(raw, 10);
        if (!isNaN(n)) out.weatherDay = n;
      } else if (key === 'webcams' || key === 'avalanche') {
        out[key] = raw === '1' || raw === 'true';
      } else {
        out[key] = raw;
      }
    });
    return out;
  }

  function writeToUrl(activeFilters, mapDayActive, layers) {
    var hash = encode(activeFilters, mapDayActive, layers);
    var current = window.location.hash.replace(/^#/, '');
    if (current === hash) return;
    /* replaceState (not pushState) so back-button doesn't traverse every filter
       click. ' ' is the documented hack to clear the hash without re-navigating. */
    history.replaceState(null, '', hash ? '#' + hash : ' ');
  }

  function readFromUrl() {
    return decode(window.location.hash);
  }

  function hasHash() {
    return window.location.hash.replace(/^#/, '').length > 0;
  }

  window.IndexUrlSync = {
    readFromUrl: readFromUrl,
    writeToUrl: writeToUrl,
    hasHash: hasHash,
    encode: encode,
    decode: decode,
  };
})();
