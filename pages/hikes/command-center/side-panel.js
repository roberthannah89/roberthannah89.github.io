/* Side panel — expandable route detail view */
(function () {
  'use strict';

  var panelEl = null;
  var currentPoi = null;

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

  function init(el) {
    panelEl = el;
    if (window.Filters && Filters.subscribe) {
      Filters.subscribe(function () {
        if (isOpen() && currentPoi) render(currentPoi);
      });
    }
  }

  function open(poi) {
    currentPoi = poi;
    render(poi);
    panelEl.classList.add('open');
  }

  function close() {
    panelEl.classList.remove('open');
    currentPoi = null;
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
  // command-center.css merges T1/T2 visually via a comma-selector, so we don't
  // collapse them here.
  function gradeClass(grade) {
    var m = /[Tt](\d)/.exec(grade || '');
    return m ? 't' + m[1] : 't1';
  }

  function matchingHike(poi) {
    // window.HIKES is the auto-generated list of built hike pages from
    // render_hike.py. Match in this order, falling through on miss:
    //   1. SAC route_id on any of the POI's routes (cleanest — IDs are stable)
    //   2. SAC peak_id on the POI's id
    //   3. lat/lon within ~200 m (handles 4-vs-5-decimal rounding)
    //   4. exact name match (case- and umlaut-insensitive)
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

  function render(poi) {
    var grade = Filters.bestGrade(poi);
    var html = '';
    var hike = matchingHike(poi);

    // Hero strip + local-page link — only when this peak has a built page.
    // The hero itself is clickable; we also place a prominent inset button on
    // top of it so the call-to-action is unmissable rather than relying on
    // the user noticing the small caption strip at the bottom.
    if (hike) {
      html += '<a class="panel-hero" href="../' + hike.href + '" '
            + 'style="display:block;position:relative;height:170px;margin:-1rem -1rem 0;'
            + 'background:#222 center/cover no-repeat url(\'' + esc(hike.photo) + '\');'
            + 'border-bottom:2px solid var(--amber);text-decoration:none;cursor:pointer">'
            + '<div style="position:absolute;inset:0;'
            +   'background:linear-gradient(to top,rgba(0,0,0,.6) 0,rgba(0,0,0,.1) 40%,rgba(0,0,0,.4) 100%);"></div>'
            + '<div style="position:absolute;top:10px;right:10px;'
            +   'background:var(--amber,#ffb000);color:#000;font-weight:700;'
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
      html += '<div class="panel-route-name"><a href="' + peakUrl + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px dotted var(--amber)">' + esc(poi.name) + ' <span style="font-size:12px;color:var(--amber);opacity:0.7">↗</span></a></div>';
    } else {
      html += '<div class="panel-route-name">' + esc(poi.name) + '</div>';
    }
    html += '<div class="panel-route-meta">';
    html += '<span class="grade-badge ' + gradeClass(grade) + '">' + grade + '</span> ';
    html += (poi.alt || '—') + ' m';
    html += '</div>';

    if (poi.routes && poi.routes.length > 0) {
      poi.routes.forEach(function (r) {
        var url = sacRouteUrl(poi, r);
        html += '<div class="panel-route-meta" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--flap-border)">';
        if (url) {
          html += '<a href="' + url + '" target="_blank" rel="noopener" style="color:var(--text-primary);text-decoration:none;border-bottom:1px dotted var(--amber)"><strong>' + esc(r.title) + '</strong> <span style="font-size:11px;color:var(--amber);opacity:0.7;margin-left:2px">↗</span></a><br>';
        } else {
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
        html += '<div style="' + topMargin + 'font-size:12px;color:var(--text-secondary);font-family:var(--font-mono);margin-bottom:6px">';
        html += '<span style="color:var(--text-muted);text-transform:uppercase;font-size:9px;letter-spacing:0.8px">' + item.kind + '</span> ';
        html += '<span style="color:var(--text-primary)">' + esc(ep.name) + '</span>' + elev;
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
    var days = WeatherService.getDayChoices();
    if (days.length > 0) {
      html += '<div class="panel-section">';
      html += '<div class="panel-label">Forecast at peak</div>';
      html += '<div class="forecast-row">';
      days.forEach(function (day) {
        var wx = WeatherService.getForPeak(poi.lat, poi.lon, day.index);
        html += '<div class="forecast-day">';
        html += '<div class="day-label">' + day.label + '</div>';
        if (wx) {
          html += '<div class="day-icon">' + WeatherService.weatherIcon(wx.code) + '</div>';
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
      var wxToday = WeatherService.getForPeak(poi.lat, poi.lon, Filters.getState().weatherDay);
      if (wxToday) {
        html += '<div style="margin-top:10px;font-size:11px;color:var(--text-secondary);font-family:var(--font-mono)">';
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
          html += '<div style="margin-top:4px;font-size:11px;color:var(--text-secondary);font-family:var(--font-mono)">';
          html += '❄️ Freezing level: ' + wxToday.freezingLevel + ' m';
          if (delta != null) {
            var sign = delta >= 0 ? '+' : '';
            html += ' <span style="color:' + (aboveSel ? '#cfe3ff' : 'var(--text-muted)') + '">'
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

    panelEl.innerHTML = '<button class="panel-close" onclick="SidePanel.close()" title="Close">&times;</button>' + html;
  }

  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function isOpen() {
    return !!panelEl && panelEl.classList.contains('open');
  }

  window.SidePanel = {
    init: init,
    open: open,
    close: close,
    isOpen: isOpen,
    matchingHike: matchingHike
  };
})();
