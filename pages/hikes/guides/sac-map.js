(function () {
  "use strict";
  if (typeof L === "undefined" || !window.SAC_ROUTES) return;

  var GRADE_COLORS = {
    t1: "#2d8a4e", t2: "#2d8a4e",
    t3: "#c8a020",
    t4: "#d07030",
    t5: "#cc3333",
    t6: "#8844cc",
  };

  function gradeBase(g) {
    if (!g) return "";
    var m = g.match(/T(\d)/i);
    return m ? "t" + m[1] : "";
  }

  function gradeColor(g) {
    return GRADE_COLORS[gradeBase(g)] || "#888";
  }

  function gradePill(g) {
    var base = gradeBase(g);
    return '<span class="pill ' + base + '">' + g + '</span>';
  }

  function fmtTime(mins) {
    if (!mins) return "";
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return m > 0 ? h + "h " + m + "m" : h + "h";
  }

  function bestGrade(poi) {
    var grades = poi.routes.map(function (r) { return r.grade || ""; });
    if (!grades.length) return "";
    return grades.sort(function (a, b) {
      var na = parseInt((a.match(/\d/) || ["0"])[0], 10);
      var nb = parseInt((b.match(/\d/) || ["0"])[0], 10);
      return nb - na;
    })[0];
  }

  function maxTime(poi) {
    var t = 0;
    poi.routes.forEach(function (r) { if (r.time_up > t) t = r.time_up; });
    return t;
  }


  // Filters
  var activeFilters = { grade: "all", elev: "all", time: "all" };

  var gradeGroup = document.querySelector('[data-filter="grade"]');
  gradeGroup.addEventListener("click", function (e) {
    var btn = e.target.closest(".filter-btn");
    if (!btn) return;
    var val = btn.dataset.value;
    if (val === "all") {
      gradeGroup.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      activeFilters.grade = "all";
    } else {
      gradeGroup.querySelector('[data-value="all"]').classList.remove("active");
      btn.classList.toggle("active");
      var selected = [];
      gradeGroup.querySelectorAll(".filter-btn.active").forEach(function (b) {
        if (b.dataset.value !== "all") selected.push(b.dataset.value);
      });
      activeFilters.grade = selected.length ? selected : "all";
      if (activeFilters.grade === "all") {
        gradeGroup.querySelector('[data-value="all"]').classList.add("active");
      }
    }
    applyFilters();
  });

  document.querySelectorAll(".filter-group:not([data-filter='grade'])").forEach(function (group) {
    var key = group.dataset.filter;
    group.addEventListener("click", function (e) {
      var btn = e.target.closest(".filter-btn");
      if (!btn) return;
      group.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      activeFilters[key] = btn.dataset.value;
      applyFilters();
    });
  });

  function matchGrade(poi, filter) {
    if (filter === "all") return true;
    var bg = gradeBase(bestGrade(poi));
    for (var i = 0; i < filter.length; i++) {
      if (filter[i] === "t1t2") { if (bg === "t1" || bg === "t2") return true; }
      else if (bg === filter[i]) return true;
    }
    return false;
  }

  function matchElev(poi, filter) {
    if (filter === "all") return true;
    var a = poi.alt || 0;
    if (filter === "low") return a <= 2000;
    if (filter === "mid") return a > 2000 && a <= 2500;
    if (filter === "high") return a > 2500 && a <= 3000;
    if (filter === "vhigh") return a > 3000;
    return true;
  }

  function matchTime(poi, filter) {
    if (filter === "all") return true;
    var t = maxTime(poi);
    if (!t) return filter === "all";
    if (filter === "short") return t <= 180;
    if (filter === "med") return t > 180 && t <= 300;
    if (filter === "long") return t > 300;
    return true;
  }


  // Map setup
  var map = L.map("map", { zoomControl: false }).setView([46.8, 8.2], 8);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  MapShared.addLayerControl(map, { defaultLayer: "hike" });

  // Marker cluster group
  var clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 45,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    disableClusteringAtZoom: 13,
  });

  // Create markers
  var markers = [];
  SAC_ROUTES.forEach(function (poi) {
    if (!poi.lat || !poi.lon) return;

    var grade = bestGrade(poi);
    var color = gradeColor(grade);

    var marker = L.circleMarker([poi.lat, poi.lon], {
      radius: 6,
      fillColor: color,
      fillOpacity: 0.85,
      color: "#000",
      weight: 1,
      opacity: 0.6,
    });

    var routeHtml = poi.routes.map(function (r) {
      var parts = [];
      if (r.grade) parts.push(gradePill(r.grade));
      if (r.gain) parts.push(r.gain + " m gain");
      if (r.time_up) parts.push("↑ " + fmtTime(r.time_up));
      if (r.time_down) parts.push("↓ " + fmtTime(r.time_down));
      return '<div class="popup-route">' +
        '<div>' + (r.title || "Route") + '</div>' +
        '<div class="popup-meta">' + parts.join(" · ") + '</div>' +
        '</div>';
    }).join("");

    var sacUrl = "https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/"
      + poi.id + "/mountain_hiking";

    marker.bindPopup(
      '<div class="popup-name">' + poi.name + '</div>' +
      '<div class="popup-meta">' + (poi.alt || "") + " m" + '</div>' +
      routeHtml +
      '<div class="popup-link"><a href="' + sacUrl + '" target="_blank" rel="noopener">View on SAC →</a></div>',
      { maxWidth: 280 }
    );

    marker._poi = poi;
    markers.push(marker);
  });

  // Initial add
  clusterGroup.addLayers(markers);
  map.addLayer(clusterGroup);

  var counterEl = document.getElementById("counter");

  function applyFilters() {
    var visible = [];
    var hidden = [];

    markers.forEach(function (m) {
      var poi = m._poi;
      var ok = matchGrade(poi, activeFilters.grade)
        && matchElev(poi, activeFilters.elev)
        && matchTime(poi, activeFilters.time);

      if (ok) {
        visible.push(m);
      } else {
        hidden.push(m);
      }
    });

    clusterGroup.clearLayers();
    clusterGroup.addLayers(visible);

    var routeCount = 0;
    visible.forEach(function (m) { routeCount += m._poi.routes.length; });
    counterEl.innerHTML = "<strong>" + visible.length + "</strong> destinations · <strong>"
      + routeCount + "</strong> routes";
  }

  applyFilters();
})();
