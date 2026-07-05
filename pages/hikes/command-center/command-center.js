/* Command Center — main orchestrator */
(function () {
  'use strict';

  var map, clusterGroup;
  var allMarkers = [];
  // Canonical shared filter store + matcher (hike_map/filter_store.js,
  // filter_matcher.js) — constructed in boot(), read by every closure below
  // via these module-scope vars (same pattern as wxLookup/markerFactory).
  var store, matcher, panel;
  // Weather lookup wrapper — SAC route coords match the pre-baked cache
  // exactly (unlike index.html's hike summit coords, which can drift), so CC
  // never needs the fuzzy fallback. Constructed here (not inside boot()) so
  // every closure below — marker icons, city pills, cluster tint, popups —
  // shares the same instance without threading it through as an argument.
  // (Named wxLookup, not wx — several functions below already use a local
  // `var wx` for the resolved forecast object; reusing the name would shadow
  // this wrapper and break `wx.get(...)`.)
  var wxLookup = window.HikeMap.WxLookup({ fuzzy: false });

  // Wrapper handed to the marker factory so the pill/dot decision also
  // respects the "Display: weather" filter toggle (index has no such toggle —
  // it always shows the pill when a forecast exists). The ❄️ above-freezing
  // badge must keep tracking the forecast regardless of that toggle, so only
  // `code` is stripped (forcing the factory's dot branch) — `freezingLevel`
  // passes through untouched.
  var markerWxLookup = {
    get: function (lat, lon, dayIndex) {
      var wx = wxLookup.get(lat, lon, dayIndex);
      if (!wx) return null;
      var showWeather = (store.get('dp') || []).indexOf('weather') !== -1;
      return showWeather ? wx : { freezingLevel: wx.freezingLevel };
    }
  };
  var markerFactory = window.HikeMap.MarkerFactory({
    wxLookup: markerWxLookup,
    showHasPage: true,
    showFreezing: true,
  });

  // Reference-city markers — not hikes, not filtered, not clustered. Added
  // directly to the map in their own layer group so the toggle simply
  // add/removes the group without touching the hike pipeline.
  var cityMarkers = [];
  var cityLayer = null;

  // Zoom at/above which permanent name labels show. Below it the tooltips are
  // unbound entirely (not just CSS-hidden) so Leaflet does zero per-marker
  // tooltip repositioning while panning/zooming the overview. See
  // updateLabelVisibility().
  var LABEL_ZOOM = 11;
  var labelsBound = false;

  /* ── Map setup ─────────────────────────────────────── */

  function initMap() {
    map = L.map('map', {
      center: [46.8, 8.2],
      zoom: 9,
      zoomControl: false
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Base layer switcher (Topo+Trails / Topo / Aerial / OSM) + Swiss border + fullscreen
    if (window.MapShared && MapShared.addLayerControl) {
      MapShared.addLayerControl(map, { defaultLayer: 'hike' });
      // Relocate the layer bar into the bottom-bar so it sits in a horizontal
      // strip alongside the route counter and forecast meta.
      var lbar = document.querySelector('.ms-layer-bar');
      var bbar = document.getElementById('bottom-bar');
      if (lbar && bbar) bbar.insertBefore(lbar, bbar.firstChild);
    } else {
      L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
        maxZoom: 18,
        attribution: '&copy; swisstopo'
      }).addTo(map);
    }

    // Cluster group — tinted by dominant weather of contained markers.
    // Cluster tint always reflects raw forecast data (not gated by the
    // "Display: weather" toggle), so this uses wxLookup directly, not the
    // markerWxLookup gating wrapper used for marker icons.
    clusterGroup = window.HikeMap.ClusterGroupFactory({
      wxLookup: wxLookup,
      dayIndexGetter: function () { return store.get('d'); },
    });
    map.addLayer(clusterGroup);

    // Bind/unbind permanent name labels around LABEL_ZOOM. Markers are
    // created after initMap, so the first real bind happens from
    // createMarkers; this keeps labels in sync on every later zoom.
    map.on('zoomend', updateLabelVisibility);
  }

  /* ── Route markers ─────────────────────────────────── */

  // SAC POI → hardest grade across its routes[]. Domain-specific (reads the
  // CC-only routes[] shape), so it stays local here rather than in the
  // generic hike_map/ engine. createMarkers() below caches the result onto
  // poi.grade so hike_map/side_panel.js's render() can read it back without
  // CC handing a callback into the panel's mount() config.
  function bestGrade(poi) {
    var best = 'T1';
    if (!poi.routes) return best;
    poi.routes.forEach(function (r) {
      if (r.grade && r.grade > best) best = r.grade;
    });
    return best;
  }

  // SAC POI → matching built hike page (window.HIKES entry), or null. Moved
  // here from side-panel.js's old module-level matchingHike() — createMarkers()
  // and openPopup() both need it independent of whether/when the side panel
  // has mounted, and it's also handed to HikeMap.SidePanel.mount() as the
  // `matchingHike` adapter (see boot()).
  //
  // Match in this order, falling through on miss:
  //   1. SAC route_id on any of the POI's routes (cleanest — IDs are stable)
  //   2. SAC peak_id on the POI's id
  //   3. lat/lon within ~200 m (handles 4-vs-5-decimal rounding)
  //   4. exact name match (case- and umlaut-insensitive)
  function matchingHike(poi) {
    if (!window.HIKES || !poi) return null;
    var poiRouteIds = (poi.routes || []).map(function (r) { return r.id; });

    function normName(s) {
      return (s || '')
        .toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    }
    var poiNameN = normName(poi.name);

    for (var i = 0; i < window.HIKES.length; i++) {
      var h = window.HIKES[i];
      if (!h) continue;
      if (h.sac_route_id && poiRouteIds.indexOf(h.sac_route_id) >= 0) return h;
      if (h.sac_peak_id && h.sac_peak_id === poi.id) return h;
    }
    for (var j = 0; j < window.HIKES.length; j++) {
      var hk = window.HIKES[j];
      if (!hk) continue;
      if (poi.lat != null && hk.lat != null
          && Math.abs(hk.lat - poi.lat) < 0.002
          && Math.abs(hk.lon - poi.lon) < 0.002) return hk;
      if (poiNameN && normName(hk.name) === poiNameN) return hk;
    }
    return null;
  }

  function createMarkers(routes) {
    routes.forEach(function (poi) {
      if (!poi.lat || !poi.lon) return;

      // Precompute the fields markerFactory.makeIcon (and toMatchable, below)
      // read directly off the POI:
      //   grade   — best (hardest) grade across routes, drives border colour.
      //   hasPage — amber ★ badge for POIs whose hike has a built page here.
      //             Reuses matchingHike() so we don't drift from the panel's
      //             link logic. toMatchable() reads this cached value rather
      //             than recomputing matchingHike() per filter pass.
      poi.grade = bestGrade(poi);
      var hasPage = !!matchingHike(poi);
      poi._hasPage = hasPage;
      poi.hasPage = hasPage;

      var marker = L.marker([poi.lat, poi.lon], {
        icon: markerFactory.makeIcon(poi, store.get('d'))
      });

      marker._poi = poi;
      marker._filtered = false;

      // Permanent name tooltips are bound lazily by updateLabelVisibility()
      // once the user zooms past LABEL_ZOOM — not here — so the overview
      // doesn't carry ~960 tooltip DOM nodes. The first-click regression
      // guard lives with the bindTooltip call in bindMarkerTooltips().

      marker.on('click', function () {
        if (panel && panel.isOpen()) {
          panel.open(poi);
        } else {
          openPopup(poi, marker);
        }
      });

      marker.on('popupopen', function (e) {
        // Once a popup has been bound, Leaflet auto-toggles it on every marker
        // click. When the side panel is already open we want clicks to act as
        // pure panel updates with no popup at all — so suppress the popup the
        // moment it opens. Keep this *and* the click-handler branch above:
        // the click handler also routes directly to panel.open so the
        // panel updates immediately without waiting for the popup-then-close.
        if (panel && panel.isOpen()) {
          marker.closePopup();
          return;
        }
        var el = e.popup.getElement();
        if (!el) return;
        var btn = el.querySelector('.popup-expand');
        if (btn) {
          btn.onclick = function () {
            marker.closePopup();
            if (panel) panel.open(poi);
          };
        }
        if (window.HikePopup && HikePopup.bindCarousel) {
          HikePopup.bindCarousel(el);
        }
      });

      allMarkers.push(marker);
    });

    updateLabelVisibility();
    refreshCluster();
  }

  // Re-render every marker's icon based on the currently selected weather day
  // and the Display filter. markerFactory decides pill vs. dot from
  // markerWxLookup, which strips the forecast `code` (forcing the dot
  // branch) whenever 'weather' isn't in the Display filter — see its
  // definition above. The ❄️ "above freezing line" badge keeps tracking the
  // selected forecast day regardless of that toggle (markerWxLookup passes
  // `freezingLevel` through untouched).
  function refreshMarkerIcons() {
    var dayIdx = store.get('d');
    allMarkers.forEach(function (m) {
      m.setIcon(markerFactory.makeIcon(m._poi, dayIdx));
    });
    // Reference-city pills track the same Day selection so they're directly
    // comparable to the hike markers around them.
    refreshCityMarkers();
  }

  // Build the metadata line for a POI ("T3 · 800m · 3h ↑ · 2700m") based on
  // which non-name fields are currently in the Display filter. Returns an
  // empty string if no metadata fields are selected or no data is available.
  function buildPoiMetaLine(poi, display) {
    var r = (poi.routes && poi.routes[0]) || null;
    var parts = [];
    if (display.indexOf('grade') !== -1) {
      var g = bestGrade(poi);
      if (g) parts.push(g);
    }
    if (display.indexOf('gain') !== -1 && r && r.gain) {
      parts.push(r.gain + 'm');
    }
    if (display.indexOf('time') !== -1 && r && r.time_up) {
      var h = r.time_up / 60;
      // Whole hours when clean, else one decimal place
      var label = (h % 1 === 0) ? h + 'h' : h.toFixed(1) + 'h';
      parts.push(label + ' ↑');
    }
    if (display.indexOf('alt') !== -1 && poi.alt) {
      parts.push(Math.round(poi.alt) + 'm');
    }
    return parts.join(' · ');
  }

  // Build the tooltip HTML for a POI. The name span is always emitted (its
  // visibility is the O(1) `body.display-name-off` CSS toggle, not a rebuild);
  // the meta line depends on which grade/gain/time/alt fields are selected.
  function tooltipContent(poi, display) {
    var lines = [];
    if (poi.name) {
      lines.push('<span class="hike-tt__name">' + esc(poi.name) + '</span>');
    }
    var meta = buildPoiMetaLine(poi, display);
    if (meta) {
      lines.push('<span class="hike-tt__meta">' + esc(meta) + '</span>');
    }
    return lines.join('');
  }

  // Rebuild content for markers that currently HAVE a tooltip bound. Below
  // LABEL_ZOOM nothing is bound, so this is a cheap no-op; the current Display
  // state is applied when bindMarkerTooltips() runs on zoom-in.
  function refreshMarkerTooltips() {
    var display = store.get('dp') || [];
    allMarkers.forEach(function (m) {
      var tip = m.getTooltip();
      if (tip) tip.setContent(tooltipContent(m._poi, display));
    });
  }

  /* ── Lazy permanent labels ─────────────────────────── */
  // Permanent tooltips are costly: Leaflet repositions every on-map tooltip on
  // each pan/zoom, and with ~960 markers that dominates overview interaction.
  // So we only bind them at/above LABEL_ZOOM (where they're actually shown) and
  // unbind below it, leaving the overview as plain markers with no tooltip DOM.

  function bindMarkerTooltips() {
    var display = store.get('dp') || [];
    allMarkers.forEach(function (m) {
      if (m.getTooltip()) return;
      // ⚠️ FIRST-CLICK REGRESSION GUARD (do not change without reading):
      // Three things together prevent "popup needs Enter to open on first
      // click":
      //   1. `interactive: false` here so the permanent tooltip never eats the
      //      marker click (it sits to the right of the marker and would
      //      otherwise absorb the pointer event).
      //   2. `.leaflet-tooltip-pane { pointer-events: none; }` in
      //      command-center.css — belt-and-braces on the entire tooltip pane.
      //   3. `openPopup()` uses `getPopup() / setPopupContent()` instead of
      //      always calling `bindPopup()` (see openPopup) so re-clicks reuse
      //      the existing popup instead of binding a new one mid-event.
      // Original fix: commit c61debf. If you remove any of the three, the
      // popup will require a second click (or Enter) to open.
      m.bindTooltip(tooltipContent(m._poi, display), {
        permanent: true,
        interactive: false,
        direction: 'right',
        offset: [22, 0],
        className: 'hike-tooltip'
      });
    });
  }

  function unbindMarkerTooltips() {
    allMarkers.forEach(function (m) {
      if (m.getTooltip()) m.unbindTooltip();
    });
  }

  // Keep label binding in sync with zoom. body.zoom-labels still drives CSS
  // visibility (and the display-name-off / empty-tooltip rules); the binding
  // state mirrors it so we never pay for tooltip DOM below the threshold.
  function updateLabelVisibility() {
    var show = map.getZoom() >= LABEL_ZOOM;
    document.body.classList.toggle('zoom-labels', show);
    if (show === labelsBound) return;
    if (show) bindMarkerTooltips();
    else unbindMarkerTooltips();
    labelsBound = show;
  }

  function refreshCluster() {
    clusterGroup.clearLayers();
    allMarkers.forEach(function (m) {
      if (!m._filtered) clusterGroup.addLayer(m);
    });
  }

  /* ── Reference cities ──────────────────────────────── */
  // Major Swiss cities rendered as a separate, non-clustered, non-filtered
  // layer purely so the user can eyeball forecast cache values against
  // MeteoSwiss/Google for a known location.

  function makeCityIcon(wxIcon, tempStr) {
    var temp = tempStr ? '<span class="city-marker__temp">' + tempStr + '</span>' : '';
    var wx = wxIcon ? '<span class="city-marker__wx">' + wxIcon + '</span>' : '<span class="city-marker__wx">—</span>';
    return L.divIcon({
      className: '',
      html: '<div class="city-marker">' + wx + temp + '</div>',
      iconSize: [44, 24],
      iconAnchor: [22, 12]
    });
  }

  function createCityMarkers() {
    var cities = window.CITIES || [];
    if (!cities.length) return;
    cityLayer = L.layerGroup();
    cities.forEach(function (city) {
      var marker = L.marker([city.lat, city.lon], {
        icon: makeCityIcon(null, null),
        // Render above hike markers so the reference pill is never buried
        // by a same-cell hike — cities are sparse enough that this is fine.
        zIndexOffset: 1000
      });
      marker._city = city;
      marker.bindTooltip(city.name, {
        permanent: true,
        interactive: false,
        direction: 'top',
        offset: [0, -10],
        className: 'city-tooltip'
      });
      marker.on('click', function () { openCityPopup(city, marker); });
      cityMarkers.push(marker);
      cityLayer.addLayer(marker);
    });
  }

  function refreshCityMarkers() {
    if (!cityMarkers.length) return;
    var dayIdx = store.get('d');
    cityMarkers.forEach(function (m) {
      var c = m._city;
      var wx = wxLookup.get(c.lat, c.lon, dayIdx);
      var emoji = wx ? WeatherService.weatherIcon(wx.code) : null;
      var tempStr = wx && wx.tempMax != null ? Math.round(wx.tempMax) + '°' : '';
      m.setIcon(makeCityIcon(emoji, tempStr));
    });
  }

  function openCityPopup(city, marker) {
    var dayIdx = store.get('d');
    var wx = wxLookup.get(city.lat, city.lon, dayIdx);
    var html = '<div class="popup-name">🏙️ ' + esc(city.name) + '</div>';
    html += '<div class="popup-meta">' + (city.alt || '—') + ' m · reference point</div>';
    if (wx) {
      var dayLabel = WeatherService.formatDayLabel(wx.date);
      html += '<div class="popup-weather">';
      html += WeatherService.weatherIcon(wx.code) + ' ' + dayLabel + ': ';
      html += WeatherService.weatherLabel(wx.code);
      html += ', ' + Math.round(wx.tempMax) + '°C';
      if (wx.precip > 0) html += ', ' + wx.precip.toFixed(1) + 'mm';
      html += ', 💨 ' + Math.round(wx.windMax) + ' km/h';
      html += '</div>';
    } else {
      html += '<div class="popup-weather">No forecast cached — run <code>make weather</code></div>';
    }
    // Direct link to MeteoSwiss's location forecast so the user can verify the
    // cached value against the source they actually trust.
    var meteo = 'https://www.meteoswiss.admin.ch/#tab=forecast-map'
      + '&lat=' + city.lat + '&lon=' + city.lon + '&zoom=9';
    html += '<div class="popup-links">'
      + '<a href="' + meteo + '" target="_blank" rel="noopener">MeteoSwiss ↗</a>'
      + '</div>';
    if (marker.getPopup()) marker.setPopupContent(html);
    else marker.bindPopup(html, { maxWidth: 280 });
    marker.openPopup();
  }

  /* Build the metadata line shown under the name in the popup. Kept short —
     the popup is a peek; the side panel is the deep-dive. */
  function popupMetaLine(poi) {
    var parts = [];
    parts.push((poi.alt || '—') + ' m');
    if (poi.routes && poi.routes.length > 0) {
      var r = poi.routes[0];
      if (r.gain) parts.push(r.gain + ' m gain');
      if (r.time_up) parts.push('↑ ' + formatTime(r.time_up));
    }
    return parts.join(' · ');
  }

  function openPopup(poi, marker) {
    var dayIdx = store.get('d');
    var wx = wxLookup.get(poi.lat, poi.lon, dayIdx);
    /* If a built hike page matches this POI, surface a direct link in the
       popup so users can jump straight to it without opening the side panel
       first. Reuses matchingHike() so we stay in sync with the panel-hero
       link logic. */
    var hike = matchingHike(poi);

    // Photos only exist for POIs that match a built hike page — HIKES carries
     // the full carousel URL list; SAC_ROUTES does not.
    var photos = hike && hike.photos && hike.photos.length
      ? hike.photos
      : (hike && hike.photo ? [hike.photo] : []);
    var html = window.HikePopup.build({
      name: poi.name,
      grade: bestGrade(poi),
      metaLine: popupMetaLine(poi),
      photos: photos,
      weather: wx ? {
        code: wx.code,
        tempMax: wx.tempMax,
        precip: wx.precip,
        windMax: wx.windMax,
        freezingLevel: wx.freezingLevel,
        date: wx.date,
        peakAlt: poi.alt,
      } : null,
      hikeHref: hike ? '../' + hike.href : null,
      showExpand: true,
    });

    /* Popup rebind pattern is load-bearing — see the FIRST-CLICK REGRESSION
       GUARD comment above bindMarkerTooltips(). Always reuse the existing
       popup via setPopupContent(); only bindPopup() on the first open. */
    if (marker.getPopup()) {
      marker.setPopupContent(html);
    } else {
      marker.bindPopup(html, { maxWidth: 300 });
    }
    marker.openPopup();
  }

  /* ── Map overlay toggles ───────────────────────────── */

  function buildWeatherToggles() {
    var panel = document.getElementById('weather-toggles');
    var s = store.state();
    // `stateKey` ties the toggle to a store state field so we can reflect
    // restored URL state. `webcams` isn't filter state — it uses defaultOn.
    // Tooltip visibility is handled entirely by the filter-bar "Show" pills
    // (display-name-off + meta presence collapse) — no separate Names toggle.
    var toggles = [
      { id: 'hikes',     icon: '🥾', label: 'Hikes',    stateKey: 'h',  defaultOn: true },
      { id: 'huts',      icon: '🏚️', label: 'SAC huts', stateKey: 'u',  defaultOn: true },
      { id: 'haspage',   icon: '⭐', label: 'Has page', stateKey: 'hp', defaultOn: false },
      { id: 'cities',    icon: '🏙️', label: 'Reference cities (sanity-check forecast)', defaultOn: true },
      { id: 'webcams',   icon: '📷', label: 'Webcams', defaultOn: true },
      // Hazard overlays. Avalanche (SLF bulletin + statutory hazard zones) is
      // NOT in this list — it's always on, no toggle (see bootAvalancheLayer()
      // in boot()). Safety-relevant hazard layers must never be hidden by
      // default; this may extend to future "danger segments" layers too.
      { id: 'slope',     icon: '📐', label: 'Slope ≥30° (avalanche-critical)' },
      { id: 'snow',      icon: '❄️', label: 'Snow & glaciers (permanent extent)' },
      // Planning / approach overlays
      { id: 'transit',   icon: '🚌', label: 'Public transport stops (SBB / PostBus)' },
      { id: 'parking',   icon: '🅿️', label: 'Trailhead parking (OSM)' },
      { id: 'water',     icon: '💧', label: 'Drinking water (OSM)' }
    ];

    toggles.forEach(function (t) {
      // Prefer current store state when the toggle maps to a state field;
      // otherwise fall back to defaultOn.
      var on = t.stateKey ? !!s[t.stateKey] : !!t.defaultOn;
      var btn = document.createElement('button');
      btn.className = 'wx-toggle' + (on ? ' active' : '');
      btn.innerHTML = '<span class="icon">' + t.icon + '</span>';
      btn.title = t.label;
      btn.addEventListener('click', function () {
        btn.classList.toggle('active');
        toggleWeatherLayer(t.id, btn.classList.contains('active'));
      });
      panel.appendChild(btn);
    });
  }

  // Reset button — clears the URL hash and reloads. Reloading is the cheapest
  // way to also reset non-store toggles (webcams) and re-render every button
  // in its default-active state.
  function wireResetButton() {
    var btn = document.getElementById('filter-reset');
    if (!btn) return;
    // Show the button whenever the URL hash carries filter state. UrlSync
    // writes to the hash inside store.set, so by the time our subscriber
    // fires the hash is already current.
    function refreshVisibility() {
      btn.hidden = !window.location.hash || window.location.hash === '#';
    }
    refreshVisibility();
    store.subscribe(refreshVisibility);
    btn.addEventListener('click', function () {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      location.reload();
    });
  }

  // Chrome toggle — hides filter groups + the bottom bar via body.chrome-hidden
  // so the map reads clean while active filters keep applying (filter STATE is
  // untouched — store.set is never called here). The back arrow and
  // the toggle itself stay visible so the user can bring the chrome back.
  // Persists across reloads via localStorage.
  var CHROME_HIDDEN_KEY = 'cc.chromeHidden';
  function wireChromeToggle() {
    var btn = document.getElementById('chrome-toggle');
    if (!btn) return;
    function apply(hidden) {
      document.body.classList.toggle('chrome-hidden', hidden);
      btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
      btn.title = hidden
        ? 'Show filter controls'
        : 'Hide filter controls (filters stay applied)';
    }
    var initial = false;
    try { initial = localStorage.getItem(CHROME_HIDDEN_KEY) === '1'; } catch (e) {}
    apply(initial);
    btn.addEventListener('click', function () {
      var hidden = !document.body.classList.contains('chrome-hidden');
      apply(hidden);
      try { localStorage.setItem(CHROME_HIDDEN_KEY, hidden ? '1' : '0'); } catch (e) {}
    });
  }

  var webcamLayer = null;

  // Generic lazy-loaded overlay registry. Each entry has a factory returning
  // Promise<L.Layer>; the layer is cached on first activation and wantedById
  // tracks intent in case the user toggles off before the layer resolves.
  // Slope, snow/glaciers, transit, drinking water, parking — all share this
  // single add/remove machinery. Avalanche is NOT here — it has no toggle (see
  // bootAvalancheLayer()) so it never goes through add/remove.
  var overlayLayers = {};   // id → L.Layer (resolved)
  var overlayWanted = {};   // id → boolean (latest user intent)
  var overlayFactories = {
    slope:     function () { return window.Overlays && window.Overlays.Slope.create(); },
    snow:      function () { return window.Overlays && window.Overlays.SnowGlaciers.create(); },
    transit:   function () { return window.Overlays && window.Overlays.Transit.create(); },
    parking:   function () { return window.Overlays && window.Overlays.Parking.create(); },
    water:     function () { return window.Overlays && window.Overlays.DrinkingWater.create(); }
  };

  // Avalanche hazard layer — always on, no toggle (safety-relevant; may extend
  // to future "danger segments" layers the same way). Auto-created at boot
  // instead of on first toggle click. window.Overlays.Avalanche.create()
  // still lazily loads SlfLayer (which itself lazy-loads slf_cache.js) —
  // only the add-to-map moment moved from click-time to boot-time.
  function bootAvalancheLayer() {
    if (!window.Overlays || !window.Overlays.Avalanche) return;
    window.Overlays.Avalanche.create().then(function (layer) {
      map.addLayer(layer);
    }).catch(function (err) {
      console.warn('Avalanche overlay failed to load:', err);
    });
  }

  function toggleLazyOverlay(id, show) {
    overlayWanted[id] = show;
    if (show) {
      if (overlayLayers[id]) {
        map.addLayer(overlayLayers[id]);
      } else {
        var factory = overlayFactories[id];
        if (!factory) return;
        var p = factory();
        if (!p || !p.then) return;
        p.then(function (layer) {
          overlayLayers[id] = layer;
          if (overlayWanted[id]) map.addLayer(layer);
        }).catch(function (err) {
          console.warn('Overlay "' + id + '" failed to load:', err);
        });
      }
    } else if (overlayLayers[id]) {
      map.removeLayer(overlayLayers[id]);
    }
  }

  function toggleWeatherLayer(id, show) {
    if (id === 'hikes') {
      store.set('h', show);
      return;
    }
    if (id === 'huts') {
      store.set('u', show);
      return;
    }
    if (id === 'haspage') {
      // Off-state is null (no filter), not false — see hasPage state semantics.
      store.set('hp', show ? true : null);
      return;
    }
    if (id === 'cities') {
      if (!cityLayer) return;
      if (show) map.addLayer(cityLayer);
      else map.removeLayer(cityLayer);
      return;
    }
    if (id === 'webcams') {
      if (show) {
        if (!webcamLayer && window.WebcamLayer) webcamLayer = window.WebcamLayer.create();
        if (webcamLayer) map.addLayer(webcamLayer);
      } else if (webcamLayer) {
        map.removeLayer(webcamLayer);
      }
      return;
    }
    if (overlayFactories[id]) {
      toggleLazyOverlay(id, show);
      return;
    }
  }

  /* ── Forecast meta (last-updated) ──────────────────── */

  var MODEL_LABELS = {
    'meteoswiss_icon_ch1': 'MeteoSwiss ICON-CH1',
    'meteoswiss_icon_ch2': 'MeteoSwiss ICON-CH2',
    'ecmwf_ifs025':        'ECMWF IFS',
    'icon_eu':             'ICON-EU'
  };

  // Anything older than this makes the meta strip pulse amber. The GH Actions
  // cron refreshes every 3h, so 6h means we've missed at least one scheduled
  // run — worth screaming about since the day-picker labels are otherwise
  // just dates and give no other cue that the numbers are stale.
  var FORECAST_STALE_HOURS = 6;

  function renderForecastMeta() {
    var el = document.getElementById('forecast-meta');
    if (!el) return;
    var meta = WeatherService.getMeta();
    if (!meta) { el.textContent = ''; el.classList.remove('stale'); return; }
    var modelLabel = MODEL_LABELS[meta.model] || meta.model;
    var updatedMs = meta.updated ? new Date(meta.updated).getTime() : NaN;
    var ageHours = isNaN(updatedMs) ? Infinity : (Date.now() - updatedMs) / 3600000;
    var stale = ageHours > FORECAST_STALE_HOURS;
    var body = '<strong>' + modelLabel + '</strong> · updated ' + WeatherService.relativeTime(meta.updated);
    el.innerHTML = stale ? ('⚠ STALE — ' + body) : body;
    el.classList.toggle('stale', stale);
  }

  /* ── Utilities ─────────────────────────────────────── */

  function formatTime(minutes) {
    if (!minutes) return '—';
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    if (h === 0) return m + 'min';
    if (m === 0) return h + 'h';
    return h + 'h ' + m + 'min';
  }

  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ── Shared filter engine adapter ──────────────────── */

  // SAC POI → matchablePoi (the shape HikeMap.FilterMatcher understands).
  // Flattens routes[] to the hardest route's own grade/gain/time so every
  // bucketed field (tm/el/gn) describes the SAME route, not a mix of maxima
  // across different routes. hasPage reuses the value createMarkers() already
  // computed via matchingHike() (poi.hasPage) rather than recomputing it on
  // every filter pass.
  function toMatchable(poi) {
    var bestRoute = (poi.routes || []).reduce(function (a, b) {
      return (a && parseInt(a.grade[1], 10) > parseInt(b.grade[1], 10)) ? a : b;
    }, null);
    // SAC grades carry an optional +/- modifier ('T4+', 'T3-', ...) that the
    // grade filter buttons don't expose individually (only bare 'T1'..'T6').
    // Strip it for matching so a T4+/T4- route still matches the T4 button —
    // mirrors the old Filters.gradeNum(), which parseInt()'d past the
    // trailing +/- for the same reason. Display elsewhere (popups, tooltips,
    // side panel) still reads poi.grade/route.grade directly and keeps the
    // modifier.
    function stripGradeMod(g) { return g ? g.replace(/[+-]$/, '') : g; }
    return {
      name: poi.name, lat: poi.lat, lon: poi.lon,
      grade: bestRoute ? stripGradeMod(bestRoute.grade) : null,
      alt: poi.alt,
      gain: bestRoute ? bestRoute.gain : null,
      // r.time_up is minutes-to-summit (see formatTime()/popupMetaLine() above,
      // both already read this field — there is no `duration_min` in the SAC
      // data).
      timeH: bestRoute && bestRoute.time_up ? bestRoute.time_up / 60 : null,
      region: null, canton: null, routeType: null,  // CC data doesn't include these — index-only concerns
      hasPage: !!poi.hasPage,
      // SAC POIs carry `type: 'hut'|'summit'|'traverse'` (there is no `kind`
      // field) — only 'hut' is a hut for filtering purposes; everything else
      // (summit, traverse) is a 'hike'.
      poiKind: poi.type === 'hut' ? 'hut' : 'hike',
      raw: poi,
    };
  }

  // Recompute marker._filtered for every marker via the shared matcher, then
  // refresh the destinations/routes counter and the cluster layer. Runs once
  // explicitly at boot (after weather loads) and again on every subsequent
  // store change (wired via boot()'s store.subscribe below) — except pure
  // 'dp' (Display) changes, which are presentation-only and never affect
  // which markers are visible (see the store.subscribe guard in boot()).
  function applyFilters() {
    var state = store.state();
    var visible = 0;
    var totalRoutes = 0;
    allMarkers.forEach(function (m) {
      var poi = m._poi;
      var show = matcher.match(toMatchable(poi), state);
      if (show) {
        visible++;
        totalRoutes += (poi.routes || []).length;
      }
      m._filtered = !show;
    });

    var counterEl = document.getElementById('route-count');
    if (counterEl) {
      counterEl.innerHTML =
        '<span title="Destinations"><span class="bb-icon">📍</span><strong>' + visible + '</strong></span>'
        + ' · '
        + '<span title="Routes"><span class="bb-icon">🥾</span><strong>' + totalRoutes + '</strong></span>';
    }

    refreshCluster();
  }

  /* ── Boot ──────────────────────────────────────────── */

  function boot() {
    var routes = window.SAC_ROUTES || [];
    var loadingText = document.getElementById('loading-text');
    var loadingOverlay = document.getElementById('loading-overlay');

    function status(msg) {
      if (loadingText) loadingText.textContent = msg;
    }

    // Canonical shared filter store + matcher (hike_map/filter_store.js,
    // filter_matcher.js). Defaults merged under the URL-restored state cover
    // the fields the old per-page `state` object used to default (weather day
    // 0, hikes/huts shown, weather-pill display on) — FilterStore itself has
    // no notion of defaults, it only holds what's handed to it.
    store = window.HikeMap.FilterStore({
      keys: ['g', 'tm', 'el', 'gn', 'd', 'sk', 't', 'sn', 'h', 'u', 'hp', 'dp', 'wc'],
      initial: Object.assign({ h: true, u: true, d: 0, dp: ['weather'] }, window.HikeMap.UrlSync.readFromUrl()),
    });
    matcher = window.HikeMap.FilterMatcher.factory({ wxLookup: wxLookup });
    window.HikeMap.UrlSync.bind({ store: store });
    window.HikeMap.UrlSync.mountCrossPageBanner({
      store: store,
      uiKeys: store.keys,
      container: '#hm-cross-page-banner',
    });

    // Recompute visible markers on every store change EXCEPT a pure 'dp'
    // (Display) change — filter_matcher.js never reads 'dp' so it can never
    // change which markers are visible, and re-running the full ~960-marker
    // applyFilters() pass on every display-pill click would be pure waste
    // (Finding 2, Phase F review). Display *does* need its own refresh
    // though: HikeMap.FilterBar's display group (hike_map/filter_bar.js)
    // only calls store.set('dp', ...) — it has no reference to
    // refreshMarkerIcons/refreshMarkerTooltips, so those refreshes (plus the
    // display-name-off body class) happen here instead.
    store.subscribe(function (state, changedKeys) {
      if (changedKeys && changedKeys.length === 1 && changedKeys[0] === 'dp') {
        document.body.classList.toggle('display-name-off', (state.dp || []).indexOf('name') === -1);
        refreshMarkerIcons();
        refreshMarkerTooltips();
        return;
      }
      applyFilters();
    });

    status('Initializing map...');
    initMap();

    status('Creating ' + routes.length + ' route markers...');
    createMarkers(routes);
    createCityMarkers();
    if (cityLayer) map.addLayer(cityLayer);

    buildWeatherToggles();
    wireResetButton();
    wireChromeToggle();
    bootAvalancheLayer();

    // CC passes SAC POIs straight through (dataAdapter: identity) — they're
    // already the { name, lat, lon, alt, id, routes[] } shape the panel
    // expects. matchingHike is the local function above (searches
    // window.HIKES); poi.grade is precomputed by createMarkers() so the
    // panel never needs a bestGrade callback.
    panel = window.HikeMap.SidePanel.mount({
      container: '#side-panel',
      wxLookup: wxLookup,
      dataAdapter: function (poi) { return poi; },
      matchingHike: matchingHike,
      store: store,
    });

    status('Fetching weather forecasts...');
    WeatherService.init(routes, status).then(function () {
      window.HikeMap.FilterBar.mount({
        container: '#cc-filter-bar',
        store: store,
        filters: ['g', 'tm', 'el', 'gn', 'd', 'sk', 't', 'sn', 'h', 'u', 'dp'],
        daySlotId: 'hm-day-slot',
      });
      window.HikeMap.DayPicker.mount({
        container: '#hm-day-slot',
        initial: store.get('d') || 0,
        onChange: function (i) {
          store.set('d', i);
          refreshMarkerIcons();
        },
      });

      refreshMarkerIcons();
      renderForecastMeta();
      applyFilters();

      setTimeout(function () {
        loadingOverlay.classList.add('hidden');
      }, 400);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
