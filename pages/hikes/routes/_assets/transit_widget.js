// GENERATED FROM ../../templates/_assets/transit_widget.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

// Live Swiss public-transport widget for hike pages — v3 (Google-Maps style).
//
// Renders an "Outbound" and "Return" card. Each card holds a small list of
// connections from transport.opendata.ch (free wrapper around SBB / search.ch).
// Tap a row to expand a full stop-by-stop timeline with Share / Print / Add-
// to-calendar actions.
//
// Integrates with the rest of the hike page via two events:
//   - listens for "hike-times-changed"   { startDate, endDate }
//       fired by the elevation profile when the user picks a date/time/pace
//       → outbound anchors on "arrive by start", return on "depart after end"
//   - dispatches "hike-origin-changed"   { origin }
//       fired when the user picks a new "From" station so hike_page.js can
//       re-anchor the Google Maps / SBB buttons in the Getting There section
//
// The chosen origin persists across all hike pages via localStorage
// ("hike-transit:origin"). The autocomplete suggestions come from the same
// transport.opendata.ch /v1/locations endpoint. Connections are cached for
// 1 h so revisits don't re-hit the API. Pages load over file://, so all
// network calls use XHR (fetch from file:// is blocked in some browsers).

(function () {
  "use strict";

  var API = "https://transport.opendata.ch/v1";
  // Bump cache version when wire format / param shape / render output changes
  // so stale entries from older builds are ignored on first load.
  var CACHE_PREFIX = "hike-transit:v3:";
  var CACHE_TTL_MS = 60 * 60 * 1000;          // 1 h
  var REFRESH_MS   = 5 * 60 * 1000;           // re-poll while the page is open
  var LAST_RETURN_HOUR = 21;                  // bias return search toward evening (Zurich time)
  var SWISS_TZ = "Europe/Zurich";             // SBB timetables roll over at Swiss midnight
  var LIST_LIMIT = 3;                         // outbound / return rows per card

  var H = window.HIKE || {};
  var cfg = window.HIKING_CONFIG || {};

  var ORIGIN_KEY = "hike-transit:origin";
  var DEFAULT_ORIGIN = cfg.defaultOrigin || "Zürich HB";
  var origin = readOrigin();

  function readOrigin() {
    try {
      var v = window.localStorage && window.localStorage.getItem(ORIGIN_KEY);
      if (v && typeof v === "string") return v;
    } catch (e) { /* private browsing / disabled storage */ }
    return DEFAULT_ORIGIN;
  }
  function writeOrigin(v) {
    try { window.localStorage && window.localStorage.setItem(ORIGIN_KEY, v); }
    catch (e) { /* ignore */ }
  }

  // ---- Inline SVG icons (Material-style, single path each) ----------------
  // Sized via CSS — author at 24px viewBox and let `width`/`height` set the
  // render size. fill="currentColor" lets the icon inherit text color.
  var ICON_TRAIN = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 15.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V5c0-3.5-3.58-4-8-4s-8 .5-8 4v10.5zm8 1.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm6-7H6V5h12v5z"/></svg>';
  var ICON_BUS   = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/></svg>';
  var ICON_TRAM  = ICON_TRAIN;
  var ICON_SHIP  = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 21c-1.39 0-2.78-.47-4-1.32-2.44 1.71-5.56 1.71-8 0C6.78 20.53 5.39 21 4 21H2v2h2c1.38 0 2.74-.35 4-.99 2.52 1.29 5.48 1.29 8 0 1.26.65 2.62.99 4 .99h2v-2h-2zM3.95 19H4c1.6 0 3.02-.88 4-2 .98 1.12 2.4 2 4 2s3.02-.88 4-2c.98 1.12 2.4 2 4 2h.05l1.89-6.68c.08-.26.06-.54-.06-.78s-.34-.42-.6-.5L20 10.62V6c0-1.1-.9-2-2-2h-3V1H9v3H6c-1.1 0-2 .9-2 2v4.62l-1.29.42c-.26.08-.48.26-.6.5s-.15.52-.06.78L3.95 19zM6 6h12v3.97L12 8 6 9.97V6z"/></svg>';
  var ICON_CABLE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5l18-2v3l-9 1v2.59l9.5-1.05V12L12 13.41V18l4-1v3l-13 1.5v-3L11 17v-3.5l-8-1.04V9.44L11 10.5V8L3 9V5z"/></svg>';
  var ICON_WALK  = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="13" cy="4" r="2"/><path d="M13.5 5.5h-3l-3.5 7 .8 4 4-3.5L13 16v6h2v-7l-2.5-1.5.6-3 2.4 2.5h3v-2h-2.5l-1.4-2.4-.5-1.1z"/></svg>';
  var ICON_CAL   = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 002 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2zM7 12h5v5H7z"/></svg>';
  var ICON_PRINT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>';
  var ICON_SHARE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>';
  var ICON_CARET = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M7 10l5 5 5-5z"/></svg>';

  // Per-line colors for Zurich S-bahn (used inside the colored line chips).
  // Sourced from ZVV's published line palette; falls back to a generic
  // purple for unmapped numbers so new S-lines still render readably.
  var S_COLORS = {
    "1":  "#4eb8e5", "2":  "#10a652", "3":  "#f4a83a", "4":  "#f4a83a",
    "5":  "#88533a", "6":  "#2b62a8", "7":  "#7a3a8f", "8":  "#5a23a8",
    "9":  "#10a652", "12": "#e8252e", "14": "#d92e8f", "15": "#4eb8e5",
    "16": "#88533a", "24": "#d92e8f", "25": "#c81e8f"
  };

  function modeOf(j) {
    if (!j) return { kind: "walk", icon: ICON_WALK };
    var c = (j.category || "").toUpperCase().trim();
    if (/^(IC|ICE|EC|TGV|RJ|RJX|PE|EXT|NJ|IR|RE)$/.test(c)) return { kind: "train", icon: ICON_TRAIN };
    if (/^S\d*$|^SN$/.test(c))                              return { kind: "train", icon: ICON_TRAIN };
    if (/^(B|BUS|NFB|KB|BN)$/.test(c))                      return { kind: "bus",   icon: ICON_BUS };
    if (/^(T|TRAM|NFT|M)$/.test(c))                         return { kind: "tram",  icon: ICON_TRAM };
    if (/^(BAT|FAE|SCH|FB)$/.test(c))                       return { kind: "ship",  icon: ICON_SHIP };
    if (/^(GB|PB|FUN|SL|LB|ASC)$/.test(c))                  return { kind: "cable", icon: ICON_CABLE };
    return { kind: "train", icon: ICON_TRAIN };
  }
  function lineLabelOf(j) {
    if (!j) return "";
    var cat = (j.category || "").trim();
    var num = (j.number || "").trim();
    var m = modeOf(j);
    // SBB style: trains show "<cat><num>" (IR35, S12); buses & trams show
    // just the line number inside the colored chip (451, not B451).
    if (m.kind === "bus" || m.kind === "tram") return num || cat || (j.name || "").trim();
    if (cat && num) return cat + num;
    return cat || (j.name || "").trim() || "Train";
  }
  function lineColorOf(j) {
    if (!j) return "var(--tw-walk)";
    var cat = (j.category || "").toUpperCase().trim();
    var num = (j.number || "").trim();
    var m = modeOf(j);
    if (m.kind === "bus")   return "#fdd700";
    if (m.kind === "tram")  return "#2b62a8";
    if (m.kind === "ship")  return "#00a3d8";
    if (m.kind === "cable") return "#5da93d";
    if (/^S/.test(cat)) return S_COLORS[num] || "#5a23a8";
    return "#e8252e";   // IR / IC / RE / ICE / etc.
  }
  function lineFgOf(color) {
    return color === "#fdd700" ? "#1a1a1a" : "#fff";
  }

  // ---- Time / date helpers ------------------------------------------------

  function dateInTZ(d, tz) {
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(d);
    var get = function (t) {
      var p = parts.find(function (x) { return x.type === t; });
      return p ? p.value : "";
    };
    return get("year") + "-" + get("month") + "-" + get("day");
  }
  function todaySwissISO() { return dateInTZ(new Date(), SWISS_TZ); }
  function tomorrowSwissISO() {
    var d = new Date(); d.setUTCDate(d.getUTCDate() + 1);
    return dateInTZ(d, SWISS_TZ);
  }
  // The elevation profile constructs its Date objects in browser-local time,
  // so when the user picks "07:30" the Date's getHours()=7, getMinutes()=30
  // regardless of the visitor's timezone. We mirror that convention when
  // building the SBB query so the wall-clock the user chose is what we ask
  // the API for.
  function localTimeOnly(d) {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function localISODate(d) {
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  function dayLabelFor(d) {
    var iso = localISODate(d);
    var now = new Date();
    if (iso === localISODate(now)) return "today";
    var t = new Date(now.getTime() + 86400000);
    if (iso === localISODate(t)) return "tomorrow";
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short", day: "numeric", month: "short"
    }).format(d);
  }
  function fmtTime(iso) {
    if (!iso) return "--:--";
    return new Date(iso).toLocaleTimeString("de-CH", {
      hour: "2-digit", minute: "2-digit", timeZone: SWISS_TZ
    });
  }
  function parseDurSecs(s) {
    if (!s) return 0;
    var m = /^(\d+)d(\d+):(\d+):(\d+)$/.exec(s);
    if (!m) return 0;
    return (+m[1]) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]);
  }
  function fmtDur(secs) {
    if (!secs || secs < 0) return "";
    var h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
    if (h && m) return h + " hr " + m + " min";
    if (h) return h + " hr";
    return m + " min";
  }
  function legDurSecs(sec) {
    if (!sec) return 0;
    if (sec.walk && sec.walk.duration) return sec.walk.duration;
    var d = sec.departure && sec.departure.departure;
    var a = sec.arrival && sec.arrival.arrival;
    if (!d || !a) return 0;
    return Math.max(0, Math.round((new Date(a) - new Date(d)) / 1000));
  }
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---- Cache --------------------------------------------------------------

  function cacheGet(key) {
    try {
      var raw = window.localStorage && window.localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || typeof obj.ts !== "number") return null;
      if (Date.now() - obj.ts > CACHE_TTL_MS) return null;
      return obj.data;
    } catch (e) { return null; }
  }
  function cacheSet(key, data) {
    try {
      window.localStorage && window.localStorage.setItem(
        CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data: data })
      );
    } catch (e) { /* quota or disabled */ }
  }

  // ---- API ----------------------------------------------------------------

  function fetchConnections(params, cb) {
    var key = JSON.stringify(params);
    var cached = cacheGet(key);
    if (cached) { cb(null, cached); return; }
    var qs = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (Array.isArray(v)) v.forEach(function (x) { qs.push(k + "=" + encodeURIComponent(x)); });
      else if (v != null && v !== "") qs.push(k + "=" + encodeURIComponent(v));
    });
    var url = API + "/connections?" + qs.join("&");
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.timeout = 8000;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var data = JSON.parse(xhr.responseText);
          cacheSet(key, data);
          cb(null, data);
        } catch (e) { cb(e, null); }
      } else cb(new Error("HTTP " + xhr.status), null);
    };
    xhr.onerror = function () { cb(new Error("network"), null); };
    xhr.ontimeout = function () { cb(new Error("timeout"), null); };
    xhr.send();
  }

  // ---- DOM helpers --------------------------------------------------------

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === "class") e.className = props[k];
      else if (k === "html") e.innerHTML = props[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    });
    if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach(function (k) {
      if (k == null) return;
      e.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
    });
    return e;
  }
  function iconSpan(svg, cls) {
    return el("span", { class: "tw-ico" + (cls ? " " + cls : ""), html: svg });
  }
  function lineChip(j) {
    var color = lineColorOf(j);
    return el("span", { class: "tw-chip" }, [
      iconSpan(modeOf(j).icon, "tw-chip-ico"),
      el("span", {
        class: "tw-chip-label",
        style: "background:" + color + ";color:" + lineFgOf(color)
      }, lineLabelOf(j))
    ]);
  }
  function chipSep() { return el("span", { class: "tw-chip-sep", html: "&rsaquo;" }); }
  function prevent(e) { if (e) { e.preventDefault(); e.stopPropagation(); } }

  // ---- Toast (for "Copied link" feedback) ---------------------------------

  function showToast(msg) {
    var t = el("div", { class: "tw-toast" }, msg);
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 1700);
  }

  // ---- Google Calendar event link ----------------------------------------
  // Google Calendar's TEMPLATE URL pre-fills a new-event form — opening it
  // in a new tab lands the user on calendar.google.com with the trip filled
  // in, just one click to save. Date format is the floating-time variant
  // (YYYYMMDDTHHMMSS, no Z) so Google interprets times in the user's local
  // calendar zone rather than re-shifting them out of Swiss wall-clock.
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function gcalStamp(d) {
    if (!d) return "";
    return "" + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
      + "T" + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + "Z";
  }
  function gcalUrl(c) {
    var dep = c.from && c.from.departure && new Date(c.from.departure);
    var arr = c.to   && c.to.arrival    && new Date(c.to.arrival);
    var fromName = (c.from && c.from.station && c.from.station.name) || "";
    var toName   = (c.to   && c.to.station   && c.to.station.name)   || "";
    var legs = (c.sections || []).filter(function (s) { return s.journey; })
      .map(function (s) { return lineLabelOf(s.journey); }).join(" → ");
    var sbb = sbbDeepLink(c);
    var desc = legs + " (" + fmtDur(parseDurSecs(c.duration)) + ")" +
      (sbb ? "\n\nTimetable: " + sbb : "");
    var qp = new URLSearchParams();
    qp.set("action", "TEMPLATE");
    qp.set("text", fromName + " → " + toName);
    if (dep && arr) qp.set("dates", gcalStamp(dep) + "/" + gcalStamp(arr));
    qp.set("location", fromName);
    qp.set("details", desc);
    return "https://calendar.google.com/calendar/render?" + qp.toString();
  }

  // ---- Share / copy -------------------------------------------------------

  function sbbDeepLink(c) {
    var from = c.from && c.from.station && c.from.station.name;
    var to   = c.to   && c.to.station   && c.to.station.name;
    if (!from || !to) return null;
    var dep = c.from && c.from.departure;
    var qp = new URLSearchParams();
    qp.set("from", from);
    qp.set("to", to);
    if (dep) {
      var d = new Date(dep);
      var iso = localISODate(d);
      qp.set("date", iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4));
      qp.set("time", localTimeOnly(d));
      qp.set("time_type", "departure");
    }
    // search.ch's timetable accepts a stable deep-link with `time_type`
    // anchoring; sbb.ch silently drops the same params and opens blank.
    // Per-row links are time-specific so search.ch is the right backend
    // here even though Getting There uses sbb.ch's legacy von/nach URL.
    return "https://timetable.search.ch/?" + qp.toString();
  }
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { showToast("Link copied"); },
        function () { fallbackCopy(text); }
      );
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var ta = el("textarea", { style: "position:fixed;opacity:0;left:0;top:0;" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); showToast("Link copied"); }
    catch (e) { showToast("Could not copy"); }
    document.body.removeChild(ta);
  }
  function shareTrip(c) {
    var url = sbbDeepLink(c) || window.location.href;
    var fromName = (c.from && c.from.station && c.from.station.name) || "";
    var toName   = (c.to   && c.to.station   && c.to.station.name)   || "";
    if (navigator.share) {
      navigator.share({
        title: fromName + " → " + toName,
        url: url
      }).catch(function () { copyToClipboard(url); });
    } else copyToClipboard(url);
  }

  // ---- Row + timeline rendering ------------------------------------------

  function renderRow(c, idx, dir, state, listEl) {
    var dep = c.from && c.from.departure;
    var arr = c.to   && c.to.arrival;
    var transitSecs = (c.sections || []).filter(function (s) { return s.journey; });
    var firstJ = transitSecs[0] && transitSecs[0].journey;
    var heroIcon = modeOf(firstJ).icon;
    var totalSec = parseDurSecs(c.duration) ||
      Math.max(0, Math.round((new Date(arr) - new Date(dep)) / 1000));

    var chipsRow = el("div", { class: "tw-row-chips" });
    transitSecs.forEach(function (s, i) {
      if (i > 0) chipsRow.appendChild(chipSep());
      chipsRow.appendChild(lineChip(s.journey));
    });

    var fromName = (c.from && c.from.station && c.from.station.name) || "";
    var fromPlatform = c.from && c.from.platform;
    var fromDelay = c.from && c.from.delay;

    var meta = el("div", { class: "tw-row-meta" });
    if (dep) {
      var bits = fmtTime(dep) + " from " + fromName;
      if (fromPlatform) bits += " · Pl. " + fromPlatform;
      meta.appendChild(el("div", null, bits));
    }
    var firstSec = c.sections && c.sections[0];
    if (firstSec && firstSec.walk) {
      var wmin = Math.max(1, Math.round((firstSec.walk.duration || 60) / 60));
      meta.appendChild(el("div", { class: "tw-row-walk" }, [iconSpan(ICON_WALK), wmin + " min walk"]));
    }

    var isExpanded = state.expandedIdx === idx;
    var rowCls = "tw-row";
    if (isExpanded) rowCls += " is-expanded";
    if (fromDelay) rowCls += " is-delayed";
    if (c._past) rowCls += " is-past";

    var content = el("div", { class: "tw-row-content" }, [
      el("div", { class: "tw-row-times" }, fmtTime(dep) + " — " + fmtTime(arr)),
      chipsRow,
      meta,
      isExpanded ? null : el("div", { class: "tw-row-hint" }, "Details")
    ]);

    var row = el("div", { class: rowCls }, [
      el("div", { class: "tw-row-hero", html: heroIcon }),
      content,
      el("div", { class: "tw-row-dur" }, fmtDur(totalSec))
    ]);
    if (isExpanded) row.appendChild(renderExpanded(c));

    row.addEventListener("click", function (e) {
      if (e.target.closest("a, button")) return;
      state.expandedIdx = isExpanded ? -1 : idx;
      reRenderList(listEl, state);
    });

    return row;
  }

  function renderExpanded(c) {
    var panel = el("div", { class: "tw-row-panel" });
    panel.appendChild(el("div", { class: "tw-row-actions" }, [
      el("a", {
        href: "#", title: "Share trip",
        onclick: function (e) { prevent(e); shareTrip(c); }
      }, [iconSpan(ICON_SHARE), "Share"]),
      el("a", {
        href: "#", title: "Print this page",
        onclick: function (e) { prevent(e); window.print(); }
      }, [iconSpan(ICON_PRINT), "Print"]),
      el("a", {
        href: gcalUrl(c), target: "_blank", rel: "noopener",
        title: "Open in Google Calendar", class: "tw-action-cal"
      }, [iconSpan(ICON_CAL), "Add to Calendar"])
    ]));
    panel.appendChild(renderTimeline(c));
    var sbbUrl = sbbDeepLink(c);
    if (sbbUrl) {
      panel.appendChild(el("div", { class: "tw-row-tickets" }, [
        el("a", {
          href: sbbUrl, target: "_blank", rel: "noopener"
        }, "Tickets & details at sbb.ch ↗")
      ]));
    }
    return panel;
  }

  function renderTimeline(c) {
    var tl = el("div", { class: "tw-tl" });
    var sections = (c.sections || []);
    var lastIdx = sections.length - 1;

    sections.forEach(function (s, i) {
      var isWalk = !!s.walk;
      var legColor = isWalk ? "var(--tw-walk)" : lineColorOf(s.journey);
      var axisStyle = "border-left-color:" + (isWalk ? "var(--tw-walk)" : legColor);

      var depDate = s.departure && s.departure.departure;
      var depName = (s.departure && s.departure.station && s.departure.station.name) || "";
      var arrDate = s.arrival && s.arrival.arrival;
      var arrName = (s.arrival && s.arrival.station && s.arrival.station.name) || "";

      // Departure-station row
      tl.appendChild(el("div", { class: "tw-tl-time" }, depDate ? fmtTime(depDate) : ""));
      tl.appendChild(el("div", { class: "tw-tl-axis" }, [
        el("div", { class: "tw-tl-line" + (isWalk ? " is-walk" : ""), style: axisStyle }),
        el("div", {
          class: "tw-tl-dot" + (i === 0 ? " is-terminus" : ""),
          style: "border-color:" + legColor
        })
      ]));
      tl.appendChild(el("div", { class: "tw-tl-text" }, [
        el("div", { class: "tw-tl-station" }, depName)
      ]));

      // Leg body row
      tl.appendChild(el("div", { class: "tw-tl-time" }, ""));
      tl.appendChild(el("div", { class: "tw-tl-axis" }, [
        el("div", { class: "tw-tl-line" + (isWalk ? " is-walk" : ""), style: axisStyle })
      ]));
      var body = el("div", { class: "tw-tl-leg" });
      if (isWalk) {
        body.appendChild(el("div", { class: "tw-tl-walk-row" }, [iconSpan(ICON_WALK), "Walk"]));
        body.appendChild(el("div", { class: "tw-tl-leg-detail" },
          "About " + Math.max(1, Math.round((s.walk.duration || 60) / 60)) + " min"));
      } else {
        var j = s.journey;
        var head = el("div", { class: "tw-tl-leg-row" }, [
          iconSpan(modeOf(j).icon, "tw-tl-mode"),
          lineChip(j),
          j.to ? el("span", { class: "tw-tl-dest" }, j.to) : null
        ]);
        body.appendChild(head);
        var legSecs = legDurSecs(s);
        var stops = (j.passList && j.passList.length) ? (j.passList.length - 2) : null;
        var det = fmtDur(legSecs);
        if (stops === 0) det += " (non-stop)";
        else if (stops != null && stops > 0) det += " (" + stops + " stop" + (stops === 1 ? "" : "s") + ")";
        if (s.departure && s.departure.platform) det += " · Pl. " + s.departure.platform;
        body.appendChild(el("div", { class: "tw-tl-leg-detail" }, det));
      }
      tl.appendChild(body);

      // Final arrival row (only after the last section)
      if (i === lastIdx) {
        tl.appendChild(el("div", { class: "tw-tl-time" }, arrDate ? fmtTime(arrDate) : ""));
        tl.appendChild(el("div", { class: "tw-tl-axis" }, [
          el("div", { class: "tw-tl-dot is-terminus", style: "border-color:" + legColor })
        ]));
        tl.appendChild(el("div", { class: "tw-tl-text" }, [
          el("div", { class: "tw-tl-station" }, arrName)
        ]));
      }
    });
    return tl;
  }

  // Re-render a list element in place when expanded-row state changes.
  function reRenderList(listEl, state) {
    if (!state.lastConns) return;
    listEl.innerHTML = "";
    state.lastConns.forEach(function (c, i) {
      listEl.appendChild(renderRow(c, i, state.dir, state, listEl));
    });
  }

  function setStatus(listEl, msg, kind) {
    listEl.innerHTML = "";
    listEl.appendChild(el("div", { class: "tw-status tw-status--" + (kind || "info") }, msg));
  }

  // ---- Mount --------------------------------------------------------------

  function mount() {
    var host = document.getElementById("transit-widget");
    if (!host) return;
    var trailhead = H.trailhead, endPoint = H.end_point;
    if (!trailhead || !trailhead.name) { host.style.display = "none"; return; }

    // Prefer the SAC-scraped SBB station over the display name for API queries.
    // Many trailhead names ("Tierfehd", "Capanna Alzasca CAS", "Holzegg, summit
    // station") aren't in SBB's timetable system — transport.opendata.ch either
    // returns nothing or rolls the query forward to a random date, leaving the
    // outbound card stuck on "Loading…". The scraped sbb_url has ?nach=<Station>
    // set to the *actual* nearest station (Linthal, Linescio, Holzegg), which
    // is what we want to feed the API.
    function stationFromSbbUrl(url) {
      if (!url) return null;
      var m = /[?&]nach=([^&]+)/.exec(url);
      if (!m) return null;
      try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { return null; }
    }
    var outDest = stationFromSbbUrl(trailhead.sbb_url) || trailhead.name;
    var retOrigin = (endPoint && (stationFromSbbUrl(endPoint.sbb_url) || endPoint.name))
                    || outDest;

    host.innerHTML =
      '<div class="tw-head">' +
        '<h3 class="tw-title">Public transport — today</h3>' +
        '<label class="tw-origin">From&nbsp;' +
          '<span class="tw-origin-wrap">' +
            '<input type="text" id="tw-origin" autocomplete="off" spellcheck="false" ' +
              'role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="tw-suggest">' +
            '<ul class="tw-suggest" id="tw-suggest" role="listbox" hidden></ul>' +
          '</span>' +
        '</label>' +
      '</div>' +
      '<div class="tw-cards">' +
        '<section class="tw-card" id="tw-card-out" aria-label="Outbound connections">' +
          '<div class="tw-card-head">' +
            '<span class="tw-card-label">Outbound</span>' +
            '<span class="tw-card-route" id="tw-out-route"></span>' +
          '</div>' +
          '<div class="tw-list" id="tw-out"></div>' +
        '</section>' +
        '<section class="tw-card" id="tw-card-ret" aria-label="Return connections">' +
          '<div class="tw-card-head">' +
            '<span class="tw-card-label">Return</span>' +
            '<span class="tw-card-route" id="tw-ret-route"></span>' +
          '</div>' +
          '<div class="tw-list" id="tw-ret"></div>' +
        '</section>' +
      '</div>' +
      '<div class="tw-foot">' +
        '<span class="tw-pulse"></span> Live via ' +
        '<a href="https://transport.opendata.ch" target="_blank" rel="noopener">transport.opendata.ch</a>' +
        ' · cached 1 h · times in local Swiss time' +
      '</div>' +
      '<details class="tw-gmaps">' +
        '<summary>Compare with Google Maps</summary>' +
        '<div class="tw-gmaps-body" id="tw-gmaps-body"></div>' +
      '</details>';

    var $origin = host.querySelector("#tw-origin");
    var $title  = host.querySelector(".tw-title");
    var $out    = host.querySelector("#tw-out");
    var $ret    = host.querySelector("#tw-ret");
    var $outR   = host.querySelector("#tw-out-route");
    var $retR   = host.querySelector("#tw-ret-route");

    var outState = { dir: "out", expandedIdx: -1, lastConns: null };
    var retState = { dir: "ret", expandedIdx: -1, lastConns: null };

    function applyHeader() {
      $outR.textContent = origin + " → " + outDest;
      $retR.textContent = retOrigin + " → " + origin;
    }
    applyHeader();
    $origin.value = origin;

    // ---- Refresh: planned vs auto ------------------------------------------
    //
    // hike_page.js (which loads earlier in the page) dispatches
    // "hike-times-changed" synchronously during its init — before this script
    // is even parsed, so we never see the first event. It also publishes the
    // latest plan onto window.HIKE_PLAN, so we seed from that here to render
    // the planned outbound/return on first load instead of falling back to
    // refreshAuto's "today" view.
    var currentPlan = null;
    if (window.HIKE_PLAN && window.HIKE_PLAN.startDate && window.HIKE_PLAN.endDate) {
      currentPlan = {
        startDate: window.HIKE_PLAN.startDate,
        endDate: window.HIKE_PLAN.endDate,
      };
    }

    function refresh() {
      if (currentPlan && currentPlan.startDate && currentPlan.endDate) {
        refreshPlanned(currentPlan);
      } else {
        refreshAuto();
      }
    }

    function refreshPlanned(plan) {
      var startDate = plan.startDate, endDate = plan.endDate;
      var startISO  = localISODate(startDate);
      var endISO    = localISODate(endDate);
      var startTime = localTimeOnly(startDate);
      var endTime   = localTimeOnly(endDate);
      $title.textContent = "Public transport — " + dayLabelFor(startDate) +
        " · arrive " + startTime + ", leave " + endTime;

      setStatus($out, "Loading…", "loading");
      setStatus($ret, "Loading…", "loading");

      fetchConnections({
        from: origin, to: outDest, date: startISO, time: startTime,
        isArrivalTime: 1, limit: 8
      }, function (err, data) {
        if (err) { setStatus($out, "Live data unavailable — use SBB link below", "error"); return; }
        var conns = (data.connections || []).filter(function (c) {
          if (!c.to || !c.to.arrival) return false;
          if (c.to.arrival.indexOf(startISO) !== 0) return false;
          return c.to.arrival.slice(11, 16) <= startTime;
        });
        conns.sort(function (a, b) { return a.to.arrival.localeCompare(b.to.arrival); });
        outState.lastConns = conns.slice(-LIST_LIMIT);
        outState.expandedIdx = -1;
        if (!outState.lastConns.length) {
          setStatus($out, "No connections arrive by " + startTime, "info");
        } else {
          reRenderList($out, outState);
        }
      });

      fetchConnections({
        from: retOrigin, to: origin, date: endISO, time: endTime,
        isArrivalTime: 0, limit: 8
      }, function (err, data) {
        if (err) { setStatus($ret, "Live data unavailable — use SBB link below", "error"); return; }
        var conns = (data.connections || []).filter(function (c) {
          if (!c.from || !c.from.departure) return false;
          if (c.from.departure.indexOf(endISO) !== 0) return false;
          return c.from.departure.slice(11, 16) >= endTime;
        });
        conns.sort(function (a, b) { return a.from.departure.localeCompare(b.from.departure); });
        retState.lastConns = conns.slice(0, LIST_LIMIT);
        retState.expandedIdx = -1;
        if (!retState.lastConns.length) {
          setStatus($ret, "No connections depart after " + endTime, "info");
        } else {
          reRenderList($ret, retState);
        }
      });
    }

    function refreshAuto() {
      $title.textContent = "Public transport — today";
      var today = todaySwissISO();
      var tomorrow = tomorrowSwissISO();
      setStatus($out, "Loading…", "loading");
      setStatus($ret, "Loading…", "loading");

      function loadOutbound(date, rolled) {
        fetchConnections({
          from: origin, to: outDest, date: date, limit: 6
        }, function (err, data) {
          if (err) { setStatus($out, "Live data unavailable — use SBB link below", "error"); return; }
          var now = new Date();
          var conns = (data.connections || []).filter(function (c) {
            if (!c.from || !c.from.departure) return false;
            if (c.from.departure.indexOf(date) !== 0) return false;
            return rolled ? true : new Date(c.from.departure) >= now;
          }).slice(0, LIST_LIMIT);
          if (!conns.length && date === today) { loadOutbound(tomorrow, true); return; }
          outState.lastConns = conns;
          outState.expandedIdx = -1;
          if (!conns.length) setStatus($out, "No connections found", "info");
          else reRenderList($out, outState);
        });
      }
      loadOutbound(today, false);

      function loadReturn(date, rolled) {
        fetchConnections({
          from: retOrigin, to: origin, date: date,
          time: String(LAST_RETURN_HOUR).padStart(2, "0") + ":00",
          isArrivalTime: 1, limit: 6
        }, function (err, data) {
          if (err) { setStatus($ret, "Live data unavailable — use SBB link below", "error"); return; }
          var conns = (data.connections || []).filter(function (c) {
            return c.from && c.from.departure && c.from.departure.indexOf(date) === 0;
          });
          conns = conns.slice(-LIST_LIMIT);
          var now = new Date();
          conns.forEach(function (c) { c._past = !rolled && new Date(c.from.departure) < now; });
          if (!conns.length && date === today) { loadReturn(tomorrow, true); return; }
          retState.lastConns = conns;
          retState.expandedIdx = -1;
          if (!conns.length) setStatus($ret, "No connections found", "info");
          else reRenderList($ret, retState);
        });
      }
      loadReturn(today, false);
    }

    // ---- Apply a new origin (commits the value, refreshes, broadcasts) -----

    function applyOrigin(v) {
      v = (v || "").trim();
      if (!v || v === origin) return;
      origin = v;
      writeOrigin(v);
      applyHeader();
      refresh();
      try {
        document.dispatchEvent(new CustomEvent("hike-origin-changed",
          { detail: { origin: v } }));
      } catch (e) { /* ancient browsers without CustomEvent — non-fatal */ }
      if ($gmaps && $gmaps.open) renderGmaps();
    }
    $origin.addEventListener("change", function () { applyOrigin($origin.value); });

    // ---- Autocomplete (transport.opendata.ch /v1/locations) ---------------

    var $sug = host.querySelector("#tw-suggest");
    var sugItems = [];
    var sugIndex = -1;
    var sugDebounce = null;
    var sugCache = {};
    var sugXhr = null;
    var SUG_LIMIT = 8;

    function hideSug() {
      $sug.hidden = true;
      $sug.innerHTML = "";
      sugItems = []; sugIndex = -1;
      $origin.setAttribute("aria-expanded", "false");
    }
    function renderSug(stations) {
      sugItems = stations.slice(0, SUG_LIMIT);
      sugIndex = -1;
      if (!sugItems.length) {
        $sug.innerHTML = '<li class="tw-suggest-empty">No matches</li>';
      } else {
        $sug.innerHTML = sugItems.map(function (s, i) {
          var kind = s.icon ? String(s.icon) : "";
          return '<li class="tw-suggest-item" role="option" data-i="' + i + '">' +
            '<span class="tw-suggest-item-name">' + escHtml(s.name) + "</span>" +
            (kind ? '<span class="tw-suggest-item-kind">' + escHtml(kind) + "</span>" : "") +
          "</li>";
        }).join("");
      }
      $sug.hidden = false;
      $origin.setAttribute("aria-expanded", "true");
    }
    function fetchSug(q) {
      if (sugCache[q]) { renderSug(sugCache[q]); return; }
      try { if (sugXhr) sugXhr.abort(); } catch (e) { /* ignore */ }
      sugXhr = new XMLHttpRequest();
      sugXhr.open("GET", API + "/locations?type=station&query=" + encodeURIComponent(q));
      sugXhr.timeout = 4000;
      sugXhr.onload = function () {
        if (sugXhr.status < 200 || sugXhr.status >= 300) return;
        try {
          var data = JSON.parse(sugXhr.responseText);
          var stations = (data && data.stations) || [];
          sugCache[q] = stations;
          if ($origin.value.trim() === q && document.activeElement === $origin) {
            renderSug(stations);
          }
        } catch (e) { /* ignore */ }
      };
      sugXhr.onerror = sugXhr.ontimeout = function () { /* silently ignore */ };
      sugXhr.send();
    }
    function setActive(i) {
      var items = $sug.querySelectorAll(".tw-suggest-item");
      items.forEach(function (el, idx) { el.classList.toggle("is-active", idx === i); });
      sugIndex = i;
      if (i >= 0 && items[i]) items[i].scrollIntoView({ block: "nearest" });
    }
    function commitSug(i) {
      if (i < 0 || i >= sugItems.length) return false;
      var s = sugItems[i];
      $origin.value = s.name;
      hideSug();
      applyOrigin(s.name);
      return true;
    }

    $origin.addEventListener("input", function () {
      var q = $origin.value.trim();
      if (sugDebounce) clearTimeout(sugDebounce);
      if (!q) { hideSug(); return; }
      sugDebounce = setTimeout(function () { fetchSug(q); }, 180);
    });
    $origin.addEventListener("focus", function () {
      var q = $origin.value.trim();
      if (q && sugCache[q]) renderSug(sugCache[q]);
    });
    $origin.addEventListener("keydown", function (e) {
      if ($sug.hidden) {
        if (e.key === "Enter") { e.preventDefault(); $origin.blur(); }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(Math.min(sugIndex + 1, sugItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(Math.max(sugIndex - 1, 0));
      } else if (e.key === "Enter") {
        if (sugIndex >= 0 && commitSug(sugIndex)) e.preventDefault();
        else { e.preventDefault(); hideSug(); $origin.blur(); }
      } else if (e.key === "Escape") {
        e.preventDefault(); hideSug();
      }
    });
    // mousedown (not click) fires before the input's blur, so the selection
    // commits before blur-driven hide tears the list out from under the cursor.
    $sug.addEventListener("mousedown", function (e) {
      var li = e.target.closest(".tw-suggest-item");
      if (!li) return;
      e.preventDefault();
      commitSug(parseInt(li.getAttribute("data-i"), 10));
    });
    $origin.addEventListener("blur", function () {
      setTimeout(hideSug, 120);
    });

    // ---- React to the elevation profile's time/pace edits ------------------

    document.addEventListener("hike-times-changed", function (e) {
      if (!e || !e.detail || !e.detail.startDate || !e.detail.endDate) return;
      currentPlan = { startDate: e.detail.startDate, endDate: e.detail.endDate };
      refresh();
    });

    // ---- Lazy Google Maps Embed pane ---------------------------------------

    var $gmaps = host.querySelector(".tw-gmaps");
    var $gmapsBody = host.querySelector("#tw-gmaps-body");
    function renderGmaps() {
      var key = (window.HIKING_CONFIG || {}).googleMapsApiKey;
      if (!key) {
        $gmapsBody.innerHTML =
          '<div class="tw-gmaps-setup">' +
            '<p><strong>Google Maps Embed needs an API key.</strong> ' +
            'See <a href="../../docs/google-maps-embed-setup.md" target="_blank" rel="noopener">' +
            'docs/google-maps-embed-setup.md</a> for the 5-minute setup.</p>' +
            '<p>Once you have a key, drop it into <code>pages/hikes/local-config.js</code>:</p>' +
            '<pre>window.HIKING_CONFIG = {\n  googleMapsApiKey: "AIza…"\n};</pre>' +
          '</div>';
        return;
      }
      var orig = encodeURIComponent(origin);
      var dest = trailhead.lat && trailhead.lon
        ? trailhead.lat + "," + trailhead.lon
        : encodeURIComponent(trailhead.name);
      var url = "https://www.google.com/maps/embed/v1/directions" +
        "?key=" + encodeURIComponent(key) +
        "&origin=" + orig +
        "&destination=" + dest +
        "&mode=transit";
      $gmapsBody.innerHTML =
        '<iframe class="tw-gmaps-frame" loading="lazy" allowfullscreen ' +
          'referrerpolicy="strict-origin-when-cross-origin" ' +
          'src="' + url + '"></iframe>' +
        '<p class="tw-gmaps-note">' +
          '<strong>' + escHtml(origin) + ' &rarr; ' + escHtml(trailhead.name) + '</strong> ' +
          '&middot; Google Embed always shows "leave now" — use the cards above to anchor on your start time.' +
        '</p>';
    }
    if ($gmaps) {
      $gmaps.addEventListener("toggle", function () {
        if ($gmaps.open) renderGmaps();
      });
    }

    refresh();
    setInterval(refresh, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
