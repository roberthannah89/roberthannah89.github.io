// GENERATED FROM ../../templates/_assets/hike_map/day_picker.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

/* Day picker. Renders one <button class="hm-day-btn"> per day returned by
   WeatherService.getDayChoices(). Both pages mount into different containers;
   the widget is identical. */
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};

  window.HikeMap.DayPicker = {
    mount: function (opts) {
      opts = opts || {};
      var el       = typeof opts.container === 'string' ? document.querySelector(opts.container) : opts.container;
      var initial  = opts.initial != null ? opts.initial : 0;
      var onChange = opts.onChange || function () {};

      if (!el) return null;
      var WS = window.WeatherService;
      el.innerHTML = '';
      if (!WS) {
        var msg = document.createElement('button');
        msg.className = 'hm-day-btn';
        msg.disabled = true;
        msg.style.opacity = '.5';
        msg.textContent = 'No forecast — run `make weather`';
        el.appendChild(msg);
        return { setActive: function () {}, destroy: function () { el.innerHTML = ''; } };
      }
      var choices = WS.getDayChoices();
      if (!choices.length) {
        var none = document.createElement('button');
        none.className = 'hm-day-btn';
        none.disabled = true;
        none.style.opacity = '.5';
        none.textContent = 'No forecast available';
        el.appendChild(none);
        return { setActive: function () {}, destroy: function () { el.innerHTML = ''; } };
      }
      var active = initial;
      var buttons = choices.map(function (c, i) {
        var btn = document.createElement('button');
        btn.className = 'hm-day-btn' + (i === active ? ' active' : '');
        btn.textContent = c.label;
        btn.onclick = function () { setActive(i); onChange(i); };
        el.appendChild(btn);
        return btn;
      });
      function setActive(i) {
        active = i;
        buttons.forEach(function (b, j) { b.classList.toggle('active', j === i); });
      }
      return { setActive: setActive, destroy: function () { el.innerHTML = ''; } };
    },
  };
})();
