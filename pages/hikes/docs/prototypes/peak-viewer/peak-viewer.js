/* Peak Viewer prototype — app logic.
 *
 * Data:    window.CH_PEAKS  (from ch-peaks.js)
 * 3D:      Cesium 1.122 with Google Photorealistic 3D Tiles when a key is set
 *          (window.HIKING_CONFIG.googleMapsApiKey), Cesium World Terrain + Bing
 *          otherwise. Falls back gracefully so the page opens without setup.
 *
 * Publicly-exposed hook (only): window.PeakViewer.togglePanel()  -- wired to
 * the DOM onclick attributes.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Data + constants
  // ------------------------------------------------------------------
  const PEAKS = Array.isArray(window.CH_PEAKS) ? window.CH_PEAKS : [];

  const MAX_LIST = 500;                // cap DOM cards rendered
  const MAX_MARKERS = 4500;            // cap Cesium entities (dots)
  const HOME_VIEW = {
    lon: 7.9, lat: 47.4, height: 260000,
    heading: 155, pitch: -42
  };
  const FLY_OFFSET_KM = 2;
  const FLY_ABOVE_M   = 800;
  const FLY_PITCH_DEG = -25;
  const FLY_DURATION_S = 2.5;

  // Per-peak label visibility distance. Bigger + notable peaks stay labelled
  // from farther away, so the on-screen label density stays roughly constant
  // as you zoom. Camera-to-peak distance in metres.
  function labelRangeM(p) {
    const ele = p.ele || 0;
    const notable = !!p.wikipedia;
    // Country-wide view (camera ~260 km up): only the biggest peaks show.
    if (ele >= 4300 || (notable && ele >= 4000)) return 500000;
    if (ele >= 3700)                              return 140000;
    if (ele >= 3000 || (notable && ele >= 2500)) return  45000;
    if (ele >= 2500)                              return  15000;
    if (ele >= 2000 || notable)                   return   7000;
    if (ele >= 1500)                              return   3500;
    return                                                1800;
  }

  // Quality tiers — mirrored from 3d-photorealistic.html
  const QUALITY_STORAGE = 'proto:peak-viewer-quality';
  const QUALITY_LABELS = { eco: '🐢 Eco', fast: '⚡ Fast', sharp: '🎨 Sharp' };
  const QUALITY_TITLES = {
    eco:   'Eco: no HiDPI render, sparse tiles. Click for Fast.',
    fast:  'Fast: ~4K render cap, balanced tiles. Click for Sharp.',
    sharp: 'Sharp: full HiDPI, dense tiles. Click for Eco.'
  };
  const QUALITY_ORDER = ['eco', 'fast', 'sharp'];
  let currentQuality = (function () {
    try { return localStorage.getItem(QUALITY_STORAGE) || 'fast'; } catch (e) { return 'fast'; }
  })();

  // Grade order used for the "hikeable" filter chips.
  const GRADES = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];

  // Elevation range bounds computed from data
  const ELE_MIN = 400;
  const ELE_MAX = (() => {
    let m = 0;
    for (const p of PEAKS) if (typeof p.ele === 'number' && p.ele > m) m = p.ele;
    return Math.ceil(m / 100) * 100;
  })();

  // Filter state (URL hash synced)
  const state = {
    search: '',
    eleMin: ELE_MIN,
    eleMax: ELE_MAX,
    cantons: new Set(),      // empty = all
    notable: false,
    hikeable: false,
    grades: new Set(),       // empty = all grades (subject to hikeable)
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
    compass: $('compass'),
    compassArrow: $('compass-arrow'),
    homeBtn: $('home-btn'),
    qualityBtn: $('quality-btn'),
  };

  // ------------------------------------------------------------------
  // Init: counts, canton chips, ranges
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
  // Filter / sort / selection
  // ------------------------------------------------------------------
  function norm(s) {
    return (s || '').toLowerCase()
      .normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[äÄ]/g, 'a');
  }

  function matchesFilters(p) {
    if (state.search) {
      if (!norm(p.name).includes(state.search)) return false;
    }
    if (typeof p.ele === 'number') {
      if (p.ele < state.eleMin || p.ele > state.eleMax) return false;
    } else if (state.eleMin > ELE_MIN || state.eleMax < ELE_MAX) {
      return false; // hide unknown-elevation when the range is not full
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
  // Render list
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
      const u = el('small', null, 'm');
      elev.appendChild(u);
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

    render3DMarkers(filtered);
    updateHash();
  }

  // ------------------------------------------------------------------
  // Selection
  // ------------------------------------------------------------------
  function findPeak(id) { return PEAKS.find(p => p.id === id) || null; }

  function select(id, opts) {
    opts = opts || {};
    state.selectedId = id;

    // Update card highlighting
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
        parts.push(h + 'h ' + (m ? m + 'm' : '').trim());
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

    if (opts.fly !== false) flyTo(p);
    updateSelectedMarker(p);
    updateHash();
  }

  function deselect() {
    state.selectedId = null;
    for (const card of dom.cardList.querySelectorAll('.peak-card.selected')) {
      card.classList.remove('selected');
    }
    dom.overPeak.hidden = true;
    updateSelectedMarker(null);
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
    // Push state back into inputs
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
    // Resize Cesium after transition finishes
    setTimeout(resizeCesium, 340);
  }
  window.PeakViewer = { togglePanel };

  // ------------------------------------------------------------------
  // Cesium 3D
  // ------------------------------------------------------------------
  let viewer = null;
  let googleTileset = null;
  let peakEntities = new Map();  // id -> billboard entity
  let selectedEntity = null;

  function showBanner(html) {
    dom.banner.hidden = false;
    dom.banner.innerHTML = html;
  }

  async function initCesium() {
    try {
      await window.__cesiumReady;
    } catch (err) {
      showBanner('Cesium failed to load. Ad-blocker or network filter is likely blocking it. Details: ' + err.message);
      return;
    }
    const Cesium = window.Cesium;

    viewer = new Cesium.Viewer('cesium-container', {
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      baseLayerPicker: false,
      timeline: false,
      animation: false,
      geocoder: false,
      homeButton: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      infoBox: false,
      selectionIndicator: false,
      fullscreenButton: false
    });
    viewer.scene.skyBox.show = true;
    viewer.scene.globe.enableLighting = false;

    // Try Google Photorealistic tiles; on failure, use Cesium World Terrain + Bing.
    const key = (window.HIKING_CONFIG && window.HIKING_CONFIG.googleMapsApiKey) || '';
    if (key) {
      try {
        googleTileset = await Cesium.createGooglePhotorealistic3DTileset(key);
        viewer.scene.primitives.add(googleTileset);
      } catch (err) {
        console.warn('Google 3D tileset failed, falling back:', err);
        showBanner('Google Photorealistic tiles failed to load — using Cesium terrain + Bing satellite fallback.<br>Set <code>googleMapsApiKey</code> in <code>local-config.js</code> and reload for the photorealistic mesh.');
        await useFallbackImagery();
      }
    } else {
      showBanner('No Google Maps API key — using Cesium terrain + Bing satellite fallback.<br>For the photorealistic mesh, copy <code>local-config.example.js → local-config.js</code> and set <code>googleMapsApiKey</code>.');
      await useFallbackImagery();
    }

    // Home camera
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(HOME_VIEW.lon, HOME_VIEW.lat, HOME_VIEW.height),
      orientation: {
        heading: Cesium.Math.toRadians(HOME_VIEW.heading),
        pitch:   Cesium.Math.toRadians(HOME_VIEW.pitch),
        roll: 0
      }
    });

    // Left-click on a peak billboard = select. Left-click elsewhere = deselect.
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement) => {
      const picked = viewer.scene.pick(movement.position);
      if (picked && picked.id && picked.id.peakId) {
        select(picked.id.peakId, { fly: true });
      } else {
        deselect();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Camera heading → compass arrow
    viewer.scene.postRender.addEventListener(() => {
      const heading = Cesium.Math.toDegrees(viewer.camera.heading);
      dom.compassArrow.style.transform = 'rotate(' + (-heading) + 'deg)';
      // Re-render markers when camera moves a lot; throttle so we don't thrash.
      throttledMarkerRerender();
    });

    dom.compass.addEventListener('click', () => {
      viewer.camera.flyTo({
        destination: viewer.camera.positionWC.clone(),
        orientation: {
          heading: 0,
          pitch: viewer.camera.pitch,
          roll: 0
        },
        duration: 0.8
      });
    });

    dom.homeBtn.addEventListener('click', flyHome);

    dom.qualityBtn.addEventListener('click', () => {
      const idx = QUALITY_ORDER.indexOf(currentQuality);
      currentQuality = QUALITY_ORDER[(idx + 1) % QUALITY_ORDER.length];
      try { localStorage.setItem(QUALITY_STORAGE, currentQuality); } catch (e) {}
      applyQuality();
    });
    applyQuality();

    // Now render markers for whatever filters are active
    render3DMarkers(lastFiltered);
  }

  function applyQuality() {
    if (!viewer) return;
    dom.qualityBtn.textContent = QUALITY_LABELS[currentQuality] || QUALITY_LABELS.fast;
    dom.qualityBtn.title = QUALITY_TITLES[currentQuality] || QUALITY_TITLES.fast;
    if (currentQuality === 'eco') {
      viewer.useBrowserRecommendedResolution = true;
      viewer.resolutionScale = 1;
      if (googleTileset) googleTileset.maximumScreenSpaceError = 24;
    } else if (currentQuality === 'sharp') {
      viewer.useBrowserRecommendedResolution = false;
      viewer.resolutionScale = 1;
      if (googleTileset) googleTileset.maximumScreenSpaceError = 8;
    } else {
      viewer.useBrowserRecommendedResolution = false;
      const dpr = window.devicePixelRatio || 1;
      const targetMaxWidth = 3840;
      const fullWidth = window.innerWidth * dpr;
      viewer.resolutionScale = fullWidth > targetMaxWidth ? targetMaxWidth / fullWidth : 1;
      if (googleTileset) googleTileset.maximumScreenSpaceError = 12;
    }
  }

  function flyHome() {
    if (!viewer) return;
    const Cesium = window.Cesium;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(HOME_VIEW.lon, HOME_VIEW.lat, HOME_VIEW.height),
      orientation: {
        heading: Cesium.Math.toRadians(HOME_VIEW.heading),
        pitch:   Cesium.Math.toRadians(HOME_VIEW.pitch),
        roll: 0
      },
      duration: 1.6
    });
  }

  async function useFallbackImagery() {
    const Cesium = window.Cesium;
    try {
      viewer.scene.setTerrain(Cesium.Terrain.fromWorldTerrain({ requestVertexNormals: true }));
    } catch (e) { /* keep default terrain */ }
    try {
      const bing = await Cesium.IonImageryProvider.fromAssetId(3);
      viewer.imageryLayers.removeAll();
      viewer.imageryLayers.addImageryProvider(bing);
    } catch (e) { /* fallback default imagery stays */ }
  }

  function resizeCesium() {
    if (viewer) viewer.resize();
  }
  window.addEventListener('resize', resizeCesium);

  // ------------------------------------------------------------------
  // Marker rendering
  //
  // Every filtered peak (up to MAX_MARKERS) is a persistent entity: a small
  // dot always visible, plus a label whose visibility distance is set per-peak
  // by labelRangeM(). Cesium culls labels beyond that camera distance
  // automatically — so screen density stays roughly constant as you zoom.
  // ------------------------------------------------------------------
  const throttledMarkerRerender = () => {};  // no longer needed — Cesium culls per-entity

  function buildLabelText(p) {
    return typeof p.ele === 'number'
      ? p.name + '  ' + Math.round(p.ele) + ' m'
      : p.name;
  }

  function makeEntity(p) {
    const Cesium = window.Cesium;
    const height = typeof p.ele === 'number' ? p.ele : 2000;
    const range = labelRangeM(p);
    return viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, height),
      peakId: p.id,
      point: {
        pixelSize: 6,
        color: Cesium.Color.fromCssColorString('#ffffff'),
        outlineColor: Cesium.Color.fromCssColorString('#171a1f'),
        outlineWidth: 1.5,
        disableDepthTestDistance: 200,      // don't render dots hidden behind mountains
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 200000)
      },
      label: {
        text: buildLabelText(p),
        font: '600 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#ffffff'),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('rgba(20,22,26,0.82)'),
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        pixelOffset: new Cesium.Cartesian2(10, -1),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        style: Cesium.LabelStyle.FILL,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, range)
      }
    });
  }

  function styleSelected(entity, isSelected) {
    const Cesium = window.Cesium;
    entity.point.pixelSize = isSelected ? 12 : 6;
    entity.point.color = isSelected
      ? Cesium.Color.fromCssColorString('#c0392b')
      : Cesium.Color.fromCssColorString('#ffffff');
    entity.point.outlineColor = isSelected
      ? Cesium.Color.fromCssColorString('#ffffff')
      : Cesium.Color.fromCssColorString('#171a1f');
    entity.point.outlineWidth = isSelected ? 2 : 1.5;
    entity.point.disableDepthTestDistance = isSelected ? Number.POSITIVE_INFINITY : 200;
    if (isSelected) {
      // Always show the selected label, regardless of camera distance.
      entity.label.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(0, 1e12);
      entity.label.backgroundColor = Cesium.Color.fromCssColorString('rgba(192,57,43,0.92)');
    } else {
      const p = findPeak(entity.peakId);
      entity.label.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(0, labelRangeM(p));
      entity.label.backgroundColor = Cesium.Color.fromCssColorString('rgba(20,22,26,0.82)');
    }
  }

  function render3DMarkers(filtered) {
    if (!viewer) return;
    filtered = filtered || [];
    // Cap: keep the top MAX_MARKERS by elevation (already sorted by state.sort,
    // so re-sort here specifically for the cap).
    const renderable = filtered.length <= MAX_MARKERS
      ? filtered
      : filtered.slice().sort((a, b) => (b.ele || 0) - (a.ele || 0)).slice(0, MAX_MARKERS);
    const renderableIds = new Set(renderable.map(p => p.id));

    // Drop entities no longer in the filter
    for (const [id, entity] of peakEntities) {
      if (!renderableIds.has(id)) {
        viewer.entities.remove(entity);
        peakEntities.delete(id);
      }
    }
    // Add new
    for (const p of renderable) {
      if (!peakEntities.has(p.id)) {
        peakEntities.set(p.id, makeEntity(p));
      }
    }

    if (state.selectedId) {
      const p = findPeak(state.selectedId);
      if (p) updateSelectedMarker(p);
    }
  }

  function updateSelectedMarker(p) {
    if (!viewer) return;
    // Clear old selection style
    if (selectedEntity) {
      styleSelected(selectedEntity, false);
      selectedEntity = null;
    }
    if (!p) return;
    let ent = peakEntities.get(p.id);
    if (!ent) {
      // Peak was outside the filter — add it anyway so we can highlight it.
      ent = makeEntity(p);
      peakEntities.set(p.id, ent);
    }
    styleSelected(ent, true);
    selectedEntity = ent;
  }

  // ------------------------------------------------------------------
  // Fly-to
  // ------------------------------------------------------------------
  function flyTo(p) {
    if (!viewer) return;
    const Cesium = window.Cesium;
    const summitEle = typeof p.ele === 'number' ? p.ele : 2000;

    // 2 km south of summit, +800 m above summit
    const kmPerDeg = 111.32;
    const camLat = p.lat - (FLY_OFFSET_KM / kmPerDeg);
    const camLon = p.lon;
    const camHeight = summitEle + FLY_ABOVE_M;

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(camLon, camLat, camHeight),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(FLY_PITCH_DEG),
        roll: 0
      },
      duration: FLY_DURATION_S
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
    initUi();
    bindFilterUi();
    readHash();
    renderList();
    initCesium().then(() => {
      // If a peak was selected via URL hash, fly to it now that Cesium is ready.
      if (state.selectedId) select(state.selectedId, { fly: true, scrollIntoView: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
