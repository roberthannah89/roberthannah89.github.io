// GENERATED FROM ../../templates/_assets/hike_map/side_panel.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

/* Side panel — expandable route/hike detail view. Shared engine between
   Command Center (SAC POI marker clicks) and the index page (hike marker
   clicks).

   window.HikeMap.SidePanel.mount({ container, wxLookup, dataAdapter,
   matchingHike, store }) returns { open(pageNative), close(), refresh(),
   isOpen() }. Each mount() call owns its own closure state (panelEl,
   currentPoi, ...) — no module-level singleton — so CC and index each get an
   independent instance from the same file.

   Adapters (page-owned, NOT engine concerns):
     - dataAdapter(pageNative) → canonical poi shape { name, lat, lon, alt,
       id, routes: [{ id, title, grade, gain, time_up, time_down }] } used to
       render the Route/Forecast sections. CC passes SAC POIs through
       untouched (dataAdapter: identity); index converts a HIKES entry via
       hikeToPoi() (see templates/_assets/index_page.js).
     - matchingHike(pageNative) → the built-hike object (window.HIKES entry)
       used for the hero strip + "Getting There & Back" section, or null.
       CC's version searches window.HIKES (moved here from the old
       module-level matchingHike — now lives in command-center.js since
       createMarkers()/openPopup() also need it outside the panel). Index's
       version is the identity function: every marker on that page already
       IS a built hike, so pageNative itself is the match. */
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};

  // SAC URL slugify — matches sac-cas.ch route portal URL conventions.
  // German umlauts transliterate (ä→ae, ö→oe, ü→ue, ß→ss); other diacritics
  // strip via NFD; non-alphanumerics collapse to single hyphens.
  function slugify(s) {
    if (!s) return '';
    var out = String(s)
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
      .replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return out.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function sacPeakUrl(poi) {
    if (!poi || !poi.name || poi.id == null) return null;
    return 'https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/'
      + slugify(poi.name) + '-' + poi.id + '/mountain-hiking/';
  }

  function sacRouteUrl(poi, route) {
    if (!poi || !poi.name || poi.id == null || !route || !route.title || route.id == null) return null;
    return 'https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/'
      + slugify(poi.name) + '-' + poi.id + '/mountain-hiking/'
      + slugify(route.title) + '-' + route.id + '/';
  }

  function formatTime(minutes) {
    if (!minutes) return '—';
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    if (h === 0) return m + 'min';
    if (m === 0) return h + 'h';
    return h + 'h ' + m + 'min';
  }

  // CSS class for the grade badge — keep in sync with Python `_grade_pill_class`
  // in scripts/render_hike.py. Returns 't1'..'t6' by extracting the digit after T;
  // side_panel.css merges T1/T2 visually via a comma-selector, so we don't
  // collapse them here.
  function gradeClass(grade) {
    var m = /[Tt](\d)/.exec(grade || '');
    return m ? 't' + m[1] : 't1';
  }

  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // Best (hardest) grade across poi.routes[] — used only as a fallback when
  // the poi doesn't already carry a top-level `grade`. CC's createMarkers()
  // precomputes poi.grade via its own domain-specific bestGrade() before
  // ever calling open(), so this branch is never hit on CC. Index's
  // hikeToPoi() adapter emits routes: [{ id, grade }] (0 or 1 entries) with
  // no top-level grade, so this recomputes it from that list.
  function bestGrade(poi) {
    if (poi.grade) return poi.grade;
    var best = 'T1';
    (poi.routes || []).forEach(function (r) {
      if (r.grade && r.grade > best) best = r.grade;
    });
    return best;
  }

  window.HikeMap.SidePanel = {
    mount: function (cfg) {
      cfg = cfg || {};
      var el = typeof cfg.container === 'string' ? document.querySelector(cfg.container) : cfg.container;
      if (!el) return null;

      var wxLookup     = cfg.wxLookup;
      var dataAdapter  = cfg.dataAdapter || function (x) { return x; };
      var matchingHike = cfg.matchingHike || function () { return null; };
      var store        = cfg.store;

      // Shared CSS lives in hike_map/side_panel.css, scoped to this class
      // (not an id) so the same stylesheet serves CC's #side-panel and
      // index's #index-side-panel container divs — same pattern as
      // hike_map/day_picker.js's .hm-day-btn.
      el.classList.add('hm-side-panel');

      var currentPoi = null;
      var currentNative = null;

      function open(pageNative) {
        currentNative = pageNative;
        currentPoi = dataAdapter(pageNative);
        render(currentPoi);
        el.classList.add('open');
      }

      function close() {
        el.classList.remove('open');
        currentPoi = null;
        currentNative = null;
      }

      function isOpen() {
        return el.classList.contains('open');
      }

      function refresh() {
        if (isOpen() && currentPoi) render(currentPoi);
      }

      function render(poi) {
        var grade = bestGrade(poi);
        var html = '';
        var hike = matchingHike(currentNative);

        // Hero strip + local-page link — only when this peak has a built page.
        // The hero itself is clickable; we also place a prominent inset button on
        // top of it so the call-to-action is unmissable rather than relying on
        // the user noticing the small caption strip at the bottom.
        if (hike) {
          html += '<a class="panel-hero" href="../' + hike.href + '" target="_blank" rel="noopener" '
                + 'style="display:block;position:relative;height:170px;margin:-1rem -1rem 0;'
                + 'background:#222 center/cover no-repeat url(\'' + esc(hike.photo) + '\');'
                + 'border-bottom:2px solid var(--panel-accent);text-decoration:none;cursor:pointer">'
                + '<div style="position:absolute;inset:0;'
                +   'background:linear-gradient(to top,rgba(0,0,0,.6) 0,rgba(0,0,0,.1) 40%,rgba(0,0,0,.4) 100%);"></div>'
                + '<div style="position:absolute;top:10px;left:10px;'
                +   'background:var(--panel-accent);color:#000;font-weight:700;'
                +   'padding:6px 12px;border-radius:4px;font-size:13px;letter-spacing:0.4px;'
                +   'box-shadow:0 2px 4px rgba(0,0,0,0.3);">'
                +   'OPEN HIKE PAGE →</div>'
                + '<div style="position:absolute;bottom:10px;left:12px;right:12px;'
                +   'color:#fff;font-size:14px;font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,0.8);'
                +   'display:flex;justify-content:space-between;align-items:end;gap:8px">'
                +   '<span>' + esc(hike.name || poi.name) + '</span>'
                +   '<span style="font-size:11px;font-weight:400;opacity:.85;white-space:nowrap">'
                +     (hike.distance || '') + (hike.gain ? ' · ↑' + hike.gain : '')
                +   '</span>'
                + '</div></a>';
        }

        // Route info
        html += '<div class="panel-section">';
        html += '<div class="panel-label">Route</div>';
        var peakUrl = sacPeakUrl(poi);
        if (peakUrl) {
          html += '<div class="panel-route-name"><a href="' + peakUrl + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px dotted var(--panel-accent)">' + esc(poi.name) + ' <span style="font-size:12px;color:var(--panel-accent);opacity:0.7">↗</span></a></div>';
        } else {
          html += '<div class="panel-route-name">' + esc(poi.name) + '</div>';
        }
        html += '<div class="panel-route-meta">';
        html += '<span class="grade-badge ' + gradeClass(grade) + '">' + grade + '</span> ';
        html += (poi.alt || '—') + ' m';
        html += '</div>';

        // Season window — heuristic from peak altitude + best grade. Labeled
        // (estimated) so users know it's not authoritative SAC data. CC-only:
        // window.Season is loaded by command-center/season.js, not shipped to
        // the index page.
        if (window.Season) {
          var season = window.Season.windowFor(poi);
          var inSeason = window.Season.isInSeason(poi);
          var dotColor = inSeason ? 'var(--panel-accent)' : '#888';
          html += '<div class="panel-route-meta" style="margin-top:4px;font-size:11px;color:var(--panel-fg-dim)" '
               +  'title="Estimated season window — derived from peak altitude and SAC grade. '
               +  'Not authoritative; check the SAC route page for definitive guidance.">';
          html += '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;'
               +  'background:' + dotColor + ';margin-right:6px;vertical-align:middle"></span>';
          html += 'Season: <strong style="color:var(--panel-fg)">' + esc(season.label) + '</strong>';
          html += ' <span style="opacity:0.6">(estimated)</span>';
          html += '</div>';
        }

        if (poi.routes && poi.routes.length > 0) {
          poi.routes.forEach(function (r) {
            var url = sacRouteUrl(poi, r);
            html += '<div class="panel-route-meta" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--panel-border)">';
            if (url) {
              html += '<a href="' + url + '" target="_blank" rel="noopener" style="color:var(--panel-fg);text-decoration:none;border-bottom:1px dotted var(--panel-accent)"><strong>' + esc(r.title) + '</strong> <span style="font-size:11px;color:var(--panel-accent);opacity:0.7;margin-left:2px">↗</span></a><br>';
            } else if (r.title) {
              html += '<strong>' + esc(r.title) + '</strong><br>';
            }
            html += '<span class="grade-badge ' + gradeClass(r.grade) + '" style="font-size:10px">' + (r.grade || '?') + '</span> ';
            if (r.gain) html += r.gain + ' m gain · ';
            html += '↑ ' + formatTime(r.time_up);
            if (r.time_down) html += ' · ↓ ' + formatTime(r.time_down);
            html += '</div>';
          });
        }
        html += '</div>';

        // Getting There & Back — trailhead and end point with travel links.
        // Only rendered when this POI has a matching built hike with a trailhead.
        // End point shown only if distinct from trailhead (otherwise it's a
        // loop/out-and-back and the start row already covers it).
        if (hike && hike.trailhead) {
          var endpoints = [{ kind: 'Start', ep: hike.trailhead }];
          if (hike.end_point && hike.end_point.name && hike.end_point.name !== hike.trailhead.name) {
            endpoints.push({ kind: 'End', ep: hike.end_point });
          }
          // Home/origin for inbound (Start) and outbound (End) journeys. No config
          // plumbing yet — match the page JS default.
          var transitOrigin = 'Zürich HB';
          html += '<div class="panel-section">';
          html += '<div class="panel-label">Getting There &amp; Back</div>';
          endpoints.forEach(function (item, idx) {
            var ep = item.ep;
            var elev = (ep.elev != null) ? ' (' + ep.elev + ' m)' : '';
            // Google Maps: prefer coords (more reliable). Fall back to name string.
            var epPoint = (ep.lat != null && ep.lon != null)
              ? (ep.lat + ',' + ep.lon)
              : encodeURIComponent(ep.name);
            var originParam, destParam, sbbVon, sbbNach;
            if (item.kind === 'Start') {
              // Travelling from home TO the trailhead.
              originParam = encodeURIComponent(transitOrigin);
              destParam = epPoint;
              sbbVon = transitOrigin;
              sbbNach = ep.name;
            } else {
              // Travelling from the end point back home.
              originParam = epPoint;
              destParam = encodeURIComponent(transitOrigin);
              sbbVon = ep.name;
              sbbNach = transitOrigin;
            }
            var gmapsDrive = 'https://www.google.com/maps/dir/?api=1&origin=' + originParam + '&destination=' + destParam + '&travelmode=driving';
            var gmapsTransit = 'https://www.google.com/maps/dir/?api=1&origin=' + originParam + '&destination=' + destParam + '&travelmode=transit';
            // SBB: prefer ep.sbb_url if the pipeline supplies one; otherwise build
            // a query from the correct von/nach pair for this leg.
            var sbbUrl = ep.sbb_url
              ? ep.sbb_url
              : 'https://www.sbb.ch/en?von=' + encodeURIComponent(sbbVon) + '&nach=' + encodeURIComponent(sbbNach);
            var topMargin = idx === 0 ? '' : 'margin-top:10px;';
            html += '<div style="' + topMargin + 'font-size:12px;color:var(--panel-fg-dim);font-family:var(--font-mono);margin-bottom:6px">';
            html += '<span style="color:var(--panel-fg-dim);opacity:.7;text-transform:uppercase;font-size:9px;letter-spacing:0.8px">' + item.kind + '</span> ';
            html += '<span style="color:var(--panel-fg)">' + esc(ep.name) + '</span>' + elev;
            html += '</div>';
            html += '<div class="panel-links">';
            html += '<a class="panel-link" href="' + gmapsDrive + '" target="_blank" rel="noopener">';
            html += '<span class="link-icon">🚗</span> Drive (Google Maps)</a>';
            html += '<a class="panel-link" href="' + gmapsTransit + '" target="_blank" rel="noopener">';
            html += '<span class="link-icon">🚆</span> Transit (Google Maps)</a>';
            html += '<a class="panel-link" href="' + sbbUrl + '" target="_blank" rel="noopener">';
            html += '<span class="link-icon">🇨🇭</span> SBB timetable</a>';
            html += '</div>';
          });
          html += '</div>';
        }

        // Weather forecast
        var days = window.WeatherService ? window.WeatherService.getDayChoices() : [];
        if (days.length > 0) {
          html += '<div class="panel-section">';
          html += '<div class="panel-label">Forecast at peak</div>';
          html += '<div class="forecast-row">';
          days.forEach(function (day) {
            var wx = wxLookup ? wxLookup.get(poi.lat, poi.lon, day.index) : null;
            html += '<div class="forecast-day">';
            html += '<div class="day-label">' + day.label + '</div>';
            if (wx) {
              html += '<div class="day-icon">' + window.WeatherService.weatherIcon(wx.code) + '</div>';
              html += '<div class="day-temp">' + Math.round(wx.tempMax) + '° / ' + Math.round(wx.tempMin) + '°</div>';
              if (wx.precip > 0) {
                html += '<div class="day-precip">' + wx.precip.toFixed(1) + ' mm</div>';
              }
              // Snow line on every card — small and consistent so you can scan
              // across days and watch the freezing level shift. Highlighted in
              // pale blue when the peak is above it (i.e. likely to be in snow).
              if (wx.freezingLevel != null) {
                var above = poi.alt && poi.alt > wx.freezingLevel;
                var cls = 'day-freeze' + (above ? ' day-freeze--above' : '');
                html += '<div class="' + cls + '">❄ ' + wx.freezingLevel + ' m</div>';
              }
            } else {
              html += '<div class="day-icon">—</div>';
              html += '<div class="day-temp">No data</div>';
            }
            html += '</div>';
          });
          html += '</div>';

          // Wind + sunrise/sunset + freezing level for selected day
          var wxToday = wxLookup ? wxLookup.get(poi.lat, poi.lon, store ? store.get('d') : 0) : null;
          if (wxToday) {
            html += '<div style="margin-top:10px;font-size:11px;color:var(--panel-fg-dim);font-family:var(--font-mono)">';
            html += '💨 Max wind: ' + Math.round(wxToday.windMax) + ' km/h';
            if (wxToday.sunrise) {
              var rise = wxToday.sunrise.split('T')[1];
              var set = wxToday.sunset.split('T')[1];
              html += ' · 🌅 ' + rise + ' – ' + set;
            }
            html += '</div>';
            if (wxToday.freezingLevel != null) {
              var aboveSel = poi.alt && poi.alt > wxToday.freezingLevel;
              var delta = poi.alt ? (poi.alt - wxToday.freezingLevel) : null;
              html += '<div style="margin-top:4px;font-size:11px;color:var(--panel-fg-dim);font-family:var(--font-mono)">';
              html += '❄️ Freezing level: ' + wxToday.freezingLevel + ' m';
              if (delta != null) {
                var sign = delta >= 0 ? '+' : '';
                html += ' <span style="color:' + (aboveSel ? '#cfe3ff' : 'inherit') + '">'
                      + '(peak ' + sign + delta + ' m)</span>';
              }
              html += '</div>';
            }
          }
          html += '</div>';
        }

        // Links
        html += '<div class="panel-section">';
        html += '<div class="panel-label">Links</div>';
        html += '<div class="panel-links">';
        html += '<a class="panel-link" href="https://www.meteoblue.com/en/weather/week/' + poi.lat + 'N' + poi.lon + 'E" target="_blank" rel="noopener">';
        html += '<span class="link-icon">⛅</span> Point forecast (meteoblue)</a>';
        html += '<a class="panel-link" href="https://www.windy.com/' + poi.lat.toFixed(3) + '/' + poi.lon.toFixed(3) + '?rain,' + poi.lat.toFixed(3) + ',' + poi.lon.toFixed(3) + ',12" target="_blank" rel="noopener">';
        html += '<span class="link-icon">🌊</span> Open in Windy</a>';
        // Google Maps directions intentionally NOT included here — the per-endpoint
        // links in the "Getting There & Back" block above point at the trailhead
        // (and end point), which is what you actually want to navigate to. Routing
        // to the summit coords from here would be redundant and misleading.
        html += '</div>';
        html += '</div>';

        el.innerHTML = '<button class="panel-close" type="button" title="Close">&times;</button>' + html;
        // No SidePanel singleton to reach for anymore (each mount() owns its
        // own close()) — bind the close button directly rather than an
        // inline onclick="SidePanel.close()" string.
        var closeBtn = el.querySelector('.panel-close');
        if (closeBtn) closeBtn.onclick = close;
      }

      if (store && store.subscribe) {
        store.subscribe(refresh);
      }

      return { open: open, close: close, refresh: refresh, isOpen: isOpen };
    },
  };
})();
