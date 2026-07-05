/* Peak Viewer prototype — app logic.
 *
 * Data:  window.CH_PEAKS  (from ch-peaks.js)
 * Modes:
 *   maplibre: SWISSIMAGE + Terrarium DEM (default; no API key required).
 *   cesium:   Google Photorealistic 3D Tiles (needs
 *             window.HIKING_CONFIG.googleMapsApiKey in local-config.js).
 *
 * Click a peak in either mode → camera flies to it, info card appears.
 * Public hook: window.PeakViewer.togglePanel()  — wired to the DOM onclick.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Data + constants
  // ------------------------------------------------------------------
  const PEAKS = Array.isArray(window.CH_PEAKS) ? window.CH_PEAKS : [];
  const MAX_LIST = 500;

  const HOME_MAPLIBRE = { center: [8.2, 46.7], zoom: 8, pitch: 55, bearing: 20 };
  // Cesium home: rough equivalent looking at the same central Switzerland spot.
  const HOME_CESIUM = { lon: 8.2, lat: 45.8, height: 250000, heading: 20, pitch: -55 };

  const MODE_STORAGE = 'proto:peak-viewer-mode';
  const GOOGLE_KEY = (window.HIKING_CONFIG && window.HIKING_CONFIG.googleMapsApiKey) || '';

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
  // Filter + mode state
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

  let mode = (function () {
    try { return localStorage.getItem(MODE_STORAGE) || 'maplibre'; } catch (e) { return 'maplibre'; }
  })();
  if (mode === 'cesium' && !GOOGLE_KEY) mode = 'maplibre';

  // Camera state preserved across mode switches. Shape:
  //   { lng, lat, distance (m), heading (deg), pitch (deg, negative = looking down) }
  let sharedCamera = null;

  // ------------------------------------------------------------------
  // DOM refs
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const dom = {
    layout: $('layout'),
    scene: $('scene'),
    host: $('map-host'),
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
    modeMaplibre: $('mode-maplibre'),
    modeCesium: $('mode-cesium'),
  };

  // ------------------------------------------------------------------
  // Init UI
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
    // Mode toggle
    updateModeBar();
    if (!GOOGLE_KEY) {
      dom.modeCesium.disabled = true;
      dom.modeCesium.title = 'Photorealistic mode needs a Google Maps API key. Copy local-config.example.js → local-config.js and set googleMapsApiKey.';
    }
    dom.modeMaplibre.addEventListener('click', () => switchMode('maplibre'));
    dom.modeCesium.addEventListener('click', () => switchMode('cesium'));
  }

  function updateModeBar() {
    dom.modeMaplibre.classList.toggle('active', mode === 'maplibre');
    dom.modeCesium.classList.toggle('active', mode === 'cesium');
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
  // Card list render
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
      chip.classList.toggle('active', !!state[chip.dataset.toggle]);
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

  function updateCantonCount() {
    dom.cantonCountLbl.textContent = state.cantons.size ? '(' + state.cantons.size + ')' : '';
  }

  // ------------------------------------------------------------------
  // Filter UI wiring
  // ------------------------------------------------------------------
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
    dom.homeBtn.addEventListener('click', flyHome);
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
    setTimeout(resizeViewer, 340);
  }
  window.PeakViewer = { togglePanel };

  function resizeViewer() {
    if (map) map.resize();
    if (viewer) viewer.resize();
  }
  window.addEventListener('resize', resizeViewer);

  function showBanner(html) {
    dom.banner.hidden = false;
    dom.banner.innerHTML = html;
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => { dom.banner.hidden = true; }, 8000);
  }

  // ------------------------------------------------------------------
  // Mode switching
  // ------------------------------------------------------------------
  let map = null;
  let viewer = null;
  let cesiumTileset = null;
  let cesiumEntities = new Map();
  let cesiumSelectedEntity = null;
  let cesiumClickHandler = null;

  function switchMode(newMode) {
    if (newMode === mode) return;
    if (newMode === 'cesium' && !GOOGLE_KEY) {
      showBanner('Photorealistic mode needs a Google Maps API key. Copy <code>local-config.example.js → local-config.js</code> and set <code>googleMapsApiKey</code>.');
      return;
    }
    sharedCamera = captureCamera();
    teardown();
    mode = newMode;
    try { localStorage.setItem(MODE_STORAGE, mode); } catch (e) {}
    updateModeBar();
    if (mode === 'maplibre') initMapLibre();
    else initCesium();
  }

  function teardown() {
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    if (viewer) {
      if (cesiumClickHandler) { try { cesiumClickHandler.destroy(); } catch (e) {} cesiumClickHandler = null; }
      cesiumEntities.clear();
      cesiumSelectedEntity = null;
      cesiumTileset = null;
      try { viewer.destroy(); } catch (e) {}
      viewer = null;
    }
    dom.host.innerHTML = '';
  }

  function captureCamera() {
    if (mode === 'maplibre' && map) return captureCameraMapLibre();
    if (mode === 'cesium' && viewer) return captureCameraCesium();
    return sharedCamera;
  }

  // Cross-mode helpers (MapLibre pitch = 0 top-down, 60 tilted;
  // Cesium pitch = -90 top-down, 0 horizon)
  function distanceToZoom(distance, lat) {
    const c = 40075016.686 * Math.cos(lat * Math.PI / 180);
    return Math.log2((window.innerWidth * c) / (256 * Math.max(distance, 1)));
  }
  function zoomToDistance(zoom, lat) {
    const c = 40075016.686 * Math.cos(lat * Math.PI / 180);
    return (window.innerWidth * c) / (256 * Math.pow(2, zoom));
  }

  function captureCameraMapLibre() {
    if (!map) return null;
    const c = map.getCenter();
    return {
      lng: c.lng, lat: c.lat,
      distance: zoomToDistance(map.getZoom(), c.lat),
      heading: map.getBearing(),
      pitch: -(90 - map.getPitch())
    };
  }
  function applyCameraMapLibre(cam) {
    if (!map || !cam) return;
    map.jumpTo({
      center: [cam.lng, cam.lat],
      zoom: distanceToZoom(cam.distance, cam.lat),
      bearing: cam.heading,
      pitch: 90 + cam.pitch
    });
  }
  function captureCameraCesium() {
    if (!viewer) return null;
    const Cesium = window.Cesium;
    const cam = viewer.camera;
    const w = viewer.canvas.clientWidth || window.innerWidth;
    const h = viewer.canvas.clientHeight || window.innerHeight;
    const center = cam.pickEllipsoid(new Cesium.Cartesian2(w / 2, h / 2));
    if (!center) return null;
    const carto = Cesium.Cartographic.fromCartesian(center);
    return {
      lng: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      distance: Cesium.Cartesian3.distance(cam.position, center),
      heading: Cesium.Math.toDegrees(cam.heading),
      pitch:   Cesium.Math.toDegrees(cam.pitch)
    };
  }

  // ------------------------------------------------------------------
  // Source updates — delegate to the active renderer.
  // ------------------------------------------------------------------
  function updatePeakSource(filtered) {
    if (mode === 'maplibre') updatePeakSourceMapLibre(filtered);
    else updatePeakSourceCesium(filtered);
  }
  function updateSelectedSource(p) {
    if (mode === 'maplibre') updateSelectedSourceMapLibre(p);
    else updateSelectedSourceCesium(p);
  }
  function flyTo(p) {
    if (mode === 'maplibre') flyToMapLibre(p);
    else flyToCesium(p);
  }
  function flyHome() {
    if (mode === 'maplibre') flyHomeMapLibre();
    else flyHomeCesium();
  }

  // ------------------------------------------------------------------
  // MapLibre renderer
  // ------------------------------------------------------------------
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
        id: p.id, name: p.name,
        ele: typeof p.ele === 'number' ? Math.round(p.ele) : null,
        tier: tierFor(p.ele, !!p.wikipedia),
        notable: !!p.wikipedia,
      }
    };
  }
  function updatePeakSourceMapLibre(filtered) {
    if (!map) return;
    const src = map.getSource('peaks');
    if (!src) return;
    src.setData({ type: 'FeatureCollection', features: filtered.map(toFeature) });
  }
  function updateSelectedSourceMapLibre(p) {
    if (!map) return;
    const src = map.getSource('selected-peak');
    if (!src) return;
    src.setData({ type: 'FeatureCollection', features: p ? [toFeature(p)] : [] });
  }

  function initMapLibre() {
    dom.host.innerHTML = '<div id="map"></div>';
    const initialView = sharedCamera
      ? {
          center: [sharedCamera.lng, sharedCamera.lat],
          zoom: distanceToZoom(sharedCamera.distance, sharedCamera.lat),
          bearing: sharedCamera.heading,
          pitch: Math.max(0, Math.min(85, 90 + sharedCamera.pitch))
        }
      : HOME_MAPLIBRE;

    map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        sources: {
          swissimage: {
            type: 'raster',
            tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'],
            // swisstopo only serves tiles from zoom 8 up. Below that, minzoom
            // keeps MapLibre from requesting non-existent low-zoom tiles.
            tileSize: 256, minzoom: 8, maxzoom: 19, attribution: '&copy; swisstopo'
          },
          terrarium: {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            tileSize: 256, maxzoom: 15, encoding: 'terrarium',
            attribution: 'Terrain: Mapzen / AWS Open Data'
          }
        },
        // Background fills in for out-of-range zooms + edges (swisstopo is
        // Switzerland-only; anything outside its coverage falls back to this).
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
      center: initialView.center, zoom: initialView.zoom,
      pitch: initialView.pitch, bearing: initialView.bearing,
      maxPitch: 85, hash: false
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    window.__peakViewerMap = map;
    map.on('load', () => {
      map.addSource('peaks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('selected-peak', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      map.addLayer({
        id: 'peaks-dot', type: 'circle', source: 'peaks',
        paint: {
          // Matches 3d-peaks.html sizes (tier1: 4, tier2: 3.2, else: 2.4).
          'circle-radius': ['case', ['==', ['get', 'tier'], 1], 4, ['==', ['get', 'tier'], 2], 3.2, 2.4],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#222222',
          'circle-stroke-width': 1.3,
          'circle-opacity': ['case',
            ['==', ['get', 'tier'], 1], 1,
            ['==', ['get', 'tier'], 2], ['interpolate', ['linear'], ['zoom'], 6, 0, 8.5, 1],
            ['interpolate', ['linear'], ['zoom'], 9, 0, 11, 1]
          ],
          'circle-stroke-opacity': ['case',
            ['==', ['get', 'tier'], 1], 1,
            ['==', ['get', 'tier'], 2], ['interpolate', ['linear'], ['zoom'], 6, 0, 8.5, 1],
            ['interpolate', ['linear'], ['zoom'], 9, 0, 11, 1]
          ]
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
          // Collision-avoidance ON (we have 7,500 peaks vs 3d-peaks' ~140).
          'text-allow-overlap': false, 'text-ignore-placement': false, 'text-padding': 3,
          'symbol-sort-key': ['-', 5000, ['coalesce', ['get', 'ele'], 0]]
        },
        paint: {
          'text-color': '#1a1a1a', 'text-halo-color': '#ffffff',
          'text-halo-width': 1.8, 'text-halo-blur': 0.4
        }
      });
      map.addLayer({
        id: 'selected-halo', type: 'circle', source: 'selected-peak',
        paint: { 'circle-radius': 14, 'circle-color': '#c0392b', 'circle-opacity': 0.22 }
      });
      map.addLayer({
        id: 'selected-dot', type: 'circle', source: 'selected-peak',
        paint: { 'circle-radius': 6.5, 'circle-color': '#c0392b',
                 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }
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
        paint: {
          'text-color': '#ffffff', 'text-halo-color': '#c0392b', 'text-halo-width': 2.2
        }
      });

      map.on('click', 'peaks-dot',   (e) => e.features && e.features[0] && select(e.features[0].properties.id, { fly: true }));
      map.on('click', 'peaks-label', (e) => e.features && e.features[0] && select(e.features[0].properties.id, { fly: true }));
      map.on('mouseenter', 'peaks-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'peaks-dot', () => { map.getCanvas().style.cursor = ''; });
      map.on('click', (e) => {
        const feats = map.queryRenderedFeatures(e.point, { layers: ['peaks-dot', 'peaks-label', 'selected-dot'] });
        if (!feats || !feats.length) deselect();
      });

      updatePeakSourceMapLibre(lastFiltered);
      if (state.selectedId) {
        const p = findPeak(state.selectedId);
        if (p) updateSelectedSourceMapLibre(p);
      }
    });
  }

  function flyToMapLibre(p) {
    if (!map) return;
    // Fit a ~3 km buffer around the peak (matches 3d-peaks.html's fitBounds
    // pattern). Yields a natural angled view showing the peak in context —
    // surrounding peaks stay visible instead of the camera burying into the
    // terrain like a raw flyTo to zoom 13.5 does. Do NOT gate on
    // map.loaded() — swisstopo returns 400 for tiles outside Switzerland, so
    // loaded() can stay false indefinitely.
    const pad = 0.028;  // ~3 km in each direction
    const bounds = [
      [p.lon - pad, p.lat - pad],
      [p.lon + pad, p.lat + pad]
    ];
    map.fitBounds(bounds, {
      padding: 60,
      pitch: 65,
      bearing: 20,
      duration: 2500,
      maxZoom: 13,
      essential: true
    });
  }
  function flyHomeMapLibre() {
    if (!map) return;
    map.flyTo({
      center: HOME_MAPLIBRE.center, zoom: HOME_MAPLIBRE.zoom,
      pitch: HOME_MAPLIBRE.pitch, bearing: HOME_MAPLIBRE.bearing,
      duration: 1800, essential: true
    });
  }

  // ------------------------------------------------------------------
  // Cesium renderer
  // ------------------------------------------------------------------
  // Per-peak label visibility distance (metres). Cesium doesn't have
  // MapLibre's automatic collision, so we cap what shows via elevation tiers.
  function labelRangeM(p) {
    const ele = p.ele || 0;
    const notable = !!p.wikipedia;
    if (ele >= 4300 || (notable && ele >= 4000)) return 500000;
    if (ele >= 3700) return 140000;
    if (ele >= 3000 || (notable && ele >= 2500)) return 45000;
    if (ele >= 2500) return 15000;
    if (ele >= 2000 || notable) return 7000;
    if (ele >= 1500) return 3500;
    return 1800;
  }

  function makeCesiumEntity(p) {
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
        disableDepthTestDistance: 200,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 200000)
      },
      label: {
        text: p.name + (typeof p.ele === 'number' ? '  ' + Math.round(p.ele) + ' m' : ''),
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

  function styleCesiumSelected(entity, isSelected) {
    if (!entity) return;
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
    entity.label.showBackground = true;
    if (isSelected) {
      entity.label.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(0, 1e12);
      entity.label.backgroundColor = Cesium.Color.fromCssColorString('rgba(192,57,43,0.92)');
    } else {
      const p = findPeak(entity.peakId);
      entity.label.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(0, labelRangeM(p));
      entity.label.backgroundColor = Cesium.Color.fromCssColorString('rgba(20,22,26,0.82)');
    }
  }

  function updatePeakSourceCesium(filtered) {
    if (!viewer) return;
    // Cap at 4500 to keep entity count bounded
    const renderable = filtered.length <= 4500
      ? filtered
      : filtered.slice().sort((a, b) => (b.ele || 0) - (a.ele || 0)).slice(0, 4500);
    const ids = new Set(renderable.map(p => p.id));
    for (const [id, ent] of cesiumEntities) {
      if (!ids.has(id)) { viewer.entities.remove(ent); cesiumEntities.delete(id); }
    }
    for (const p of renderable) {
      if (!cesiumEntities.has(p.id)) cesiumEntities.set(p.id, makeCesiumEntity(p));
    }
    if (state.selectedId) {
      const p = findPeak(state.selectedId);
      if (p) updateSelectedSourceCesium(p);
    }
  }

  function updateSelectedSourceCesium(p) {
    if (!viewer) return;
    if (cesiumSelectedEntity) {
      styleCesiumSelected(cesiumSelectedEntity, false);
      cesiumSelectedEntity = null;
    }
    if (!p) return;
    let ent = cesiumEntities.get(p.id);
    if (!ent) { ent = makeCesiumEntity(p); cesiumEntities.set(p.id, ent); }
    styleCesiumSelected(ent, true);
    cesiumSelectedEntity = ent;
  }

  async function initCesium() {
    dom.host.innerHTML = '<div id="cesium-container"></div>';
    try {
      await window.__cesiumReady;
    } catch (err) {
      showBanner('Cesium failed to load — falling back to Satellite mode. ' + err.message);
      mode = 'maplibre'; updateModeBar(); initMapLibre();
      return;
    }
    const Cesium = window.Cesium;
    viewer = new Cesium.Viewer('cesium-container', {
      baseLayer: false, baseLayerPicker: false,
      timeline: false, animation: false, geocoder: false,
      sceneModePicker: false, navigationHelpButton: false,
      homeButton: false, infoBox: false, selectionIndicator: false, fullscreenButton: false
    });
    viewer.scene.globe.show = false;
    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.skyAtmosphere.show = true;
    if (viewer.scene.postProcessStages && viewer.scene.postProcessStages.fxaa) {
      viewer.scene.postProcessStages.fxaa.enabled = true;
    }

    try {
      cesiumTileset = await Cesium.createGooglePhotorealistic3DTileset(GOOGLE_KEY);
      viewer.scene.primitives.add(cesiumTileset);
    } catch (err) {
      showBanner('Google Photorealistic tiles failed to load. Check that <code>googleMapsApiKey</code> is valid and the Map Tiles API is enabled. Falling back to Satellite.');
      teardown(); mode = 'maplibre'; updateModeBar(); initMapLibre();
      return;
    }

    // Camera: reuse sharedCamera if present, else default home.
    const cam = sharedCamera || {
      lng: HOME_CESIUM.lon, lat: HOME_CESIUM.lat,
      distance: HOME_CESIUM.height, heading: HOME_CESIUM.heading, pitch: HOME_CESIUM.pitch
    };
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(cam.lng, cam.lat - 0.5, Math.max(cam.distance, 5000)),
      orientation: {
        heading: Cesium.Math.toRadians(cam.heading || 0),
        pitch:   Cesium.Math.toRadians(cam.pitch != null ? cam.pitch : -45),
        roll: 0
      }
    });

    // Click detection
    cesiumClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    cesiumClickHandler.setInputAction((movement) => {
      const picked = viewer.scene.pick(movement.position);
      if (picked && picked.id && picked.id.peakId) select(picked.id.peakId, { fly: true });
      else deselect();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Populate
    updatePeakSourceCesium(lastFiltered);
  }

  function flyToCesium(p) {
    if (!viewer) return;
    const Cesium = window.Cesium;
    const summitEle = typeof p.ele === 'number' ? p.ele : 2000;
    const kmPerDeg = 111.32;
    const camLat = p.lat - (2.0 / kmPerDeg);
    const camLon = p.lon;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(camLon, camLat, summitEle + 800),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-25),
        roll: 0
      },
      duration: 2.5
    });
  }

  function flyHomeCesium() {
    if (!viewer) return;
    const Cesium = window.Cesium;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(HOME_CESIUM.lon, HOME_CESIUM.lat, HOME_CESIUM.height),
      orientation: {
        heading: Cesium.Math.toRadians(HOME_CESIUM.heading),
        pitch:   Cesium.Math.toRadians(HOME_CESIUM.pitch),
        roll: 0
      },
      duration: 1.8
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function boot() {
    if (!PEAKS.length) {
      showBanner('No peak data found. Run <code>python3 scripts/build_ch_peaks.py</code> to generate <code>ch-peaks.js</code>.');
      dom.peakCountTotal.textContent = 'No data';
      return;
    }
    if (typeof maplibregl === 'undefined') {
      showBanner('MapLibre GL failed to load — check the network.');
      return;
    }
    initUi();
    bindFilterUi();
    readHash();
    renderList();
    if (mode === 'cesium') initCesium();
    else initMapLibre();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
