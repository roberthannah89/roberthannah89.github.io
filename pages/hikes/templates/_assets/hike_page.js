// Shared hike-page runtime. Reads per-hike data from window.HIKE (set inline by the page).
(function () {
  "use strict";
  const H = window.HIKE || {};
  const SUMMIT = H.summit, TRAILHEAD = H.trailhead, END_POINT = H.end_point, WAYPOINTS = H.waypoints || [];
  const HIKR_INDEX_URL = H.hikr_index_url;
  const GPX_FILENAME = H.gpx_filename, REPORTS_UPDATED = H.reports_updated;
  const PAGE_GENERATED = H.page_generated, WEBCAMS = H.webcams || [];

  const cfg = (window.HIKING_CONFIG || {});
  const mapsKey = cfg.mapsApiKey || "";
  const transitOrigin = cfg.defaultOrigin || "Zürich HB";

  // Populate the print-only page URL (must run before any early-return so the
  // printed copy points back to the live page even if Leaflet failed to load).
  document.querySelectorAll(".page-url").forEach(el => {
    el.textContent = location.href.replace(/^file:\/\//, "");
  });

  // ---- Map (Leaflet) ----
  if (typeof L === "undefined") {
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.innerHTML =
      '<div style="padding:2rem;text-align:center;color:#666;">' +
      '<strong>Map could not load.</strong><br>Leaflet CDN unreachable or JS blocked. ' +
      'Open this file in a real browser (Chrome / Firefox / Edge) to view the interactive map.</div>';
    return;
  }

  const MS = window.MapShared;
  const map = L.map("map", { zoomControl: true });
  if (MS) MS.addLayerControl(map, { defaultLayer: "hike" });

  // Pull the Fit/Download buttons up into the layer-control bar so the
  // map's whole toolbar sits on one horizontal line above the map.
  (function moveMapControlsIntoLayerBar() {
    const ctl = document.querySelector('.map-controls');
    const bar = document.querySelector('.ms-layer-bar');
    if (ctl && bar) {
      ctl.classList.add('map-controls--inbar');
      bar.appendChild(ctl);
    }
  })();
  const line = L.polyline([], { color: "#9b59b6", weight: 3, opacity: 0.85, dashArray: "8 6" }).addTo(map);

  // Waypoint + peak markers live in a togglable layerGroup. Off by default
  // because their permanent labels overlap with the basemap's own peak/place
  // labels and clutter the view; user can flip them back on via the toolbar
  // button for routes where the basemap is sparse.
  const waypointLayer = L.layerGroup();
  WAYPOINTS.forEach(([lat, lon, label, kind]) => {
    const color = kind === "start" ? "#9b59b6" : "#ff5c5c";
    L.circleMarker([lat, lon], {
      radius: 9, fillColor: color, color: "#222", weight: 2, fillOpacity: 1
    }).bindPopup(`<strong>${label}</strong>`).bindTooltip(label, {
      permanent: true, direction: "right", offset: [10, 0], className: "route-tooltip"
    }).addTo(waypointLayer);
  });
  (function wireWaypointToggle() {
    const btn = document.getElementById('waypoint-toggle');
    if (!btn) return;
    let visible = false;
    function apply() {
      if (visible) {
        if (!map.hasLayer(waypointLayer)) waypointLayer.addTo(map);
      } else if (map.hasLayer(waypointLayer)) {
        map.removeLayer(waypointLayer);
      }
      btn.classList.toggle('active', visible);
      btn.setAttribute('aria-pressed', String(visible));
    }
    apply();
    btn.addEventListener('click', () => { visible = !visible; apply(); });
  })();

  const TRACK = window.TRACK || [];
  line.setLatLngs(TRACK);
  const routeBounds = line.getBounds();
  if (TRACK.length) map.fitBounds(routeBounds, { padding: [40, 40] });
  line.bringToFront();

  // Direction arrows along the track
  const arrowLayer = L.layerGroup().addTo(map);
  const arrowSvg = '<svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 1 L10 6 L2 11 Z" fill="#9b59b6" stroke="#fff" stroke-width="1"/></svg>';
  function placeArrows() {
    arrowLayer.clearLayers();
    if (TRACK.length < 20) return;
    const step = Math.max(1, Math.floor(TRACK.length / 25));
    for (let i = step; i < TRACK.length - step; i += step) {
      const a = map.latLngToContainerPoint(L.latLng(TRACK[i]));
      const b = map.latLngToContainerPoint(L.latLng(TRACK[Math.min(i + step, TRACK.length - 1)]));
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      const icon = L.divIcon({
        html: '<div style="transform:rotate(' + angle + 'deg);width:12px;height:12px;">' + arrowSvg + '</div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
        className: ''
      });
      L.marker(L.latLng(TRACK[i]), { icon: icon, interactive: false }).addTo(arrowLayer);
    }
  }
  if (TRACK.length) { map.whenReady(placeArrows); map.on('zoomend moveend', placeArrows); }

  function fitRoute() { if (TRACK.length) map.fitBounds(routeBounds, { padding: [40, 40] }); }

  // Briefly pulse a marker at (lat, lon) on the map; used by elevation-badge clicks.
  function pulseOnMap(lat, lon) {
    if (typeof map === "undefined" || !lat || !lon) return;
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.scrollIntoView({ behavior: "smooth", block: "center" });
    map.panTo([lat, lon], { animate: true });
    const ring = L.circleMarker([lat, lon], {
      radius: 6, color: "#ff5c5c", weight: 3, fill: false, interactive: false,
    }).addTo(map);
    let r = 6, op = 1;
    const id = setInterval(() => {
      r += 3; op -= 0.08;
      ring.setRadius(r);
      ring.setStyle({ opacity: Math.max(0, op) });
      if (op <= 0) { clearInterval(id); map.removeLayer(ring); }
    }, 50);
  }
  const fitBtn = document.getElementById("fitBtn");
  if (fitBtn) fitBtn.onclick = fitRoute;
  const gpxBtn = document.getElementById("gpxBtn");
  if (gpxBtn) gpxBtn.href = GPX_FILENAME;

  // ---- Shared planning state (date selection across daily forecast tiles and hourly overlay) ----
  function todayIsoLocal() {
    const d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  const planning = (function () {
    const params = new URLSearchParams(location.search);
    let selectedDate = params.get("date") || todayIsoLocal();
    const listeners = [];
    function syncUrl(iso) {
      try {
        const url = new URL(location.href);
        if (iso === todayIsoLocal()) url.searchParams.delete("date");
        else url.searchParams.set("date", iso);
        if (url.toString() !== location.href) history.replaceState({}, "", url);
      } catch (e) { /* old browser — silently skip URL sync */ }
    }
    return {
      get date() { return selectedDate; },
      setDate(iso) {
        if (!iso || iso === selectedDate) return;
        selectedDate = iso;
        syncUrl(iso);
        listeners.forEach(fn => { try { fn(iso); } catch (e) { /* noop */ } });
      },
      onChange(fn) { listeners.push(fn); },
    };
  })();

  // ---- 7-day summit forecast (Open-Meteo) ----
  function fmtSunTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Zurich"
    });
  }
  function wxLabel(code) {
    if (code === 0)             return { text: "Clear",       cls: "clear" };
    if (code <= 3)              return { text: "Part. cloudy",cls: "" };
    if (code === 45 || code === 48) return { text: "Fog",     cls: "" };
    if (code >= 51 && code <= 57)   return { text: "Drizzle", cls: "rain" };
    if (code >= 61 && code <= 67)   return { text: "Rain",    cls: "rain" };
    if (code >= 71 && code <= 77)   return { text: "Snow",    cls: "snow" };
    if (code >= 80 && code <= 82)   return { text: "Showers", cls: "rain" };
    if (code >= 85 && code <= 86)   return { text: "Snow showers", cls: "snow" };
    if (code >= 95)             return { text: "Thunder",     cls: "storm" };
    return { text: "—", cls: "" };
  }
  async function loadForecast() {
    const container = document.getElementById("forecast");
    if (!container || !SUMMIT) return;
    const url =
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${SUMMIT.lat}&longitude=${SUMMIT.lon}&elevation=${SUMMIT.elev}` +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum," +
      "precipitation_probability_max,wind_gusts_10m_max,weather_code," +
      "sunrise,sunset" +
      "&timezone=Europe%2FZurich&forecast_days=7";
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      const d = data.daily;
      const html = d.time.map((iso, i) => {
        const date = new Date(iso + "T12:00:00");
        const day = date.toLocaleDateString("en-GB", { weekday: "short" });
        const dm  = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        const code = d.weather_code[i];
        const { text, cls } = wxLabel(code);
        const isThunder = code >= 95;
        const isSelected = (planning.date === iso);
        const pop = d.precipitation_probability_max[i];
        const popStr = pop != null && pop > 0 ? ` · ${pop}% rain` : '';
        const icon = wxIcon(code);
        return `
          <div class="forecast-day${isThunder ? " thunder" : ""}${isSelected ? " planned" : ""}"
               data-date="${iso}" role="button" tabindex="0"
               aria-pressed="${isSelected}" aria-label="Plan hike for ${day} ${dm} — ${text}">
            <div class="day">${day} <span class="date">${dm}</span></div>
            <div class="wx-icon">${icon}</div>
            <div class="wx ${cls}">${text}</div>
            <div class="temps">
              <span class="hi">${Math.round(d.temperature_2m_max[i])}°</span> /
              <span class="lo">${Math.round(d.temperature_2m_min[i])}°</span><span class="precip">${popStr}</span>
            </div>
          </div>`;
      }).join("");
      container.innerHTML = html;
      // Click to choose a day for the hourly overlay below; the highlight stays in sync.
      function syncSelected() {
        container.querySelectorAll(".forecast-day").forEach(tile => {
          const selected = tile.dataset.date === planning.date;
          tile.classList.toggle("planned", selected);
          tile.setAttribute("aria-pressed", String(selected));
        });
      }
      container.querySelectorAll(".forecast-day").forEach(tile => {
        const iso = tile.dataset.date;
        tile.addEventListener("click", () => planning.setDate(iso));
        tile.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            planning.setDate(iso);
          }
        });
      });
      planning.onChange(syncSelected);
    } catch (e) {
      container.innerHTML =
        '<p class="forecast-error">Could not load forecast (' + e.message +
        '). Check <a href="https://www.meteoswiss.admin.ch/" target="_blank">MeteoSwiss</a> manually.</p>';
    }
  }

  function setupTransit() {
    const enc = encodeURIComponent;
    // Local date/time formatter — Google Maps and SBB want the user's
    // wall-clock time in their URL params, not UTC.
    function localDT(dt) {
      return {
        date: dt.getFullYear() + "-" +
              String(dt.getMonth() + 1).padStart(2, "0") + "-" +
              String(dt.getDate()).padStart(2, "0"),
        time: String(dt.getHours()).padStart(2, "0") + ":" +
              String(dt.getMinutes()).padStart(2, "0"),
      };
    }
    // Maps "classic" URL — same one Google Maps' share button emits — which
    // unlike the api=1 format DOES support date/time/ttype params for transit.
    // dirflg: r=transit, d=driving, w=walking. ttype: arr=arrival, dep=departure.
    function mapsUrl(saddr, daddr, mode, anchor) {
      const dirflg = mode === "transit" ? "r" : (mode === "walking" ? "w" : "d");
      let url = `https://www.google.com/maps?saddr=${enc(saddr)}&daddr=${enc(daddr)}&dirflg=${dirflg}`;
      if (anchor && anchor.dt && mode === "transit") {
        const dt = localDT(anchor.dt);
        url += `&ttype=${anchor.type}&date=${dt.date}&time=${dt.time}`;
      }
      return url;
    }
    // SBB's public timetable URL accepts von/nach + date/time + zeit (an/ab).
    function sbbUrl(von, nach, anchor) {
      let url = `https://www.sbb.ch/en?von=${enc(von)}&nach=${enc(nach)}`;
      if (anchor && anchor.dt) {
        const dt = localDT(anchor.dt);
        url += `&date=${dt.date}&time=${dt.time}&zeit=${anchor.type === "arr" ? "an" : "ab"}`;
      }
      return url;
    }
    const gmapsDrive      = document.getElementById("gmaps-drive-link");
    const gmapsTransit    = document.getElementById("gmaps-transit-link");
    const sbbLink         = document.getElementById("sbb-link");
    const originLabel     = document.getElementById("transit-origin");
    const gmapsDriveEnd   = document.getElementById("gmaps-drive-link-end");
    const gmapsTransitEnd = document.getElementById("gmaps-transit-link-end");
    const sbbLinkEnd      = document.getElementById("sbb-link-end");
    const originLabelEnd  = document.getElementById("transit-origin-end");
    if (TRAILHEAD && originLabel)   originLabel.textContent   = transitOrigin;
    if (END_POINT && originLabelEnd) originLabelEnd.textContent = transitOrigin;

    function update(startDate, endDate) {
      if (TRAILHEAD) {
        const dest = `${TRAILHEAD.lat},${TRAILHEAD.lon}`;
        const arrAnchor = startDate ? { type: "arr", dt: startDate } : null;
        if (gmapsDrive)   gmapsDrive.href   = mapsUrl(transitOrigin, dest, "driving", null);
        if (gmapsTransit) gmapsTransit.href = mapsUrl(transitOrigin, dest, "transit", arrAnchor);
        if (sbbLink) {
          sbbLink.href = arrAnchor
            ? sbbUrl(transitOrigin, TRAILHEAD.name, arrAnchor)
            : (TRAILHEAD.sbb_url || sbbUrl(transitOrigin, TRAILHEAD.name, null));
        }
      }
      if (END_POINT) {
        const origin = `${END_POINT.lat},${END_POINT.lon}`;
        const depAnchor = endDate ? { type: "dep", dt: endDate } : null;
        if (gmapsDriveEnd)   gmapsDriveEnd.href   = mapsUrl(origin, transitOrigin, "driving", null);
        if (gmapsTransitEnd) gmapsTransitEnd.href = mapsUrl(origin, transitOrigin, "transit", depAnchor);
        if (sbbLinkEnd) {
          sbbLinkEnd.href = depAnchor
            ? sbbUrl(END_POINT.name, transitOrigin, depAnchor)
            : (END_POINT.sbb_url || sbbUrl(END_POINT.name, transitOrigin, null));
        }
      }
    }
    update(null, null);
    document.addEventListener("hike-times-changed", e => {
      update(e.detail && e.detail.startDate, e.detail && e.detail.endDate);
    });
  }
  setupTransit();

  function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function renderWebcams() {
    const grid = document.getElementById("webcams");
    if (!grid) return;
    if (!WEBCAMS.length) { grid.parentElement.style.display = "none"; return; }
    grid.innerHTML = WEBCAMS.map((cam, i) => {
      const url = escHtml(cam.url);
      const label = escHtml(cam.label);
      if (cam.fallback) {
        return `<figure>
          <a href="${url}" target="_blank" rel="noopener"
             style="display:flex;align-items:center;justify-content:center;height:200px;background:#f0ede4;color:var(--fg);text-decoration:none;font-weight:600;">
            View webcams →
          </a>
          <figcaption>${label}</figcaption>
        </figure>`;
      }
      return `<figure>
        <img class="webcam-img" data-idx="${i}" src="${url}" alt="${label}" loading="lazy"
             onerror="this.nextElementSibling.textContent+=' (image unavailable)';this.style.display='none';">
        <figcaption>${label}</figcaption>
      </figure>`;
    }).join("");
  }
  renderWebcams();

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]), lat2 = toRad(b[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function renderElevation() {
    const statsEl = document.getElementById("elev-stats");
    const svg     = document.getElementById("elev-chart");
    if (!svg || !TRACK.length || TRACK[0].length < 3) {
      if (statsEl) statsEl.parentElement.style.display = "none";
      return null;
    }
    const S = window.TRACK_STATS;
    let dist = 0, maxEle = -Infinity, minEle = Infinity;
    const points = [];                 // [distM, ele]
    const trackDist = new Array(TRACK.length);  // cumulative distance per TRACK index
    for (let i = 0; i < TRACK.length; i++) {
      const [lat, lon, ele] = TRACK[i];
      if (i > 0) dist += haversineMeters(TRACK[i - 1], TRACK[i]);
      trackDist[i] = dist;
      points.push([dist, ele]);
      if (ele > maxEle) maxEle = ele;
      if (ele < minEle) minEle = ele;
    }
    if (!S && statsEl) {
      let ascent = 0, descent = 0, maxGrade = 0;
      for (let i = 1; i < TRACK.length; i++) {
        const seg = haversineMeters(TRACK[i - 1], TRACK[i]);
        const dEle = TRACK[i][2] - TRACK[i - 1][2];
        if (dEle > 0) ascent += dEle; else descent -= dEle;
        if (seg > 5) { const g = Math.abs(dEle) / seg; if (g > maxGrade) maxGrade = g; }
      }
      statsEl.innerHTML = `
        <span><strong>${(dist/1000).toFixed(1)} km</strong> total</span>
        <span>↑ <strong>${Math.round(ascent)} m</strong> ascent</span>
        <span>↓ <strong>${Math.round(descent)} m</strong> descent</span>
        <span>max <strong>${maxEle} m</strong></span>
        <span>steepest <strong>${(maxGrade * 100).toFixed(0)}%</strong></span>
      `;
    }
    const totalKm = dist / 1000;
    const W = 800, H = 220, padL = 38, padR = 8, padT = 12, padB = 24;
    const x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
    const xScale = m => x0 + (m / dist) * (x1 - x0);
    const yPad = (maxEle - minEle) * 0.05 || 50;
    const yMin = minEle - yPad, yMax = maxEle + yPad;
    const yScale = e => y0 - ((e - yMin) / (yMax - yMin)) * (y0 - y1);
    const linePts = points.map(([m, e]) => `${xScale(m).toFixed(1)},${yScale(e).toFixed(1)}`).join(" ");
    const areaPts = `${x0},${y0} ` + linePts + ` ${x1},${y0}`;
    const ticks = [];
    const step = Math.max(100, Math.ceil((yMax - yMin) / 4 / 100) * 100);
    for (let e = Math.ceil(yMin / step) * step; e <= yMax; e += step) {
      ticks.push(`<text x="${x0 - 4}" y="${(yScale(e) + 3).toFixed(1)}" text-anchor="end">${e}</text>` +
                 `<line class="axis" x1="${x0}" x2="${x1}" y1="${yScale(e).toFixed(1)}" y2="${yScale(e).toFixed(1)}" stroke-opacity="0.15" />`);
    }
    const xticks = [];
    const xStep = totalKm > 12 ? 4 : (totalKm > 6 ? 2 : 1);
    for (let km = 0; km <= totalKm; km += xStep) {
      const x = xScale(km * 1000);
      xticks.push(`<text x="${x.toFixed(1)}" y="${(y0 + 14)}" text-anchor="middle">${km}km</text>`);
    }
    svg.innerHTML = `
      <polygon class="area" points="${areaPts}" />
      <polyline class="line" points="${linePts}" />
      <line class="axis" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" />
      ${ticks.join("")}
      ${xticks.join("")}
      <g class="hour-overlay" id="elev-hour-overlay"></g>
      <g class="elev-waypoints" id="elev-waypoints"></g>
    `;
    // Lookup: distance (m) → elevation (m) along the curve, linearly interpolated.
    // Lets the hour-overlay drop guide-lines from each badge down onto the curve.
    function elevAt(distM) {
      if (distM <= 0) return points[0][1];
      if (distM >= dist) return points[points.length - 1][1];
      let lo = 0, hi = points.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid][0] < distM) lo = mid; else hi = mid;
      }
      const [d0, e0] = points[lo], [d1, e1] = points[hi];
      const t = (distM - d0) / (d1 - d0 || 1);
      return e0 + (e1 - e0) * t;
    }
    return {
      svg, totalM: dist, trackDist,
      x0, x1, y0, y1,
      xScale, yScale, elevAt,
    };
  }
  const ELEV_GEOM = renderElevation();

  // ---- Waypoint markers on the elevation curve ----
  // Each `WAYPOINTS` entry is [lat, lon, label, kind]. We snap the waypoint to the
  // nearest TRACK point, drop a small marker on the curve at that distance, and
  // add a hover/tap title for the label + elevation.
  function renderWaypointTicks(geom) {
    if (!geom || !WAYPOINTS.length) return;
    const layer = document.getElementById("elev-waypoints");
    if (!layer) return;
    const SNAP_M = 250;       // skip waypoints farther than this from the track
    const out = [];
    WAYPOINTS.forEach(([lat, lon, label, kind]) => {
      if (kind === "start" || kind === "end") return;       // covered by hour-0 / route ends
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < TRACK.length; i++) {
        const d = haversineMeters([lat, lon], TRACK[i]);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI < 0 || bestD > SNAP_M) return;
      const distM = geom.trackDist[bestI];
      const x  = geom.xScale(distM);
      const yC = geom.yScale(geom.elevAt(distM));
      const yTop = yC - 14;
      out.push(
        '<g class="elev-waypoint elev-waypoint--' + (kind || "other") + '">' +
          '<title>' + label.replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</title>' +
          '<line x1="' + x.toFixed(1) + '" y1="' + yTop.toFixed(1) + '" ' +
                'x2="' + x.toFixed(1) + '" y2="' + yC.toFixed(1) + '"/>' +
          '<circle cx="' + x.toFixed(1) + '" cy="' + yC.toFixed(1) + '" r="3"/>' +
        '</g>'
      );
    });
    layer.innerHTML = out.join("");
  }
  renderWaypointTicks(ELEV_GEOM);

  // ---- Chart ↔ map hover sync ----
  function wireElevHover(geom) {
    if (!geom || !TRACK.length) return;
    const svg = geom.svg;
    const wrap = svg.closest('.elev-chart-wrap');
    const info = document.getElementById('elev-hover-info');
    if (!wrap || !info) return;
    const NS = 'http://www.w3.org/2000/svg';
    const hoverG = document.createElementNS(NS, 'g');
    hoverG.setAttribute('class', 'elev-hover');
    hoverG.style.display = 'none';
    const hoverLine = document.createElementNS(NS, 'line');
    hoverLine.setAttribute('class', 'elev-hover-x');
    hoverLine.setAttribute('y1', geom.y1);
    hoverLine.setAttribute('y2', geom.y0);
    const hoverDot = document.createElementNS(NS, 'circle');
    hoverDot.setAttribute('class', 'elev-hover-dot');
    hoverDot.setAttribute('r', '4');
    hoverG.appendChild(hoverLine);
    hoverG.appendChild(hoverDot);
    svg.appendChild(hoverG);

    const mapMarker = L.circleMarker([0, 0], {
      radius: 8, color: '#fff', weight: 2,
      fillColor: '#9b59b6', fillOpacity: 1, interactive: false,
    });
    let mapMarkerOn = false;

    function clientXToDistM(clientX) {
      const rect = svg.getBoundingClientRect();
      const VB_W = 800;
      const vbX = ((clientX - rect.left) / rect.width) * VB_W;
      const t = (vbX - geom.x0) / (geom.x1 - geom.x0);
      return Math.max(0, Math.min(geom.totalM, t * geom.totalM));
    }
    function trackIndexAtDist(distM) {
      const td = geom.trackDist;
      let lo = 0, hi = td.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (td[mid] < distM) lo = mid; else hi = mid;
      }
      return (distM - td[lo]) < (td[hi] - distM) ? lo : hi;
    }
    // Window for the local-grade calculation (m). 60 m is wide enough to
    // smooth out GPS-jitter noise but tight enough to feel like "right here".
    const SLOPE_WIN_M = 60;
    function slopeAt(distM) {
      const d0 = Math.max(0, distM - SLOPE_WIN_M);
      const d1 = Math.min(geom.totalM, distM + SLOPE_WIN_M);
      const dd = d1 - d0;
      if (dd <= 0) return 0;
      return (geom.elevAt(d1) - geom.elevAt(d0)) / dd * 100;
    }
    // T-grade for the hover position, when segments are loaded. Linear scan
    // is fine — typical routes have <20 segments. Returns null if the point
    // falls outside any segment (gaps between adjacent bisect-rounded ranges
    // are rare but possible; the badge just omits T-grade in that case).
    const TG_SEGS = (window.SAC_GRADE_SEGMENTS && window.SAC_GRADE_SEGMENTS.segments) || null;
    function tGradeAt(distM) {
      if (!TG_SEGS) return null;
      for (const s of TG_SEGS) {
        if (distM >= s.start_m && distM <= s.end_m) return s.t_grade;
      }
      return null;
    }
    function show(clientX) {
      const distM = clientXToDistM(clientX);
      const idx = trackIndexAtDist(distM);
      const tp = TRACK[idx];
      if (!tp) return;
      const ele = geom.elevAt(distM);
      const x = geom.xScale(distM);
      const y = geom.yScale(ele);
      hoverLine.setAttribute('x1', x.toFixed(1));
      hoverLine.setAttribute('x2', x.toFixed(1));
      hoverDot.setAttribute('cx', x.toFixed(1));
      hoverDot.setAttribute('cy', y.toFixed(1));
      hoverG.style.display = '';
      info.hidden = false;
      const slope = slopeAt(distM);
      const slopeStr = Math.abs(slope) < 1
        ? 'flat'
        : (slope > 0 ? '↑' : '↓') + Math.abs(Math.round(slope)) + '%';
      const grade = tGradeAt(distM);
      const gradeStr = grade ? ` · ${grade}` : '';
      info.textContent = `${(distM / 1000).toFixed(2)} km · ${Math.round(ele)} m · ${slopeStr}${gradeStr}`;
      if (!mapMarkerOn) { mapMarker.addTo(map); mapMarkerOn = true; }
      mapMarker.setLatLng([tp[0], tp[1]]);
    }
    function hide() {
      hoverG.style.display = 'none';
      info.hidden = true;
      if (mapMarkerOn) { map.removeLayer(mapMarker); mapMarkerOn = false; }
    }
    svg.addEventListener('mousemove', e => show(e.clientX));
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchstart', e => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('touchmove',  e => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('touchend', hide);
    svg.addEventListener('touchcancel', hide);
  }
  wireElevHover(ELEV_GEOM);

  // ---- SAC T-grade per-segment coloring (OSM + swissTLM3D hybrid) ----
  // Colors the elevation profile + Leaflet route polyline, builds the legend.
  // When `window.SAC_GRADE_SEGMENTS` is absent (hikes without segment data
  // generated yet), this is a no-op and the page renders with the single-
  // color route + profile defaults.
  const T_PALETTE = {
    "T1":      "#1a9850",
    "T2":      "#91cf60",
    "T3":      "#fee08b",
    "T4":      "#fc8d59",
    "T5":      "#d73027",
    "T6":      "#7a0177",
    "T2/T3":   "#b8c46a",  // swissTLM3D Bergwanderweg — muted, hints at imprecision
    "T4+":     "#c97a6a",  // swissTLM3D Alpinwanderweg — desaturated terra-cotta
    "unknown": "#888888",
  };
  const TLM_GRADES = new Set(["T2/T3", "T4+"]);
  function bisectLeftArr(arr, val) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < val) lo = m + 1; else hi = m; }
    return lo;
  }
  function bisectRightArr(arr, val) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= val) lo = m + 1; else hi = m; }
    return lo;
  }
  function segBoundsFromSegments(segments, trackDist) {
    const last = trackDist.length - 1;
    return segments.map(s => {
      let si = Math.max(0, Math.min(bisectLeftArr(trackDist, s.start_m), last));
      let ei = Math.max(si, Math.min(bisectRightArr(trackDist, s.end_m) - 1, last));
      return { start_i: si, end_i: ei, t_grade: s.t_grade, source: s.source };
    });
  }
  function colorProfileByTGrade(geom, segments) {
    if (!geom || !segments || !segments.length) return;
    const svg = geom.svg;
    // Drop the single-color area + line so we can repaint per segment.
    const oldArea = svg.querySelector('polygon.area');
    const oldLine = svg.querySelector('polyline.line');
    if (oldArea) oldArea.remove();
    if (oldLine) oldLine.remove();
    const NS = 'http://www.w3.org/2000/svg';
    const bounds = segBoundsFromSegments(segments, geom.trackDist);
    const newNodes = [];
    for (let k = 0; k < bounds.length; k++) {
      const { start_i, end_i, t_grade } = bounds[k];
      // Extend draw range by one point so adjacent segments share a boundary
      // pixel (otherwise sub-pixel slivers appear as white seams).
      const draw_end = (k + 1 < bounds.length)
        ? Math.max(end_i, bounds[k + 1].start_i)
        : end_i;
      if (draw_end <= start_i) continue;
      const color = T_PALETTE[t_grade] || T_PALETTE.unknown;
      const areaPts = [];
      const linePts = [];
      for (let i = start_i; i <= draw_end; i++) {
        const x = geom.xScale(geom.trackDist[i]).toFixed(1);
        const y = geom.yScale(TRACK[i][2]).toFixed(1);
        areaPts.push(`${x},${y}`);
        linePts.push(`${x},${y}`);
      }
      areaPts.push(`${geom.xScale(geom.trackDist[draw_end]).toFixed(1)},${geom.y0.toFixed(1)}`);
      areaPts.push(`${geom.xScale(geom.trackDist[start_i]).toFixed(1)},${geom.y0.toFixed(1)}`);
      const polygon = document.createElementNS(NS, 'polygon');
      polygon.setAttribute('points', areaPts.join(' '));
      polygon.setAttribute('fill', color);
      polygon.setAttribute('fill-opacity', '0.55');
      polygon.setAttribute('stroke', 'none');
      polygon.setAttribute('class', 'tgrade-area');
      newNodes.push(polygon);
      const polyline = document.createElementNS(NS, 'polyline');
      polyline.setAttribute('points', linePts.join(' '));
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', color);
      polyline.setAttribute('stroke-width', '1.6');
      polyline.setAttribute('class', 'tgrade-line');
      newNodes.push(polyline);
    }
    // Insert before axes/groups so the curve sits under the gridlines + waypoints.
    for (let n = newNodes.length - 1; n >= 0; n--) svg.insertBefore(newNodes[n], svg.firstChild);
  }
  function colorMapPolylineByTGrade(segments) {
    if (!segments || !segments.length || !TRACK.length) return;
    let dist = 0;
    const trackDist = new Array(TRACK.length);
    for (let i = 0; i < TRACK.length; i++) {
      if (i > 0) dist += haversineMeters(TRACK[i - 1], TRACK[i]);
      trackDist[i] = dist;
    }
    const bounds = segBoundsFromSegments(segments, trackDist);
    // Remove the single-color dashed line.
    map.removeLayer(line);
    // Draw a thick dark "casing" pass first, then the colored line on top.
    // Without this the green T2/T1 segments disappear against the green
    // basemap. Two passes keep contrast consistent across every T-grade.
    const casingLayer = L.layerGroup().addTo(map);
    const colorLayer = L.layerGroup().addTo(map);
    for (let k = 0; k < bounds.length; k++) {
      const { start_i, end_i, t_grade } = bounds[k];
      const draw_end = (k + 1 < bounds.length)
        ? Math.max(end_i, bounds[k + 1].start_i)
        : end_i;
      if (draw_end <= start_i) continue;
      const latlngs = [];
      for (let i = start_i; i <= draw_end; i++) latlngs.push([TRACK[i][0], TRACK[i][1]]);
      L.polyline(latlngs, {
        color: '#1a1a1a', weight: 7, opacity: 0.85,
        interactive: false, lineCap: 'round', lineJoin: 'round',
      }).addTo(casingLayer);
      L.polyline(latlngs, {
        color: T_PALETTE[t_grade] || T_PALETTE.unknown,
        weight: 4, opacity: 1.0, interactive: false,
        lineCap: 'round', lineJoin: 'round',
      }).addTo(colorLayer);
    }
    // Make sure the colored layer always sits above the casing.
    colorLayer.eachLayer(l => l.bringToFront());
  }
  function buildTGradeLegend(segments) {
    const el = document.getElementById('tgrade-legend');
    if (!el || !segments || !segments.length) return;
    const seen = new Set(segments.map(s => s.t_grade));
    const order = ["T1", "T2", "T2/T3", "T3", "T4", "T4+", "T5", "T6", "unknown"];
    el.innerHTML = order.filter(g => seen.has(g)).map(g => {
      const color = T_PALETTE[g] || T_PALETTE.unknown;
      const cls = TLM_GRADES.has(g) ? "tgrade-swatch tgrade-swatch--tlm" : "tgrade-swatch";
      const tag = TLM_GRADES.has(g) ? ' <em class="tgrade-src-tag">swissTLM3D</em>' : '';
      return `<span class="${cls}"><i style="background:${color}"></i>${g}${tag}</span>`;
    }).join('');
  }
  if (window.SAC_GRADE_SEGMENTS && window.SAC_GRADE_SEGMENTS.segments) {
    const segs = window.SAC_GRADE_SEGMENTS.segments;
    colorProfileByTGrade(ELEV_GEOM, segs);
    colorMapPolylineByTGrade(segs);
    buildTGradeLegend(segs);
  }

  // ---- Hourly weather overlay on the elevation profile ----
  // Walk the GPX via Naismith from a user-chosen start time; sample weather at each whole
  // hour position. One batched Open-Meteo call covers all sampled grid cells. Temperatures
  // are lapse-rate corrected from the model's grid elevation down to the actual trail point.
  // WMO code → emoji (mirrors command-center/weather.js → WeatherService.weatherIcon).
  // The U+FE0F selector forces colour-emoji presentation, matching the map markers.
  function wxIcon(code) {
    if (code == null) return "—";
    if (code <= 1)  return "☀️";
    if (code <= 2)  return "⛅";
    if (code <= 48) return "☁️";
    if (code <= 67) return "🌧️";
    if (code <= 77) return "❄️";
    if (code <= 82) return "🌧️";
    if (code <= 86) return "❄️";
    if (code >= 95) return "⛈️";
    return "🌤️";
  }
  const NIGHT_ICON = "🌙";
  function renderHourlyWeather(geom) {
    if (!geom) return;
    const C = H.pipeline_constants || {};
    const SPEED_KMH = C.naismith_speed_kmh || 5.0;
    const ASCENT_MH = C.naismith_ascent_mh || 600.0;
    const LAPSE_PER_KM = C.lapse_rate_c_per_km || 6.5;
    const MAX_HOURS = 12;
    const GRID_DEG = 0.02;            // ≈ 2 km grid (ICON-CH2 cell width)
    const BADGE_HALF_VB = 30;         // half a badge's width in viewBox units (used for packing)
    const ROW_HEIGHT_PX = 28;
    const FORECAST_DAYS = 7;          // match the daily forecast horizon above
    const STORM_CODE = 95;            // WMO codes ≥ this are thunderstorms
    const PRECIP_MIN_MM = 0.1;
    const GUST_MIN_KMH  = 30;

    const controlsEl = document.getElementById("elev-controls");
    const dayLabelEl = document.getElementById("elev-controls-day");
    const startInput = document.getElementById("elev-start-time");
    const nowBtn     = document.getElementById("elev-now-btn");
    const paceWrap   = document.getElementById("elev-controls-pace");
    const tempToggle = document.getElementById("elev-temp-toggle");
    const endsEl     = document.getElementById("elev-controls-end");
    const statusEl   = document.getElementById("elev-controls-status");
    const badgesEl   = document.getElementById("elev-hour-badges");
    const overlayG   = document.getElementById("elev-hour-overlay");
    if (!controlsEl || !startInput || !badgesEl || !overlayG) return;
    if (!TRACK || TRACK.length < 2) return;
    controlsEl.hidden = false;
    function toIsoDate(d) {
      return d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0");
    }

    let totalAscent = 0;
    for (let i = 1; i < TRACK.length; i++) {
      const d = TRACK[i][2] - TRACK[i - 1][2];
      if (d > 0) totalAscent += d;
    }
    // Pace + temperature mode are user-tweakable; everything downstream reads them via accessors.
    let paceMul = 1.0;
    let useFeelsLike = false;
    function effectiveSpeed()  { return SPEED_KMH * paceMul; }
    function effectiveAscent() { return ASCENT_MH * paceMul; }
    function totalHoursNow()   { return (geom.totalM / 1000) / effectiveSpeed() + totalAscent / effectiveAscent(); }

    function startDateFromInput() {
      const time = startInput.value || "10:00";
      const [hh, mm] = time.split(":").map(Number);
      const dateStr = planning.date || todayIsoLocal();
      const [y, mo, d] = dateStr.split("-").map(Number);
      return new Date(y, (mo || 1) - 1, d || 1, hh || 10, mm || 0, 0, 0);
    }
    function dayWording(iso) {
      const today = todayIsoLocal();
      if (iso === today) return "Today";
      const d = new Date(iso + "T12:00:00");
      const todayD = new Date(today + "T12:00:00");
      const diff = Math.round((d - todayD) / 86400000);
      if (diff === 1) return "Tomorrow";
      return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    }
    function fmtTime(d) {
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    function localIsoHour(d) {
      return d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0") + "T" +
        String(d.getHours()).padStart(2, "0") + ":00";
    }
    function gridKey(lat, lon) {
      return (Math.round(lat / GRID_DEG) * GRID_DEG).toFixed(3) + "_" +
             (Math.round(lon / GRID_DEG) * GRID_DEG).toFixed(3);
    }

    // Walk TRACK forward, interpolating exact lat/lon/ele at each integer hour past start.
    // The leading mark (kind: "start") is the trailhead itself — weather at the moment you
    // set off. The trailing mark (kind: "end") is the route end at total-Naismith-time.
    function naismithHourPoints(startDate) {
      const marks = [{
        kind: "start",
        time: new Date(startDate.getTime()),
        distM: 0,
        lat: TRACK[0][0],
        lon: TRACK[0][1],
        ele: TRACK[0][2],
      }];
      let cumH = 0;
      let nextHour = 1;
      const speedKmh = effectiveSpeed();
      const ascentMh = effectiveAscent();
      for (let i = 1; i < TRACK.length && nextHour <= MAX_HOURS; i++) {
        const a = TRACK[i - 1], b = TRACK[i];
        const segM = haversineMeters(a, b);
        const dEle = b[2] - a[2];
        const segH = (segM / 1000) / speedKmh + Math.max(0, dEle) / ascentMh;
        if (segH <= 0) { continue; }
        while (nextHour <= MAX_HOURS && nextHour <= cumH + segH) {
          const t = (nextHour - cumH) / segH;
          const lat = a[0] + (b[0] - a[0]) * t;
          const lon = a[1] + (b[1] - a[1]) * t;
          const ele = a[2] + (b[2] - a[2]) * t;
          const distM = geom.trackDist[i - 1] + (geom.trackDist[i] - geom.trackDist[i - 1]) * t;
          marks.push({
            kind: "hour",
            time: new Date(startDate.getTime() + nextHour * 3600 * 1000),
            distM, lat, lon, ele,
          });
          nextHour++;
        }
        cumH += segH;
      }
      const last = TRACK[TRACK.length - 1];
      marks.push({
        kind: "end",
        time: new Date(startDate.getTime() + totalHoursNow() * 3600 * 1000),
        distM: geom.totalM,
        lat: last[0],
        lon: last[1],
        ele: last[2],
      });
      return marks;
    }

    let forecastCache = null;
    async function fetchHourly(hourPoints) {
      if (forecastCache) return forecastCache;
      if (!hourPoints.length) return null;
      const seen = new Map();
      for (const p of hourPoints) {
        const k = gridKey(p.lat, p.lon);
        if (!seen.has(k)) seen.set(k, { key: k, lat: p.lat, lon: p.lon });
      }
      const grid = [...seen.values()];
      const params = new URLSearchParams({
        latitude: grid.map(g => g.lat.toFixed(4)).join(","),
        longitude: grid.map(g => g.lon.toFixed(4)).join(","),
        hourly: "temperature_2m,apparent_temperature,weather_code,wind_gusts_10m,precipitation",
        daily: "sunset",
        timezone: "Europe/Zurich",
        forecast_days: String(FORECAST_DAYS),
      });
      const r = await fetch("https://api.open-meteo.com/v1/forecast?" + params.toString());
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      const arr = Array.isArray(data) ? data : [data];
      const byGrid = new Map();
      grid.forEach((g, i) => {
        const d = arr[i];
        if (!d) return;
        byGrid.set(g.key, {
          gridElev: d.elevation || 0,
          hourly: d.hourly || {},
          daily: d.daily || {},
        });
      });
      forecastCache = { byGrid };
      return forecastCache;
    }

    // Resolve forecast data at one hour-point: returns the matched grid cell and hourly index,
    // plus the lapse-corrected temperature (either actual or apparent depending on mode).
    function lookupForecast(p, fc) {
      if (!fc) return null;
      const g = fc.byGrid.get(gridKey(p.lat, p.lon));
      if (!g || !g.hourly || !g.hourly.time) return null;
      const idx = g.hourly.time.indexOf(localIsoHour(p.time));
      if (idx < 0) return null;
      const h = g.hourly;
      const rawSeries = useFeelsLike && h.apparent_temperature ? h.apparent_temperature : h.temperature_2m;
      const rawT = rawSeries && rawSeries[idx];
      const temp = (rawT != null)
        ? rawT - (p.ele - (g.gridElev || 0)) * (LAPSE_PER_KM / 1000)
        : null;
      return {
        temp,
        code:   h.weather_code   && h.weather_code[idx],
        precip: h.precipitation  && h.precipitation[idx],
        gust:   h.wind_gusts_10m && h.wind_gusts_10m[idx],
      };
    }
    // Pack badges into as many rows as needed: each badge takes the lowest row that doesn't
    // overlap an already-placed badge within ±BADGE_HALF_VB. badgesEl height grows to fit.
    function packRows(placed) {
      const order = placed.slice().sort((a, b) => a.xVB - b.xVB);
      const rowRight = [];
      let maxRow = 0;
      for (const p of order) {
        const leftEdge = p.xVB - BADGE_HALF_VB;
        let row = 0;
        while (row < rowRight.length && leftEdge < rowRight[row] + 2) row++;
        p.row = row;
        rowRight[row] = p.xVB + BADGE_HALF_VB;
        if (row > maxRow) maxRow = row;
      }
      return maxRow;
    }
    // Find runs of consecutive hour-points with WMO storm codes (≥95) and return their x-spans.
    function findStormRuns(hourPoints, lookups) {
      const runs = [];
      let runStart = -1;
      for (let i = 0; i < hourPoints.length; i++) {
        const lu = lookups[i];
        const isStorm = lu && lu.code != null && lu.code >= STORM_CODE;
        if (isStorm && runStart < 0) runStart = i;
        if ((!isStorm || i === hourPoints.length - 1) && runStart >= 0) {
          const end = isStorm ? i : i - 1;
          runs.push({ start: runStart, end });
          runStart = -1;
        }
      }
      return runs;
    }
    function renderBadges(hourPoints, fc, startDate) {
      badgesEl.innerHTML = "";
      overlayG.innerHTML = "";
      if (!hourPoints.length) return;
      // Sunset for the selected day (date picker may have moved off "today").
      let sunsetDate = null;
      if (fc) {
        const startIsoDay = toIsoDate(startDate);
        for (const v of fc.byGrid.values()) {
          const days = v.daily && v.daily.time;
          if (!days) continue;
          const di = days.indexOf(startIsoDay);
          const iso = di >= 0 && v.daily.sunset ? v.daily.sunset[di] : null;
          if (iso) { sunsetDate = new Date(iso); break; }
        }
      }
      const lookups = hourPoints.map(p => lookupForecast(p, fc));
      // Storm bands first, so badges paint on top.
      const stormRuns = findStormRuns(hourPoints, lookups);
      stormRuns.forEach(run => {
        const xA = geom.xScale(hourPoints[run.start].distM);
        const xB = geom.xScale(hourPoints[run.end].distM);
        const width = Math.max(xB - xA, 6);
        overlayG.insertAdjacentHTML("beforeend",
          '<rect class="elev-storm-band" x="' + xA.toFixed(1) + '" y="' + geom.y1.toFixed(1) + '" ' +
            'width="' + width.toFixed(1) + '" height="' + (geom.y0 - geom.y1).toFixed(1) + '"/>' +
          '<text class="elev-storm-label" x="' + ((xA + xB) / 2).toFixed(1) + '" y="' + (geom.y1 + 12).toFixed(1) + '" ' +
            'text-anchor="middle">⛈ storm ' + fmtTime(hourPoints[run.start].time) +
            (run.end !== run.start ? "–" + fmtTime(hourPoints[run.end].time) : "") + '</text>'
        );
      });
      const placed = hourPoints.map((p, i) => {
        const xVB = geom.xScale(p.distM);
        const leftPct = ((xVB - geom.x0) / (geom.x1 - geom.x0)) * 100;
        return Object.assign({}, p, {
          xVB,
          leftPct: Math.max(3, Math.min(97, leftPct)),
          row: 0,
          lookup: lookups[i],
        });
      });
      const maxRow = packRows(placed);
      badgesEl.style.minHeight = ((maxRow + 1) * ROW_HEIGHT_PX + 28) + "px";
      placed.forEach(p => {
        const lu = p.lookup || {};
        const postSunset = !!(sunsetDate && p.time > sunsetDate);
        const label = fmtTime(p.time);
        const tempStr = (lu.temp != null) ? Math.round(lu.temp) + "°" : "";
        const iconStr = postSunset ? NIGHT_ICON : wxIcon(lu.code);
        const isStorm = lu.code != null && lu.code >= STORM_CODE;
        const isWindy = lu.gust != null && lu.gust >= GUST_MIN_KMH;
        const isWet   = lu.precip != null && lu.precip >= PRECIP_MIN_MM;
        const kindClass = p.kind === "start" ? " elev-hour-badge--start"
                       : p.kind === "end"   ? " elev-hour-badge--end"
                       : "";
        const badge = document.createElement("div");
        badge.className = "elev-hour-badge"
          + (postSunset ? " elev-hour-badge--night" : "")
          + (isStorm    ? " elev-hour-badge--storm" : "")
          + (!isStorm && isWindy ? " elev-hour-badge--wind" : "")
          + kindClass;
        badge.style.left = p.leftPct.toFixed(2) + "%";
        badge.style.top  = (p.row * ROW_HEIGHT_PX) + "px";
        // Daylight remaining on the end badge (only when end < sunset).
        let extraTitle = "";
        if (p.kind === "end" && sunsetDate && p.time < sunsetDate) {
          const mins = Math.round((sunsetDate - p.time) / 60000);
          const hh = Math.floor(mins / 60), mm = mins - hh * 60;
          extraTitle = " — " + (hh ? hh + "h " : "") + mm + "m daylight left";
        }
        badge.title = (p.kind === "start" ? "Trailhead — click to show on map"
                     : p.kind === "end"   ? "Route end — click to show on map"
                     : "Click to show this point on the map") + extraTitle;
        badge.dataset.lat = p.lat.toFixed(5);
        badge.dataset.lon = p.lon.toFixed(5);
        badge.addEventListener("click", () => pulseOnMap(p.lat, p.lon));
        const prefix = p.kind === "start" ? '<span class="elev-hour-kind">▶</span> '
                     : p.kind === "end"   ? '<span class="elev-hour-kind">■</span> '
                     : "";
        const extras = [];
        if (isWet)   extras.push('<span class="elev-hour-precip">' + lu.precip.toFixed(1) + ' mm</span>');
        if (isWindy) extras.push('<span class="elev-hour-gust">g ' + Math.round(lu.gust) + '</span>');
        badge.innerHTML =
          '<div class="elev-hour-time">' + prefix + label + '</div>' +
          '<div class="elev-hour-data">' +
            '<span class="elev-hour-icon">' + iconStr + '</span>' +
            '<span class="elev-hour-temp">' + tempStr + '</span>' +
          '</div>' +
          (extras.length ? '<div class="elev-hour-extras">' + extras.join("") + '</div>' : "");
        badgesEl.appendChild(badge);
        const yCurve = geom.yScale(geom.elevAt(p.distM));
        overlayG.insertAdjacentHTML("beforeend",
          '<line class="elev-hour-guide' + (postSunset ? ' elev-hour-guide--night' : '') + '" ' +
          'x1="' + p.xVB.toFixed(1) + '" y1="' + geom.y1.toFixed(1) + '" ' +
          'x2="' + p.xVB.toFixed(1) + '" y2="' + yCurve.toFixed(1) + '"/>'
        );
      });
    }

    async function redraw() {
      const startDate = startDateFromInput();
      const hourPoints = naismithHourPoints(startDate);
      const total = totalHoursNow();
      const endDate = new Date(startDate.getTime() + total * 3600 * 1000);
      if (dayLabelEl) dayLabelEl.textContent = dayWording(planning.date);
      if (endsEl) {
        const hh = Math.floor(total);
        const mm = Math.round((total - hh) * 60);
        const sameDay = toIsoDate(startDate) === toIsoDate(endDate);
        const endStr = sameDay ? fmtTime(endDate)
          : fmtTime(endDate) + " (+" + Math.round((endDate - startDate) / 86400000) + "d)";
        endsEl.textContent = "· " + hh + "h " + String(mm).padStart(2, "0") + "m · ends " + endStr;
      }
      // Tell the transit links about the freshly computed start/end so they
      // can rebuild their URLs with arrival_time (Maps trip to trailhead) and
      // departure_time (Maps return from end point).
      document.dispatchEvent(new CustomEvent("hike-times-changed", {
        detail: { startDate, endDate },
      }));
      if (statusEl) statusEl.textContent = forecastCache ? "" : "loading weather…";
      try {
        const fc = await fetchHourly(hourPoints);
        renderBadges(hourPoints, fc, startDate);
        if (statusEl) statusEl.textContent = "";
      } catch (e) {
        renderBadges(hourPoints, null, startDate);
        if (statusEl) statusEl.textContent = "weather unavailable";
      }
    }

    // If selected day is today and the chosen start time is already in the past, snap
    // start to the next quarter-hour so the badges show forecasts the user can act on.
    function maybeShiftPastStart() {
      if (planning.date !== todayIsoLocal()) return;
      const sd = startDateFromInput();
      if (sd.getTime() > Date.now()) return;
      const d = new Date();
      let m = Math.ceil(d.getMinutes() / 15) * 15;
      if (m === 60) { d.setHours(d.getHours() + 1); m = 0; }
      d.setMinutes(m, 0, 0);
      startInput.value = String(d.getHours()).padStart(2, "0") + ":" + String(m).padStart(2, "0");
    }

    startInput.addEventListener("change", redraw);
    // Mouse-wheel over the start-time input nudges by 10-minute increments
    // (matches the input's step). Only active while the input is focused so
    // accidental scrolls over the controls bar don't change planning state.
    const STEP_MIN = 10, DAY_LAST_MIN = 23 * 60 + 50;
    startInput.addEventListener("wheel", (e) => {
      if (document.activeElement !== startInput) return;
      e.preventDefault();
      const [h, m] = (startInput.value || "10:00").split(":").map(Number);
      const cur = h * 60 + m;
      const delta = e.deltaY < 0 ? STEP_MIN : -STEP_MIN;  // wheel up = later
      const next = Math.max(0, Math.min(DAY_LAST_MIN, cur + delta));
      const hh = String(Math.floor(next / 60)).padStart(2, "0");
      const mm = String(next % 60).padStart(2, "0");
      startInput.value = `${hh}:${mm}`;
      startInput.dispatchEvent(new Event("change", { bubbles: true }));
    }, { passive: false });
    planning.onChange(() => { maybeShiftPastStart(); redraw(); });
    if (nowBtn) {
      nowBtn.addEventListener("click", () => {
        const d = new Date();
        let m = Math.ceil(d.getMinutes() / 15) * 15;
        if (m === 60) { d.setHours(d.getHours() + 1); m = 0; }
        d.setMinutes(m, 0, 0);
        startInput.value = String(d.getHours()).padStart(2, "0") + ":" + String(m).padStart(2, "0");
        planning.setDate(toIsoDate(d));
        redraw();
      });
    }
    if (paceWrap) {
      paceWrap.querySelectorAll(".elev-pace-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          paceWrap.querySelectorAll(".elev-pace-btn").forEach(b => b.classList.remove("elev-pace-btn--active"));
          btn.classList.add("elev-pace-btn--active");
          paceMul = parseFloat(btn.dataset.pace) || 1.0;
          redraw();
        });
      });
    }
    if (tempToggle) {
      tempToggle.addEventListener("click", () => {
        useFeelsLike = !useFeelsLike;
        tempToggle.setAttribute("aria-pressed", String(useFeelsLike));
        tempToggle.textContent = useFeelsLike ? "actual" : "feels-like";
        redraw();
      });
    }
    maybeShiftPastStart();
    redraw();
  }
  renderHourlyWeather(ELEV_GEOM);

  const hikrLink = document.getElementById("hikr-link");
  const reportsUpdated = document.getElementById("reports-updated");
  if (hikrLink && HIKR_INDEX_URL) hikrLink.href = HIKR_INDEX_URL;
  if (reportsUpdated && REPORTS_UPDATED) reportsUpdated.textContent = REPORTS_UPDATED;

  const pageGen = document.getElementById("page-generated");
  if (pageGen && PAGE_GENERATED) pageGen.textContent = PAGE_GENERATED;

  if (REPORTS_UPDATED) {
    const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;
    const reportsAge = Date.now() - new Date(REPORTS_UPDATED + "T00:00:00").getTime();
    if (reportsAge > SIX_MONTHS_MS) {
      const tr = document.querySelector(".trip-reports");
      if (tr) tr.insertAdjacentHTML(
        "beforebegin",
        '<p class="forecast-error">Trip-report digest is older than 6 months — consider regenerating.</p>'
      );
    }
  }

  window.addEventListener("focus", () => {
    document.querySelectorAll(".webcam-img").forEach(img => {
      const idx = +img.dataset.idx;
      const cam = WEBCAMS[idx];
      const base = cam && cam.url;
      if (base) img.src = base + (base.includes("?") ? "&" : "?") + "t=" + Date.now();
    });
  });

  loadForecast();
})();
