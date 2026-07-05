/* Peak Viewer prototype — app logic.
 *
 * Data:  window.CH_PEAKS  (from ch-peaks.js)
 * Map:   MapLibre GL with swisstopo SWISSIMAGE aerial imagery + Terrarium DEM
 *        for 3D terrain — same stack as 3d-peaks.html. No API key required.
 *
 * Public hook: window.PeakViewer.togglePanel()  — wired to the DOM onclick.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Data + constants
  // ------------------------------------------------------------------
  const PEAKS = Array.isArray(window.CH_PEAKS) ? window.CH_PEAKS : [];

  const MAX_LIST = 500;                 // cap DOM cards rendered
  const HOME_VIEW = {
    center: [8.2, 46.7], zoom: 7, pitch: 55, bearing: 20
  };
  const FLY_DURATION_MS = 2500;

  // ------------------------------------------------------------------
  // Elevation range bounds
  // ------------------------------------------------------------------
  const ELE_MIN = 400;
  const ELE_MAX = (() => {
    let m = 0;
    for (const p of PEAKS) if (typeof p.ele === 'number' && p.ele > m) m = p.ele;
    return Math.ceil(m / 100) * 100;
  })();

  // ------------------------------------------------------------------
  // Filter state
  // ------------------------------------------------------------------
  const state = {
    search: '',
    eleMin: ELE_MIN,
    eleMax: ELE_MAX,
    cantons: new Set(),
    notable: false,
    hikeable: false,
    grades: new Set(),
    sort: 'ele-desc',
    selectedId: null
  };

  // ------------------------------------------------------------------
  // DOM refs
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const dom = {
    layout: $('layout'),
    scene: $('scene'),
    map: $('map'),
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
  };

  // ------------------------------------------------------------------
  // Init UI: counts, canton chips, ranges
  // ------------------------------------------------------------------
  const CANTONS = (function () {
    const m = new Map();
    for (const p of PEAKS) if (p.canton) m.set(p.canton, (m.get(p.canton) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  })();

  function initUi() {
    dom.peakCountTotal.textContent = PEAKS.length.toLocaleString() + ' peaks';
    dom.panelTotal.textContent = PEAKS.length.toLocaleString();
    dom.eleMin.min = dom.eleMax.min = ELE_MIN;
    dom.eleMin.max = dom.eleMax.max = ELE_MAX;
    dom.eleMin.value = ELE_MIN;
    dom.eleMax.value = ELE_MAX;
    dom.eleMinVal.textContent = ELE_MIN;
    dom.eleMaxVal.textContent = ELE_MAX;

    for (const [ak, count] of CANTONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip outline';
      btn.dataset.canton = ak;
      btn.textContent = ak;
      btn.title = ak + ' — ' + count + ' peaks';
      dom.chipCantons.appendChild(btn);
    }
  }

  // ------------------------------------------------------------------
  // Filter / sort
  // ------------------------------------------------------------------
  function norm(s) {
    return (s || '').toLowerCase()
      .normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[äÄ]/g, 'a');
  }

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
      const g = (p.sac.grade || '').replace(/[+-]/g, '');
      if (!state.grades.has(g)) return false;
    }
    return true;
  }

  function sortKey(p) {
    switch (state.sort) {
      case 'name-asc':    return norm(p.name);
      case 'prom-desc':   return -(p.prominence || -1);
      case 'canton-asc':  return p.canton || 'ZZ';
      case 'ele-desc':
      default:            return -(p.ele || -1);
    }
  }

  function applyFilters() {
    const list = PEAKS.filter(matchesFilters);
    list.sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      if (ka < kb) return -1;
      if (ka > kb) return  1;
      return 0;
    });
    return list;
  }

  // ------------------------------------------------------------------
  // Render list (DOM cards)
  // ------------------------------------------------------------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderCard(p) {
    const card = el('div', 'peak-card');
    card.dataset.id = p.id;
    if (p.id === state.selectedId) card.classList.add('selected');

    const info = el('div');
    info.appendChild(el('div', 'name', p.name));
    const meta = el('div', 'meta');
    if (p.canton) meta.appendChild(el('span', null, p.canton));
    if (typeof p.prominence === 'number') {
      if (meta.childNodes.length) meta.appendChild(el('span', 'sep', '·'));
      meta.appendChild(el('span', null, 'Prom ' + p.prominence + ' m'));
    }
    if (p.sac && p.sac.grade) {
      if (meta.childNodes.length) meta.appendChild(el('span', 'sep', '·'));
      const g = el('span', 'grade ' + (p.sac.grade.replace(/[+-]/g, '').toLowerCase()), p.sac.grade);
      meta.appendChild(g);
    }
    if (p.wikipedia) {
      if (meta.childNodes.length) meta.appendChild(el('span', 'sep', '·'));
      meta.appendChild(el('span', 'star', '★'));
    }
    info.appendChild(meta);
    card.appendChild(info);

    const elev = el('div', 'elev');
    if (typeof p.ele === 'number') {
      elev.textContent = Math.round(p.ele).toLocaleString();
      elev.appendChild(el('small', null, 'm'));
    } else {
      elev.classList.add('unknown');
      elev.textContent = '—';
    }
    card.appendChild(elev);

    card.addEventListener('click', () => select(p.id, { fly: true }));
    return card;
  }

  let lastFiltered = [];

  function renderList() {
    const filtered = applyFilters();
    lastFiltered = filtered;

    dom.panelFiltered.textContent = filtered.length.toLocaleString();
    dom.peakCountFiltered.textContent = filtered.length.toLocaleString();
    dom.edgeCount.textContent = filtered.length.toLocaleString();

    dom.cardList.textContent = '';
    if (!filtered.length) {
      const empty = el('div', 'empty-state');
      empty.appendChild(el('strong', null, 'No peaks match.'));
      empty.appendChild(el('div', null, 'Loosen a filter or clear the search.'));
      dom.cardList.appendChild(empty);
    } else {
      const shown = filtered.slice(0, MAX_LIST);
      const frag = document.createDocumentFragment();
      for (const p of shown) frag.appendChild(renderCard(p));
      if (filtered.length > MAX_LIST) {
        const more = el('div', 'loading',
          'Showing top ' + MAX_LIST.toLocaleString() +
          ' of ' + filtered.length.toLocaleString() +
          ' — narrow the filters to see more.');
        frag.appendChild(more);
      }
      dom.cardList.appendChild(frag);
    }

    updatePeakSource(filtered);
    updateHash();
  }

  // ------------------------------------------------------------------
  // Selection
  // ------------------------------------------------------------------
  function findPeak(id) { return PEAKS.find(p => p.id === id) || null; }

  function select(id, opts) {
    opts = opts || {};
    state.selectedId = id;

    for (const card of dom.cardList.querySelectorAll('.peak-card')) {
      card.classList.toggle('selected', card.dataset.id === id);
    }
    const activeCard = dom.cardList.querySelector('.peak-card.selected');
    if (activeCard && opts.scrollIntoView !== false) {
      activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    const p = findPeak(id);
    if (!p) {
      dom.overPeak.hidden = true;
      updateSelectedSource(null);
      updateHash();
      return;
    }

    dom.selName.textContent = p.name;
    dom.selEle.textContent = typeof p.ele === 'number' ? p.ele.toLocaleString() + ' m' : '';

    const bits = [];
    if (p.canton) bits.push('Kanton ' + p.canton);
    if (p.region) bits.push(p.region);
    if (typeof p.prominence === 'number') bits.push('Prom ' + p.prominence + ' m');
    dom.selLoc.textContent = bits.join(' · ');

    if (p.sac) {
      const parts = ['SAC'];
      if (p.sac.grade) parts.push(p.sac.grade);
      if (typeof p.sac.gain === 'number') parts.push(p.sac.gain + ' m gain');
      if (typeof p.sac.time_up === 'number') {
        const h = Math.floor(p.sac.time_up / 60), m = p.sac.time_up % 60;
        parts.push(h + 'h' + (m ? ' ' + m + 'm' : ''));
      }
      dom.selSac.textContent = parts.join(' · ');
      dom.selSac.hidden = false;
    } else {
      dom.selSac.hidden = true;
    }

    if (p.nearest_hut) {
      dom.selHut.textContent = 'Nearest hut: ' + p.nearest_hut.name + ' (' + p.nearest_hut.dist_km + ' km)';
    } else {
      dom.selHut.textContent = '';
    }

    if (p.wikipedia) {
      const parts = p.wikipedia.split(':');
      const lang = parts[0], title = parts.slice(1).join(':');
      dom.selWiki.href = 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
      dom.selWiki.hidden = false;
    } else {
      dom.selWiki.hidden = true;
    }

    dom.overPeak.hidden = false;
    updateSelectedSource(p);
    if (opts.fly !== false) flyTo(p);
    updateHash();
  }

  function deselect() {
    state.selectedId = null;
    for (const card of dom.cardList.querySelectorAll('.peak-card.selected')) {
      card.classList.remove('selected');
    }
    dom.overPeak.hidden = true;
    updateSelectedSource(null);
    updateHash();
  }

  // ------------------------------------------------------------------
  // URL hash sync
  // ------------------------------------------------------------------
  let suppressHashUpdate = false;

  function updateHash() {
    if (suppressHashUpdate) return;
    const parts = [];
    if (state.search) parts.push('q=' + encodeURIComponent(state.search));
    if (state.eleMin > ELE_MIN) parts.push('emin=' + state.eleMin);
    if (state.eleMax < ELE_MAX) parts.push('emax=' + state.eleMax);
    if (state.cantons.size) parts.push('c=' + Array.from(state.cantons).join(','));
    if (state.notable) parts.push('n=1');
    if (state.hikeable) parts.push('h=1');
    if (state.grades.size) parts.push('g=' + Array.from(state.grades).join(','));
    if (state.sort !== 'ele-desc') parts.push('s=' + state.sort);
    if (state.selectedId) parts.push('peak=' + state.selectedId);
    const h = parts.join('&');
    const newHash = h ? '#' + h : '';
    if (newHash !== location.hash) history.replaceState(null, '', newHash || location.pathname);
  }

  function readHash() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return;
    suppressHashUpdate = true;
    for (const kv of raw.split('&')) {
      const [k, v] = kv.split('=');
      if (!k) continue;
      const val = decodeURIComponent(v || '');
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
      }
    }
    dom.searchInput.value = state.search;
    dom.eleMin.value = state.eleMin;
    dom.eleMax.value = state.eleMax;
    dom.eleMinVal.textContent = state.eleMin;
    dom.eleMaxVal.textContent = state.eleMax;
    dom.sortSelect.value = state.sort;
    for (const chip of dom.chipToggles.querySelectorAll('.chip')) {
      const key = chip.dataset.toggle;
      chip.classList.toggle('active', !!state[key]);
    }
    dom.chipGrades.hidden = !state.hikeable;
    for (const chip of dom.chipGrades.querySelectorAll('.chip')) {
      chip.classList.toggle('active', state.grades.has(chip.dataset.grade));
    }
    for (const chip of dom.chipCantons.querySelectorAll('.chip')) {
      chip.classList.toggle('active', state.cantons.has(chip.dataset.canton));
    }
    updateCantonCount();
    suppressHashUpdate = false;
  }

  // ------------------------------------------------------------------
  // Filter UI wiring
  // ------------------------------------------------------------------
  function updateCantonCount() {
    dom.cantonCountLbl.textContent = state.cantons.size ? '(' + state.cantons.size + ')' : '';
  }

  function bindFilterUi() {
    dom.searchInput.addEventListener('input', () => {
      state.search = norm(dom.searchInput.value.trim());
      renderList();
    });

    function updateElevInputs() {
      let lo = +dom.eleMin.value, hi = +dom.eleMax.value;
      if (lo > hi) { [lo, hi] = [hi, lo]; }
      state.eleMin = lo; state.eleMax = hi;
      dom.eleMinVal.textContent = lo;
      dom.eleMaxVal.textContent = hi;
      renderList();
    }
    dom.eleMin.addEventListener('input', updateElevInputs);
    dom.eleMax.addEventListener('input', updateElevInputs);

    dom.chipToggles.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const key = chip.dataset.toggle;
      state[key] = !state[key];
      chip.classList.toggle('active', state[key]);
      if (key === 'hikeable') {
        dom.chipGrades.hidden = !state.hikeable;
        if (!state.hikeable) state.grades.clear();
      }
      renderList();
    });

    dom.chipGrades.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const g = chip.dataset.grade;
      if (state.grades.has(g)) state.grades.delete(g);
      else state.grades.add(g);
      chip.classList.toggle('active', state.grades.has(g));
      renderList();
    });

    dom.chipCantons.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const ak = chip.dataset.canton;
      if (state.cantons.has(ak)) state.cantons.delete(ak);
      else state.cantons.add(ak);
      chip.classList.toggle('active', state.cantons.has(ak));
      updateCantonCount();
      renderList();
    });

    dom.sortSelect.addEventListener('change', () => {
      state.sort = dom.sortSelect.value;
      renderList();
    });

    dom.selDeselect.addEventListener('click', deselect);
    dom.selFly.addEventListener('click', () => {
      const p = findPeak(state.selectedId);
      if (p) flyTo(p);
    });

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
      if (e.key === 'Escape') deselect();
      else if (e.key === '[') togglePanel(true);
      else if (e.key === ']') togglePanel(false);
    });
  }

  // ------------------------------------------------------------------
  // Minimize / expand
  // ------------------------------------------------------------------
  function togglePanel(force) {
    const wantCollapse = (typeof force === 'boolean')
      ? force
      : !dom.layout.classList.contains('collapsed');
    dom.layout.classList.toggle('collapsed', wantCollapse);
    // Resize MapLibre after CSS transition finishes so its canvas fills again.
    setTimeout(() => { if (map) map.resize(); }, 340);
  }
  window.PeakViewer = { togglePanel };

  // ------------------------------------------------------------------
  // MapLibre — map, layers, and interactions
  // ------------------------------------------------------------------
  let map = null;

  // Peak tier used by MapLibre style expressions.
  // 1 = major (visible from country view)
  // 2 = mid  (visible zoomed in a step)
  // 3 = local (only close-in)
  // notable OR high elevation bumps into higher tiers.
  function tierFor(ele, notable) {
    ele = ele || 0;
    if (ele >= 3800 || (notable && ele >= 3300)) return 1;
    if (ele >= 3000 || (notable && ele >= 2000)) return 2;
    return 3;
  }

  function toFeature(p) {
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: {
        id: p.id,
        name: p.name,
        ele: typeof p.ele === 'number' ? Math.round(p.ele) : null,
        tier: tierFor(p.ele, !!p.wikipedia),
        notable: !!p.wikipedia,
        hikeable: !!p.sac,
      }
    };
  }

  function updatePeakSource(filtered) {
    if (!map) return;
    const src = map.getSource('peaks');
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: filtered.map(toFeature)
    });
  }

  function updateSelectedSource(p) {
    if (!map) return;
    const src = map.getSource('selected-peak');
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: p ? [toFeature(p)] : []
    });
  }

  function showBanner(html) {
    dom.banner.hidden = false;
    dom.banner.innerHTML = html;
  }

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
            tileSize: 256, maxzoom: 19,
            attribution: '&copy; swisstopo'
          },
          terrarium: {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            tileSize: 256, maxzoom: 15, encoding: 'terrarium',
            attribution: 'Terrain: Mapzen / AWS Open Data'
          }
        },
        layers: [{ id: 'satellite', type: 'raster', source: 'swissimage' }],
        terrain: { source: 'terrarium', exaggeration: 1.4 },
        sky: {
          'sky-color': '#a8c6de',
          'horizon-color': '#dfe7ed',
          'fog-color': '#dfe7ed',
          'fog-ground-blend': 0.5
        }
      },
      center: HOME_VIEW.center, zoom: HOME_VIEW.zoom,
      pitch: HOME_VIEW.pitch, bearing: HOME_VIEW.bearing,
      maxPitch: 85, hash: false
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      map.addSource('peaks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('selected-peak', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      // Dots — zoom-based visibility per tier so the country view stays clean
      // and detail appears as you zoom in.
      map.addLayer({
        id: 'peaks-dot',
        type: 'circle',
        source: 'peaks',
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'tier'], 1], 5,
            ['==', ['get', 'tier'], 2], 3.6,
            2.4
          ],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#171a1f',
          'circle-stroke-width': 1.4,
          'circle-opacity': [
            'case',
            ['==', ['get', 'tier'], 1], 1,
            ['==', ['get', 'tier'], 2],
              ['interpolate', ['linear'], ['zoom'], 6, 0, 8.5, 1],
            ['interpolate', ['linear'], ['zoom'], 9, 0, 11, 1]
          ],
          'circle-stroke-opacity': [
            'case',
            ['==', ['get', 'tier'], 1], 1,
            ['==', ['get', 'tier'], 2],
              ['interpolate', ['linear'], ['zoom'], 6, 0, 8.5, 1],
            ['interpolate', ['linear'], ['zoom'], 9, 0, 11, 1]
          ]
        }
      });

      // Peak labels — MapLibre's automatic collision detection culls
      // overlapping labels. symbol-sort-key keeps high-elevation peaks
      // visible when there's a conflict.
      map.addLayer({
        id: 'peaks-label',
        type: 'symbol',
        source: 'peaks',
        layout: {
          'text-field': [
            'case',
            ['==', ['get', 'ele'], null], ['get', 'name'],
            ['concat', ['get', 'name'], '  ', ['to-string', ['get', 'ele']], ' m']
          ],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'case',
            ['==', ['get', 'tier'], 1], 13,
            ['==', ['get', 'tier'], 2], 11.5,
            10.5
          ],
          'text-anchor': 'bottom',
          'text-offset': [0, -0.65],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-padding': 3,
          // Higher elevation wins ties (lower sort key = drawn first).
          'symbol-sort-key': ['-', 5000, ['coalesce', ['get', 'ele'], 0]]
        },
        paint: {
          'text-color': '#171a1f',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.6,
          'text-halo-blur': 0.4
        }
      });

      // Selected peak — pulse ring + red dot + big label, always on top.
      map.addLayer({
        id: 'selected-halo',
        type: 'circle',
        source: 'selected-peak',
        paint: {
          'circle-radius': 14,
          'circle-color': '#c0392b',
          'circle-opacity': 0.22
        }
      });
      map.addLayer({
        id: 'selected-dot',
        type: 'circle',
        source: 'selected-peak',
        paint: {
          'circle-radius': 6.5,
          'circle-color': '#c0392b',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2
        }
      });
      map.addLayer({
        id: 'selected-label',
        type: 'symbol',
        source: 'selected-peak',
        layout: {
          'text-field': [
            'case',
            ['==', ['get', 'ele'], null], ['get', 'name'],
            ['concat', ['get', 'name'], '  ', ['to-string', ['get', 'ele']], ' m']
          ],
          'text-font': ['Open Sans Bold'],
          'text-size': 14,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.95],
          'text-allow-overlap': true,
          'text-ignore-placement': true
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#c0392b',
          'text-halo-width': 2.2
        }
      });

      // Click a peak → select it
      map.on('click', 'peaks-dot', (e) => {
        if (!e.features || !e.features.length) return;
        select(e.features[0].properties.id, { fly: true });
      });
      map.on('click', 'peaks-label', (e) => {
        if (!e.features || !e.features.length) return;
        select(e.features[0].properties.id, { fly: true });
      });
      // Cursor over hits
      map.on('mouseenter', 'peaks-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'peaks-dot', () => { map.getCanvas().style.cursor = ''; });

      // Click empty terrain = deselect
      map.on('click', (e) => {
        const feats = map.queryRenderedFeatures(e.point, { layers: ['peaks-dot', 'peaks-label', 'selected-dot'] });
        if (!feats || !feats.length) deselect();
      });

      // Populate with current filter state
      updatePeakSource(lastFiltered);
      if (state.selectedId) {
        const p = findPeak(state.selectedId);
        if (p) { updateSelectedSource(p); flyTo(p); }
      }
    });

    dom.homeBtn.addEventListener('click', flyHome);
  }

  function flyTo(p) {
    if (!map || !map.loaded()) return;
    map.flyTo({
      center: [p.lon, p.lat],
      zoom: 13.5,
      pitch: 70,
      bearing: 20,
      speed: 1.2,
      duration: FLY_DURATION_MS,
      essential: true
    });
  }

  function flyHome() {
    if (!map) return;
    map.flyTo({
      center: HOME_VIEW.center,
      zoom: HOME_VIEW.zoom,
      pitch: HOME_VIEW.pitch,
      bearing: HOME_VIEW.bearing,
      duration: 1800,
      essential: true
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function boot() {
    if (!PEAKS.length) {
      showBanner('No peak data found. Run <code>python3 scripts/build_ch_peaks.py</code> to generate <code>docs/prototypes/peak-viewer/ch-peaks.js</code>.');
      dom.peakCountTotal.textContent = 'No data';
      return;
    }
    if (typeof maplibregl === 'undefined') {
      showBanner('MapLibre GL failed to load. Ad-blocker or network filter is likely blocking <code>unpkg.com</code>.');
      return;
    }
    initUi();
    bindFilterUi();
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
