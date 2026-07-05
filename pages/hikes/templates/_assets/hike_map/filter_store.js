/* Filter store. Holds a mutable state map, notifies subscribers on set. Unknown
   keys land in state() (so cross-page URL replay applies via the matcher) but
   only listed keys fire callbacks. */
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};

  window.HikeMap.FilterStore = function (opts) {
    opts = opts || {};
    var listed = new Set(opts.keys || []);
    var state = Object.assign({}, opts.initial || {});
    var subs = [];

    function get(k) { return state[k]; }

    function set(k, v) {
      if (state[k] === v) return;
      state[k] = v;
      subs.forEach(function (fn) { fn(state, [k]); });
    }

    function setAll(partial) {
      var changed = [];
      Object.keys(partial).forEach(function (k) {
        if (state[k] !== partial[k]) { state[k] = partial[k]; changed.push(k); }
      });
      if (changed.length) subs.forEach(function (fn) { fn(state, changed); });
    }

    function subscribe(fn) { if (typeof fn === 'function') subs.push(fn); }
    function unsubscribe(fn) { subs = subs.filter(function (f) { return f !== fn; }); }

    return {
      get: get, set: set, setAll: setAll,
      state: function () { return state; },
      subscribe: subscribe, unsubscribe: unsubscribe,
      keys: Array.from(listed),
    };
  };
})();
