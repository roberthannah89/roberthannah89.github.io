/* Filter bar — CC-only rendering of the shared filter state as clickable
   pill groups. One renderer per canonical short key; HikeMap.FilterBar.mount
   renders whichever subset a page lists and wires every click straight into
   HikeMap.FilterStore via store.set(key, value) — no page-specific glue.

   Index does NOT mount this module. Its external region/canton/grade/etc.
   buttons are page-owned markup that already writes to the store directly
   (wired in Phase F) — this module only serves CC's compact pill-bar UI.

   Weather-dependent groups (Day / Sky / Temp) render nothing until
   WeatherService has a populated cache (mirrors the old buildWeatherFilters()
   early-return) — CC only calls mount() once the weather cache is loaded, but
   the guard is kept here too so the module is safe to call earlier. */
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};

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

  // Group label glyphs. Emoji for the topographic ones (mountain peak, gain
  // chart) so they read as colored hints; mono SVG for the eye (no good
  // emoji equivalent). CC's .filter-label--icon rule bumps font-size so
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

  // Generic pill-group builder shared by the grade/time/elev/gain/temp
  // groups. Reads/writes state via `store` (HikeMap.FilterStore) instead of
  // the old Filters.getState()/setState() shim.
  function filterGroup(store, label, options, multiSelect, style) {
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
    var s = store.state();

    // The multi-select state field is the shared `key` across the option list
    // (every option in a multi-select group writes into the same state slot,
    // so we read the first option's key once).
    var multiKey = multiSelect && options.length ? options[0].key : null;
    // The T1-2 grade button represents TWO real grade values at once — its
    // opt.value is an array (['T1','T2']) rather than a scalar. The matcher's
    // `inSet` does plain membership checks against poi.grade (a single 'T1'..
    // 'T6' string), so both values must actually land in state[multiKey], not
    // just a literal 'T1-2' placeholder — see valuesOf()/the click handler below.
    function valuesOf(opt) {
      return Array.isArray(opt.value) ? opt.value : [opt.value];
    }

    // Decide whether a given option should start active based on restored state.
    // - Multi-select: button active iff ALL of its values are in state[multiKey].
    // - Single-select: button active iff state[opt.key] equals opt.value.
    function isActive(opt) {
      if (multiSelect) {
        var arr = s[multiKey];
        if (!arr) return false;
        if (typeof arr === 'string') arr = [arr];  // tolerate legacy single-string state from old URLs
        return valuesOf(opt).every(function (v) { return arr.indexOf(v) !== -1; });
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
          // and write them to state[multiKey] (e.g. 'g' or 'gn').
          // Empty selection = any (no Any button needed).
          btn.classList.toggle(activeClass);
          var active = [];
          group.querySelectorAll('.filter-btn').forEach(function (b, i) {
            if (b.classList.contains(activeClass)) {
              active = active.concat(valuesOf(options[i]));
            }
          });
          store.set(multiKey, active);
        } else {
          // Single select: clicking the already-active button clears the
          // filter (state = null = any). Otherwise select just this one.
          var wasActive = btn.classList.contains(activeClass);
          group.querySelectorAll('.filter-btn').forEach(function (b) {
            b.classList.remove(activeClass);
          });
          if (wasActive) {
            store.set(opt.key, null);
          } else {
            btn.classList.add(activeClass);
            store.set(opt.key, opt.value);
          }
        }
      });

      group.appendChild(btn);
    });

    return group;
  }

  // Grade — multi-select. Icon-only (SAC trail markers); no label needed.
  // No "Any" button: empty selection means any.
  function renderGradeGroup(store) {
    return filterGroup(store, '', [
      { label: 'T1-2', icon: sacGradeIcon('T1-2'), key: 'g', value: ['T1', 'T2'], title: 'SAC T1–T2 · hiking / mountain hiking, well-marked paths' },
      { label: 'T3',   icon: sacGradeIcon('T3'),   key: 'g', value: ['T3'],   title: 'SAC T3 · demanding mountain hiking, exposed sections, sure-footedness needed' },
      { label: 'T4',   icon: sacGradeIcon('T4'),   key: 'g', value: ['T4'],   title: 'SAC T4 · alpine hiking, some scrambling and route-finding' },
      { label: 'T5',   icon: sacGradeIcon('T5'),   key: 'g', value: ['T5'],   title: 'SAC T5 · demanding alpine hiking, exposed scrambling' },
      { label: 'T6',   icon: sacGradeIcon('T6'),   key: 'g', value: ['T6'],   title: 'SAC T6 · difficult alpine hiking, roped climbing sections' }
    ], true);
  }

  // Time (moving time, canonical key `tm` — was `duration`) — single-select;
  // "h" suffix carries the meaning, no label.
  function renderTimeGroup(store) {
    return filterGroup(store, '', [
      { label: '≤3h',  key: 'tm', value: 'short', title: 'Duration ≤ 3 h moving time' },
      { label: '3-5h', key: 'tm', value: 'mid',   title: 'Duration 3–5 h moving time' },
      { label: '5h+',  key: 'tm', value: 'long',  title: 'Duration 5 h or more moving time' }
    ]);
  }

  // Peak elevation
  function renderElevGroup(store) {
    return filterGroup(store, 'elev', [
      { label: '≤2000',  key: 'el', value: 'low',  title: 'Peak elevation ≤ 2000 m' },
      { label: '2-2.5k', key: 'el', value: 'mid',  title: 'Peak elevation 2000–2500 m' },
      { label: '2.5k+',  key: 'el', value: 'high', title: 'Peak elevation ≥ 2500 m' }
    ]);
  }

  // Vertical gain
  function renderGainGroup(store) {
    return filterGroup(store, 'gain', [
      { label: '≤500',   key: 'gn', value: 'easy', title: 'Vertical gain ≤ 500 m' },
      { label: '500-1k', key: 'gn', value: 'mod',  title: 'Vertical gain 500–1000 m' },
      { label: '1-1.5k', key: 'gn', value: 'hard', title: 'Vertical gain 1000–1500 m' },
      { label: '1.5k+',  key: 'gn', value: 'epic', title: 'Vertical gain ≥ 1500 m' }
    ], /* multiSelect */ true);
  }

  // Day filter cell: a plain .filter-group wrapping the day-slot div, which
  // the shared HikeMap.DayPicker widget mounts its buttons into (the caller —
  // command-center.js's boot() — does the actual DayPicker.mount call after
  // this cell is in the DOM). Skipped entirely when there's no weather cache,
  // matching the old buildWeatherFilters() early-return.
  function renderDaySlot(_store, cfg) {
    if (!window.WeatherService || !WeatherService.getDayChoices().length) return null;
    var dayGroup = document.createElement('div');
    dayGroup.className = 'filter-group filter-group--day';
    var slot = document.createElement('div');
    slot.id = (cfg && cfg.daySlotId) || 'hm-day-slot';
    dayGroup.appendChild(slot);
    return dayGroup;
  }

  // Threshold icon buttons for sky conditions: clicking a category means
  // "this weather or better". null = any. Clicking the current threshold clears.
  function renderSkyGroup(store) {
    if (!window.WeatherService || !WeatherService.getDayChoices().length) return null;
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--sky';

    // No "Sky" label — weather emoji buttons are self-explanatory.
    var keys = WeatherService.SKY_CATEGORIES.map(function (c) { return c.key; });

    function refresh() {
      var sel = store.get('sk');
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
        var current = store.get('sk');
        store.set('sk', current === cat.key ? null : cat.key);
        refresh();
      });
      group.appendChild(btn);
    });

    refresh();
    return group;
  }

  // Temperature (canonical key `t` — was `tempMin`) — single-select; "°"
  // suffix carries the meaning, no label.
  function renderTempGroup(store) {
    if (!window.WeatherService || !WeatherService.getDayChoices().length) return null;
    return filterGroup(store, '', [
      { label: '>0°',  key: 't', value: 0,  title: 'Forecast max temperature above 0 °C' },
      { label: '>5°',  key: 't', value: 5,  title: 'Forecast max temperature above 5 °C' },
      { label: '>10°', key: 't', value: 10, title: 'Forecast max temperature above 10 °C' },
      { label: '>15°', key: 't', value: 15, title: 'Forecast max temperature above 15 °C' }
    ], false, 'weather');
  }

  // Single-button "in season now" toggle. Same click-active-to-clear idiom as
  // the rest of the single-select filters but rendered as one button (no group
  // label, no value pills) because the only meaningful state is on/off.
  function renderSeasonToggle(store) {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--season';

    var btn = document.createElement('button');
    btn.className = 'filter-btn filter-btn--icon';
    var monthLabel = (window.Season && Season.currentMonthLabel()) || '';
    btn.title = 'In season now (' + monthLabel
              + ') · estimated from altitude + grade';
    btn.innerHTML = '<span class="season-icon">🍂</span>';

    if (store.get('sn') === true) btn.classList.add('active');

    btn.addEventListener('click', function () {
      var was = btn.classList.contains('active');
      btn.classList.toggle('active');
      store.set('sn', was ? null : true);
    });
    group.appendChild(btn);
    return group;
  }

  // Multi-select pills controlling which fields each POI renders. Empty
  // selection = nothing shown. Only writes store.set('dp', [...]) — it does
  // NOT call marker-icon/tooltip refresh directly (this module has no
  // reference to CC's marker functions). The caller reacts to 'dp' changes
  // via store.subscribe (command-center.js's boot()), which is also where
  // the "no full visibility recompute for dp-only changes" guard lives.
  function renderDisplayGroup(store) {
    var group = document.createElement('div');
    group.className = 'filter-group filter-group--display';

    var lbl = document.createElement('span');
    lbl.className = 'filter-label filter-label--icon';
    lbl.title = LABEL_TITLES.show;
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

    var current = (store.get('dp') || []).slice();
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
        var selected = [];
        group.querySelectorAll('.filter-btn--display.active').forEach(function (b) {
          selected.push(b.getAttribute('data-display'));
        });
        store.set('dp', selected);
      });
      group.appendChild(btn);
    });

    return group;
  }

  // Per-key renderer registry. Each entry knows how to render one filter
  // group; `filters` (passed to mount()) is a subset of these canonical short
  // keys. `h`/`u` (Hikes/Huts) are intentionally absent — CC renders those as
  // toggle buttons in its separate #weather-toggles panel, not in this bar.
  var RENDERERS = {
    g:  renderGradeGroup,
    tm: renderTimeGroup,
    el: renderElevGroup,
    gn: renderGainGroup,
    d:  renderDaySlot,
    sk: renderSkyGroup,
    t:  renderTempGroup,
    sn: renderSeasonToggle,
    dp: renderDisplayGroup,
  };

  window.HikeMap.FilterBar = {
    mount: function (cfg) {
      cfg = cfg || {};
      var container = typeof cfg.container === 'string' ? document.querySelector(cfg.container) : cfg.container;
      if (!container) return null;
      var store = cfg.store;
      container.innerHTML = '';
      (cfg.filters || []).forEach(function (k) {
        var render = RENDERERS[k];
        if (!render) return;
        var el = render(store, cfg);
        if (el) container.appendChild(el);
      });
      return { destroy: function () { container.innerHTML = ''; } };
    },
  };
})();
