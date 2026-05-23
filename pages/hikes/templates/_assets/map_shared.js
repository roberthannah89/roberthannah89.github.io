// Shared map utilities — tile layers, layer switcher, fullscreen control.
// Loaded before page-specific map scripts. Exposes window.MapShared.
(function () {
  "use strict";
  if (typeof L === "undefined") return;

  var TILE_URLS = {
    color:  "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
    grey:   "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg",
    trails: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swisstlm3d-wanderwege/default/current/3857/{z}/{x}/{y}.png",
    aerial: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg",
    osm:    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  };

  function makeLayers() {
    return {
      color:  L.tileLayer(TILE_URLS.color,  { attribution: "&copy; swisstopo", maxZoom: 18 }),
      grey:   L.tileLayer(TILE_URLS.grey,   { attribution: "&copy; swisstopo", maxZoom: 18 }),
      trails: L.tileLayer(TILE_URLS.trails, { attribution: "&copy; swisstopo (Wanderwege)", maxZoom: 18 }),
      aerial: L.tileLayer(TILE_URLS.aerial, { attribution: "&copy; swisstopo (SWISSIMAGE)", maxZoom: 19 }),
      osm:    L.tileLayer(TILE_URLS.osm,    { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }),
    };
  }

  // Layer definitions: key → label, factory fn
  var LAYER_DEFS = [
    { key: "hike",   label: "Topo + Trails",    trails: true, make: function (l) { return L.layerGroup([l.color, l.trails]); } },
    { key: "color",  label: "Topo",              trails: false, make: function (l) { return l.color; } },
    { key: "aerial", label: "Aerial",            trails: false, make: function (l) { return l.aerial; } },
    { key: "osm",    label: "OpenStreetMap",     trails: false, make: function (l) { return l.osm; } },
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
