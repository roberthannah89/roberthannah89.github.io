/* 3D Swiss Trails prototype — app logic.
 *
 * Merges the peak-viewer database panel (search / elev range / notable /
 * hikeable / T-grade / canton chips / sortable card list / URL-hash state)
 * with the SAC-graded trails overlay fetched from Overpass, on the MapLibre
 * 3D SWISSIMAGE + Terrarium DEM base.
 *
 * Data:  window.CH_PEAKS  (from ch-peaks.js)
 *        window.TRACK     (from routes/zindlenspitz/zindlenspitz.track.js)
 * Trails: fetched on demand from Overpass, cached by z11 tile key.
 */
(function () {
  'use strict';

  // ==========================================================================
  // Config
  // ==========================================================================

  // Trails endpoints — Swiss mirror first (co-located with CH data, ~2–3 s per
  // z11 SAC tile), main instance as fallback.
  var OVERPASS_ENDPOINTS = [
    'https://overpass.osm.ch/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ];
  var CACHE_ZOOM = 11;             // z11 tile grid — 4–8 tiles per view at pitch 60
  var MIN_ZOOM_FOR_TRAILS = 12;    // below this: show hint, skip fetch
  // Cap on tiles we'll fetch for a single view. Raised from 8 so that a
  // fly-to-a-peak view — which frames the peak with pitch 65 and lets the
  // horizon spill wide — still loads trails instead of showing the "zoom in
  // more" hint. Concurrency-2 keeps Overpass happy even at 15 tiles.
  var MAX_TILES_PER_FETCH = 15;
  var DEBOUNCE_MS = 400;
  var MAX_CONCURRENT = 2;          // Overpass 406s on burst-parallel requests
  var RETRY_DELAYS_MS = [1500, 4000];

  // Swiss Wanderland signpost colors (T1 yellow → T6 violet) — matches the
  // paint on the rocks. Kept here as both a MapLibre expression and a
  // JS lookup so the map layer and the legend agree.
  var SAC_COLOR_EXPR = [
    'match', ['get', 'sac'],
    'hiking',                    '#F5C518',
    'mountain_hiking',           '#E4572E',
    'demanding_mountain_hiking', '#B02A1B',
    'alpine_hiking',             '#2E86DE',
    'demanding_alpine_hiking',   '#1B4F8C',
    'difficult_alpine_hiking',   '#7D3C98',
    '#888'
  ];
  var SAC_GRADE_LABEL = {
    hiking: 'T1',
    mountain_hiking: 'T2',
    demanding_mountain_hiking: 'T3',
    alpine_hiking: 'T4',
    demanding_alpine_hiking: 'T5',
    difficult_alpine_hiking: 'T6'
  };

  // The prototype opens framed on the Zindlenspitz route so the existing
  // track + trailhead marker stay meaningful. Home button returns here.
  var TRAILHEAD  = [8.9303, 47.0851];
  var DEFAULT_SUMMIT = [8.95987, 47.07627];
  var DEFAULT_SUMMIT_NAME = 'Zindlenspitz';
  var HOME_VIEW = {
    center: [(TRAILHEAD[0] + DEFAULT_SUMMIT[0]) / 2, (TRAILHEAD[1] + DEFAULT_SUMMIT[1]) / 2],
    zoom: 13.2, pitch: 62, bearing: 35
  };

  // Bounds clamp — at high pitch the visible bbox can spill far outside CH.
  var CH_BBOX = { s: 45.75, w: 5.85, n: 47.85, e: 10.55 };

  // ==========================================================================
  // Peak data + filter state
  // ==========================================================================

  var PEAKS = Array.isArray(window.CH_PEAKS) ? window.CH_PEAKS : [];
  var MAX_LIST = 500;

  var ELE_MIN = 400;
  var ELE_MAX = (function () {
    var m = 0;
    for (var i = 0; i < PEAKS.length; i++) {
      var e = PEAKS[i].ele;
      if (typeof e === 'number' && e > m) m = e;
    }
    return Math.ceil(m / 100) * 100;
  })();

  var state = {
    search: '',
    eleMin: ELE_MIN,
    eleMax: ELE_MAX,
    cantons: new Set(),
    notable: false,
    hikeable: false,
    grades: new Set(),
    sort: 'ele-desc',
    selectedId: null,
    trailsOn: true
  };

  // ==========================================================================
  // DOM refs
  // ==========================================================================

  var $ = function (id) { return document.getElementById(id); };
  var dom = {
    layout: $('layout'),
    banner: $('banner'),
    overStatus: $('over-status'),
    overPeak: $('over-peak'),
    selName: $('sel-name'),
    selEle: $('sel-ele'),
    selLoc: $('sel-loc'),
    selSac: $('sel-sac'),
    selHut: $('sel-hut'),
    selWiki: $('sel-wiki'),
    selFly: $('sel-fly'),
    selTour: $('sel-tour'),
    selDeselect: $('sel-deselect'),
    peakCountTotal: $('peak-count-total'),
    peakCountFiltered: $('peak-count-filtered'),
    panelTotal: $('panel-total'),
    panelFiltered: $('panel-filtered'),
    edgeCount: $('edge-count'),
    searchInput: $('search-input'),
    eleMin: $('elev-min'),
    eleMax: $('elev-max'),
    eleMinVal: $('elev-min-val'),
    eleMaxVal: $('elev-max-val'),
    chipToggles: $('chip-toggles'),
    chipGrades: $('chip-grades'),
    chipCantons: $('chip-cantons'),
    cantonCountLbl: $('canton-count-lbl'),
    sortSelect: $('sort-select'),
    cardList: $('card-list'),
    homeBtn: $('home-btn'),
    trailsBtn: $('trails-btn'),
    trailsCount: $('trails-count'),
    trailsRing: $('trails-ring'),
    peaksBtn: $('peaks-btn'),
    tourBtn: $('tour-btn'),
    hintEl: $('hint'),
    legendEl: $('legend')
  };

  // ==========================================================================
  // Utilities
  // ==========================================================================

  function norm(s) {
    return (s || '').toLowerCase()
      .normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[äÄ]/g, 'a');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function findPeak(id) {
    for (var i = 0; i < PEAKS.length; i++) if (PEAKS[i].id === id) return PEAKS[i];
    return null;
  }

  // ==========================================================================
  // Filters + sort
  // ==========================================================================

  function matchesFilters(p) {
    if (state.search && !norm(p.name).includes(state.search)) return false;
    if (typeof p.ele === 'number') {
      if (p.ele < state.eleMin || p.ele > state.eleMax) return false;
    } else if (state.eleMin > ELE_MIN || state.eleMax < ELE_MAX) {
      return false;
    }
    if (state.cantons.size && !state.cantons.has(p.canton)) return false;
    if (state.notable && !p.wikipedia) return false;
    if (state.hikeable && !p.sac) return false;
    if (state.grades.size) {
      if (!p.sac) return false;
      var g = (p.sac.grade || '').replace(/[+-]/g, '');
      if (!state.grades.has(g)) return false;
    }
    return true;
  }
  function sortKey(p) {
    switch (state.sort) {
      case 'name-asc':   return norm(p.name);
      case 'prom-desc':  return -(p.prominence || -1);
      case 'canton-asc': return p.canton || 'ZZ';
      case 'ele-desc':
      default:           return -(p.ele || -1);
    }
  }
  function applyFilters() {
    var list = PEAKS.filter(matchesFilters);
    list.sort(function (a, b) {
      var ka = sortKey(a), kb = sortKey(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return 0;
    });
    return list;
  }

  // ==========================================================================
  // Card list
  // ==========================================================================

  function renderCard(p) {
    var card = el('div', 'peak-card');
    card.dataset.id = p.id;
    if (p.id === state.selectedId) card.classList.add('selected');

    var info = el('div');
    info.appendChild(el('div', 'name', p.name));
    var meta = el('div', 'meta');
    if (p.canton) meta.appendChild(el('span', null, p.canton));
    if (typeof p.prominence === 'number') {
      if (meta.childNodes.length) meta.appendChild(el('span', 'sep', '·'));
      meta.appendChild(el('span', null, 'Prom ' + p.prominence + ' m'));
    }
    if (p.sac && p.sac.grade) {
      if (meta.childNodes.length) meta.appendChild(el('span', 'sep', '·'));
      meta.appendChild(el('span', 'grade ' + (p.sac.grade.replace(/[+-]/g, '').toLowerCase()), p.sac.grade));
    }
    if (p.wikipedia) {
      if (meta.childNodes.length) meta.appendChild(el('span', 'sep', '·'));
      meta.appendChild(el('span', 'star', '★'));
    }
    info.appendChild(meta);
    card.appendChild(info);

    var elev = el('div', 'elev');
    if (typeof p.ele === 'number') {
      elev.textContent = Math.round(p.ele).toLocaleString();
      elev.appendChild(el('small', null, 'm'));
    } else {
      elev.classList.add('unknown');
      elev.textContent = '—';
    }
    card.appendChild(elev);
    card.addEventListener('click', function () { select(p.id, { fly: true }); });
    return card;
  }

  var lastFiltered = [];
  function renderList() {
    var filtered = applyFilters();
    lastFiltered = filtered;

    dom.panelFiltered.textContent = filtered.length.toLocaleString();
    if (dom.peakCountFiltered) dom.peakCountFiltered.textContent = filtered.length.toLocaleString();
    if (dom.edgeCount) dom.edgeCount.textContent = filtered.length.toLocaleString();

    dom.cardList.textContent = '';
    if (!filtered.length) {
      var empty = el('div', 'empty-state');
      empty.appendChild(el('strong', null, 'No peaks match.'));
      empty.appendChild(el('div', null, 'Loosen a filter or clear the search.'));
      dom.cardList.appendChild(empty);
    } else {
      var shown = filtered.slice(0, MAX_LIST);
      var frag = document.createDocumentFragment();
      for (var i = 0; i < shown.length; i++) frag.appendChild(renderCard(shown[i]));
      if (filtered.length > MAX_LIST) {
        frag.appendChild(el('div', 'loading',
          'Showing top ' + MAX_LIST.toLocaleString() +
          ' of ' + filtered.length.toLocaleString() +
          ' — narrow the filters to see more.'));
      }
      dom.cardList.appendChild(frag);
    }
    updatePeakSource(filtered);
    updateHash();
  }

  // ==========================================================================
  // Selection
  // ==========================================================================

  function select(id, opts) {
    opts = opts || {};
    state.selectedId = id;

    var cards = dom.cardList.querySelectorAll('.peak-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('selected', cards[i].dataset.id === id);
    }
    var activeCard = dom.cardList.querySelector('.peak-card.selected');
    if (activeCard && opts.scrollIntoView !== false) {
      activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    var p = findPeak(id);
    if (!p) {
      dom.overPeak.hidden = true;
      updateSelectedSource(null);
      updateHash();
      return;
    }
    dom.selName.textContent = p.name;
    dom.selEle.textContent = typeof p.ele === 'number' ? p.ele.toLocaleString() + ' m' : '';
    var bits = [];
    if (p.canton) bits.push('Kanton ' + p.canton);
    if (p.region) bits.push(p.region);
    if (typeof p.prominence === 'number') bits.push('Prom ' + p.prominence + ' m');
    dom.selLoc.textContent = bits.join(' · ');

    if (p.sac) {
      var parts = ['SAC'];
      if (p.sac.grade) parts.push(p.sac.grade);
      if (typeof p.sac.gain === 'number') parts.push(p.sac.gain + ' m gain');
      if (typeof p.sac.time_up === 'number') {
        var h = Math.floor(p.sac.time_up / 60), mm = p.sac.time_up % 60;
        parts.push(h + 'h' + (mm ? ' ' + mm + 'm' : ''));
      }
      dom.selSac.textContent = parts.join(' · ');
      dom.selSac.hidden = false;
    } else {
      dom.selSac.hidden = true;
    }
    dom.selHut.textContent = p.nearest_hut
      ? 'Nearest hut: ' + p.nearest_hut.name + ' (' + p.nearest_hut.dist_km + ' km)'
      : '';
    if (p.wikipedia) {
      var parts2 = p.wikipedia.split(':');
      var lang = parts2[0], title = parts2.slice(1).join(':');
      dom.selWiki.href = 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
      dom.selWiki.hidden = false;
    } else {
      dom.selWiki.hidden = true;
    }
    dom.overPeak.hidden = false;
    updateSelectedSource(p);
    if (opts.fly !== false) flyToPeak(p);
    updateHash();
  }

  function deselect() {
    state.selectedId = null;
    var cards = dom.cardList.querySelectorAll('.peak-card.selected');
    for (var i = 0; i < cards.length; i++) cards[i].classList.remove('selected');
    dom.overPeak.hidden = true;
    updateSelectedSource(null);
    updateHash();
  }

  // ==========================================================================
  // URL hash sync
  // ==========================================================================

  var suppressHashUpdate = false;
  function updateHash() {
    if (suppressHashUpdate) return;
    var parts = [];
    if (state.search) parts.push('q=' + encodeURIComponent(state.search));
    if (state.eleMin > ELE_MIN) parts.push('emin=' + state.eleMin);
    if (state.eleMax < ELE_MAX) parts.push('emax=' + state.eleMax);
    if (state.cantons.size) parts.push('c=' + Array.from(state.cantons).join(','));
    if (state.notable) parts.push('n=1');
    if (state.hikeable) parts.push('h=1');
    if (state.grades.size) parts.push('g=' + Array.from(state.grades).join(','));
    if (state.sort !== 'ele-desc') parts.push('s=' + state.sort);
    if (state.selectedId) parts.push('peak=' + state.selectedId);
    if (!state.trailsOn) parts.push('trails=0');
    var h = parts.join('&');
    var newHash = h ? '#' + h : '';
    if (newHash !== location.hash) history.replaceState(null, '', newHash || location.pathname);
  }

  function readHash() {
    var raw = location.hash.replace(/^#/, '');
    if (!raw) return;
    suppressHashUpdate = true;
    var pairs = raw.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split('=');
      var k = kv[0]; if (!k) continue;
      var val = decodeURIComponent(kv[1] || '');
      switch (k) {
        case 'q': state.search = val; break;
        case 'emin': state.eleMin = +val; break;
        case 'emax': state.eleMax = +val; break;
        case 'c': state.cantons = new Set(val.split(',').filter(Boolean)); break;
        case 'n': state.notable = val === '1'; break;
        case 'h': state.hikeable = val === '1'; break;
        case 'g': state.grades = new Set(val.split(',').filter(Boolean)); break;
        case 's': state.sort = val; break;
        case 'peak': state.selectedId = val; break;
        case 'trails': state.trailsOn = val !== '0'; break;
      }
    }
    dom.searchInput.value = state.search;
    dom.eleMin.value = state.eleMin;
    dom.eleMax.value = state.eleMax;
    dom.eleMinVal.textContent = state.eleMin;
    dom.eleMaxVal.textContent = state.eleMax;
    dom.sortSelect.value = state.sort;
    var toggles = dom.chipToggles.querySelectorAll('.chip');
    for (var t = 0; t < toggles.length; t++) {
      var toggleKey = toggles[t].dataset.toggle;
      toggles[t].classList.toggle('active', !!state[toggleKey]);
    }
    dom.chipGrades.hidden = !state.hikeable;
    var gchips = dom.chipGrades.querySelectorAll('.chip');
    for (var g = 0; g < gchips.length; g++) gchips[g].classList.toggle('active', state.grades.has(gchips[g].dataset.grade));
    var cchips = dom.chipCantons.querySelectorAll('.chip');
    for (var c = 0; c < cchips.length; c++) cchips[c].classList.toggle('active', state.cantons.has(cchips[c].dataset.canton));
    updateCantonCount();
    dom.trailsBtn.classList.toggle('off', !state.trailsOn);
    dom.legendEl.classList.toggle('hidden', !state.trailsOn);
    suppressHashUpdate = false;
  }

  function updateCantonCount() {
    dom.cantonCountLbl.textContent = state.cantons.size ? '(' + state.cantons.size + ')' : '';
  }

  // ==========================================================================
  // Filter UI wiring
  // ==========================================================================

  function bindFilterUi() {
    dom.searchInput.addEventListener('input', function () {
      state.search = norm(dom.searchInput.value.trim());
      renderList();
    });
    function updateElevInputs() {
      var lo = +dom.eleMin.value, hi = +dom.eleMax.value;
      if (lo > hi) { var tmp = lo; lo = hi; hi = tmp; }
      state.eleMin = lo; state.eleMax = hi;
      dom.eleMinVal.textContent = lo;
      dom.eleMaxVal.textContent = hi;
      renderList();
    }
    dom.eleMin.addEventListener('input', updateElevInputs);
    dom.eleMax.addEventListener('input', updateElevInputs);
    dom.chipToggles.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      var key = chip.dataset.toggle;
      state[key] = !state[key];
      chip.classList.toggle('active', state[key]);
      if (key === 'hikeable') {
        dom.chipGrades.hidden = !state.hikeable;
        if (!state.hikeable) state.grades.clear();
      }
      renderList();
    });
    dom.chipGrades.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      var g = chip.dataset.grade;
      if (state.grades.has(g)) state.grades.delete(g); else state.grades.add(g);
      chip.classList.toggle('active', state.grades.has(g));
      renderList();
    });
    dom.chipCantons.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      var ak = chip.dataset.canton;
      if (state.cantons.has(ak)) state.cantons.delete(ak); else state.cantons.add(ak);
      chip.classList.toggle('active', state.cantons.has(ak));
      updateCantonCount();
      renderList();
    });
    dom.sortSelect.addEventListener('change', function () {
      state.sort = dom.sortSelect.value;
      renderList();
    });
    dom.selDeselect.addEventListener('click', deselect);
    dom.selFly.addEventListener('click', function () {
      var p = findPeak(state.selectedId);
      if (p) flyToPeak(p);
    });
    dom.selTour.addEventListener('click', function () {
      if (TOUR_STATE !== 'idle') endTour(); else beginTour();
    });
    dom.homeBtn.addEventListener('click', flyHome);
    window.addEventListener('keydown', function (e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
      if (e.key === 'Escape') deselect();
      else if (e.key === '[') togglePanel(true);
      else if (e.key === ']') togglePanel(false);
    });
  }

  // ==========================================================================
  // Panel toggle
  // ==========================================================================

  function togglePanel(force) {
    var wantCollapse = (typeof force === 'boolean') ? force : !dom.layout.classList.contains('collapsed');
    dom.layout.classList.toggle('collapsed', wantCollapse);
    if (dom.peaksBtn) dom.peaksBtn.classList.toggle('active', !wantCollapse);
    setTimeout(function () { if (map) map.resize(); }, 340);
  }
  window.PeakViewer = { togglePanel: togglePanel };
  if (dom.peaksBtn) {
    dom.peaksBtn.addEventListener('click', function () { togglePanel(); });
  }
  window.addEventListener('resize', function () { if (map) map.resize(); });

  function showBanner(html) {
    dom.banner.hidden = false;
    dom.banner.innerHTML = html;
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(function () { dom.banner.hidden = true; }, 8000);
  }

  // ==========================================================================
  // Cantons — initial chips populated from data
  // ==========================================================================

  var CANTONS = (function () {
    var m = new Map();
    for (var i = 0; i < PEAKS.length; i++) {
      var canton = PEAKS[i].canton;
      if (canton) m.set(canton, (m.get(canton) || 0) + 1);
    }
    return Array.from(m.entries()).sort(function (a, b) { return b[1] - a[1]; });
  })();

  function initUi() {
    if (dom.peakCountTotal) dom.peakCountTotal.textContent = PEAKS.length.toLocaleString() + ' peaks';
    dom.panelTotal.textContent = PEAKS.length.toLocaleString();
    dom.eleMin.min = dom.eleMax.min = ELE_MIN;
    dom.eleMin.max = dom.eleMax.max = ELE_MAX;
    dom.eleMin.value = ELE_MIN;
    dom.eleMax.value = ELE_MAX;
    dom.eleMinVal.textContent = ELE_MIN;
    dom.eleMaxVal.textContent = ELE_MAX;
    for (var i = 0; i < CANTONS.length; i++) {
      var ak = CANTONS[i][0], count = CANTONS[i][1];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip outline';
      btn.dataset.canton = ak;
      btn.textContent = ak;
      btn.title = ak + ' — ' + count + ' peaks';
      dom.chipCantons.appendChild(btn);
    }
  }

  // ==========================================================================
  // Peak dot rendering (map source updates)
  // ==========================================================================

  function tierFor(ele, notable) {
    ele = ele || 0;
    if (ele >= 4000 || (notable && ele >= 3500)) return 1;
    if (ele >= 3000 || (notable && ele >= 2500)) return 2;
    return 3;
  }
  function peakToFeature(p) {
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: {
        id: p.id,
        name: p.name,
        ele: typeof p.ele === 'number' ? Math.round(p.ele) : null,
        tier: tierFor(p.ele, !!p.wikipedia),
        notable: !!p.wikipedia
      }
    };
  }
  function updatePeakSource(filtered) {
    if (!map || !mapReady) return;
    var src = map.getSource('peaks');
    if (!src) return;
    src.setData({ type: 'FeatureCollection', features: filtered.map(peakToFeature) });
  }
  function updateSelectedSource(p) {
    if (!map || !mapReady) return;
    var src = map.getSource('selected-peak');
    if (!src) return;
    src.setData({ type: 'FeatureCollection', features: p ? [peakToFeature(p)] : [] });
  }

  // ==========================================================================
  // Trails — Overpass fetch with tile cache + concurrency limit + retry/failover
  // ==========================================================================

  function lng2tile(lng, z) { return Math.floor(((lng + 180) / 360) * Math.pow(2, z)); }
  function lat2tile(lat, z) {
    var rad = lat * Math.PI / 180;
    return Math.floor(
      (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z)
    );
  }
  function tile2lng(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
  function tile2lat(y, z) {
    var n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  function tileBbox(x, y, z) {
    // Overpass wants (south, west, north, east)
    return [tile2lat(y + 1, z), tile2lng(x, z), tile2lat(y, z), tile2lng(x + 1, z)];
  }
  function clampToCH(bounds) {
    return {
      s: Math.max(bounds.getSouth(), CH_BBOX.s),
      w: Math.max(bounds.getWest(),  CH_BBOX.w),
      n: Math.min(bounds.getNorth(), CH_BBOX.n),
      e: Math.min(bounds.getEast(),  CH_BBOX.e)
    };
  }
  function tilesForBounds(bounds, z) {
    var c = clampToCH(bounds);
    if (c.n <= c.s || c.e <= c.w) return [];
    var x0 = lng2tile(c.w, z), x1 = lng2tile(c.e, z);
    var y0 = lat2tile(c.n, z), y1 = lat2tile(c.s, z);
    var tiles = [];
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) tiles.push({ x: x, y: y, z: z });
    return tiles;
  }

  var tileCache = new Map();
  var tileInflight = new Map();
  var fetchGen = 0;

  var running = 0;
  var pending = [];
  function withSlot(runFn) {
    return new Promise(function (resolve, reject) {
      pending.push({ run: runFn, resolve: resolve, reject: reject });
      drain();
    });
  }
  function drain() {
    while (running < MAX_CONCURRENT && pending.length > 0) {
      var job = pending.shift();
      running++;
      Promise.resolve().then(job.run).then(
        function (v) { running--; drain(); job.resolve(v); },
        function (e) { running--; drain(); job.reject(e); }
      );
    }
  }
  function overpassPost(endpoint, query) {
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query)
    }).then(function (res) {
      if (!res.ok) { var err = new Error('Overpass ' + res.status); err.status = res.status; throw err; }
      return res.json();
    });
  }
  function overpassWithRetry(query) {
    var epIdx = 0, retry = 0;
    function tryOnce() {
      var endpoint = OVERPASS_ENDPOINTS[epIdx];
      return overpassPost(endpoint, query).catch(function (err) {
        var retryable = err.status === 429 || err.status === 406 || err.status === 504 || !err.status;
        if (!retryable) throw err;
        if (epIdx < OVERPASS_ENDPOINTS.length - 1) { epIdx++; return tryOnce(); }
        if (retry < RETRY_DELAYS_MS.length) {
          var delay = RETRY_DELAYS_MS[retry++];
          epIdx = 0;
          return new Promise(function (r) { setTimeout(r, delay); }).then(tryOnce);
        }
        throw err;
      });
    }
    return tryOnce();
  }
  function overpassWayToFeature(way) {
    if (!way.geometry || way.geometry.length < 2) return null;
    var coords = way.geometry.map(function (p) { return [p.lon, p.lat]; });
    var tags = way.tags || {};
    return {
      type: 'Feature',
      properties: {
        sac: tags.sac_scale || 'hiking',
        name: tags.name || tags.ref || null,
        id: way.id
      },
      geometry: { type: 'LineString', coordinates: coords }
    };
  }
  function tileKey(t) { return t.z + '/' + t.x + '/' + t.y; }
  function fetchTile(t) {
    var key = tileKey(t);
    if (tileCache.has(key)) return Promise.resolve(tileCache.get(key));
    if (tileInflight.has(key)) return tileInflight.get(key);
    var b = tileBbox(t.x, t.y, t.z);
    var q = '[out:json][timeout:25];way["sac_scale"](' + b[0] + ',' + b[1] + ',' + b[2] + ',' + b[3] + ');out geom;';
    var p = withSlot(function () { return overpassWithRetry(q); })
      .then(function (data) {
        var feats = (data.elements || []).map(overpassWayToFeature).filter(function (f) { return !!f; });
        tileCache.set(key, feats);
        return feats;
      })
      .finally(function () { tileInflight.delete(key); });
    tileInflight.set(key, p);
    return p;
  }

  function showHint(text) { dom.hintEl.textContent = text; dom.hintEl.classList.remove('hidden'); }
  function hideHint() { dom.hintEl.classList.add('hidden'); }
  function setSpinner(on) { dom.trailsRing.classList.toggle('hidden', !on); }
  function updateTrailsSource(features) {
    if (!map || !mapReady) return;
    var src = map.getSource('trails');
    if (src) src.setData({ type: 'FeatureCollection', features: features });
  }

  var debounceTimer = null;
  function scheduleRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refreshTrails, DEBOUNCE_MS);
  }
  function refreshTrails() {
    if (!state.trailsOn || !map || !mapReady) return;
    var z = map.getZoom();
    if (z < MIN_ZOOM_FOR_TRAILS) {
      showHint('Zoom in to load trails');
      updateTrailsSource([]);
      dom.trailsCount.textContent = '—';
      return;
    }
    var tiles = tilesForBounds(map.getBounds(), CACHE_ZOOM);
    if (tiles.length === 0) {
      showHint('Pan into Switzerland');
      updateTrailsSource([]);
      dom.trailsCount.textContent = '—';
      return;
    }
    if (tiles.length > MAX_TILES_PER_FETCH) {
      showHint('Zoom in more to load trails');
      return;
    }
    hideHint();
    var uncached = 0;
    for (var i = 0; i < tiles.length; i++) if (!tileCache.has(tileKey(tiles[i]))) uncached++;
    if (uncached > 0) setSpinner(true);
    var gen = ++fetchGen;
    Promise.all(tiles.map(fetchTile))
      .then(function (arrs) {
        if (gen !== fetchGen) return;
        var features = arrs.reduce(function (acc, a) { return acc.concat(a); }, []);
        updateTrailsSource(features);
        dom.trailsCount.textContent = features.length.toLocaleString();
      })
      .catch(function (err) {
        console.error('[trails]', err);
        if (gen === fetchGen) showHint('Overpass unavailable — retry by panning');
      })
      .finally(function () { if (gen === fetchGen) setSpinner(false); });
  }

  // ==========================================================================
  // Trails toggle
  // ==========================================================================

  function bindTrailsToggle() {
    dom.trailsBtn.addEventListener('click', function () {
      state.trailsOn = !state.trailsOn;
      dom.trailsBtn.classList.toggle('off', !state.trailsOn);
      dom.legendEl.classList.toggle('hidden', !state.trailsOn);
      if (!state.trailsOn) {
        updateTrailsSource([]);
        hideHint();
        dom.trailsCount.textContent = 'off';
        setSpinner(false);
      } else {
        refreshTrails();
      }
      updateHash();
    });
  }

  // ==========================================================================
  // Fly-to + home + summit tour (retargeted to selected peak)
  // ==========================================================================

  function flyToPeak(p) {
    if (!map) return;
    var pad = 0.028; // ~3 km each direction
    var bounds = [[p.lon - pad, p.lat - pad], [p.lon + pad, p.lat + pad]];
    map.fitBounds(bounds, { padding: 60, pitch: 65, bearing: 20, duration: 2500, maxZoom: 13.6, essential: true });
  }
  function flyHome() {
    if (!map) return;
    map.flyTo({
      center: HOME_VIEW.center, zoom: HOME_VIEW.zoom,
      pitch: HOME_VIEW.pitch, bearing: HOME_VIEW.bearing,
      duration: 1800, essential: true
    });
  }

  var FLY_MS = 2200, ROTATE_MS = 25000, RETURN_MS = 2000;
  var TOUR_PITCH = 68, TOUR_ZOOM = 14.2;
  var TOUR_STATE = 'idle';
  var pendingFlyTimeout = null, pendingReturnTimeout = null;
  var rotateRaf = null, rotateStartMs = 0, rotateStartBearing = 0;
  var savedView = null;

  function currentTourTarget() {
    var p = findPeak(state.selectedId);
    if (p) return { center: [p.lon, p.lat], name: p.name };
    return { center: DEFAULT_SUMMIT, name: DEFAULT_SUMMIT_NAME };
  }
  function setTourIcon(isStop) {
    dom.tourBtn.textContent = isStop ? '⏹' : '🎥';
    dom.tourBtn.title = isStop
      ? 'Stop tour'
      : 'Fly to the selected peak and pan 360°';
  }
  function beginTour() {
    if (TOUR_STATE !== 'idle' || !map) return;
    var target = currentTourTarget();
    TOUR_STATE = 'flying';
    setTourIcon(true);
    dom.tourBtn.classList.add('playing');
    savedView = {
      lng: map.getCenter().lng, lat: map.getCenter().lat,
      zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()
    };
    map.easeTo({ center: target.center, zoom: TOUR_ZOOM, pitch: TOUR_PITCH, bearing: 0, duration: FLY_MS });
    pendingFlyTimeout = setTimeout(function () {
      pendingFlyTimeout = null;
      if (TOUR_STATE !== 'flying') return;
      TOUR_STATE = 'rotating';
      rotateStartMs = performance.now();
      rotateStartBearing = map.getBearing();
      rotateRaf = requestAnimationFrame(rotateStep);
    }, FLY_MS);
  }
  function rotateStep(now) {
    if (TOUR_STATE !== 'rotating') return;
    var t = Math.min(1, (now - rotateStartMs) / ROTATE_MS);
    map.setBearing(rotateStartBearing + t * 360);
    if (t < 1) rotateRaf = requestAnimationFrame(rotateStep);
    else       { rotateRaf = null; endTour(); }
  }
  function endTour() {
    if (TOUR_STATE === 'idle' || TOUR_STATE === 'returning') return;
    if (pendingFlyTimeout) { clearTimeout(pendingFlyTimeout); pendingFlyTimeout = null; }
    if (rotateRaf) { cancelAnimationFrame(rotateRaf); rotateRaf = null; }
    TOUR_STATE = 'returning';
    map.easeTo({
      center: [savedView.lng, savedView.lat],
      zoom: savedView.zoom, pitch: savedView.pitch, bearing: savedView.bearing % 360,
      duration: RETURN_MS
    });
    pendingReturnTimeout = setTimeout(function () {
      pendingReturnTimeout = null;
      TOUR_STATE = 'idle';
      setTourIcon(false);
      dom.tourBtn.classList.remove('playing');
    }, RETURN_MS);
  }
  function bindTourButton() {
    dom.tourBtn.addEventListener('click', function () {
      if (TOUR_STATE === 'idle') beginTour(); else endTour();
    });
  }

  // ==========================================================================
  // Map init
  // ==========================================================================

  var map = null;
  var mapReady = false;

  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        sources: {
          swissimage: {
            type: 'raster',
            tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'],
            tileSize: 256, minzoom: 8, maxzoom: 19,
            attribution: '&copy; swisstopo'
          },
          terrarium: {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            tileSize: 256, maxzoom: 15, encoding: 'terrarium',
            attribution: 'Terrain: Mapzen / AWS Open Data'
          }
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#8ba58c' } },
          { id: 'satellite', type: 'raster', source: 'swissimage' }
        ],
        terrain: { source: 'terrarium', exaggeration: 1.5 },
        sky: {
          'sky-color': '#9fc8ec', 'horizon-color': '#dfe7ed',
          'fog-color': '#dfe7ed', 'fog-ground-blend': 0.5
        }
      },
      center: HOME_VIEW.center, zoom: HOME_VIEW.zoom,
      pitch: HOME_VIEW.pitch, bearing: HOME_VIEW.bearing,
      maxPitch: 85, hash: false
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

    map.on('load', function () {
      // --- Trails source + layers (drawn below the peak dots) --------------
      map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'trails-casing', type: 'line', source: 'trails',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0a0a0a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 4.5, 17, 8],
          'line-opacity': 0.55
        }
      });
      map.addLayer({
        id: 'trails-line', type: 'line', source: 'trails',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': SAC_COLOR_EXPR,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 14, 2.6, 17, 4.6],
          'line-opacity': 0.95
        }
      });

      // --- Zindlenspitz track (kept from parent) ---------------------------
      var src = window.TRACK || [];
      if (src.length) {
        var coords = src.map(function (pt) { return [pt[1], pt[0]]; });
        map.addSource('track', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
        });
        map.addLayer({
          id: 'track-casing', type: 'line', source: 'track',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#1a1a1a', 'line-width': 6, 'line-opacity': 0.45 }
        });
        map.addLayer({
          id: 'track-line', type: 'line', source: 'track',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#e74c3c', 'line-width': 3.5 }
        });
      }
      new maplibregl.Marker({ color: '#27ae60' }).setLngLat(TRAILHEAD)
        .setPopup(new maplibregl.Popup().setText('Trailhead')).addTo(map);

      // --- Peaks: hit-target, dot, label, selected halo/dot/label ----------
      map.addSource('peaks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('selected-peak', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      map.addLayer({
        id: 'peaks-hit', type: 'circle', source: 'peaks',
        paint: { 'circle-radius': 12, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 0 }
      });
      // Zoom-gated visibility: <9.5 shows only Tier 1 majors; 9.5–11.5 adds
      // Tier 2; ≥11.5 shows all. Hard step boundaries avoid partial opacity.
      var opacityByZoom = ['step', ['zoom'],
                     ['case', ['==', ['get', 'tier'], 1], 1, 0],
        9.5,  ['case', ['<=', ['get', 'tier'], 2], 1, 0],
        11.5, 1
      ];
      map.addLayer({
        id: 'peaks-dot', type: 'circle', source: 'peaks',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            7, ['case', ['==', ['get', 'tier'], 1], 4, ['==', ['get', 'tier'], 2], 3, 2.4],
            13, ['case', ['==', ['get', 'tier'], 1], 7, ['==', ['get', 'tier'], 2], 6, 5.5]
          ],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#171a1f',
          'circle-stroke-width': 1.6,
          'circle-opacity': opacityByZoom,
          'circle-stroke-opacity': opacityByZoom
        }
      });
      map.addLayer({
        id: 'peaks-label', type: 'symbol', source: 'peaks',
        layout: {
          'text-field': ['case',
            ['==', ['get', 'ele'], null], ['get', 'name'],
            ['concat', ['get', 'name'], '  ', ['to-string', ['get', 'ele']], ' m']
          ],
          'text-font': ['Open Sans Regular'],
          'text-size': ['case', ['==', ['get', 'tier'], 1], 13, ['==', ['get', 'tier'], 2], 11.5, 10.5],
          'text-anchor': 'bottom', 'text-offset': [0, -0.6],
          'text-allow-overlap': false, 'text-ignore-placement': false, 'text-padding': 3,
          'symbol-sort-key': ['-', 5000, ['coalesce', ['get', 'ele'], 0]]
        },
        paint: {
          'text-color': '#1a1a1a', 'text-halo-color': '#ffffff',
          'text-halo-width': 1.8, 'text-halo-blur': 0.4,
          'text-opacity': opacityByZoom
        }
      });
      map.addLayer({
        id: 'selected-halo', type: 'circle', source: 'selected-peak',
        paint: { 'circle-radius': 14, 'circle-color': '#c0392b', 'circle-opacity': 0.22 }
      });
      map.addLayer({
        id: 'selected-dot', type: 'circle', source: 'selected-peak',
        paint: { 'circle-radius': 6.5, 'circle-color': '#c0392b', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }
      });
      map.addLayer({
        id: 'selected-label', type: 'symbol', source: 'selected-peak',
        layout: {
          'text-field': ['case',
            ['==', ['get', 'ele'], null], ['get', 'name'],
            ['concat', ['get', 'name'], '  ', ['to-string', ['get', 'ele']], ' m']
          ],
          'text-font': ['Open Sans Bold'], 'text-size': 14,
          'text-anchor': 'bottom', 'text-offset': [0, -0.95],
          'text-allow-overlap': true, 'text-ignore-placement': true
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#c0392b', 'text-halo-width': 2.2 }
      });

      // --- Interaction wiring ---------------------------------------------
      var PEAK_HIT_LAYERS = ['peaks-hit', 'peaks-dot', 'peaks-label', 'selected-dot', 'selected-label'];
      for (var i = 0; i < PEAK_HIT_LAYERS.length; i++) {
        (function (layer) {
          map.on('click', layer, function (e) {
            if (e.features && e.features[0]) select(e.features[0].properties.id, { fly: true });
          });
          map.on('mouseenter', layer, function () { map.getCanvas().style.cursor = 'pointer'; });
          map.on('mouseleave', layer, function () { map.getCanvas().style.cursor = ''; });
        })(PEAK_HIT_LAYERS[i]);
      }
      map.on('click', 'trails-line', function (e) {
        if (!e.features.length) return;
        var f = e.features[0];
        var sac = f.properties.sac;
        var grade = SAC_GRADE_LABEL[sac] || '?';
        var name = f.properties.name || '(unnamed)';
        var html = '<b>' + name + '</b><br><span style="color:#666">SAC ' + grade + ' · ' + sac + '</span>';
        new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on('mouseenter', 'trails-line', function () { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'trails-line', function () { map.getCanvas().style.cursor = ''; });
      // Empty click = deselect (only if no peak or trail underneath)
      map.on('click', function (e) {
        var feats = map.queryRenderedFeatures(e.point, { layers: PEAK_HIT_LAYERS.concat(['trails-line']) });
        if (!feats || !feats.length) deselect();
      });

      map.on('moveend', scheduleRefresh);
      mapReady = true;

      // Push what we have now to the map sources
      updatePeakSource(lastFiltered);
      if (state.selectedId) {
        var p = findPeak(state.selectedId);
        if (p) { updateSelectedSource(p); }
      }
      refreshTrails();
    });

    // Exposed for browser devtools + automated smoke tests
    window.map = map;
  }

  // ==========================================================================
  // Boot
  // ==========================================================================

  function boot() {
    if (!PEAKS.length) {
      showBanner('No peak data found. Run <code>python3 scripts/build_ch_peaks.py</code> to generate <code>ch-peaks.js</code>.');
      return;
    }
    if (typeof maplibregl === 'undefined') {
      showBanner('MapLibre GL failed to load — check the network.');
      return;
    }
    initUi();
    bindFilterUi();
    bindTrailsToggle();
    bindTourButton();
    readHash();
    renderList();
    initMap();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
