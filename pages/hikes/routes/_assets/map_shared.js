// GENERATED FROM ../../templates/_assets/map_shared.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

// Shared map utilities — tile layers, layer switcher, fullscreen control.
// Loaded before page-specific map scripts. Exposes window.MapShared.
(function () {
  "use strict";
  if (typeof L === "undefined") return;

  var TILE_URLS = {
    color:  "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
    grey:   "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg",
    // Wanderland — SchweizMobil's curated national/regional/local walking
    // routes. Much cleaner than the previous ch.swisstopo.swisstlm3d-
    // wanderwege overlay, which painted every farmer's yellow footpath in
    // the country on top of the topo tiles and turned the map into noise.
    // The base swisstopo topo already shows all trails baked in; this
    // overlay just adds the numbered SchweizMobil route badges + emphasis.
    trails: "https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&LAYERS=ch.astra.wanderland&CRS=EPSG:3857&STYLES=&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}",
    aerial: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg",
    osm:    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  };

  // crossOrigin: "anonymous" on the swisstopo layers makes the service
  // worker store tile responses at their real size (~7x smaller than
  // opaque responses on Chrome). SwissTopo serves Access-Control-Allow-
  // Origin: *, so this is free. OSM is left as-is — not in the SW cache
  // allowlist, so opaque-padding doesn't apply.
  //
  // "trails" uses L.tileLayer.wms (not the WMTS URL template above); the
  // TILE_URLS.trails string is kept for reference / documentation but not
  // consumed. Every other layer stays WMTS.
  function makeLayers() {
    return {
      color:  L.tileLayer(TILE_URLS.color,  { attribution: "&copy; swisstopo", maxZoom: 18, crossOrigin: "anonymous" }),
      grey:   L.tileLayer(TILE_URLS.grey,   { attribution: "&copy; swisstopo", maxZoom: 18, crossOrigin: "anonymous" }),
      trails: L.tileLayer.wms("https://wms.geo.admin.ch/", {
        layers: "ch.astra.wanderland",
        format: "image/png",
        transparent: true,
        version: "1.3.0",
        crs: L.CRS.EPSG3857,
        maxZoom: 18,
        attribution: "&copy; ASTRA / SchweizMobil (Wanderland)"
      }),
      aerial: L.tileLayer(TILE_URLS.aerial, { attribution: "&copy; swisstopo (SWISSIMAGE)", maxZoom: 19, crossOrigin: "anonymous" }),
      osm:    L.tileLayer(TILE_URLS.osm,    { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }),
    };
  }

  // Layer definitions: key → label (shown on button), title (hover tooltip / a11y), factory fn
  var LAYER_DEFS = [
    { key: "hike",   label: "🥾",  title: "Topo + Wanderland routes (SchweizMobil)", trails: true,  make: function (l) { return L.layerGroup([l.color, l.trails]); } },
    { key: "color",  label: "🗺️", title: "Topo (swisstopo)",    trails: false, make: function (l) { return l.color; } },
    { key: "aerial", label: "🛰️", title: "Aerial (SWISSIMAGE)", trails: false, make: function (l) { return l.aerial; } },
    { key: "osm",    label: "OSM",           title: "OpenStreetMap",       trails: false, make: function (l) { return l.osm; } },
  ];

  function addLayerControl(map, opts) {
    opts = opts || {};
    var l = makeLayers();
    var defs = LAYER_DEFS.filter(function (d) {
      if (d.trails && opts.includeTrails === false) return false;
      return true;
    });

    var layers = {};
    defs.forEach(function (d) { layers[d.key] = d.make(l); });

    var defaultKey = opts.defaultLayer || defs[0].key;
    var current = layers[defaultKey];
    if (current) current.addTo(map);

    // Build button bar and insert before the map element
    var bar = document.createElement("div");
    bar.className = "ms-layer-bar";
    var mapEl = map.getContainer();
    mapEl.parentNode.insertBefore(bar, mapEl);

    defs.forEach(function (d) {
      var btn = document.createElement("button");
      btn.textContent = d.label;
      btn.title = d.title || d.label;
      btn.setAttribute("aria-label", d.title || d.label);
      btn.className = "ms-layer-btn" + (d.key === defaultKey ? " active" : "");
      btn.addEventListener("click", function () {
        if (layers[d.key] === current) return;
        map.removeLayer(current);
        current = layers[d.key];
        current.addTo(map);
        bar.querySelectorAll(".ms-layer-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        map.fire("baselayerchange");
      });
      bar.appendChild(btn);
    });

    addSwissBorder(map);
    addFullscreen(map, mapEl);

    return layers;
  }

  function addSwissBorder(map) {
    if (!window.SWISS_BORDER) return;
    map.createPane("border");
    map.getPane("border").style.zIndex = 650;
    L.geoJSON(window.SWISS_BORDER, {
      pane: "border",
      style: { color: "#000", weight: 2.5, fillOpacity: 0, interactive: false },
    }).addTo(map);
  }

  function addFullscreen(map, el) {
    var ctrl = L.control({ position: "topleft" });
    ctrl.onAdd = function () {
      var btn = L.DomUtil.create("button", "ms-fullscreen-btn leaflet-bar");
      btn.title = "Toggle fullscreen";
      btn.innerHTML = "&#x26F6;";
      L.DomEvent.disableClickPropagation(btn);
      btn.onclick = function () {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          el.requestFullscreen();
        }
      };
      return btn;
    };
    ctrl.addTo(map);
    el.addEventListener("fullscreenchange", function () {
      setTimeout(function () { map.invalidateSize(); }, 100);
    });
  }

  window.MapShared = {
    makeLayers: makeLayers,
    addLayerControl: addLayerControl,
    addFullscreen: addFullscreen,
    addSwissBorder: addSwissBorder,
  };
})();
