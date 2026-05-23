// Shared map utilities — tile layers, layer switcher, fullscreen control.
// Loaded before page-specific map scripts. Exposes window.MapShared.
(function () {
  "use strict";
  if (typeof L === "undefined") return;

  var swissColor = L.tileLayer(
    "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
    { attribution: "&copy; swisstopo", maxZoom: 18 }
  );
  var swissGrey = L.tileLayer(
    "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg",
    { attribution: "&copy; swisstopo", maxZoom: 18 }
  );
  var swissTrails = L.tileLayer(
    "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swisstlm3d-wanderwege/default/current/3857/{z}/{x}/{y}.png",
    { attribution: "&copy; swisstopo (Wanderwege)", maxZoom: 18 }
  );
  var swissAerial = L.tileLayer(
    "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg",
    { attribution: "&copy; swisstopo (SWISSIMAGE)", maxZoom: 19 }
  );
  var osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }
  );

  function makeLayers() {
    return {
      color: L.tileLayer("https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
        { attribution: "&copy; swisstopo", maxZoom: 18 }),
      grey: L.tileLayer("https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg",
        { attribution: "&copy; swisstopo", maxZoom: 18 }),
      trails: L.tileLayer("https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swisstlm3d-wanderwege/default/current/3857/{z}/{x}/{y}.png",
        { attribution: "&copy; swisstopo (Wanderwege)", maxZoom: 18 }),
      aerial: L.tileLayer("https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg",
        { attribution: "&copy; swisstopo (SWISSIMAGE)", maxZoom: 19 }),
      osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }),
    };
  }

  function hikeBase() {
    var l = makeLayers();
    return L.layerGroup([l.color, l.trails]);
  }

  function addLayerControl(map, opts) {
    opts = opts || {};
    var l = makeLayers();
    var bases = {};
    if (opts.includeTrails !== false) {
      bases["Topo + Trails"] = L.layerGroup([l.color, l.trails]);
    }
    bases["Topo (colour)"] = l.color;
    bases["Topo (greyscale)"] = l.grey;
    bases["Aerial"] = l.aerial;
    bases["OpenStreetMap"] = l.osm;

    var defaultKey = opts.defaultLayer || Object.keys(bases)[0];
    var defaultBase = bases[defaultKey];
    if (defaultBase) defaultBase.addTo(map);

    L.control.layers(bases, null, { position: "topright", collapsed: true }).addTo(map);
    return bases;
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
    hikeBase: hikeBase,
    addLayerControl: addLayerControl,
    addFullscreen: addFullscreen,
  };
})();
