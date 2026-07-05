/* Command Center — main orchestrator */
(function () {
  'use strict';

  var map, clusterGroup;
  var allMarkers = [];
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
      var showWeather = (Filters.getState().display || []).indexOf('weather') !== -1;
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
      dayIndexGetter: function () { return Filters.getState().weatherDay; },
    });
    map.addLayer(clusterGroup);

    // Bind/unbind permanent name labels around LABEL_ZOOM. Markers are
    // created after initMap, so the first real bind happens from
    // createMarkers; this keeps labels in sync on every later zoom.
    map.on('zoomend', updateLabelVisibility);
  }

  /* ── Route markers ─────────────────────────────────── */

  function createMarkers(routes) {
    routes.forEach(function (poi) {
      if (!poi.lat || !poi.lon) return;

      // Precompute the fields markerFactory.makeIcon reads directly off the
      // POI (it doesn't know about Filters or SidePanel):
      //   grade   — best (hardest) grade across routes, drives border colour.
      //   hasPage — amber ★ badge for POIs whose hike has a built page here.
      //             Reuses SidePanel.matchingHike so we don't drift from the
      //             panel's link logic. Filters.matchesHasPage still reads
      //             poi._hasPage, so both names are set.
      poi.grade = Filters.bestGrade(poi);
      var hasPage = !!(window.SidePanel && SidePanel.matchingHike && SidePanel.matchingHike(poi));
      poi._hasPage = hasPage;
      poi.hasPage = hasPage;

      var marker = L.marker([poi.lat, poi.lon], {
        icon: markerFactory.makeIcon(poi, Filters.getState().weatherDay)
      });

      marker._poi = poi;
      marker._filtered = false;

      // Permanent name tooltips are bound lazily by updateLabelVisibility()
      // once the user zooms past LABEL_ZOOM — not here — so the overview
      // doesn't carry ~960 tooltip DOM nodes. The first-click regression
      // guard lives with the bindTooltip call in bindMarkerTooltips().

      marker.on('click', function () {
        if (window.SidePanel && SidePanel.isOpen()) {
          SidePanel.open(poi);
        } else {
          openPopup(poi, marker);
        }
      });

      marker.on('popupopen', function (e) {
        // Once a popup has been bound, Leaflet auto-toggles it on every marker
        // click. When the side panel is already open we want clicks to act as
        // pure panel updates with no popup at all — so suppress the popup the
        // moment it opens. Keep this *and* the click-handler branch above:
        // the click handler also routes directly to SidePanel.open so the
        // panel updates immediately without waiting for the popup-then-close.
        if (window.SidePanel && SidePanel.isOpen()) {
          marker.closePopup();
          return;
        }
        var el = e.popup.getElement();
        if (!el) return;
        var btn = el.querySelector('.popup-expand');
        if (btn) {
          btn.onclick = function () {
            marker.closePopup();
            SidePanel.open(poi);
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
    var dayIdx = Filters.getState().weatherDay;
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
      var g = Filters.bestGrade(poi);
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
    var display = Filters.getState().display || [];
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
    var display = Filters.getState().display || [];
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
    var dayIdx = Filters.getState().weatherDay;
    cityMarkers.forEach(function (m) {
      var c = m._city;
      var wx = wxLookup.get(c.lat, c.lon, dayIdx);
      var emoji = wx ? WeatherService.weatherIcon(wx.code) : null;
      var tempStr = wx && wx.tempMax != null ? Math.round(wx.tempMax) + '°' : '';
      m.setIcon(makeCityIcon(emoji, tempStr));
    });
  }

  function openCityPopup(city, marker) {
    var dayIdx = Filters.getState().weatherDay;
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
    var dayIdx = Filters.getState().weatherDay;
    var wx = wxLookup.get(poi.lat, poi.lon, dayIdx);
    /* If a built hike page matches this POI, surface a direct link in the
       popup so users can jump straight to it without opening the side panel
       first. Reuses SidePanel.matchingHike so we stay in sync with the
       panel-hero link logic. */
    var hike = (window.SidePanel && SidePanel.matchingHike)
      ? SidePanel.matchingHike(poi) : null;

    // Photos only exist for POIs that match a built hike page — HIKES carries
     // the full carousel URL list; SAC_ROUTES does not.
    var photos = hike && hike.photos && hike.photos.length
      ? hike.photos
      : (hike && hike.photo ? [hike.photo] : []);
    var html = window.HikePopup.build({
      name: poi.name,
      grade: Filters.bestGrade(poi),
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

  /* ── Filter bar ────────────────────────────────────── */

  // Swiss trail-marker icon for SAC grade buttons.
  //   T1-2  → solid yellow (Wanderweg)
  //   T3    → white-red-white horizontal stripe (Bergwanderweg)
  //   T4-T6 → white-blue-white horizontal stripe (Alpinwanderweg)
  // The TX grade label is overlaid centered in the colored band.
  function sacGradeIcon(label) {
    var w = 22, h = 22;
    var bg, band, textFill;
    if (label === 'T1-2') {
      bg = '#f2c800'; band = null; textFill = '#1a1810';
    } else if (label === 'T3') {
      bg = '#ffffff'; band = '#d72030'; textFill = '#ffffff';
    } else {
      bg = '#ffffff'; band = '#3388ff'; textFill = '#ffffff';
    }
    // T1-2 is 4 chars so it needs a smaller font than the single-digit labels.
    var fontSize = label.length > 2 ? 6.5 : 9;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" class="grade-icon">';
    svg += '<rect width="' + w + '" height="' + h + '" fill="' + bg + '" rx="2"/>';
    if (band) {
      svg += '<rect y="6" width="' + w + '" height="10" fill="' + band + '"/>';
    }
    svg += '<text x="' + (w/2) + '" y="' + (h/2 + 3) + '" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="' + fontSize + '" font-weight="700" fill="' + textFill + '">' + label + '</text>';
    svg += '</svg>';
    return svg;
  }

  function buildFilterBar() {
    var bar = document.getElementById('filter-bar');

    // Grade — multi-select. Icon-only (SAC trail markers); no label needed.
    // No "Any" button: empty selection means any.
    bar.appendChild(filterGroup('', [
      { label: 'T1-2', icon: sacGradeIcon('T1-2'), key: 'grades', value: ['T1-2'], title: 'SAC T1–T2 · hiking / mountain hiking, well-marked paths' },
      { label: 'T3',   icon: sacGradeIcon('T3'),   key: 'grades', value: ['T3'],   title: 'SAC T3 · demanding mountain hiking, exposed sections, sure-footedness needed' },
      { label: 'T4',   icon: sacGradeIcon('T4'),   key: 'grades', value: ['T4'],   title: 'SAC T4 · alpine hiking, some scrambling and route-finding' },
      { label: 'T5',   icon: sacGradeIcon('T5'),   key: 'grades', value: ['T5'],   title: 'SAC T5 · demanding alpine hiking, exposed scrambling' },
      { label: 'T6',   icon: sacGradeIcon('T6'),   key: 'grades', value: ['T6'],   title: 'SAC T6 · difficult alpine hiking, roped climbing sections' }
    ], true));

    // Duration — single-select; "h" suffix carries the meaning, no label.
    bar.appendChild(filterGroup('', [
      { label: '≤3h',  key: 'duration', value: 'short',  title: 'Duration ≤ 3 h moving time' },
      { label: '3-5h', key: 'duration', value: 'medium', title: 'Duration 3–5 h moving time' },
      { label: '5h+',  key: 'duration', value: 'long',   title: 'Duration 5 h or more moving time' }
    ]));

    // Peak elevation
    bar.appendChild(filterGroup('elev', [
      { label: '≤2000',  key: 'elevation', value: 'low',  title: 'Peak elevation ≤ 2000 m' },
      { label: '2-2.5k', key: 'elevation', value: 'mid',  title: 'Peak elevation 2000–2500 m' },
      { label: '2.5k+',  key: 'elevation', value: 'high', title: 'Peak elevation ≥ 2500 m' }
    ]));

    // Vertical gain
    bar.appendChild(filterGroup('gain', [
      { label: '≤500',   key: 'gain', value: 'easy', title: 'Vertical gain ≤ 500 m' },
      { label: '500-1k', key: 'gain', value: 'mod',  title: 'Vertical gain 500–1000 m' },
      { label: '1-1.5k', key: 'gain', value: 'hard', title: 'Vertical gain 1000–1500 m' },
      { label: '1.5k+',  key: 'gain', value: 'epic', title: 'Vertical gain ≥ 1500 m' }
    ], /* multiSelect */ true));

    // Season — single toggle. Hides routes whose heuristic season window
    // doesn't include the current month (see season.js). Icon-only with a
    // tooltip explaining the heuristic — the data is estimated, not
    // authoritative.
    bar.appendChild(seasonFilterGroup());

    // Display — multi-select pills controlling what shows on each POI.
    // 'weather' = marker pill (vs simple dot); others = tooltip metadata.
    bar.appendChild(displayFilterGroup());
  }

  // Single-button "in season now" toggle. Same click-active-to-clear idiom as
  // the rest of the single-select filters but rendered as one button (no group
  // label, no value pills) because the only meaningful state is on/off.
  function seasonFilterGroup() {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--season';

    var btn = document.createElement('button');
    btn.className = 'filter-btn filter-btn--icon';
    var monthLabel = (window.Season && Season.currentMonthLabel()) || '';
    btn.title = 'In season now (' + monthLabel
              + ') · estimated from altitude + grade';
    btn.innerHTML = '<span class="season-icon">🍂</span>';

    if (Filters.getState().inSeasonNow === true) btn.classList.add('active');

    btn.addEventListener('click', function () {
      var was = btn.classList.contains('active');
      btn.classList.toggle('active');
      Filters.setState('inSeasonNow', was ? null : true);
    });
    group.appendChild(btn);
    return group;
  }

  // Multi-select pills controlling which fields each POI renders. Empty
  // selection = nothing shown. Toggling 'weather' swaps marker style;
  // toggling anything else rebuilds tooltips.
  function displayFilterGroup() {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--display';

    var lbl = document.createElement('span');
    lbl.className = 'filter-label filter-label--icon';
    lbl.title = 'What each marker shows on the map';
    lbl.innerHTML = LABEL_ICONS.show;
    group.appendChild(lbl);

    var options = [
      { key: 'weather', label: '⛅' , title: 'Colour markers by weather (rainy / cloudy / sunny) for the selected day' },
      { key: 'name',    label: 'Name', title: 'Show peak / route name on the marker' },
      { key: 'grade',   label: 'T',    title: 'Show SAC grade (T1–T6) on the marker' },
      { key: 'gain',    label: '↑m',   title: 'Show vertical gain (m) on the marker' },
      { key: 'time',    label: 'h',    title: 'Show estimated moving time (h) on the marker' },
      { key: 'alt',     label: 'alt',  title: 'Show peak altitude (m) on the marker' }
    ];

    var current = (Filters.getState().display || []).slice();
    // Initialise the CSS-driven name visibility from restored state. The
    // name span lives in every tooltip; this class hides it instantly.
    document.body.classList.toggle('display-name-off', current.indexOf('name') === -1);

    options.forEach(function (opt) {
      var active = current.indexOf(opt.key) !== -1;
      var btn = document.createElement('button');
      btn.className = 'filter-btn filter-btn--display' + (active ? ' active' : '');
      btn.title = opt.title;
      btn.setAttribute('data-display', opt.key);
      btn.innerHTML = opt.label;
      btn.addEventListener('click', function () {
        btn.classList.toggle('active');
        var nowActive = btn.classList.contains('active');
        var selected = [];
        group.querySelectorAll('.filter-btn--display.active').forEach(function (b) {
          selected.push(b.getAttribute('data-display'));
        });
        Filters.setState('display', selected);
        if (opt.key === 'name') {
          // Pure CSS toggle — no per-marker work.
          document.body.classList.toggle('display-name-off', !nowActive);
        } else if (opt.key === 'weather') {
          // Only the marker icon depends on this; tooltips unaffected.
          refreshMarkerIcons();
        } else {
          // grade / gain / time / alt — changes the meta line text.
          refreshMarkerTooltips();
        }
      });
      group.appendChild(btn);
    });

    return group;
  }

  function buildWeatherFilters() {
    var bar = document.getElementById('filter-bar');

    // Day picker with summary subtitle
    var days = WeatherService.getDayChoices();
    if (days.length === 0) return;

    // Day filter cell: a plain .filter-group wrapping #hm-day-slot, which the
    // shared HikeMap.DayPicker widget (also used by the index page) mounts
    // its buttons into.
    var dayGroup = document.createElement('div');
    dayGroup.className = 'filter-group filter-group--day';
    var daySlot = document.createElement('div');
    daySlot.id = 'hm-day-slot';
    dayGroup.appendChild(daySlot);
    bar.appendChild(dayGroup);

    window.HikeMap.DayPicker.mount({
      container: '#hm-day-slot',
      initial: Filters.getState().weatherDay,
      onChange: function (i) {
        Filters.setState('weatherDay', i);
        refreshMarkerIcons();
      },
    });

    // Sky condition — multi-select icon buttons
    bar.appendChild(skyFilterGroup());

    // Temperature — single-select; "°" suffix carries the meaning, no label.
    bar.appendChild(filterGroup('', [
      { label: '>0°',  key: 'tempMin', value: 0,  title: 'Forecast max temperature above 0 °C' },
      { label: '>5°',  key: 'tempMin', value: 5,  title: 'Forecast max temperature above 5 °C' },
      { label: '>10°', key: 'tempMin', value: 10, title: 'Forecast max temperature above 10 °C' },
      { label: '>15°', key: 'tempMin', value: 15, title: 'Forecast max temperature above 15 °C' }
    ], false, 'weather'));
  }

  // Threshold icon buttons for sky conditions: clicking a category means
  // "this weather or better". null = any. Clicking the current threshold clears.
  function skyFilterGroup() {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--sky';

    // No "Sky" label — weather emoji buttons are self-explanatory.
    var keys = WeatherService.SKY_CATEGORIES.map(function (c) { return c.key; });

    function refresh() {
      var sel = Filters.getState().sky;
      var threshold = sel ? keys.indexOf(sel) : -1;
      group.querySelectorAll('.filter-btn--sky').forEach(function (b, idx) {
        b.classList.toggle('weather-active', threshold !== -1 && idx <= threshold);
      });
    }

    WeatherService.SKY_CATEGORIES.forEach(function (cat) {
      // Hidden categories (snow, storm) remain in SKY_CATEGORIES so the
      // threshold filter still excludes them, but aren't shown as buttons.
      if (cat.hidden) return;
      var btn = document.createElement('button');
      btn.className = 'filter-btn filter-btn--sky';
      btn.title = cat.label + ' or better';
      btn.setAttribute('data-sky', cat.key);
      btn.innerHTML = '<span class="sky-icon">' + cat.icon + '</span>';
      btn.addEventListener('click', function () {
        var current = Filters.getState().sky;
        Filters.setState('sky', current === cat.key ? null : cat.key);
        refresh();
      });
      group.appendChild(btn);
    });

    refresh();
    return group;
  }

  // Group label glyphs. Emoji for the topographic ones (mountain peak, gain
  // chart) so they read as colored hints; mono SVG for the eye (no good
  // emoji equivalent). The CSS rule .filter-label--icon bumps font-size so
  // emoji render at a visible size against the small label slot.
  var LABEL_ICONS = {
    elev: '🏔️',
    gain: '📈',
    show: '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1 6 Q6 1.5 11 6 Q6 10.5 1 6 Z"/><circle cx="6" cy="6" r="1.6" fill="currentColor"/></svg>'
  };
  var LABEL_TITLES = {
    elev: 'Peak elevation',
    gain: 'Vertical gain',
    show: 'What each marker shows on the map'
  };

  function filterGroup(label, options, multiSelect, style) {
    var group = document.createElement('div');
    group.className = 'filter-group';

    // Label is optional — pass '' (or null/undefined) to render an icon-only
    // group where the buttons are self-evident (e.g. Grade, Time, Sky, Temp).
    // Pass a key from LABEL_ICONS (e.g. 'elev') to render an inline SVG glyph
    // instead of text.
    if (label) {
      var lbl = document.createElement('span');
      lbl.className = 'filter-label';
      if (LABEL_ICONS[label]) {
        lbl.classList.add('filter-label--icon');
        lbl.title = LABEL_TITLES[label] || (label.charAt(0).toUpperCase() + label.slice(1));
        lbl.innerHTML = LABEL_ICONS[label];
      } else {
        lbl.textContent = label;
      }
      group.appendChild(lbl);
    }

    var activeClass = style === 'weather' ? 'weather-active' : 'active';
    var s = Filters.getState();

    // The multi-select state field is the shared `key` across the option list
    // (every option in a multi-select group writes into the same state slot,
    // so we read the first option's key once).
    var multiKey = multiSelect && options.length ? options[0].key : null;
    // Some multi-select groups (grades) carry the bucket label in opt.value[0]
    // instead of opt.value. Detect once.
    function valueOf(opt) {
      return Array.isArray(opt.value) ? opt.value[0] : opt.value;
    }

    // Decide whether a given option should start active based on restored state.
    // - Multi-select: button active iff its value is in state[multiKey].
    // - Single-select: button active iff state[opt.key] equals opt.value.
    function isActive(opt) {
      if (multiSelect) {
        var arr = s[multiKey];
        if (!arr) return false;
        if (typeof arr === 'string') arr = [arr];  // tolerate legacy single-string state from old URLs
        return arr.indexOf(valueOf(opt)) !== -1;
      }
      return s[opt.key] === opt.value;
    }

    options.forEach(function (opt) {
      var btn = document.createElement('button');
      btn.className = 'filter-btn';
      if (opt.icon) {
        btn.innerHTML = opt.icon;
        btn.title = opt.title || opt.label;
        btn.classList.add('filter-btn--icon');
      } else {
        btn.textContent = opt.label;
        if (opt.title) btn.title = opt.title;
      }
      if (isActive(opt)) btn.classList.add(activeClass);

      btn.addEventListener('click', function () {
        if (multiSelect) {
          // Multi-select: toggle this button, then collect all active values
          // and write them to state[multiKey] (e.g. 'grades' or 'gain').
          // Empty selection = any (no Any button needed).
          btn.classList.toggle(activeClass);
          var active = [];
          group.querySelectorAll('.filter-btn').forEach(function (b, i) {
            if (b.classList.contains(activeClass)) {
              active.push(valueOf(options[i]));
            }
          });
          Filters.setState(multiKey, active);
        } else {
          // Single select: clicking the already-active button clears the
          // filter (state = null = any). Otherwise select just this one.
          var wasActive = btn.classList.contains(activeClass);
          group.querySelectorAll('.filter-btn').forEach(function (b) {
            b.classList.remove(activeClass);
          });
          if (wasActive) {
            Filters.setState(opt.key, null);
          } else {
            btn.classList.add(activeClass);
            Filters.setState(opt.key, opt.value);
          }
          // Re-render marker icons when the weather day changes
          if (opt.key === 'weatherDay') refreshMarkerIcons();
        }
      });

      group.appendChild(btn);
    });

    return group;
  }

  /* ── Map overlay toggles ───────────────────────────── */

  function buildWeatherToggles() {
    var panel = document.getElementById('weather-toggles');
    var s = Filters.getState();
    // `stateKey` ties the toggle to a Filters state field so we can reflect
    // restored URL state. `webcams` isn't filter state — it uses defaultOn.
    // Tooltip visibility is handled entirely by the filter-bar "Show" pills
    // (display-name-off + meta presence collapse) — no separate Names toggle.
    var toggles = [
      { id: 'hikes',     icon: '⛰️', label: 'Hikes',    stateKey: 'showHikes', defaultOn: true },
      { id: 'huts',      icon: '🏚️', label: 'SAC huts', stateKey: 'showHuts',  defaultOn: true },
      { id: 'haspage',   icon: '⭐', label: 'Has page', stateKey: 'hasPage',   defaultOn: false },
      { id: 'cities',    icon: '🏙️', label: 'Reference cities (sanity-check forecast)', defaultOn: true },
      { id: 'webcams',   icon: '📷', label: 'Webcams', defaultOn: true },
      // Hazard overlays
      { id: 'avalanche', icon: '⚠️', label: 'Avalanche (SLF bulletin + statutory hazard zones)' },
      { id: 'slope',     icon: '📐', label: 'Slope ≥30° (avalanche-critical)' },
      { id: 'snow',      icon: '❄️', label: 'Snow & glaciers (permanent extent)' },
      // Planning / approach overlays
      { id: 'transit',   icon: '🚌', label: 'Public transport stops (SBB / PostBus)' },
      { id: 'parking',   icon: '🅿️', label: 'Trailhead parking (OSM)' },
      { id: 'water',     icon: '💧', label: 'Drinking water (OSM)' }
    ];

    toggles.forEach(function (t) {
      // Prefer current Filters state when the toggle maps to a state field;
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
  // way to also reset non-Filters toggles (webcams) and re-render every button
  // in its default-active state.
  function wireResetButton() {
    var btn = document.getElementById('filter-reset');
    if (!btn) return;
    // Show the button whenever the URL hash carries filter state. UrlSync
    // writes to the hash inside Filters.setState, so by the time our
    // subscriber fires the hash is already current.
    function refreshVisibility() {
      btn.hidden = !window.location.hash || window.location.hash === '#';
    }
    refreshVisibility();
    if (window.Filters && Filters.subscribe) {
      Filters.subscribe(refreshVisibility);
    }
    btn.addEventListener('click', function () {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      location.reload();
    });
  }

  // Chrome toggle — hides filter groups + the bottom bar via body.chrome-hidden
  // so the map reads clean while active filters keep applying (filter STATE is
  // untouched — Filters.setState is never called here). The back arrow and
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
  // Avalanche, slope, snow/glaciers, transit, drinking water, parking — all
  // share this single add/remove machinery.
  var overlayLayers = {};   // id → L.Layer (resolved)
  var overlayWanted = {};   // id → boolean (latest user intent)
  var overlayFactories = {
    avalanche: function () { return window.Overlays && window.Overlays.Avalanche.create(); },
    slope:     function () { return window.Overlays && window.Overlays.Slope.create(); },
    snow:      function () { return window.Overlays && window.Overlays.SnowGlaciers.create(); },
    transit:   function () { return window.Overlays && window.Overlays.Transit.create(); },
    parking:   function () { return window.Overlays && window.Overlays.Parking.create(); },
    water:     function () { return window.Overlays && window.Overlays.DrinkingWater.create(); }
  };

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
      Filters.setState('showHikes', show);
      return;
    }
    if (id === 'huts') {
      Filters.setState('showHuts', show);
      return;
    }
    if (id === 'haspage') {
      // Off-state is null (no filter), not false — see hasPage state semantics.
      Filters.setState('hasPage', show ? true : null);
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

  function renderForecastMeta() {
    var el = document.getElementById('forecast-meta');
    if (!el) return;
    var meta = WeatherService.getMeta();
    if (!meta) { el.textContent = ''; return; }
    var modelLabel = MODEL_LABELS[meta.model] || meta.model;
    el.innerHTML = '<strong>' + modelLabel + '</strong> · updated ' + WeatherService.relativeTime(meta.updated);
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

  /* ── Boot ──────────────────────────────────────────── */

  function boot() {
    var routes = window.SAC_ROUTES || [];
    var loadingText = document.getElementById('loading-text');
    var loadingOverlay = document.getElementById('loading-overlay');

    function status(msg) {
      if (loadingText) loadingText.textContent = msg;
    }

    status('Initializing map...');
    initMap();

    status('Creating ' + routes.length + ' route markers...');
    Filters.init(allMarkers, document.getElementById('route-count'), refreshCluster);
    // Restore filter state from URL hash BEFORE building the filter UI so the
    // buttons reflect the restored state instead of all showing "Any" active.
    if (window.UrlSync && Filters.loadState) {
      Filters.loadState(window.UrlSync.readFromUrl());
    }
    createMarkers(routes);
    createCityMarkers();
    if (cityLayer) map.addLayer(cityLayer);

    buildFilterBar();
    buildWeatherToggles();
    wireResetButton();
    wireChromeToggle();

    SidePanel.init(document.getElementById('side-panel'));

    status('Fetching weather forecasts...');
    WeatherService.init(routes, status).then(function () {
      buildWeatherFilters();
      refreshMarkerIcons();
      renderForecastMeta();
      Filters.apply();

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
