/* Canonical URL hash sync. One short-key map shared by both pages so a hash
   minted on one applies on the other via the matcher. Cross-page filters
   banner surfaces filters that have no UI on the current page. */
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};

  var KEYS = {
    // Short → long. Also the canonical short-key set the store uses on set.
    g:  { type: 'csv'   },
    r:  { type: 'csv'   },
    c:  { type: 'csv'   },
    rt: { type: 'csv'   },
    di: { type: 'str'   },
    tm: { type: 'str'   },
    el: { type: 'str'   },
    gn: { type: 'str'   },
    d:  { type: 'int'   },
    sk: { type: 'str'   },
    t:  { type: 'num'   },
    sn: { type: 'bool'  },
    h:  { type: 'bool', defaultTrue: true },
    u:  { type: 'bool', defaultTrue: true },
    wc: { type: 'bool'  },
    // dp — CC-only tooltip content toggles (weather/name/T/↑m/h/alt). Included
    // in the canonical map so a CC hash round-trips; index doesn't render the
    // toggles and the matcher doesn't read this key, so `dp` in an index URL
    // is a no-op.
    dp: { type: 'csv'   },
    // hp — CC-only "only routes with a built page" toggle. Short-keyed for
    // URL compactness and consistency with the other boolean toggles.
    hp: { type: 'bool'  },
  };

  function encodeVal(k, v) {
    var def = KEYS[k]; if (!def) return null;
    if (v == null || v === '') return null;
    if (def.type === 'csv')  return Array.isArray(v) ? (v.length ? v.join(',') : null) : String(v);
    if (def.type === 'bool') {
      if (def.defaultTrue) return v === false ? '0' : null;
      return v === true ? '1' : null;
    }
    if (def.type === 'int' || def.type === 'num') return String(v);
    return encodeURIComponent(String(v));
  }

  function decodeVal(k, raw) {
    var def = KEYS[k]; if (!def) return raw;
    if (def.type === 'csv')  return raw.split(',').filter(Boolean);
    if (def.type === 'bool') return raw === '1' || raw === 'true';
    if (def.type === 'int')  return parseInt(raw, 10);
    if (def.type === 'num')  return parseFloat(raw);
    return decodeURIComponent(raw);
  }

  function readFromUrl() {
    var out = {};
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return out;
    h.split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq < 0) return;
      var k = pair.slice(0, eq), raw = pair.slice(eq + 1);
      if (KEYS[k]) out[k] = decodeVal(k, raw);
    });
    return out;
  }

  function writeToUrl(state) {
    var parts = [];
    Object.keys(KEYS).forEach(function (k) {
      var v = encodeVal(k, state[k]);
      if (v !== null) parts.push(k + '=' + v);
    });
    var hash = parts.join('&');
    var current = window.location.hash.replace(/^#/, '');
    if (current === hash) return;
    history.replaceState(null, '', hash ? '#' + hash : ' ');
  }

  function bind(cfg) {
    var store = cfg.store;
    store.subscribe(function (state) { writeToUrl(state); });
  }

  function reset() {
    history.replaceState(null, '', ' ');
    window.location.reload();
  }

  function copyLink(el, label) {
    label = label || 'Copied';
    if (navigator.clipboard) navigator.clipboard.writeText(window.location.href);
    if (el) {
      var prev = el.textContent;
      el.textContent = label;
      setTimeout(function () { el.textContent = prev; }, 1200);
    }
  }

  /* Cross-page banner. Called after mount when the store has keys the current
     page's UI doesn't render. Renders a dismissible strip with a Clear button. */
  function mountCrossPageBanner(cfg) {
    var store   = cfg.store;
    var uiKeys  = new Set(cfg.uiKeys || []);
    var container = typeof cfg.container === 'string' ? document.querySelector(cfg.container) : cfg.container;
    if (!container) return;

    function invisibleKeys() {
      return Object.keys(store.state()).filter(function (k) {
        var v = store.state()[k];
        var empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
        return !empty && !uiKeys.has(k) && KEYS[k];
      });
    }

    function render() {
      var invis = invisibleKeys();
      if (!invis.length) { container.innerHTML = ''; container.style.display = 'none'; return; }
      container.style.display = '';
      container.innerHTML = 'This URL sets filters that don\'t appear on this page: '
        + '<code>' + invis.join(', ') + '</code> '
        + '<button type="button" class="hm-banner-clear">Clear</button>';
      container.querySelector('.hm-banner-clear').onclick = function () {
        var patch = {};
        invis.forEach(function (k) { patch[k] = null; });
        store.setAll(patch);
      };
    }

    store.subscribe(render);
    render();
  }

  window.HikeMap.UrlSync = {
    KEYS: KEYS,
    readFromUrl: readFromUrl,
    writeToUrl: writeToUrl,
    bind: bind,
    reset: reset,
    copyLink: copyLink,
    mountCrossPageBanner: mountCrossPageBanner,
  };
})();
