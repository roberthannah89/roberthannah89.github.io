/* Coach-mark overlay — "what does everything on this page do?"
 *
 * Toggled by the (i) button in the bottom-right of #app. On open we draw a
 * labeled callout next to every registered UI region, with an elbow-line
 * connector back to the region and a dashed highlight ring around it. Any
 * click anywhere on the page closes the overlay, so it acts like a
 * dismiss-on-continue coach-mark rather than a modal.
 *
 * Non-overlap strategy: targets are bucketed into two "zones" — top (filter
 * bar, callouts hang below into the map) and bottom (bottom bar, callouts
 * float above into the map). Within a zone, callouts are packed into
 * horizontal "lanes" (rows) using a first-fit algorithm: sorted by target
 * x-position, each callout takes the first lane whose previous callout
 * ends before this callout would start (plus a small gap). The elbow
 * connector uses the manhattan route target→lane-height→callout, so lines
 * from adjacent targets to non-adjacent lanes don't visually cross each
 * other — every horizontal segment sits at its callout's own lane height.
 *
 * First-visit UX: if localStorage['cc.infoSeen'] is unset we auto-open the
 * overlay ~800ms after boot and mark the button with a short attention
 * pulse. The flag is set the moment the overlay first opens (whether from
 * the auto-open or a manual click), so a user who ignores it once never
 * gets nagged again.
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
      desc: 'POIs (huts, transit, parking, water), hazards (slope, snow), and reference cities.' },
    { sel: '#route-counter',         zone: 'bottom', title: 'Live counter',
      desc: 'Destinations and routes matching your current filters.' },
    { sel: '.ms-layer-bar',          zone: 'bottom', title: 'Base map',
      desc: 'Topo + trails, plain topo, aerial, or OpenStreetMap.' },
    { sel: '#forecast-meta',         zone: 'bottom', title: 'Forecast freshness',
      desc: 'Weather model + how recent the pre-baked cache is. Turns amber when it’s over 6 h old.' },
  ];

  // Callout box target sizing. Height varies with description length; we
  // measure after insertion, but reserve a stable "row height" so the lane
  // packer doesn't need a second layout pass.
  var CALLOUT_W_DESKTOP = 200;
  var CALLOUT_W_MOBILE  = 168;
  var LANE_GAP          = 8;    // vertical space between rows of callouts
  var HORIZONTAL_GAP    = 12;   // minimum horizontal gap between callouts in the same lane
  var LEG_LENGTH        = 22;   // length of the vertical stub off the target

  var overlayEl = null;
  var svgEl     = null;
  var isOpen    = false;

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

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'info-overlay';
    // SVG lives inside overlayEl but behind the callouts (they're appended
    // after this, so DOM order gives us the paint order we want).
    svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.classList.add('info-svg');
    svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    overlayEl.appendChild(svgEl);
    document.getElementById('app').appendChild(overlayEl);
    return overlayEl;
  }

  function clearOverlay() {
    if (!overlayEl) return;
    // Remove everything except the SVG root (keep the reference; empty it).
    while (overlayEl.lastChild && overlayEl.lastChild !== svgEl) {
      overlayEl.removeChild(overlayEl.lastChild);
    }
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
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
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svgEl.appendChild(path);

    // Small dot at the target end so it's obviously anchored.
    var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', fromX);
    dot.setAttribute('cy', fromY);
    dot.setAttribute('r', 2.5);
    svgEl.appendChild(dot);
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

  function layoutZone(zone, defs, filterBarBottom, bottomBarTop) {
    var vpW = window.innerWidth;
    var vpH = window.innerHeight;
    var calloutW = calloutWidth();

    // Measurement: collect rect + preferred callout center-x per visible target.
    var entries = [];
    defs.forEach(function (def) {
      var node = document.querySelector(def.sel);
      if (!node) return;
      var rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;   // hidden
      var targetCX = rect.left + rect.width / 2;
      var targetCY = rect.top  + rect.height / 2;
      // Preferred callout center-x = target center-x, clamped to viewport.
      var minCX = calloutW / 2 + 8;
      var maxCX = vpW - calloutW / 2 - 8;
      var calloutCX = Math.max(minCX, Math.min(maxCX, targetCX));
      entries.push({
        def: def,
        rect: rect,
        targetCX: targetCX,
        targetCY: targetCY,
        calloutCenterX: calloutCX
      });
    });

    if (!entries.length) return;
    entries.sort(function (a, b) { return a.calloutCenterX - b.calloutCenterX; });
    packLanes(entries, calloutW);

    // Draw pass. For each callout: figure out its top-y based on lane, insert
    // element, then draw its connector back to the target.
    entries.forEach(function (e) {
      drawHighlight(e.rect);
      var calloutEl = drawCallout(e, calloutW);
      // Measure post-insert height so lane baselines don't stack tighter than
      // the tallest callout in the previous lane. Cheap: we do this once per
      // callout during a single layout pass — no reflow storm.
      var ch = calloutEl.offsetHeight;
      var laneY;
      if (zone === 'top') {
        laneY = filterBarBottom + LEG_LENGTH + e.lane * (ch + LANE_GAP);
        calloutEl.style.top  = laneY + 'px';
      } else {
        laneY = bottomBarTop - LEG_LENGTH - e.lane * (ch + LANE_GAP) - ch;
        calloutEl.style.top  = laneY + 'px';
      }
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
    clearOverlay();
    // Reference measurements so both zones share the same map-clear bounds.
    var filterBar = document.getElementById('filter-bar');
    var bottomBar = document.getElementById('bottom-bar');
    var fbRect = filterBar ? filterBar.getBoundingClientRect() : { bottom: 60 };
    var bbRect = bottomBar ? bottomBar.getBoundingClientRect() : { top: window.innerHeight - 60 };

    var topDefs    = TARGETS.filter(function (t) { return t.zone === 'top';    });
    var bottomDefs = TARGETS.filter(function (t) { return t.zone === 'bottom'; });
    layoutZone('top',    topDefs,    fbRect.bottom, bbRect.top);
    layoutZone('bottom', bottomDefs, fbRect.bottom, bbRect.top);

    document.body.classList.add('info-open');
    var btn = document.getElementById('info-btn');
    if (btn) {
      btn.classList.add('active');
      btn.classList.remove('pulse');
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

  function wire() {
    var btn = document.getElementById('info-btn');
    if (!btn) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();       // don't let the document click-listener close it
      toggle();
    });

    // Any other click / touch / key press dismisses. Capture phase so we run
    // BEFORE Leaflet's map handlers get a chance to swallow the event.
    document.addEventListener('click', function () {
      if (isOpen) close();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (isOpen && (e.key === 'Escape' || e.key === 'Esc')) close();
    });

    // Repaint on resize while open — target rects shift and lane-packing
    // needs to re-run so callouts don't hang off the edge. Rebuild from
    // scratch: cheap enough (< 20 elements) and simpler than tracking deltas.
    var resizeTimer;
    window.addEventListener('resize', function () {
      if (!isOpen) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        // reopen() = close + open, without touching the seen flag.
        clearOverlay();
        var filterBar = document.getElementById('filter-bar');
        var bottomBar = document.getElementById('bottom-bar');
        var fbRect = filterBar ? filterBar.getBoundingClientRect() : { bottom: 60 };
        var bbRect = bottomBar ? bottomBar.getBoundingClientRect() : { top: window.innerHeight - 60 };
        layoutZone('top',    TARGETS.filter(function (t) { return t.zone === 'top'; }),    fbRect.bottom, bbRect.top);
        layoutZone('bottom', TARGETS.filter(function (t) { return t.zone === 'bottom'; }), fbRect.bottom, bbRect.top);
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
