/* 3d-cc orchestrator.
 *
 * Owns app state (mode, filter state, selection, layer visibility) and
 * coordinates the active renderer. On mode toggle, captures viewport →
 * tears down the old renderer → wipes the map container → initializes
 * the new renderer → replays state.
 *
 * Pattern borrowed from the retired peak-viewer (git show
 * a1259c9^:pages/hikes/docs/prototypes/peak-viewer/peak-viewer.js) but
 * simplified: Leaflet↔MapLibre both use Web Mercator zoom directly, so
 * no distance/pitch fudge is needed.
 */
/* ─────────────────────────────────────────────────────────────
 * Minimal inline Filters shim.
 *
 * Upstream moved the full Filters engine into routes/_assets/hike_map/
 * (FilterStore + FilterMatcher) and its API is very different from the
 * legacy command-center/filters.js this prototype was originally
 * designed against. Rather than fight that (and become brittle to
 * further hike_map/ changes), we inline a small self-contained shim
 * that covers exactly what the toggle prototype needs: grade filtering
 * + subscribe. If we productionize the toggle, we swap this out for
 * the hike_map/ engine.
 * ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.Filters) return; // Don't shadow the real thing if present.
  var state = { grades: [], weatherDay: 0, display: ['weather'] };
  var subs = [];
  function bestGrade(poi) {
    var best = 'T1';
    (poi.routes || []).forEach(function (r) {
      if (r.grade && r.grade > best) best = r.grade;
    });
    return best;
  }
  function gradeNum(g) { return parseInt((g || 'T1').replace('T', ''), 10) || 1; }
  function matchesPoi(poi) {
    if (!state.grades.length) return true;
    var n = gradeNum(bestGrade(poi));
    return state.grades.some(function (g) {
      if (g === 'T1-2') return n <= 2;
      return gradeNum(g) === n;
    });
  }
  function fire() { subs.forEach(function (cb) { try { cb(state); } catch (e) {} }); }
  window.Filters = {
    getState: function () { return state; },
    setState: function (key, val) { state[key] = val; fire(); },
    loadState: function (obj) { Object.keys(obj || {}).forEach(function (k) { if (k in state) state[k] = obj[k]; }); },
    subscribe: function (cb) { if (typeof cb === 'function') subs.push(cb); },
    matchesPoi: matchesPoi, bestGrade: bestGrade, gradeNum: gradeNum
  };
})();

(function () {
  'use strict';

  var CCR = window.CCRenderer;
  var MODE_STORAGE = '3d-cc:mode';

  var mode = null;                     // '2d' | '3d'
  var renderer = null;
  var hikes = [];
  var selection = null;                // hike POI or {__peak:true, peak, lat, lon, name}
  var layerVisibility = { slope: false, trails: true, 'peaks-panel': true };

  var dom = {
    map:         document.getElementById('map'),
    toggle2d:    document.getElementById('mode-2d'),
    toggle3d:    document.getElementById('mode-3d'),
    routeCount:  document.getElementById('route-count'),
    filterBar:   document.getElementById('filter-bar'),
    loading:     document.getElementById('loading-overlay'),
    banner:      document.getElementById('banner'),
    slopeBtn:    document.getElementById('slope-toggle'),
    trailsBtn:   document.getElementById('trails-toggle')
  };

  function showBanner(html, ms) {
    if (!dom.banner) return;
    dom.banner.hidden = false;
    dom.banner.innerHTML = html;
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(function () { dom.banner.hidden = true; }, ms || 3500);
  }

  /* ── Minimal v1 filter bar (grade chips + reset) ─────── */
  var GRADES = ['T1-2', 'T3', 'T4', 'T5', 'T6'];
  function buildFilterBar() {
    if (!dom.filterBar) return;
    dom.filterBar.innerHTML = '';

    var group = document.createElement('div');
    group.className = 'cc3d-filter-group';
    GRADES.forEach(function (g) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc3d-chip';
      btn.textContent = g;
      btn.dataset.grade = g;
      btn.title = 'SAC ' + g;
      btn.addEventListener('click', function () {
        var s = Filters.getState();
        var arr = Array.isArray(s.grades) ? s.grades.slice() : [];
        var i = arr.indexOf(g);
        if (i >= 0) arr.splice(i, 1); else arr.push(g);
        Filters.setState('grades', arr);
        btn.classList.toggle('active', arr.indexOf(g) >= 0);
      });
      group.appendChild(btn);
    });
    dom.filterBar.appendChild(group);

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'cc3d-chip cc3d-chip--reset';
    reset.textContent = 'Reset';
    reset.addEventListener('click', function () {
      Filters.setState('grades', []);
      dom.filterBar.querySelectorAll('.cc3d-chip[data-grade]').forEach(function (b) { b.classList.remove('active'); });
    });
    dom.filterBar.appendChild(reset);

    // Reflect current state
    var s = Filters.getState();
    (s.grades || []).forEach(function (g) {
      var el = dom.filterBar.querySelector('.cc3d-chip[data-grade="' + g + '"]');
      if (el) el.classList.add('active');
    });
  }

  /* ── Mode-toggle UI ───────────────────────────────────── */
  function paintToggle() {
    if (dom.toggle2d) dom.toggle2d.classList.toggle('active', mode === '2d');
    if (dom.toggle3d) dom.toggle3d.classList.toggle('active', mode === '3d');
    document.body.classList.toggle('mode-2d', mode === '2d');
    document.body.classList.toggle('mode-3d', mode === '3d');
    if (dom.slopeBtn) dom.slopeBtn.classList.toggle('cc3d-disabled', mode === '3d');
    if (dom.trailsBtn) dom.trailsBtn.classList.toggle('cc3d-disabled', mode === '2d');
  }

  /* ── Initial mode resolution ─────────────────────────── */
  function readInitialMode() {
    // URL hash first so links can override the stored default.
    var m = new URLSearchParams(location.hash.replace(/^#/, '')).get('m');
    if (m === '2d' || m === '3d') return m;
    try {
      var stored = localStorage.getItem(MODE_STORAGE);
      if (stored === '2d' || stored === '3d') return stored;
    } catch (e) {}
    return '2d';
  }

  function persistMode() {
    try { localStorage.setItem(MODE_STORAGE, mode); } catch (e) {}
    // Reflect into URL hash so a copied link boots into the right mode.
    var params = new URLSearchParams(location.hash.replace(/^#/, ''));
    params.set('m', mode);
    var h = params.toString();
    var newHash = h ? '#' + h : '';
    if (newHash !== location.hash) history.replaceState(null, '', newHash || location.pathname);
  }

  /* ── Filter → renderer ───────────────────────────────── */
  function filteredIdSet() {
    if (!window.Filters || !Filters.matchesPoi) return null;
    var out = new Set();
    for (var i = 0; i < hikes.length; i++) {
      if (Filters.matchesPoi(hikes[i])) out.add(CCR.poiId(hikes[i]));
    }
    return out;
  }
  function pushFilter() {
    if (!renderer) return;
    var ids = filteredIdSet();
    renderer.setFilteredIds(ids);
    if (dom.routeCount) {
      var total = hikes.length;
      var shown = ids ? ids.size : total;
      dom.routeCount.textContent = shown + ' / ' + total + ' hikes';
    }
  }

  /* ── Selection handling ──────────────────────────────── */
  function onRendererSelect(item) {
    if (item && item.__peak) {
      selection = item;
      if (renderer) renderer.setSelection(item);
      showBanner('Peak: ' + (item.peak.name || '') + ' · ' + (item.peak.ele || '') + ' m', 3000);
      return;
    }
    selection = item;
    if (renderer) renderer.setSelection(item);
    if (window.SidePanel && SidePanel.open) SidePanel.open(item);
  }
  function onRendererEmpty() {
    // Empty click doesn't clear filter selection; matches command-center UX.
  }

  /* ── Mode switch ─────────────────────────────────────── */
  var switching = false;
  function switchMode(next, opts) {
    opts = opts || {};
    if (switching) return;
    if (next === mode) return;
    if (next !== '2d' && next !== '3d') return;
    switching = true;

    var previousViewport = renderer ? renderer.getViewport() : null;

    if (dom.loading) dom.loading.hidden = false;
    if (renderer) {
      try { renderer.teardown(); } catch (e) { console.error('teardown', e); }
    }
    renderer = null;
    dom.map.innerHTML = '';
    // Strip Leaflet/MapLibre-added classes so the container looks fresh to
    // the next renderer. Leaflet's remove() doesn't strip its own
    // .leaflet-container class; MapLibre doesn't add one but is defensive.
    dom.map.className = '';

    mode = next;
    paintToggle();
    persistMode();

    var factory = (mode === '3d') ? CCR.createMapLibre : CCR.createLeaflet;
    renderer = factory();
    renderer.onSelectHike(onRendererSelect);
    renderer.onEmptyClick(onRendererEmpty);

    var v = previousViewport || CCR.HOME_VIEWPORT;

    renderer.init(dom.map.id, v, {}).then(function () {
      renderer.setHikes(hikes);
      renderer.setLayerVisible('slope', !!layerVisibility.slope);
      renderer.setLayerVisible('trails', !!layerVisibility.trails);
      renderer.setLayerVisible('peaks-panel', !!layerVisibility['peaks-panel']);
      pushFilter();
      if (selection) {
        if (selection.__peak && mode === '2d') {
          selection = null;
          showBanner('Peak selection cleared — peaks only render in 3D.', 3000);
        } else {
          renderer.setSelection(selection);
        }
      }
      if (dom.loading) dom.loading.hidden = true;
      switching = false;
    }).catch(function (err) {
      console.error('mode init failed', err);
      if (dom.loading) dom.loading.hidden = true;
      showBanner('Map init failed: ' + err.message);
      switching = false;
    });
  }

  /* ── Filters wiring ─────────────────────────────────── */
  function onFiltersChanged() {
    pushFilter();
    if (renderer && renderer.refreshMarkerIcons) renderer.refreshMarkerIcons();
    if (renderer && renderer.refreshMarkerTooltips) renderer.refreshMarkerTooltips();
  }

  /* ── Boot ────────────────────────────────────────────── */
  function boot() {
    if (!window.SAC_ROUTES || !window.SAC_ROUTES.length) {
      showBanner('POI data missing (sac-routes.js).'); return;
    }
    if (typeof L === 'undefined' || typeof maplibregl === 'undefined') {
      showBanner('Map libraries failed to load.'); return;
    }
    // Command-center uses SAC_ROUTES as the primary POI list (peaks, huts,
    // traverses); HIKES is a lookup for which POIs have a built page in
    // this repo — enriched inside each renderer via SidePanel.matchingHike.
    hikes = window.SAC_ROUTES;

    if (window.Filters && Filters.subscribe) Filters.subscribe(onFiltersChanged);

    buildFilterBar();

    // Mode toggle wiring
    if (dom.toggle2d) dom.toggle2d.addEventListener('click', function () { switchMode('2d'); });
    if (dom.toggle3d) dom.toggle3d.addEventListener('click', function () { switchMode('3d'); });
    window.addEventListener('keydown', function (e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
      // Shift+3 → '#' character in most keyboard layouts
      if (e.shiftKey && (e.key === '#' || e.key === '3')) {
        switchMode(mode === '3d' ? '2d' : '3d');
      }
    });

    mode = readInitialMode();
    paintToggle();

    var factory = (mode === '3d') ? CCR.createMapLibre : CCR.createLeaflet;
    renderer = factory();
    renderer.onSelectHike(onRendererSelect);
    renderer.onEmptyClick(onRendererEmpty);

    if (dom.loading) dom.loading.hidden = false;
    renderer.init(dom.map.id, CCR.HOME_VIEWPORT, {}).then(function () {
      renderer.setHikes(hikes);
      renderer.setLayerVisible('slope', !!layerVisibility.slope);
      renderer.setLayerVisible('trails', !!layerVisibility.trails);
      renderer.setLayerVisible('peaks-panel', !!layerVisibility['peaks-panel']);
      pushFilter();
      if (dom.loading) dom.loading.hidden = true;
    }).catch(function (err) {
      console.error('initial init failed', err);
      if (dom.loading) dom.loading.hidden = true;
      showBanner('Map init failed: ' + err.message);
    });

    if (dom.slopeBtn) {
      dom.slopeBtn.addEventListener('click', function () {
        layerVisibility.slope = !layerVisibility.slope;
        dom.slopeBtn.classList.toggle('active', layerVisibility.slope);
        if (renderer && renderer.supports.slope) {
          renderer.setLayerVisible('slope', layerVisibility.slope);
        } else if (layerVisibility.slope) {
          showBanner('Slope layer is 2D-only.', 2500);
        }
      });
    }
    if (dom.trailsBtn) {
      dom.trailsBtn.addEventListener('click', function () {
        layerVisibility.trails = !layerVisibility.trails;
        dom.trailsBtn.classList.toggle('active', layerVisibility.trails);
        if (renderer && renderer.supports.trails) {
          renderer.setLayerVisible('trails', layerVisibility.trails);
        } else if (layerVisibility.trails) {
          showBanner('Trails overlay is 3D-only.', 2500);
        }
      });
    }
  }

  // Expose for tests
  window.CC3D = {
    switchMode: function (m) { switchMode(m); },
    getMode: function () { return mode; },
    getSelection: function () { return selection; },
    getRenderer: function () { return renderer; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
