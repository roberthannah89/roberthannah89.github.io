// Live Swiss public-transport widget for hike pages.
//
// Renders inline "next 3 outbound" and "last 3 return" departures using the
// free transport.opendata.ch API (which wraps SBB + search.ch timetable data).
//
// Reads window.HIKE.trailhead and window.HIKE.end_point for station names
// and window.HIKING_CONFIG.defaultOrigin for the reference city (default
// "Zürich HB"). Caches JSON in localStorage for ~1 h to keep revisits snappy.
//
// CORS: transport.opendata.ch sends Access-Control-Allow-Origin: *, so this
// works from file:// as well as http(s)://. If the API call fails for any
// reason (network down, station name not recognised, rate limited), the
// widget hides itself — the static SBB-timetable link in the existing
// "Getting There" section remains the fallback.

(function () {
  "use strict";

  var API = "https://transport.opendata.ch/v1";
  // Bump cache version when wire format / param shape changes so stale entries
  // from older builds are ignored on first load.
  var CACHE_PREFIX = "hike-transit:v2:";
  var CACHE_TTL_MS = 60 * 60 * 1000;          // 1 h
  var REFRESH_MS   = 5 * 60 * 1000;           // re-poll while the page is open
  var LAST_RETURN_HOUR = 21;                  // bias return search toward evening (Zurich time)
  var SWISS_TZ = "Europe/Zurich";             // SBB timetables roll over at Swiss midnight

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

  // Format `d` as YYYY-MM-DD in the given IANA timezone. SBB calendars roll
  // over at Swiss midnight, not at the visitor's local midnight, so always
  // ask the API for Zurich's "today" — otherwise a visitor in e.g. New York
  // before 18:00 EDT sees the *previous* Swiss day's already-departed trains.
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

  function fmtTime(iso) {
    if (!iso) return "--:--";
    var d = new Date(iso);
    // Always render in Swiss local time — visitors planning a Swiss hike
    // want to see the platform clock, not their home-timezone clock.
    return d.toLocaleTimeString("de-CH", {
      hour: "2-digit", minute: "2-digit", timeZone: SWISS_TZ
    });
  }

  function fmtDuration(dur) {
    if (!dur) return "";
    var m = dur.match(/(\d+)d(\d+):(\d+):/);
    if (!m) return dur;
    var days = parseInt(m[1], 10);
    var hrs = parseInt(m[2], 10) + days * 24;
    var mins = parseInt(m[3], 10);
    if (hrs > 0) return hrs + "h " + (mins ? mins + "m" : "");
    return mins + " min";
  }

  function categoryClass(cat) {
    if (!cat) return "";
    var c = String(cat).toUpperCase();
    if (/^(IC|ICE|EC|IR|RE|S|TGV|RJ|PE|EXT)/.test(c)) return "train";
    if (/^(B|BUS|NFB|KB)$/.test(c)) return "bus";
    if (/^(BAT|FAE)/.test(c)) return "ship";
    if (/^(T|TRAM|NFT)/.test(c)) return "tram";
    if (/^(GB|PB|FUN|SL|LB)/.test(c)) return "cable";
    return "";
  }

  function legLabel(j) {
    if (!j) return "";
    var cat = (j.category || "").trim();
    var num = (j.number || "").trim();
    if (cat && num) return cat + " " + num;
    if (cat) return cat;
    if (j.name && !/^\d{5,}$/.test(j.name.trim())) return j.name.trim();
    return "Train";
  }

  // ---- Cache layer ---------------------------------------------------------

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

  // ---- API fetch (XHR for file:// compatibility) ---------------------------

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
      } else {
        cb(new Error("HTTP " + xhr.status), null);
      }
    };
    xhr.onerror = function () { cb(new Error("network"), null); };
    xhr.ontimeout = function () { cb(new Error("timeout"), null); };
    xhr.send();
  }

  // ---- Render --------------------------------------------------------------

  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderConnection(c) {
    var dep = fmtTime(c.from && c.from.departure);
    var arr = fmtTime(c.to && c.to.arrival);
    var platform = c.from && c.from.platform ? "Pl. " + c.from.platform : "";
    var delay = c.from && c.from.delay ? "+" + c.from.delay + "'" : "";
    var sections = (c.sections || []).filter(function (s) { return s.journey; });
    var legs = sections.map(function (s) {
      var cls = categoryClass(s.journey.category);
      return '<span class="tw-leg tw-leg--' + cls + '">' + escHtml(legLabel(s.journey)) + "</span>";
    }).join('<span class="tw-leg-sep">▸</span>');
    var transferText = sections.length <= 1 ? "Direct" :
      (sections.length - 1) + " transfer" + (sections.length > 2 ? "s" : "");
    var duration = fmtDuration(c.duration);
    var classes = "tw-conn";
    if (c.from && c.from.delay) classes += " tw-conn--delayed";
    if (c._past) classes += " tw-conn--past";
    return '<li class="' + classes + '">' +
      '<div class="tw-time tw-time--dep">' + dep +
        (platform ? ' <span class="tw-platform">' + escHtml(platform) + "</span>" : "") +
        (delay ? ' <span class="tw-delay">' + escHtml(delay) + "</span>" : "") +
      "</div>" +
      '<div class="tw-route">' + legs + ' <span class="tw-transfers">· ' + transferText + "</span></div>" +
      '<div class="tw-time tw-time--arr">' + arr + ' <span class="tw-duration">' + duration + "</span></div>" +
    "</li>";
  }

  function renderList(el, conns, emptyMsg) {
    if (!conns || !conns.length) {
      el.innerHTML = '<li class="tw-empty">' + escHtml(emptyMsg) + "</li>";
      return;
    }
    el.innerHTML = conns.map(renderConnection).join("");
  }

  function setStatus(el, msg, kind) {
    el.innerHTML = '<li class="tw-status tw-status--' + (kind || "info") + '">' + escHtml(msg) + "</li>";
  }

  // ---- Mount ---------------------------------------------------------------

  function mount() {
    var host = document.getElementById("transit-widget");
    if (!host) return;
    var trailhead = H.trailhead, endPoint = H.end_point;
    if (!trailhead || !trailhead.name) { host.style.display = "none"; return; }

    var destName = (endPoint && endPoint.name) ? endPoint.name : trailhead.name;
    var legBackName = trailhead.name;   // return trip starts where the hike ends — handled below

    host.innerHTML =
      '<div class="tw-head">' +
        '<h3>Public transport — today</h3>' +
        '<label class="tw-origin">From&nbsp;' +
          '<input type="text" id="tw-origin" autocomplete="off" spellcheck="false">' +
        "</label>" +
      "</div>" +
      '<div class="tw-grid">' +
        '<div class="tw-col">' +
          '<div class="tw-col-head"><span class="tw-col-label">Outbound</span> ' +
            '<span class="tw-col-route" id="tw-out-route"></span>' +
          "</div>" +
          '<ul class="tw-list" id="tw-out"></ul>' +
        "</div>" +
        '<div class="tw-col">' +
          '<div class="tw-col-head"><span class="tw-col-label">Return</span> ' +
            '<span class="tw-col-route" id="tw-ret-route"></span>' +
          "</div>" +
          '<ul class="tw-list" id="tw-ret"></ul>' +
        "</div>" +
      "</div>" +
      '<div class="tw-foot">' +
        '<span class="tw-pulse"></span> Live via ' +
        '<a href="https://transport.opendata.ch" target="_blank" rel="noopener">transport.opendata.ch</a>' +
        ' · cached 1 h · times in local Swiss time' +
      "</div>";

    var $origin = host.querySelector("#tw-origin");
    var $out    = host.querySelector("#tw-out");
    var $ret    = host.querySelector("#tw-ret");
    var $outR   = host.querySelector("#tw-out-route");
    var $retR   = host.querySelector("#tw-ret-route");
    var outDest = destName;
    var retOrigin = (endPoint && endPoint.name) ? endPoint.name : trailhead.name;

    // For a point-to-point hike, the *outbound* lands at the trailhead;
    // the *return* leaves from the end_point. For an out-and-back, both
    // collapse to the trailhead.
    outDest = trailhead.name;
    retOrigin = (endPoint && endPoint.name) ? endPoint.name : trailhead.name;

    $origin.value = origin;
    $outR.textContent = origin + " → " + outDest;
    $retR.textContent = retOrigin + " → " + origin;

    function refresh() {
      setStatus($out, "Loading…", "loading");
      setStatus($ret, "Loading…", "loading");

      var date = todaySwissISO();

      fetchConnections({
        from: origin, to: outDest, date: date, limit: 4
      }, function (err, data) {
        if (err) { setStatus($out, "Live data unavailable — use SBB link below", "error"); return; }
        var conns = (data.connections || []).filter(function (c) {
          return c.from && c.from.departure && new Date(c.from.departure) >= new Date();
        }).slice(0, 3);
        renderList($out, conns, "No more outbound connections today");
      });

      // For "last 3 returns," anchor the search at late evening with
      // isArrivalTime=1 so the API returns connections that *arrive home by*
      // that time. We show the latest 3 of today regardless of whether they
      // have already departed — useful for planning a future visit. Past
      // departures are dimmed.
      fetchConnections({
        from: retOrigin, to: origin, date: date,
        time: String(LAST_RETURN_HOUR).padStart(2, "0") + ":00",
        isArrivalTime: 1, limit: 6
      }, function (err, data) {
        if (err) { setStatus($ret, "Live data unavailable — use SBB link below", "error"); return; }
        var todayPrefix = date;
        var conns = (data.connections || []).filter(function (c) {
          return c.from && c.from.departure && c.from.departure.indexOf(todayPrefix) === 0;
        });
        conns = conns.slice(-3);  // latest 3 of today
        // Tag past departures so the renderer can dim them.
        var now = new Date();
        conns.forEach(function (c) {
          c._past = new Date(c.from.departure) < now;
        });
        renderList($ret, conns, "No more return connections today");
      });
    }

    $origin.addEventListener("change", function () {
      var v = $origin.value.trim();
      if (!v) return;
      origin = v;
      writeOrigin(v);
      $outR.textContent = origin + " → " + outDest;
      $retR.textContent = retOrigin + " → " + origin;
      refresh();
    });
    $origin.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $origin.blur(); }
    });

    refresh();
    setInterval(refresh, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
