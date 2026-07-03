// GENERATED FROM ../../templates/_assets/hike_popup.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

/* Shared hike marker popup.

   Renders the small window shown when you click a hike marker on either the
   gallery page (pages/hikes/index.html) or the command-center map. Both pages
   call HikePopup.build(...) so the two popups stay identical.

   Weather block uses window.WeatherService; grade badge and buttons rely on
   the styles in hike_popup.css (loaded alongside this file). */
(function () {
  'use strict';

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;');
  }

  // Keep in sync with the Python `_grade_pill_class` in scripts/render_hike.py
  // and gradeClass() in command-center/side-panel.js.
  function gradeClass(grade) {
    var m = /[Tt](\d)/.exec(grade || '');
    return m ? 't' + m[1] : 't1';
  }

  /* Build popup HTML. Options:
       name        (string, required)         hike / peak name
       grade       (string)                   SAC grade ('T3', 'T4+', …)
       metaLine    (string)                   pre-formatted meta ('2260 m · 700 m gain · ↑ 3h')
       weather     (object)                   { code, tempMax, precip, windMax, freezingLevel, date, peakAlt }
       hikeHref    (string)                   href for "Open hike page →" link
       showExpand  (bool)                     append "Expand details ▸" button
  */
  function build(opts) {
    opts = opts || {};
    var gc = gradeClass(opts.grade);
    var html = '<div class="popup-name">'
      + '<span class="grade-badge ' + gc + '">' + esc(opts.grade || '?') + '</span> '
      + esc(opts.name || '') + '</div>';

    if (opts.metaLine) {
      html += '<div class="popup-meta">' + esc(opts.metaLine) + '</div>';
    }

    var wx = opts.weather;
    var W = window.WeatherService;
    if (wx && W) {
      var dayLabel = W.formatDayLabel ? W.formatDayLabel(wx.date) : '';
      html += '<div class="popup-weather">';
      html += W.weatherIcon(wx.code) + ' ' + esc(dayLabel) + ': ';
      html += esc(W.weatherLabel(wx.code));
      if (wx.tempMax != null) html += ', ' + Math.round(wx.tempMax) + '°C';
      if (wx.precip > 0) html += ', ' + wx.precip.toFixed(1) + 'mm';
      if (wx.windMax != null) html += ', 💨 ' + Math.round(wx.windMax) + ' km/h';
      if (wx.freezingLevel != null) {
        var above = wx.peakAlt && wx.peakAlt > wx.freezingLevel;
        html += '<br>❄️ Snow line: ' + wx.freezingLevel + ' m';
        if (above) html += ' <strong>(peak above)</strong>';
      }
      html += '</div>';
    }

    if (opts.hikeHref) {
      html += '<a class="popup-open-page" href="' + escAttr(opts.hikeHref) + '">Open hike page →</a>';
    }

    if (opts.showExpand) {
      html += '<button class="popup-expand" type="button">Expand details ▸</button>';
    }

    return html;
  }

  window.HikePopup = { build: build, gradeClass: gradeClass };
})();
