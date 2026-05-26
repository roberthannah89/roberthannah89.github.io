/* URL state sync — persists filter state to the URL hash so views are
   bookmarkable and shareable. Keys are kept short and tolerant of changes
   so old links degrade gracefully. */
(function () {
  'use strict';

  // Map of state-key → short URL key. Arrays get joined with "," in the URL.
  var KEY_MAP = {
    grades:     'g',
    duration:   'dur',
    elevation:  'el',
    gain:       'gn',
    showHikes:  'h',
    showHuts:   'u',
    weatherDay: 'd',
    sky:        'sk',
    tempMin:    't'
  };
  var REV_MAP = {};
  Object.keys(KEY_MAP).forEach(function (k) { REV_MAP[KEY_MAP[k]] = k; });

  function encode(state) {
    var parts = [];
    Object.keys(KEY_MAP).forEach(function (k) {
      var v = state[k];
      if (v === null || v === undefined || v === '') return;
      if (Array.isArray(v)) {
        if (v.length === 0) return;
        parts.push(KEY_MAP[k] + '=' + v.join(','));
      } else if (typeof v === 'boolean') {
        // Only encode if not the default (true)
        if (v === false) parts.push(KEY_MAP[k] + '=0');
      } else {
        parts.push(KEY_MAP[k] + '=' + encodeURIComponent(v));
      }
    });
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
      if (key === 'grades' || key === 'sky') {
        out[key] = raw.split(',').filter(Boolean);
      } else if (key === 'showHikes' || key === 'showHuts') {
        out[key] = raw !== '0';
      } else if (key === 'weatherDay' || key === 'tempMin') {
        out[key] = parseFloat(raw);
      } else {
        out[key] = raw;
      }
    });
    return out;
  }

  var writing = false;
  function syncToUrl(state) {
    writing = true;
    var hash = encode(state);
    var newUrl = hash ? '#' + hash : window.location.pathname + window.location.search;
    if (window.location.hash.replace(/^#/, '') !== hash) {
      history.replaceState(null, '', hash ? '#' + hash : ' ');
    }
    writing = false;
  }

  function readFromUrl() {
    return decode(window.location.hash);
  }

  window.UrlSync = {
    encode: encode,
    decode: decode,
    syncToUrl: syncToUrl,
    readFromUrl: readFromUrl
  };
})();
