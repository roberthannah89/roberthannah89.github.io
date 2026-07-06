/* 3d-peaks — orchestrator.
 *
 * Mirrors command-center.js's boot flow (FilterStore → matcher → panel →
 * DayPicker → FilterBar → weather load → apply) with one addition: a
 * mode-agnostic renderer seam. The active renderer (Leaflet 2D or MapLibre
 * 3D) owns the #map container's contents; everything else — filter store,
 * side panel, weather picker — is identical to CC.
 *
 * Productionization path: rename this to `command-center.js` and drop the
 * old one. The 2D behavior is byte-identical to CC today; the 3D mode is
 * additive.
 */
(function () {
  'use strict';

  var MODE_STORAGE = '3d-peaks:mode';
  var HOME_2D = { lng: 8.2, lat: 46.8, zoom: 9, pitch: 0, bearing: 0 };
  var HOME_3D = { lng: 8.2, lat: 46.8, zoom: 9, pitch: 62, bearing: 20 };

  var store, matcher, panel;
  var wxLookup, markerWxLookup, markerFactory;
  var renderer = null;
  var mode = null;
  var switching = false;

  var routes = [];                // window.SAC_ROUTES (peaks + huts + traverses)
  var chPeaks = [];               // window.CH_PEAKS pre-wrapped as SAC POIs
  var slfLayerInstance = null;    // 2D only; created lazily by SlfLayer
  var webcamLayerInstance = null; // 2D only; created on 'wc' toggle

  window.CC3DPeaks = window.CC3DPeaks || {};
  window.CC3DPeaks._selected = null;

  /* ── Shared adapters (identical to CC's) ───────────────── */
  function bestGrade(poi) {
    var best = 'T1';
    if (!poi.routes) return best;
    poi.routes.forEach(function (r) { if (r.grade && r.grade > best) best = r.grade; });
    return best;
  }
  // MINIMUM grade — easiest known route to summit. Peak coloring uses this
  // so hikers can spot "cheapest way in" at a glance. Peaks with no matched
  // SAC route return null and get the "unclassified" grey.
  function computeMinGrade(poi) {
    if (!poi.routes || !poi.routes.length) return null;
    var min = null;
    poi.routes.forEach(function (r) {
      if (!r.grade) return;
      var n = parseInt(r.grade.replace(/[^0-9]/g, ''), 10);
      if (isNaN(n)) return;
      if (min === null || n < min) min = n;
    });
    return min;
  }
  function matchingHike(poi) {
    if (!window.HIKES || !poi) return null;
    var poiRouteIds = (poi.routes || []).map(function (r) { return r.id; });
    function normName(s) {
      return (s || '').toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    }
    var poiNameN = normName(poi.name);
    for (var i = 0; i < window.HIKES.length; i++) {
      var h = window.HIKES[i]; if (!h) continue;
      if (h.sac_route_id && poiRouteIds.indexOf(h.sac_route_id) >= 0) return h;
      if (h.sac_peak_id && h.sac_peak_id === poi.id) return h;
    }
    for (var j = 0; j < window.HIKES.length; j++) {
      var hk = window.HIKES[j]; if (!hk) continue;
      if (poi.lat != null && hk.lat != null
          && Math.abs(hk.lat - poi.lat) < 0.002
          && Math.abs(hk.lon - poi.lon) < 0.002) return hk;
      if (poiNameN && normName(hk.name) === poiNameN) return hk;
    }
    return null;
  }
  function stripGradeMod(g) { return g ? g.replace(/[+-]/g, '') : g; }
  // CH_PEAKS have a different shape than SAC_ROUTES — no `routes[]`, `ele`
  // instead of `alt`, and an optional `sac` singleton. Wrap so the shared
  // SidePanel can render it identically to a SAC POI. Wrap once at boot and
  // pass the wrapped array to the 3D renderer; the wrapped id starts with
  // "chpeak-" so click handlers can dispatch cleanly.
  function chPeakToSacPoi(peak) {
    var routes = [];
    if (peak.sac) {
      routes.push({
        id: peak.sac.route_id,
        title: peak.sac.route_title,
        grade: peak.sac.grade,
        gain: peak.sac.gain,
        time_up: peak.sac.time_up,
        time_down: null
      });
    }
    return {
      id: 'chpeak-' + peak.id,
      name: peak.name,
      alt: peak.ele,
      lat: peak.lat, lon: peak.lon,
      type: 'summit',
      routes: routes,
      grade: peak.sac ? peak.sac.grade : null,
      hasPage: false,
      _isChPeak: true,
      _minGrade: peak._minGrade,
      _prominence: peak.prominence,
      _wikipedia: peak.wikipedia,
      _nearest_hut: peak.nearest_hut,
      _canton: peak.canton
    };
  }

  function toMatchable(poi) {
    var bestRoute = poi.routes && poi.routes[0];
    return {
      name: poi.name, lat: poi.lat, lon: poi.lon,
      grade: bestRoute ? stripGradeMod(bestRoute.grade) : null,
      alt: poi.alt,
      gain: bestRoute ? bestRoute.gain : null,
      timeH: bestRoute && bestRoute.time_up ? bestRoute.time_up / 60 : null,
      region: null, canton: null, routeType: null,
      hasPage: !!poi.hasPage,
      poiKind: poi.type === 'hut' ? 'hut' : 'hike',
      raw: poi
    };
  }

  /* ── Mode toggle ─────────────────────────────────── */
  function paintModeToggle() {
    var b2 = document.getElementById('mode-2d');
    var b3 = document.getElementById('mode-3d');
    if (b2) b2.classList.toggle('active', mode === '2d');
    if (b3) b3.classList.toggle('active', mode === '3d');
    document.body.classList.toggle('mode-2d', mode === '2d');
    document.body.classList.toggle('mode-3d', mode === '3d');
    var legend = document.getElementById('grade-legend');
    if (legend) legend.classList.toggle('hidden', mode !== '3d');
  }
  function readInitialMode() {
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
    var params = new URLSearchParams(location.hash.replace(/^#/, ''));
    params.set('m', mode);
    var h = params.toString();
    var newHash = h ? '#' + h : '';
    if (newHash !== location.hash) history.replaceState(null, '', newHash || location.pathname);
  }

  function makeRenderer(next) {
    var deps = {
      store: store, matcher: matcher, wxLookup: wxLookup,
      markerFactory: markerFactory, panel: panel,
      matchingHike: matchingHike, toMatchable: toMatchable,
      bestGrade: bestGrade
    };
    return (next === '3d')
      ? window.CC3DPeaks.Renderer3D(deps)
      : window.CC3DPeaks.Renderer2D(deps);
  }

  function switchMode(next) {
    if (switching || next === mode) return;
    if (next !== '2d' && next !== '3d') return;
    switching = true;

    var savedViewport = renderer ? renderer.getViewport() : null;
    var loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    // info-overlay.js relocates #info-btn into Leaflet's top-right control
    // bar in 2D. That container lives inside #map — Leaflet's map.remove()
    // AND our innerHTML wipe would both drop the button. Rescue it BEFORE
    // renderer.teardown() runs; the overlay's poller re-relocates it if
    // 2D reappears.
    var infoBtn = document.getElementById('info-btn');
    var app = document.getElementById('app');
    if (infoBtn && app && infoBtn.parentElement !== app) app.appendChild(infoBtn);

    if (renderer) {
      try { renderer.teardown(); } catch (e) { console.error('teardown', e); }
    }
    renderer = null;
    var mapEl = document.getElementById('map');
    mapEl.innerHTML = '';
    mapEl.className = '';   // Leaflet leaves .leaflet-container on the node

    mode = next;
    paintModeToggle();
    persistMode();

    renderer = makeRenderer(mode);
    var v = savedViewport || (mode === '3d' ? HOME_3D : HOME_2D);

    renderer.init('map', v).then(function () {
      renderer.setPois(routes);
      renderer.setChPeaks(chPeaks);
      renderer.setLayerVisibility('peaks', !!store.get('pk'));
      renderer.applyVisibility(store.state());
      renderer.refreshIcons();
      // Re-hydrate 2D-only overlays (SLF avalanche layer, optional webcam layer)
      if (mode === '2d') {
        if (slfLayerInstance) renderer.addLayer(slfLayerInstance);
        if (webcamLayerInstance) renderer.addLayer(webcamLayerInstance);
      }
      if (loadingOverlay) setTimeout(function () { loadingOverlay.classList.add('hidden'); }, 300);
      switching = false;
    }).catch(function (err) {
      console.error('mode init failed', err);
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      switching = false;
    });
  }

  /* ── Boot ─────────────────────────────────────────── */
  function boot() {
    routes = window.SAC_ROUTES || [];
    var loadingText = document.getElementById('loading-text');
    function status(msg) { if (loadingText) loadingText.textContent = msg; }

    // Precompute min-grade + has-page for both datasets. Both renderers read
    // these off the POI object; computing here (not inside a renderer) keeps
    // the flag consistent across mode swaps and makes the initial 3D boot
    // show the ★ star badge without waiting for a first 2D pass.
    routes.forEach(function (poi) {
      poi._minGrade = computeMinGrade(poi);
      poi._hasPage = !!matchingHike(poi);
      poi.hasPage = poi._hasPage;   // matcher reads camelCase; keep both in sync
    });
    // Wrap CH_PEAKS into SAC-POI shape at boot so the click adapter is a
    // no-op — panel + renderer see the same object shape.
    var chPeaksRaw = window.CH_PEAKS || [];
    chPeaks = chPeaksRaw.map(function (p) {
      // sac.grade → minGrade for the coloring expression
      p._minGrade = p.sac && p.sac.grade
        ? (parseInt(p.sac.grade.replace(/[^0-9]/g, ''), 10) || null)
        : null;
      return chPeakToSacPoi(p);
    });

    // Shared engine setup — identical to CC's boot().
    wxLookup = window.HikeMap.WxLookup({ fuzzy: false });
    markerWxLookup = {
      get: function (lat, lon, dayIndex) {
        var wx = wxLookup.get(lat, lon, dayIndex); if (!wx) return null;
        var showWeather = (store.get('dp') || []).indexOf('weather') !== -1;
        return showWeather ? wx : { freezingLevel: wx.freezingLevel };
      }
    };
    markerFactory = window.HikeMap.MarkerFactory({
      wxLookup: markerWxLookup, showHasPage: true, showFreezing: true
    });

    store = window.HikeMap.FilterStore({
      // `pk` = show bare peaks from CH_PEAKS (7,512 named Swiss peaks).
      // 3D-only visual, but the store carries it in both modes so a bookmark
      // survives a mode swap.
      keys: ['g', 'tm', 'el', 'gn', 'd', 'sk', 't', 'sn', 'h', 'u', 'hp', 'dp', 'wc', 'pk'],
      initial: Object.assign({ h: true, u: true, d: 0, dp: ['weather'], pk: true }, window.HikeMap.UrlSync.readFromUrl())
    });
    matcher = window.HikeMap.FilterMatcher.factory({ wxLookup: wxLookup });
    window.HikeMap.UrlSync.bind({ store: store });
    window.HikeMap.UrlSync.mountCrossPageBanner({
      store: store, uiKeys: store.keys, container: '#hm-cross-page-banner'
    });

    store.subscribe(function (state, changedKeys) {
      // dp-only skip — identical to CC (see hike_map/DESIGN.md § dp-only skip).
      if (changedKeys && changedKeys.length === 1 && changedKeys[0] === 'dp') {
        document.body.classList.toggle('display-name-off', (state.dp || []).indexOf('name') === -1);
        if (renderer) { renderer.refreshIcons(); renderer.refreshTooltips(); }
        return;
      }
      // pk-only skip — matches the dp pattern. `pk` controls the CH_PEAKS
      // layer visibility (3D only); it never changes SAC POI visibility, so
      // no need to run the full applyVisibility pass.
      if (changedKeys && changedKeys.length === 1 && changedKeys[0] === 'pk') {
        if (renderer && renderer.setLayerVisibility) renderer.setLayerVisibility('peaks', !!state.pk);
        return;
      }
      if (renderer) renderer.applyVisibility(state);
      updateRouteCounter(state);
    });

    // Panel opens before renderer init so click handlers can call panel.open()
    // right away. Adapter passes SAC POIs through unchanged; CH_PEAKS get
    // wrapped into a SAC-POI shape (see chPeakToSacPoi below).
    panel = window.HikeMap.SidePanel.mount({
      container: '#side-panel',
      wxLookup: wxLookup,
      dataAdapter: function (poi) { return poi._isChPeak ? poi : poi; },
      matchingHike: matchingHike,
      store: store
    });

    // Initial mode + renderer init
    mode = readInitialMode();
    paintModeToggle();
    renderer = makeRenderer(mode);

    status('Initializing map...');
    renderer.init('map', mode === '3d' ? HOME_3D : HOME_2D).then(function () {
      status('Creating ' + routes.length + ' markers...');
      renderer.setPois(routes);
      renderer.setChPeaks(chPeaks);
      renderer.setLayerVisibility('peaks', !!store.get('pk'));
      renderer.applyVisibility(store.state());

      // Avalanche layer — always-on in CC, 2D-only here (Leaflet layer)
      if (mode === '2d' && window.Overlays && window.Overlays.Avalanche) {
        window.Overlays.Avalanche.create().then(function (layer) {
          slfLayerInstance = layer;
          if (mode === '2d' && renderer) renderer.addLayer(layer);
        }).catch(function () {});
      }

      status('Fetching weather forecasts...');
      window.WeatherService.init(routes, status).then(function () {
        window.HikeMap.FilterBar.mount({
          container: '#cc-filter-bar', store: store,
          filters: ['g', 'tm', 'el', 'gn', 'd', 'sk', 't', 'sn', 'h', 'u', 'dp'],
          daySlotId: 'hm-day-slot'
        });
        window.HikeMap.DayPicker.mount({
          container: '#hm-day-slot',
          initial: store.get('d') || 0,
          onChange: function (i) { store.set('d', i); if (renderer) renderer.refreshIcons(); }
        });

        if (renderer) renderer.refreshIcons();
        updateRouteCounter(store.state());

        // Webcam toggle — subscribes to store.wc
        store.subscribe(function (state, changed) {
          if (!changed || changed.indexOf('wc') === -1) return;
          if (state.wc && !webcamLayerInstance && window.WebcamLayer) {
            window.WebcamLayer.create().then(function (layer) {
              webcamLayerInstance = layer;
              if (mode === '2d' && renderer) renderer.addLayer(layer);
            });
          } else if (webcamLayerInstance) {
            if (mode === '2d' && renderer) {
              if (state.wc) renderer.addLayer(webcamLayerInstance);
              else renderer.removeLayer(webcamLayerInstance);
            }
          }
        });

        var loadingOverlay = document.getElementById('loading-overlay');
        setTimeout(function () { if (loadingOverlay) loadingOverlay.classList.add('hidden'); }, 400);
      });
    }).catch(function (err) {
      console.error('renderer init failed', err);
    });

    // Mode toggle wiring
    document.getElementById('mode-2d').addEventListener('click', function () { switchMode('2d'); });
    document.getElementById('mode-3d').addEventListener('click', function () { switchMode('3d'); });
    window.addEventListener('keydown', function (e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
      if (e.shiftKey && (e.key === '#' || e.key === '3')) switchMode(mode === '3d' ? '2d' : '3d');
    });

    // 3D-only buttons — dispatch to the active renderer if it supports them.
    var trailsBtn = document.getElementById('trails-btn');
    if (trailsBtn) trailsBtn.addEventListener('click', function () {
      if (renderer && renderer.supports.trails && renderer.toggleTrails) renderer.toggleTrails();
    });
    var tourBtn = document.getElementById('tour-btn');
    if (tourBtn) tourBtn.addEventListener('click', function () {
      if (renderer && renderer.supports.tour && renderer.toggleTour) renderer.toggleTour();
    });

    // Chrome + reset + refresh buttons — same as CC (declared in the HTML shell)
    wireChromeToggle();
    wireResetButton();
    wireRefreshButton();

    buildWeatherToggles();
  }

  // Bottom-bar toggles — same location and styling as CC. Shared "Discover"
  // set (hikes / huts / webcams) plus three mode-specific additions:
  //   peaks     — CH_PEAKS layer; 3D only (CSS-hidden in 2D)
  //   trails    — SAC T1–T6 Overpass overlay; 3D only
  //   cinematic — fly-to-and-orbit selected peak; 3D only
  // Framework goal: whichever renderer is active exposes its supported
  // features via renderer.supports.*, and the button's onclick dispatches
  // to the right renderer method. Solving problems in one mode's toggle
  // handling automatically propagates because the button + wiring live in
  // one place.
  function buildWeatherToggles() {
    var panel = document.getElementById('weather-toggles');
    if (!panel) return;
    panel.innerHTML = '';
    var s = store.state();
    var toggles = [
      { id: 'hikes',     icon: '🥾', label: 'Hikes',                       stateKey: 'h' },
      { id: 'huts',      icon: '🏚️', label: 'SAC huts',                    stateKey: 'u' },
      { id: 'peaks',     icon: '🏔️', label: 'Peaks (3D only)',             stateKey: 'pk' },
      { id: 'webcams',   icon: '📷', label: 'Webcams',                     stateKey: 'wc' },
      { id: 'trails',    icon: '👣', label: 'SAC T1–T6 trails (3D only)',  action: 'trails',    defaultOn: true  },
      { id: 'cinematic', icon: '🎥', label: 'Cinematic tour (3D only)',    action: 'cinematic', defaultOn: false }
    ];
    toggles.forEach(function (t) {
      var on = t.stateKey ? !!s[t.stateKey] : !!t.defaultOn;
      var btn = document.createElement('button');
      btn.className = 'wx-toggle' + (on ? ' active' : '');
      btn.innerHTML = '<span class="icon">' + t.icon + '</span>';
      btn.title = t.label;
      btn.setAttribute('data-toggle', t.id);
      btn.addEventListener('click', function () {
        if (t.action === 'trails') {
          if (renderer && renderer.toggleTrails) {
            renderer.toggleTrails();
            btn.classList.toggle('active');
          }
        } else if (t.action === 'cinematic') {
          if (renderer && renderer.toggleTour) {
            renderer.toggleTour();
            btn.classList.toggle('active');
          }
        } else if (t.stateKey) {
          var next = !btn.classList.contains('active');
          btn.classList.toggle('active', next);
          store.set(t.stateKey, next);
        }
      });
      panel.appendChild(btn);
    });
  }

  function updateRouteCounter(state) {
    var visible = 0, totalRoutes = 0;
    routes.forEach(function (poi) {
      if (matcher.match(toMatchable(poi), state)) {
        visible++; totalRoutes += (poi.routes || []).length;
      }
    });
    var counterEl = document.getElementById('route-count');
    if (counterEl) {
      counterEl.innerHTML =
        '<span title="Destinations"><span class="bb-icon">📍</span><strong>' + visible + '</strong></span>'
        + ' · '
        + '<span title="Routes"><span class="bb-icon">🥾</span><strong>' + totalRoutes + '</strong></span>';
    }
    var resetBtn = document.getElementById('filter-reset');
    if (resetBtn) {
      var hasFilterHash = !!location.hash && location.hash !== '#';
      resetBtn.hidden = !hasFilterHash;
    }
  }

  function wireChromeToggle() {
    var btn = document.getElementById('chrome-toggle');
    if (!btn) return;
    var HIDDEN_STORAGE = 'cc.chromeHidden';
    var startHidden = false;
    try { startHidden = localStorage.getItem(HIDDEN_STORAGE) === '1'; } catch (e) {}
    if (startHidden) document.body.classList.add('cc-chrome-hidden');
    btn.setAttribute('aria-pressed', startHidden ? 'true' : 'false');
    btn.addEventListener('click', function () {
      var hidden = document.body.classList.toggle('cc-chrome-hidden');
      btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
      try { localStorage.setItem(HIDDEN_STORAGE, hidden ? '1' : '0'); } catch (e) {}
    });
  }
  function wireResetButton() {
    var btn = document.getElementById('filter-reset');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (window.HikeMap.UrlSync.reset) window.HikeMap.UrlSync.reset();
    });
  }
  function wireRefreshButton() {
    var btn = document.getElementById('refresh-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      // Unregister any service workers then hard-reload
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          regs.forEach(function (r) { r.unregister(); });
          location.reload();
        });
      } else {
        location.reload();
      }
    });
  }

  window.CC3DPeaks.switchMode = switchMode;
  window.CC3DPeaks.getMode = function () { return mode; };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
