/* Coach-mark overlay — "what does everything on this page do?"
 *
 * Toggled by an (i) button hosted inside Leaflet's top-right control block
 * (same visual grammar as the +/- zoom buttons — never floats over other
 * controls, works the same on desktop and mobile). On open we draw a
 * labelled callout next to every registered UI region, with an elbow-line
 * connector back to the region and a dashed highlight ring around it.
 * Any click anywhere on the page closes the overlay, so it acts like a
 * dismiss-on-continue coach-mark rather than a modal.
 *
 * SCRIM — the dim/blur backdrop is drawn as an SVG rectangle with a
 * per-target rectangular hole punched by <mask>. The controls the callouts
 * point at therefore stay visible at their natural brightness while the
 * map behind them is dimmed. No z-index shuffling — the scrim genuinely
 * has holes at the target positions, so target hit-testing / hover / focus
 * behaves normally.
 *
 * NON-OVERLAP — targets are bucketed into two zones (top = filter bar,
 * callouts hang below; bottom = bottom bar, callouts float above). Within
 * a zone, callouts are sorted by target x-position and packed into
 * horizontal lanes via first-fit: each callout takes the first lane whose
 * previous callout ends before this one starts (plus a small gap). The
 * elbow connector uses the manhattan route target → same-x stub →
 * same-y lane track → callout, so lines from adjacent targets to
 * non-adjacent lanes don't visually cross each other — every horizontal
 * segment sits at its callout's own lane height.
 *
 * WHY body.info-open IS APPLIED BEFORE LAYOUT — the overlay itself is
 * display:none until body.info-open is set. If we laid callouts out first,
 * the inserted callout elements would be inside a display:none subtree, so
 * offsetHeight would be 0 for all of them and every lane would collapse to
 * the same y-position (that was the launch bug). Set the class first,
 * measure second.
 *
 * FIRST-VISIT UX — if localStorage['cc.infoSeen'] is unset we auto-open
 * ~800ms after boot and mark the button with a short attention pulse.
 * The flag is set the moment the overlay first opens (whether from the
 * auto-open or a manual click), so a user who ignores it once never gets
 * nagged again.
 */
(function () {
  'use strict';

  var LS_SEEN_KEY = 'cc.infoSeen';

  // Registration order doesn't matter — sort-by-x happens per-zone at draw
  // time. `zone` decides which edge of the map the callout hangs off of.
  // Any selector that resolves to zero visible elements at open time is
  // silently skipped (e.g. weather-only groups when there's no cache).
  var TARGETS = [
    { sel: '#cc-tools',              zone: 'top', title: 'Page tools',
      desc: 'Menu, hide chrome, hard-refresh — the last one clears the cache if the site looks out of date.' },
    { sel: '.filter-group--grade',   zone: 'top', title: 'SAC grade',
      desc: 'Filter by difficulty T1–T6. Multi-select — pick as many as you want.' },
    { sel: '.filter-group--time',    zone: 'top', title: 'Moving time',
      desc: 'Naismith-rule estimate based on distance + vertical gain.' },
    { sel: '.filter-group--day',     zone: 'top', title: 'Forecast day',
      desc: 'Which day the weather filters + weather-coloured markers use.' },
    { sel: '.filter-group--sky',     zone: 'top', title: 'Sky condition',
      desc: 'Threshold filter — the chosen weather or better. Snow/storm always excluded.' },
    { sel: '.filter-group--temp',    zone: 'top', title: 'Temperature',
      desc: 'Forecast max temp at the peak on the selected day.' },
    { sel: '.filter-group--elev',    zone: 'top', title: 'Peak elevation',
      desc: 'Metres above sea level at the summit.' },
    { sel: '.filter-group--gain',    zone: 'top', title: 'Vertical gain',
      desc: 'Total climb along the route.' },
    { sel: '.filter-group--season',  zone: 'top', title: 'In season now',
      desc: 'Rough altitude + grade heuristic for the current month — cross-check with local conditions.' },
    { sel: '.filter-group--display', zone: 'top', title: 'Marker display',
      desc: 'What each pin shows on the map — name, grade, weather colour, gain, etc.' },
    { sel: '#weather-toggles',       zone: 'bottom', title: 'Map layers',
      desc: 'Three groups: Discover (hikes, huts, cities, webcams), Safety (all off by default — closures, snow, fire, wildlife, rockfall, slope; enable to see), Approach (transit, parking, water).' },
    { sel: '#route-counter',         zone: 'bottom', title: 'Live counter',
      desc: 'Destinations and routes matching your current filters.' },
    { sel: '.ms-layer-bar',          zone: 'bottom', title: 'Base map',
      desc: 'Topo + trails, plain topo, aerial, or OpenStreetMap.' },
    { sel: '#forecast-meta',         zone: 'bottom', title: 'Forecast freshness',
      desc: 'Weather model + how recent the pre-baked cache is. Turns amber when it is over 6 h old.' },
  ];

  // Callout target sizing. Height varies with description length; we
  // measure post-insert. Layout applies body.info-open BEFORE this pass, so
  // offsetHeight returns the real rendered height (not 0 from display:none).
  var CALLOUT_W_DESKTOP = 200;
  var CALLOUT_W_MOBILE  = 168;
  var LANE_GAP          = 8;    // vertical space between rows of callouts
  var HORIZONTAL_GAP    = 12;   // minimum horizontal gap between callouts in the same lane
  var LEG_LENGTH        = 22;   // length of the vertical stub off the target
  var SCRIM_HOLE_PAD    = 6;    // extra padding around each target in the scrim cutout

  var overlayEl    = null;
  var scrimSvg     = null;      // SVG that draws the dimmed backdrop with target-shaped holes
  var scrimMaskEl  = null;      // <mask> element holding the target holes
  var connectorSvg = null;      // separate SVG for callout connector lines
  var isOpen       = false;

  function isMobile() {
    return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  }
  function calloutWidth() {
    return isMobile() ? CALLOUT_W_MOBILE : CALLOUT_W_DESKTOP;
  }

  function markSeen() {
    try { localStorage.setItem(LS_SEEN_KEY, '1'); } catch (e) {}
  }
  function hasSeen() {
    try { return localStorage.getItem(LS_SEEN_KEY) === '1'; } catch (e) { return false; }
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) {
      for (var k in attrs) el.setAttribute(k, attrs[k]);
    }
    return el;
  }

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'info-overlay';

    // Scrim layer — full-viewport dark rect with a mask that punches
    // rectangular holes over each target so the actual UI controls stay
    // visible (unblurred) while the map behind is dimmed.
    scrimSvg = svgEl('svg', { class: 'info-scrim' });
    var defs = svgEl('defs');
    scrimMaskEl = svgEl('mask', { id: 'info-scrim-mask' });
    // White fill on mask → whole scrim is opaque by default.
    scrimMaskEl.appendChild(
      svgEl('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'white' })
    );
    defs.appendChild(scrimMaskEl);
    scrimSvg.appendChild(defs);
    scrimSvg.appendChild(svgEl('rect', {
      x: 0, y: 0, width: '100%', height: '100%',
      fill: 'rgba(6, 4, 0, 0.55)',
      mask: 'url(#info-scrim-mask)'
    }));
    overlayEl.appendChild(scrimSvg);

    // Connector layer — drawn ABOVE the scrim but BELOW callouts. Uses a
    // separate SVG so we can clear and repopulate connectors without
    // touching the scrim's mask defs each open.
    connectorSvg = svgEl('svg', { class: 'info-connectors' });
    overlayEl.appendChild(connectorSvg);

    document.getElementById('app').appendChild(overlayEl);
    return overlayEl;
  }

  function clearOverlay() {
    if (!overlayEl) return;
    // Reset the scrim mask to fully opaque (drop any prior holes).
    while (scrimMaskEl.firstChild) scrimMaskEl.removeChild(scrimMaskEl.firstChild);
    scrimMaskEl.appendChild(
      svgEl('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'white' })
    );
    // Clear connectors.
    while (connectorSvg.firstChild) connectorSvg.removeChild(connectorSvg.firstChild);
    // Remove all non-SVG children (highlight rings + callout DIVs). The two
    // SVG layers stay so we can reuse the mask/defs setup.
    var kids = Array.prototype.slice.call(overlayEl.children);
    kids.forEach(function (k) {
      if (k !== scrimSvg && k !== connectorSvg) overlayEl.removeChild(k);
    });
  }

  // Punch a rectangular hole in the scrim mask at the given viewport rect.
  // Mask uses fill=black to make that region "transparent" in the mask, so
  // the corresponding scrim area draws no fill and the underlying UI shows
  // through at full brightness.
  function punchHole(rect) {
    scrimMaskEl.appendChild(svgEl('rect', {
      x: rect.left - SCRIM_HOLE_PAD,
      y: rect.top  - SCRIM_HOLE_PAD,
      width:  rect.width  + SCRIM_HOLE_PAD * 2,
      height: rect.height + SCRIM_HOLE_PAD * 2,
      rx: 6, ry: 6,
      fill: 'black'
    }));
  }

  // First-fit lane packer. `entries` are already sorted by target center-x.
  // Returns the same list with `.lane` (integer, 0-based) assigned to each.
  function packLanes(entries, calloutW) {
    var laneRightEdge = [];   // index → rightmost x used by the last callout in that lane
    entries.forEach(function (e) {
      var left  = e.calloutCenterX - calloutW / 2;
      var right = e.calloutCenterX + calloutW / 2;
      var placed = false;
      for (var i = 0; i < laneRightEdge.length; i++) {
        if (laneRightEdge[i] + HORIZONTAL_GAP <= left) {
          e.lane = i;
          laneRightEdge[i] = right;
          placed = true;
          break;
        }
      }
      if (!placed) {
        e.lane = laneRightEdge.length;
        laneRightEdge.push(right);
      }
    });
    return entries;
  }

  function drawConnector(fromX, fromY, toX, toY) {
    // Elbow route target → same-x stub → same-y lane track → callout edge.
    // If we're basically vertical (fromX ≈ toX) collapse to a straight line
    // so there's no cosmetic dogleg on perfectly-aligned targets.
    var d;
    if (Math.abs(fromX - toX) < 3) {
      d = 'M' + fromX + ' ' + fromY + ' L' + toX + ' ' + toY;
    } else {
      d = 'M' + fromX + ' ' + fromY +
          ' L' + fromX + ' ' + toY +
          ' L' + toX  + ' ' + toY;
    }
    connectorSvg.appendChild(svgEl('path', { d: d }));
    // Small dot at the target end so it's obviously anchored.
    connectorSvg.appendChild(svgEl('circle', { cx: fromX, cy: fromY, r: 2.5 }));
  }

  function drawHighlight(rect) {
    var pad = 4;
    var box = document.createElement('div');
    box.className = 'info-highlight';
    box.style.left   = (rect.left   - pad) + 'px';
    box.style.top    = (rect.top    - pad) + 'px';
    box.style.width  = (rect.width  + pad * 2) + 'px';
    box.style.height = (rect.height + pad * 2) + 'px';
    overlayEl.appendChild(box);
  }

  function drawCallout(entry, calloutW) {
    var el = document.createElement('div');
    el.className = 'info-callout';
    el.style.width = calloutW + 'px';
    el.innerHTML =
      '<span class="info-callout__title"></span>' +
      '<span class="info-callout__desc"></span>';
    el.querySelector('.info-callout__title').textContent = entry.def.title;
    el.querySelector('.info-callout__desc').textContent  = entry.def.desc;
    overlayEl.appendChild(el);
    return el;
  }

  // Preflight pass — measure every visible target from every zone so we can
  // punch scrim holes BEFORE we start laying callouts. This is what keeps
  // the toggles unblurred through the scrim.
  function measureAllTargets() {
    return TARGETS.map(function (def) {
      var node = document.querySelector(def.sel);
      if (!node) return null;
      var rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { def: def, rect: rect };
    }).filter(Boolean);
  }

  function layoutZone(zone, visible, filterBarBottom, bottomBarTop) {
    var vpW = window.innerWidth;
    var calloutW = calloutWidth();

    var entries = visible
      .filter(function (v) { return v.def.zone === zone; })
      .map(function (v) {
        var targetCX = v.rect.left + v.rect.width / 2;
        var targetCY = v.rect.top  + v.rect.height / 2;
        var minCX = calloutW / 2 + 8;
        var maxCX = vpW - calloutW / 2 - 8;
        var calloutCX = Math.max(minCX, Math.min(maxCX, targetCX));
        return {
          def: v.def,
          rect: v.rect,
          targetCX: targetCX,
          targetCY: targetCY,
          calloutCenterX: calloutCX
        };
      });

    if (!entries.length) return;
    entries.sort(function (a, b) { return a.calloutCenterX - b.calloutCenterX; });
    packLanes(entries, calloutW);

    // Draw pass. Each callout is inserted, measured (real height because
    // body.info-open is already applied), then positioned + connected.
    entries.forEach(function (e) {
      drawHighlight(e.rect);
      var calloutEl = drawCallout(e, calloutW);
      var ch = calloutEl.offsetHeight;
      var laneY;
      if (zone === 'top') {
        laneY = filterBarBottom + LEG_LENGTH + e.lane * (ch + LANE_GAP);
      } else {
        laneY = bottomBarTop - LEG_LENGTH - e.lane * (ch + LANE_GAP) - ch;
      }
      calloutEl.style.top  = laneY + 'px';
      calloutEl.style.left = (e.calloutCenterX - calloutW / 2) + 'px';

      // Connector endpoints. Target end is the edge closest to the map area
      // (bottom edge for top-zone targets, top edge for bottom-zone).
      var fromX = e.targetCX;
      var fromY = zone === 'top' ? (e.rect.bottom + 2) : (e.rect.top - 2);
      var toX   = e.calloutCenterX;
      var toY   = zone === 'top' ? laneY : (laneY + ch);
      drawConnector(fromX, fromY, toX, toY);
    });
  }

  function open() {
    if (isOpen) return;
    ensureOverlay();
    // CRITICAL: set the open class BEFORE any measurement — see the header
    // comment. Otherwise callouts render inside display:none, offsetHeight
    // returns 0, and every lane collapses to the same y-position.
    document.body.classList.add('info-open');
    clearOverlay();

    // Preflight: measure targets, punch scrim holes so controls stay
    // unblurred through the mask.
    var visible = measureAllTargets();
    visible.forEach(function (v) { punchHole(v.rect); });

    // Also punch a hole around the info button itself so the (i) stays
    // visible / clickable on the same tap as the dismiss.
    var btnEl = document.getElementById('info-btn');
    if (btnEl) punchHole(btnEl.getBoundingClientRect());

    // Reference measurements so both zones share the same map-clear bounds.
    var filterBar = document.getElementById('filter-bar');
    var bottomBar = document.getElementById('bottom-bar');
    var fbRect = filterBar ? filterBar.getBoundingClientRect() : { bottom: 60 };
    var bbRect = bottomBar ? bottomBar.getBoundingClientRect() : { top: window.innerHeight - 60 };

    layoutZone('top',    visible, fbRect.bottom, bbRect.top);
    layoutZone('bottom', visible, fbRect.bottom, bbRect.top);

    if (btnEl) {
      btnEl.classList.add('active');
      btnEl.classList.remove('pulse');
    }
    isOpen = true;
    markSeen();
  }

  function close() {
    if (!isOpen) return;
    if (overlayEl) clearOverlay();
    document.body.classList.remove('info-open');
    var btn = document.getElementById('info-btn');
    if (btn) btn.classList.remove('active');
    isOpen = false;
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  // Mount the (i) button. The button is present in the static HTML at boot
  // (bottom-right corner via CSS) so older cached copies of this script
  // that only look up `#info-btn` also work. When the Leaflet control
  // container has finished mounting, we RELOCATE the same button into
  // .leaflet-top.leaflet-right so it stacks with the native zoom /
  // fullscreen controls instead of floating over them.
  function attachInfoButton() {
    var btn = document.getElementById('info-btn');
    if (!btn) return null;
    // Wire click if not already wired. The `data-wired` guard makes this
    // safe to call more than once (both from the initial DOMContentLoaded
    // pass and from a later Leaflet-ready relocation).
    if (btn.getAttribute('data-wired') !== '1') {
      ['mousedown','touchstart','pointerdown','click','dblclick','wheel'].forEach(function (t) {
        btn.addEventListener(t, function (e) { e.stopPropagation(); });
      });
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        toggle();
      });
      btn.setAttribute('data-wired', '1');
    }
    return btn;
  }

  // Move the (already-wired) button into the Leaflet top-right control
  // block so it participates in Leaflet's responsive stacking. Called
  // once the control container has appeared. Wraps the button in a
  // .leaflet-bar / .leaflet-control div so it visually matches native
  // controls (zoom, fullscreen). Idempotent — bails if the button is
  // already inside the Leaflet container.
  function relocateIntoLeafletBar(btn) {
    if (!btn) return;
    var topRight = document.querySelector('.leaflet-top.leaflet-right');
    if (!topRight) return;
    if (topRight.contains(btn)) return;
    var bar = document.createElement('div');
    bar.className = 'leaflet-bar leaflet-control info-btn-wrap';
    // Stop the wrapper too so map dragging isn't triggered by grabbing
    // the padding around the button.
    ['mousedown','touchstart','pointerdown','click','dblclick','wheel'].forEach(function (t) {
      bar.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    bar.appendChild(btn);
    topRight.appendChild(bar);
    document.body.classList.add('info-btn-in-leaflet');
  }

  // Boot: wire the static button immediately, then poll briefly for the
  // Leaflet control container and relocate the button when it appears.
  // If Leaflet never boots (e.g. offline) the button still works from its
  // static corner position.
  function wire() {
    var btn = attachInfoButton();
    if (btn) postMount(btn);
    var attempts = 0;
    var timer = setInterval(function () {
      attempts++;
      var topRight = document.querySelector('.leaflet-top.leaflet-right');
      if (topRight || attempts > 60) {
        clearInterval(timer);
        relocateIntoLeafletBar(btn || document.getElementById('info-btn'));
      }
    }, 100);
  }

  function postMount(btn) {
    // Any click / touch / key press dismisses. Capture phase so we run
    // BEFORE Leaflet's map handlers get a chance to swallow the event.
    document.addEventListener('click', function () {
      if (isOpen) close();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (isOpen && (e.key === 'Escape' || e.key === 'Esc')) close();
    });

    // Repaint on resize while open — target rects shift and lane-packing
    // needs to re-run so callouts don't hang off the edge. Rebuild from
    // scratch: cheap enough (~15 elements) and simpler than tracking deltas.
    var resizeTimer;
    window.addEventListener('resize', function () {
      if (!isOpen) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        clearOverlay();
        var visible = measureAllTargets();
        visible.forEach(function (v) { punchHole(v.rect); });
        var btnEl = document.getElementById('info-btn');
        if (btnEl) punchHole(btnEl.getBoundingClientRect());
        var filterBar = document.getElementById('filter-bar');
        var bottomBar = document.getElementById('bottom-bar');
        var fbRect = filterBar ? filterBar.getBoundingClientRect() : { bottom: 60 };
        var bbRect = bottomBar ? bottomBar.getBoundingClientRect() : { top: window.innerHeight - 60 };
        layoutZone('top',    visible, fbRect.bottom, bbRect.top);
        layoutZone('bottom', visible, fbRect.bottom, bbRect.top);
      }, 120);
    });

    // First-visit auto-open. Wait until the loading overlay has faded so the
    // filter groups have their real widths (buildWeatherToggles + FilterBar
    // populate asynchronously — see command-center.js boot()). We poll for
    // #filter-bar to have non-zero children instead of racing the timers.
    if (!hasSeen()) {
      btn.classList.add('pulse');
      var attempts = 0;
      var poll = setInterval(function () {
        attempts++;
        var fb = document.getElementById('filter-bar');
        var hasWeatherToggles = document.querySelectorAll('#weather-toggles .wx-toggle').length > 0;
        var hasFilterGroups   = document.querySelectorAll('#cc-filter-bar .filter-group').length >= 3;
        if ((fb && hasWeatherToggles && hasFilterGroups) || attempts > 60) {
          clearInterval(poll);
          setTimeout(open, 400);
        }
      }, 200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // Expose a tiny handle so a console user (or future keybinding) can open
  // the overlay without hunting the button.
  window.HikeCcInfo = { open: open, close: close, toggle: toggle };
})();
