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
  // and gradeClass() in templates/_assets/hike_map/side_panel.js.
  function gradeClass(grade) {
    var m = /[Tt](\d)/.exec(grade || '');
    return m ? 't' + m[1] : 't1';
  }

  /* Build popup HTML. Options:
       name        (string, required)         hike / peak name
       grade       (string)                   SAC grade ('T3', 'T4+', …)
       metaLine    (string)                   pre-formatted meta ('2260 m · 700 m gain · ↑ 3h')
       photos      (array<string>)            list of image URLs; renders a carousel with prev/next arrows
       weather     (object)                   { code, tempMax, precip, windMax, freezingLevel, date, peakAlt }
       hikeHref    (string)                   href for "Open hike page →" link
       showExpand  (bool)                     append "Expand details ▸" button

     If `photos` is provided, call HikePopup.bindCarousel(popupEl) once the
     popup DOM is in the tree so the arrows are wired up.
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

    var photos = (opts.photos || []).filter(function (u) { return !!u; });
    if (photos.length) {
      var first = photos[0];
      var multi = photos.length > 1;
      // Photos are stored in a data-attribute (JSON) so bindCarousel can read
      // them back without a closure — the popup HTML is a string, not a DOM
      // handle, at build time.
      var payload = escAttr(JSON.stringify(photos));
      html += '<div class="popup-carousel" data-photos="' + payload + '" data-idx="0">'
        + '<img class="popup-carousel__img" src="' + escAttr(first) + '" alt="" loading="lazy">';
      if (multi) {
        html += '<button type="button" class="popup-carousel__nav popup-carousel__nav--prev" aria-label="Previous photo">‹</button>'
          + '<button type="button" class="popup-carousel__nav popup-carousel__nav--next" aria-label="Next photo">›</button>'
          + '<span class="popup-carousel__count">1 / ' + photos.length + '</span>';
      }
      html += '</div>';
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
      html += '<a class="popup-open-page" href="' + escAttr(opts.hikeHref) + '" target="_blank" rel="noopener">Open hike page →</a>';
    }

    if (opts.showExpand) {
      html += '<button class="popup-expand" type="button">Expand details ▸</button>';
    }

    return html;
  }

  /* Wire prev/next buttons on any .popup-carousel inside `root`.
     Called once per popup open — safe to re-invoke (idempotent via
     data-carousel-wired). */
  function bindCarousel(root) {
    if (!root) return;
    var els = root.querySelectorAll ? root.querySelectorAll('.popup-carousel') : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.dataset.carouselWired === '1') continue;
      wireOne(el);
      el.dataset.carouselWired = '1';
    }
  }

  function wireOne(el) {
    var photos;
    try { photos = JSON.parse(el.getAttribute('data-photos') || '[]'); }
    catch (_) { photos = []; }
    if (photos.length < 2) return;

    var img = el.querySelector('.popup-carousel__img');
    var counter = el.querySelector('.popup-carousel__count');
    var prev = el.querySelector('.popup-carousel__nav--prev');
    var next = el.querySelector('.popup-carousel__nav--next');

    function show(idx) {
      var n = photos.length;
      idx = ((idx % n) + n) % n;
      el.dataset.idx = String(idx);
      img.src = photos[idx];
      if (counter) counter.textContent = (idx + 1) + ' / ' + n;
    }

    function step(delta) {
      return function (e) {
        e.preventDefault();
        e.stopPropagation();
        var cur = parseInt(el.dataset.idx || '0', 10) || 0;
        show(cur + delta);
      };
    }

    if (prev) prev.addEventListener('click', step(-1));
    if (next) next.addEventListener('click', step(1));
  }

  window.HikePopup = { build: build, gradeClass: gradeClass, bindCarousel: bindCarousel };
})();
