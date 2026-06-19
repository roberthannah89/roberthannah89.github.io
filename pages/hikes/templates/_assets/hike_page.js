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
  const line = L.polyline([], { color: "#9b59b6", weight: 3, opacity: 0.85, dashArray: "8 6" }).addTo(map);

  WAYPOINTS.forEach(([lat, lon, label, kind]) => {
    const color = kind === "start" ? "#9b59b6" : "#ff5c5c";
    L.circleMarker([lat, lon], {
      radius: 9, fillColor: color, color: "#222", weight: 2, fillOpacity: 1
    }).addTo(map).bindPopup(`<strong>${label}</strong>`).bindTooltip(label, {
      permanent: true, direction: "right", offset: [10, 0], className: "route-tooltip"
    });
  });

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
        return `
          <div class="forecast-day${isThunder ? " thunder" : ""}${isSelected ? " planned" : ""}"
               data-date="${iso}" role="button" tabindex="0"
               aria-pressed="${isSelected}" aria-label="Plan hike for ${day} ${dm}">
            <div class="day">${day}</div>
            <div class="date">${dm}</div>
            <div class="wx ${cls}">${text}</div>
            <div class="temps">
              <span class="hi">${Math.round(d.temperature_2m_max[i])}°</span> /
              <span class="lo">${Math.round(d.temperature_2m_min[i])}°</span>
            </div>
            <div class="precip">${d.precipitation_sum[i].toFixed(1)} mm${pop != null ? " · " + pop + "%" : ""}</div>
            <div class="wind">gust ${Math.round(d.wind_gusts_10m_max[i])} km/h</div>
            <div class="sun">↑ ${fmtSunTime(d.sunrise[i])} · ↓ ${fmtSunTime(d.sunset[i])}</div>
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
    // --- Start (trailhead) ---
    const gmapsDrive   = document.getElementById("gmaps-drive-link");
    const gmapsTransit = document.getElementById("gmaps-transit-link");
    const sbbLink      = document.getElementById("sbb-link");
    const originLabel  = document.getElementById("transit-origin");
    if (TRAILHEAD) {
      if (originLabel) originLabel.textContent = transitOrigin;
      const dest = `${TRAILHEAD.lat},${TRAILHEAD.lon}`;
      if (gmapsDrive)   gmapsDrive.href   = `https://www.google.com/maps/dir/?api=1&origin=${enc(transitOrigin)}&destination=${dest}&travelmode=driving`;
      if (gmapsTransit) gmapsTransit.href = `https://www.google.com/maps/dir/?api=1&origin=${enc(transitOrigin)}&destination=${dest}&travelmode=transit`;
      if (sbbLink)      sbbLink.href      = TRAILHEAD.sbb_url || `https://www.sbb.ch/en?von=${enc(transitOrigin)}&nach=${enc(TRAILHEAD.name)}`;
    }
    // --- End point (return journey) ---
    const gmapsDriveEnd   = document.getElementById("gmaps-drive-link-end");
    const gmapsTransitEnd = document.getElementById("gmaps-transit-link-end");
    const sbbLinkEnd      = document.getElementById("sbb-link-end");
    const originLabelEnd  = document.getElementById("transit-origin-end");
    if (END_POINT) {
      if (originLabelEnd) originLabelEnd.textContent = transitOrigin;
      const origin = `${END_POINT.lat},${END_POINT.lon}`;
      if (gmapsDriveEnd)   gmapsDriveEnd.href   = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${enc(transitOrigin)}&travelmode=driving`;
      if (gmapsTransitEnd) gmapsTransitEnd.href = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${enc(transitOrigin)}&travelmode=transit`;
      if (sbbLinkEnd)      sbbLinkEnd.href      = END_POINT.sbb_url || `https://www.sbb.ch/en?von=${enc(END_POINT.name)}&nach=${enc(transitOrigin)}`;
    }
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
    const COLLISION_VB = 40;          // viewBox-x distance below which badges stagger
    const FORECAST_DAYS = 7;          // match the daily forecast horizon above

    const controlsEl = document.getElementById("elev-controls");
    const dayLabelEl = document.getElementById("elev-controls-day");
    const startInput = document.getElementById("elev-start-time");
    const nowBtn     = document.getElementById("elev-now-btn");
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
    const totalHours = (geom.totalM / 1000) / SPEED_KMH + totalAscent / ASCENT_MH;

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
    // The leading mark (hour 0) is the trailhead itself — weather at the moment you set off.
    function naismithHourPoints(startDate) {
      const marks = [{
        hour: 0,
        time: new Date(startDate.getTime()),
        distM: 0,
        lat: TRACK[0][0],
        lon: TRACK[0][1],
        ele: TRACK[0][2],
      }];
      let cumH = 0;
      let nextHour = 1;
      for (let i = 1; i < TRACK.length && nextHour <= MAX_HOURS; i++) {
        const a = TRACK[i - 1], b = TRACK[i];
        const segM = haversineMeters(a, b);
        const dEle = b[2] - a[2];
        const segH = (segM / 1000) / SPEED_KMH + Math.max(0, dEle) / ASCENT_MH;
        if (segH <= 0) { continue; }
        while (nextHour <= MAX_HOURS && nextHour <= cumH + segH) {
          const t = (nextHour - cumH) / segH;
          const lat = a[0] + (b[0] - a[0]) * t;
          const lon = a[1] + (b[1] - a[1]) * t;
          const ele = a[2] + (b[2] - a[2]) * t;
          const distM = geom.trackDist[i - 1] + (geom.trackDist[i] - geom.trackDist[i - 1]) * t;
          marks.push({
            hour: nextHour,
            time: new Date(startDate.getTime() + nextHour * 3600 * 1000),
            distM, lat, lon, ele,
          });
          nextHour++;
        }
        cumH += segH;
      }
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
        hourly: "temperature_2m,weather_code,wind_gusts_10m,precipitation",
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

    function renderBadges(hourPoints, fc, startDate) {
      badgesEl.innerHTML = "";
      overlayG.innerHTML = "";
      if (!hourPoints.length) return;
      // Look up sunset for the actual day the hike starts (date picker may have
      // moved off "today"). All grid cells share the same day index because the
      // batched fetch uses one timezone.
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
      const placed = hourPoints.map(p => {
        const xVB = geom.xScale(p.distM);
        const leftPct = ((xVB - geom.x0) / (geom.x1 - geom.x0)) * 100;
        return Object.assign({}, p, {
          xVB,
          leftPct: Math.max(3, Math.min(97, leftPct)),
          row: 0,
        });
      });
      for (let i = 1; i < placed.length; i++) {
        if (placed[i].xVB - placed[i - 1].xVB < COLLISION_VB && placed[i - 1].row === 0) {
          placed[i].row = 1;
        }
      }
      placed.forEach(p => {
        let temp = null, code = null;
        if (fc) {
          const g = fc.byGrid.get(gridKey(p.lat, p.lon));
          if (g && g.hourly && g.hourly.time) {
            const idx = g.hourly.time.indexOf(localIsoHour(p.time));
            if (idx >= 0) {
              const rawT = g.hourly.temperature_2m && g.hourly.temperature_2m[idx];
              code = g.hourly.weather_code && g.hourly.weather_code[idx];
              if (rawT != null) {
                temp = rawT - (p.ele - (g.gridElev || 0)) * (LAPSE_PER_KM / 1000);
              }
            }
          }
        }
        const postSunset = !!(sunsetDate && p.time > sunsetDate);
        const label = fmtTime(p.time);
        const tempStr = (temp != null) ? Math.round(temp) + "°" : "";
        const iconStr = postSunset ? NIGHT_ICON : wxIcon(code);
        const badge = document.createElement("div");
        badge.className = "elev-hour-badge"
          + (p.row === 1 ? " elev-hour-badge--stagger" : "")
          + (postSunset ? " elev-hour-badge--night" : "");
        badge.style.left = p.leftPct.toFixed(2) + "%";
        badge.title = "Click to show this point on the map";
        badge.dataset.lat = p.lat.toFixed(5);
        badge.dataset.lon = p.lon.toFixed(5);
        badge.addEventListener("click", () => pulseOnMap(p.lat, p.lon));
        badge.innerHTML =
          '<div class="elev-hour-time">' + label + '</div>' +
          '<div class="elev-hour-data">' +
            '<span class="elev-hour-icon">' + iconStr + '</span>' +
            '<span class="elev-hour-temp">' + tempStr + '</span>' +
          '</div>';
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
      if (dayLabelEl) dayLabelEl.textContent = dayWording(planning.date);
      if (endsEl) {
        const endDate = new Date(startDate.getTime() + totalHours * 3600 * 1000);
        const hh = Math.floor(totalHours);
        const mm = Math.round((totalHours - hh) * 60);
        const sameDay = toIsoDate(startDate) === toIsoDate(endDate);
        const endStr = sameDay ? fmtTime(endDate)
          : fmtTime(endDate) + " (+" + Math.round((endDate - startDate) / 86400000) + "d)";
        endsEl.textContent = "· " + hh + "h " + String(mm).padStart(2, "0") + "m · ends " + endStr;
      }
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

    startInput.addEventListener("change", redraw);
    planning.onChange(redraw);
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
