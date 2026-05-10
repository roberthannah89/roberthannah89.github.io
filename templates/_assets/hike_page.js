// Shared hike-page runtime. Reads per-hike data from window.HIKE (set inline by the page).
(function () {
  "use strict";
  const H = window.HIKE || {};
  const SUMMIT = H.summit, TRAILHEAD = H.trailhead, WAYPOINTS = H.waypoints || [];
  const TRANSIT_DEST = H.transit_dest, HIKR_INDEX_URL = H.hikr_index_url;
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

  const swissTopo = L.tileLayer(
    "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
    { attribution: "© swisstopo", maxZoom: 18 });
  const swissHike = L.layerGroup([
    L.tileLayer(
      "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
      { attribution: "© swisstopo", maxZoom: 18 }),
    L.tileLayer(
      "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swisstlm3d-wanderwege/default/current/3857/{z}/{x}/{y}.png",
      { attribution: "© swisstopo (Wanderwege)", maxZoom: 18 }),
  ]);
  const swissAerial = L.tileLayer(
    "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg",
    { attribution: "© swisstopo (SWISSIMAGE)", maxZoom: 19 });
  const osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: "© OpenStreetMap contributors", maxZoom: 19 });
  const layers = { topo: swissTopo, hike: swissHike, aerial: swissAerial, osm: osm };

  const map = L.map("map", { layers: [swissHike], zoomControl: true });
  const halo = L.polyline([], { color: "white", weight: 8, opacity: 0.9 }).addTo(map);
  const line = L.polyline([], { color: "#ff5c5c", weight: 4, opacity: 1 }).addTo(map);

  WAYPOINTS.forEach(([lat, lon, label, kind]) => {
    const color = kind === "start" ? "#2e7d32" : "#ff5c5c";
    L.circleMarker([lat, lon], {
      radius: 9, fillColor: color, color: "#222", weight: 2, fillOpacity: 1
    }).addTo(map).bindPopup(`<strong>${label}</strong>`).bindTooltip(label, {
      permanent: true, direction: "right", offset: [10, 0], className: "route-tooltip"
    });
  });

  const TRACK = window.TRACK || [];
  halo.setLatLngs(TRACK);
  line.setLatLngs(TRACK);
  const routeBounds = line.getBounds();
  if (TRACK.length) map.fitBounds(routeBounds, { padding: [40, 40] });
  halo.bringToFront(); line.bringToFront();

  function fitRoute() { if (TRACK.length) map.fitBounds(routeBounds, { padding: [40, 40] }); }
  const fitBtn = document.getElementById("fitBtn");
  if (fitBtn) fitBtn.onclick = fitRoute;
  const gpxBtn = document.getElementById("gpxBtn");
  if (gpxBtn) gpxBtn.href = GPX_FILENAME;

  let current = swissHike;
  document.querySelectorAll(".map-controls button[data-layer]").forEach(btn => {
    btn.onclick = () => {
      const next = layers[btn.dataset.layer];
      if (next === current) return;
      map.removeLayer(current);
      next.addTo(map);
      halo.bringToFront(); line.bringToFront();
      current = next;
      document.querySelectorAll(".map-controls button[data-layer]").forEach(b =>
        b.classList.toggle("active", b === btn));
    };
  });

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
    const params = new URLSearchParams(location.search);
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
        const planned = (params.get("date") === iso);
        const pop = d.precipitation_probability_max[i];
        return `
          <div class="forecast-day${isThunder ? " thunder" : ""}${planned ? " planned" : ""}">
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
    } catch (e) {
      container.innerHTML =
        '<p class="forecast-error">Could not load forecast (' + e.message +
        '). Check <a href="https://www.meteoswiss.admin.ch/" target="_blank">MeteoSwiss</a> manually.</p>';
    }
  }

  function setupTransit() {
    const embed       = document.getElementById("transit-embed");
    const iframe      = document.getElementById("transit-iframe");
    const gmapsLink   = document.getElementById("gmaps-link");
    const sbbLink     = document.getElementById("sbb-link");
    const originLabel = document.getElementById("transit-origin");
    const destLabel   = document.getElementById("transit-dest");
    if (!embed || !TRANSIT_DEST) return;
    if (originLabel) originLabel.textContent = transitOrigin;
    if (destLabel)   destLabel.textContent   = TRANSIT_DEST;
    const enc = encodeURIComponent;
    if (gmapsLink) gmapsLink.href = `https://www.google.com/maps/dir/?api=1&origin=${enc(transitOrigin)}&destination=${enc(TRANSIT_DEST)}&travelmode=transit`;
    if (sbbLink)   sbbLink.href   = `https://www.sbb.ch/en?stops=${enc(transitOrigin)}%20%E2%86%92%20${enc(TRANSIT_DEST)}`;
    if (mapsKey && iframe) {
      iframe.src = `https://www.google.com/maps/embed/v1/directions?key=${enc(mapsKey)}&origin=${enc(transitOrigin)}&destination=${enc(TRANSIT_DEST)}&mode=transit`;
      embed.classList.remove("empty");
    }
  }
  setupTransit();

  function renderWebcams() {
    const grid = document.getElementById("webcams");
    if (!grid) return;
    if (!WEBCAMS.length) { grid.parentElement.style.display = "none"; return; }
    grid.innerHTML = WEBCAMS.map((cam, i) => {
      if (cam.fallback) {
        return `<figure>
          <a href="${cam.url}" target="_blank" rel="noopener"
             style="display:flex;align-items:center;justify-content:center;height:200px;background:#f0ede4;color:var(--fg);text-decoration:none;font-weight:600;">
            View webcams →
          </a>
          <figcaption>${cam.label}</figcaption>
        </figure>`;
      }
      return `<figure>
        <img class="webcam-img" data-idx="${i}" src="${cam.url}" alt="${cam.label}" loading="lazy"
             onerror="this.parentElement.querySelector('figcaption').insertAdjacentHTML('beforeend',' <em>(image unavailable)</em>');this.style.display='none';">
        <figcaption>${cam.label}</figcaption>
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
    const stats = document.getElementById("elev-stats");
    const svg   = document.getElementById("elev-chart");
    if (!stats || !svg || !TRACK.length || TRACK[0].length < 3) {
      if (stats) stats.parentElement.style.display = "none";
      return;
    }
    let dist = 0, ascent = 0, descent = 0, maxEle = -Infinity, minEle = Infinity;
    let maxGrade = 0;
    const points = [];
    for (let i = 0; i < TRACK.length; i++) {
      const [lat, lon, ele] = TRACK[i];
      if (i > 0) {
        const seg = haversineMeters(TRACK[i - 1], TRACK[i]);
        dist += seg;
        const dEle = ele - TRACK[i - 1][2];
        if (dEle > 0) ascent += dEle; else descent -= dEle;
        if (seg > 5) {
          const grade = Math.abs(dEle) / seg;
          if (grade > maxGrade) maxGrade = grade;
        }
      }
      points.push([dist, ele]);
      if (ele > maxEle) maxEle = ele;
      if (ele < minEle) minEle = ele;
    }
    const totalKm = dist / 1000;
    stats.innerHTML = `
      <span><strong>${totalKm.toFixed(1)} km</strong> total</span>
      <span>↑ <strong>${Math.round(ascent)} m</strong> ascent</span>
      <span>↓ <strong>${Math.round(descent)} m</strong> descent</span>
      <span>max <strong>${maxEle} m</strong></span>
      <span>steepest <strong>${(maxGrade * 100).toFixed(0)}%</strong></span>
    `;
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
    `;
  }
  renderElevation();

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
      const base = WEBCAMS[idx]?.url;
      if (base) img.src = base + (base.includes("?") ? "&" : "?") + "t=" + Date.now();
    });
  });

  loadForecast();
})();
