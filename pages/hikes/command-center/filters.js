/* Filter engine shim — thin passthrough to the shared HikeMap.FilterStore +
   HikeMap.FilterMatcher (templates/_assets/hike_map/). command-center.js's
   boot() constructs the store + matcher and assigns them to the transitional
   globals window.__hmStore / window.__hmMatcher before this module's methods
   are used. Every existing call site (command-center.js, side-panel.js) keeps
   calling Filters.* unchanged — Phase G deletes this shim once those call
   sites talk to store/matcher directly. */
(function () {
  'use strict';

  var markers = [];
  var counterEl = null;
  var onFilterChange = null;
  var toMatchableFn = null;

  function bestGrade(poi) {
    var best = 'T1';
    if (!poi.routes) return best;
    poi.routes.forEach(function (r) {
      if (r.grade && r.grade > best) best = r.grade;
    });
    return best;
  }

  // Recompute marker._filtered for every marker via the shared matcher, then
  // refresh the destinations/routes counter and notify the changeCb (cluster
  // refresh). Runs once explicitly at boot (after weather loads) and again on
  // every subsequent store change (wired via init() below).
  function apply() {
    var store = window.__hmStore;
    var matcher = window.__hmMatcher;
    if (!store || !matcher || !toMatchableFn) return;
    var state = store.state();
    var visible = 0;
    var totalRoutes = 0;
    markers.forEach(function (m) {
      var poi = m._poi;
      var show = matcher.match(toMatchableFn(poi), state);
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
  }

  // toMatchable is the CC → matchablePoi adapter (defined in command-center.js,
  // where it has access to SidePanel.matchingHike / poi.hasPage); passed in
  // here rather than looked up as a bare global so filters.js stays a leaf.
  function init(markerList, counterElement, changeCb, toMatchable) {
    markers = markerList;
    counterEl = counterElement;
    onFilterChange = changeCb;
    toMatchableFn = toMatchable;
    if (window.__hmStore) {
      window.__hmStore.subscribe(function (state, changedKeys) {
        // `dp` (the Display filter — which tooltip/marker fields to show) is
        // presentation-only: filter_matcher.js's match() never reads it, so
        // it can never change which markers are visible. Its one call site
        // (command-center.js's display-filter click handler) already calls
        // refreshMarkerIcons()/refreshMarkerTooltips() itself right after
        // Filters.setState('dp', ...), so re-running the full ~960-marker
        // apply() pass here on every display-pill click is pure waste. The
        // pre-refactor Filters.setState had the same guard explicitly
        // (`if (key !== 'display') apply();`) — Finding 2, Phase F review.
        if (changedKeys && changedKeys.length === 1 && changedKeys[0] === 'dp') return;
        apply();
      });
    }
  }

  window.Filters = {
    // Passthroughs to the shared store/matcher. Kept for existing call sites;
    // Phase G migrates them to consume store/matcher directly.
    getState:  function ()       { return window.__hmStore.state(); },
    setState:  function (k, v)   { window.__hmStore.set(k, v); },
    subscribe: function (fn)     { window.__hmStore.subscribe(fn); },
    // Domain-specific helpers that stay regardless of the store migration.
    bestGrade: bestGrade,
    matches:   function (poi)    { return window.__hmMatcher.match(toMatchableFn(poi), window.__hmStore.state()); },
    apply:     apply,
    init:      init,
  };
})();
