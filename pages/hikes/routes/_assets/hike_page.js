// GENERATED FROM ../../templates/_assets/hike_page.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

// Shared hike-page runtime. Reads per-hike data from window.HIKE (set inline by the page).
(function () {
  "use strict";
  const H = window.HIKE || {};
  const SUMMIT = H.summit, TRAILHEAD = H.trailhead, END_POINT = H.end_point, WAYPOINTS = H.waypoints || [];
  const HAZARDS = H.hazards || [];
  const HIKR_INDEX_URL = H.hikr_index_url;
  const GPX_FILENAME = H.gpx_filename, REPORTS_UPDATED = H.reports_updated;
  const PAGE_GENERATED = H.page_generated, WEBCAMS = H.webcams || [];

  const cfg = (window.HIKING_CONFIG || {});
  const mapsKey = cfg.mapsApiKey || "";
  const TRANSIT_ORIGIN_KEY = "hike-transit:origin"; // shared with transit_widget.js
  function readTransitOrigin() {
    try {
      const v = window.localStorage && window.localStorage.getItem(TRANSIT_ORIGIN_KEY);
      if (v && typeof v === "string") return v;
    } catch (e) { /* private mode */ }
    return cfg.defaultOrigin || "Zürich HB";
  }
  let transitOrigin = readTransitOrigin();

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

  // ---- Hazard markers ----
  // Per-hazard schema: { type, lat, lon, note }. `type` keys a small lookup
  // table of emoji + accent colour + readable label. Unknown types fall back to
  // a generic warning marker so a typo never silently hides a hazard.
  const HAZARD_KINDS = {
    cable:    { emoji: "⛓",  color: "#b86b1f", label: "Fixed chain / cable" },
    exposed:  { emoji: "🪂", color: "#c0392b", label: "Exposed ridge / no-fall zone" },
    scree:    { emoji: "🪨", color: "#7f6a52", label: "Loose scree / rockfall" },
    stream:   { emoji: "💧", color: "#2e7fb8", label: "Stream crossing" },
    snow:     { emoji: "❄",  color: "#4f8bbf", label: "Snowfield / steep snow" },
    cableway: { emoji: "🚠", color: "#5a4a8a", label: "Cable car / funicular" },
    other:    { emoji: "⚠",  color: "#888",    label: "Hazard" },
  };
  const hazardLayer = L.layerGroup();
  HAZARDS.forEach(h => {
    if (typeof h.lat !== "number" || typeof h.lon !== "number") return;
    const kind = HAZARD_KINDS[h.type] || HAZARD_KINDS.other;
    const icon = L.divIcon({
      className: "hazard-marker",
      html:
        '<span class="hazard-marker__pin" style="border-color:' + kind.color + '">' +
        '<span class="hazard-marker__emoji">' + kind.emoji + '</span></span>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -14],
    });
    const safeNote = (h.note || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    L.marker([h.lat, h.lon], { icon, riseOnHover: true })
      .bindPopup(
        '<div class="hazard-popup">' +
        '<strong>' + kind.emoji + ' ' + kind.label + '</strong>' +
        (safeNote ? '<p>' + safeNote + '</p>' : '') +
        '</div>'
      )
      .addTo(hazardLayer);
  });
  // Hazards visible by default — they're the point of the layer.
  if (HAZARDS.length) hazardLayer.addTo(map);
  (function wireHazardToggle() {
    const btn = document.getElementById('hazard-toggle');
    if (!btn || !HAZARDS.length) return;
    let visible = true;
    function apply() {
      if (visible) {
        if (!map.hasLayer(hazardLayer)) hazardLayer.addTo(map);
      } else if (map.hasLayer(hazardLayer)) {
        map.removeLayer(hazardLayer);
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
  // Date helpers anchored to Europe/Zurich. The Open-Meteo forecast is queried with
  // timezone=Europe/Zurich, so its day-keyed responses use Zurich-local dates — using the
  // browser's local date would mismatch for users (or headless browsers) outside that zone,
  // which would leave the "your day" highlight off until something is clicked.
  function zurichNowParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t).value;
    return { y: get("year"), m: get("month"), d: get("day"), h: parseInt(get("hour"), 10) };
  }
  function todayIsoLocal() {
    const { y, m, d } = zurichNowParts();
    return `${y}-${m}-${d}`;
  }
  // After 5pm Zurich time, today's hike is unlikely — default the planner to tomorrow so
  // the highlighted tile and hourly weather reflect the next realistic day. The start-time
  // input keeps its 10:00 default (set on the <input>) in both cases.
  function defaultPlanningDate() {
    const { y, m, d, h } = zurichNowParts();
    if (h < 17) return `${y}-${m}-${d}`;
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.getUTCFullYear() + "-" +
      String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(dt.getUTCDate()).padStart(2, "0");
  }
  // Persist the planner's date + start time across pages so users hopping between hikes
  // keep their plan. Stored dates in the past are discarded so a forgotten plan from days
  // ago doesn't override today's sensible default.
  const STORE_DATE = "hikes:planning:date";
  const STORE_TIME = "hikes:planning:time";
  function safeStorage() {
    try { return window.localStorage; } catch (e) { return null; }
  }
  function loadStoredDate() {
    const s = safeStorage(); if (!s) return null;
    let iso; try { iso = s.getItem(STORE_DATE); } catch (e) { return null; }
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    if (iso < todayIsoLocal()) return null;
    return iso;
  }
  function saveStoredDate(iso) {
    const s = safeStorage(); if (!s) return;
    try { s.setItem(STORE_DATE, iso); } catch (e) { /* quota / disabled — ignore */ }
  }
  function loadStoredTime() {
    const s = safeStorage(); if (!s) return null;
    let t; try { t = s.getItem(STORE_TIME); } catch (e) { return null; }
    return /^\d{2}:\d{2}$/.test(t) ? t : null;
  }
  function saveStoredTime(t) {
    const s = safeStorage(); if (!s) return;
    try { s.setItem(STORE_TIME, t); } catch (e) { /* ignore */ }
  }
  const planning = (function () {
    const params = new URLSearchParams(location.search);
    let selectedDate = params.get("date") || loadStoredDate() || defaultPlanningDate();
    saveStoredDate(selectedDate);
    const listeners = [];
    function syncUrl(iso) {
      try {
        const url = new URL(location.href);
        if (iso === defaultPlanningDate()) url.searchParams.delete("date");
        else url.searchParams.set("date", iso);
        if (url.toString() !== location.href) history.replaceState({}, "", url);
      } catch (e) { /* old browser — silently skip URL sync */ }
    }
    return {
      get date() { return selectedDate; },
      setDate(iso) {
        if (!iso || iso === selectedDate) return;
        selectedDate = iso;
        saveStoredDate(iso);
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
    // Resolve an endpoint to a Google-Maps-friendly address string.
    // Prefer "lat,lon" (unambiguous, avoids geocoding the wrong stop) and
    // fall back to a GPX-track point (the trailhead is the first track
    // sample, the end point is the last) so hikes whose data.json lacks an
    // explicit end lat/lon (e.g. pizol's "Pizolhütte, Bergstation") still
    // emit a coordinate-based URL rather than a free-text station name that
    // Google might geocode wrong. The bare name is the last-ditch fallback.
    function pointAddr(p, fallbackPt) {
      if (p && typeof p.lat === "number" && typeof p.lon === "number") {
        return `${p.lat},${p.lon}`;
      }
      if (fallbackPt && fallbackPt.length >= 2 &&
          typeof fallbackPt[0] === "number" && typeof fallbackPt[1] === "number") {
        return `${fallbackPt[0]},${fallbackPt[1]}`;
      }
      return (p && p.name) || "";
    }
    const trackStart = (TRACK && TRACK.length) ? TRACK[0] : null;
    const trackEnd   = (TRACK && TRACK.length) ? TRACK[TRACK.length - 1] : null;
    // Google Maps documented `/maps/dir/?api=1` URL — pre-fills origin,
    // destination, and travel mode reliably across browsers/regions. We
    // moved off the classic `?saddr=&daddr=&dirflg=` URL because Google has
    // been progressively dropping support for it (the end-point lat/lon
    // saddr stopped resolving to a directions panel in recent rollouts).
    // Time anchoring isn't supported by api=1; for time-anchored transit
    // planning, the live transit widget above is the source of truth.
    function mapsUrl(origin, destination, mode) {
      const travelmode = mode === "transit" ? "transit"
                       : mode === "walking" ? "walking"
                       : "driving";
      const qp = new URLSearchParams();
      qp.set("api", "1");
      qp.set("origin", origin);
      qp.set("destination", destination);
      qp.set("travelmode", travelmode);
      return "https://www.google.com/maps/dir/?" + qp.toString();
    }
    // SBB legacy timetable URL — the `/buying/pages/fahrplan/fahrplan.xhtml`
    // endpoint pre-fills von (from) and nach (to) reliably. This is the
    // same format SAC's route portal hands us in `trailhead.sbb_url` (we
    // prefer that exact URL when present and only synthesise this one as a
    // fallback). We deliberately omit date/time params — adding them to
    // this URL breaks the pre-fill, and SBB's modern SPA URL with `stops[]`
    // params no longer pre-fills anything at all.
    function sbbUrl(von, nach) {
      const qp = new URLSearchParams();
      qp.set("language", "en");
      qp.set("von", von);
      qp.set("nach", nach);
      return "https://www.sbb.ch/en/buying/pages/fahrplan/fahrplan.xhtml?" + qp.toString();
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

    let lastStart = null, lastEnd = null;
    function update(startDate, endDate) {
      lastStart = startDate; lastEnd = endDate;
      if (TRAILHEAD) {
        const dest = pointAddr(TRAILHEAD, trackStart);
        if (gmapsDrive)   gmapsDrive.href   = mapsUrl(transitOrigin, dest, "driving");
        if (gmapsTransit) gmapsTransit.href = mapsUrl(transitOrigin, dest, "transit");
        // Prefer the SAC-scraped sbb_url when present — it's the canonical
        // pre-filled legacy URL the SAC route portal hands us, and adding
        // synthesised params (time / different shape) tends to break it.
        if (sbbLink) {
          sbbLink.href = TRAILHEAD.sbb_url || sbbUrl(transitOrigin, TRAILHEAD.name);
        }
      }
      if (END_POINT) {
        const origin = pointAddr(END_POINT, trackEnd);
        if (gmapsDriveEnd)   gmapsDriveEnd.href   = mapsUrl(origin, transitOrigin, "driving");
        if (gmapsTransitEnd) gmapsTransitEnd.href = mapsUrl(origin, transitOrigin, "transit");
        if (sbbLinkEnd) {
          sbbLinkEnd.href = END_POINT.sbb_url || sbbUrl(END_POINT.name, transitOrigin);
        }
      }
    }
    update(null, null);
    document.addEventListener("hike-times-changed", e => {
      update(e.detail && e.detail.startDate, e.detail && e.detail.endDate);
    });
    document.addEventListener("hike-origin-changed", e => {
      const v = e.detail && e.detail.origin;
      if (!v) return;
      transitOrigin = v;
      if (originLabel)    originLabel.textContent    = transitOrigin;
      if (originLabelEnd) originLabelEnd.textContent = transitOrigin;
      update(lastStart, lastEnd);
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
  // WMO code → emoji (mirrors hike_map/weather.js → WeatherService.weatherIcon).
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

    // Restore the start time from the last hike page the user looked at. Programmatic
    // mutations of startInput.value elsewhere in this function route through setStartTime
    // so the stored value stays in sync.
    const storedTime = loadStoredTime();
    if (storedTime) startInput.value = storedTime;
    saveStoredTime(startInput.value);
    function setStartTime(v) { startInput.value = v; saveStoredTime(v); }
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
      // departure_time (Maps return from end point). Also publish to a global
      // so late-loading listeners (e.g. transit_widget.js, which is parsed
      // *after* this script and so misses the synchronous initial dispatch)
      // can read the current plan at their own mount time.
      window.HIKE_PLAN = { startDate, endDate };
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
      setStartTime(String(d.getHours()).padStart(2, "0") + ":" + String(m).padStart(2, "0"));
    }

    startInput.addEventListener("change", () => { saveStoredTime(startInput.value); redraw(); });
    planning.onChange(() => { maybeShiftPastStart(); redraw(); });
    if (nowBtn) {
      nowBtn.addEventListener("click", () => {
        const d = new Date();
        let m = Math.ceil(d.getMinutes() / 15) * 15;
        if (m === 60) { d.setHours(d.getHours() + 1); m = 0; }
        d.setMinutes(m, 0, 0);
        setStartTime(String(d.getHours()).padStart(2, "0") + ":" + String(m).padStart(2, "0"));
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
