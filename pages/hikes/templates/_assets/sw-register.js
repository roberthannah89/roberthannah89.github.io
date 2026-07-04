/* Service Worker registrar — safe to include from any page in the hike
 * site. Bails out (with a one-line console note) when the page is opened
 * from file:// or in a browser without SW support. On https:// it
 * registers /pages/hikes/service-worker.js with scope /pages/hikes/.
 *
 * The SW path is computed from this script's own URL so the same file
 * works whether it's loaded by index.html ("./routes/_assets/...") or by
 * a hike page ("../_assets/..."). No path-juggling at the call site.
 *
 * See docs/design/offline.md for the full design.
 */
(function () {
  "use strict";

  // 1. Bail on file:// — SW requires a secure context. This is the
  //    development case and is expected: the message is informational,
  //    not an error.
  if (location.protocol === "file:") {
    if (window.console) console.info("[sw-register] file:// — service worker disabled (dev mode).");
    return;
  }

  // 2. Bail on browsers without SW. (Modern Safari/Chrome/Firefox have it;
  //    very old WebViews don't.)
  if (!("serviceWorker" in navigator)) {
    if (window.console) console.info("[sw-register] serviceWorker not supported in this browser.");
    return;
  }

  // 3. Resolve the SW URL relative to *this script's* location, so callers
  //    don't need to know how deep they are in the directory tree. The
  //    SW lives at <hikes-root>/service-worker.js and this script lives
  //    at <hikes-root>/routes/_assets/sw-register.js, so we go up two.
  var thisScript = document.currentScript;
  if (!thisScript) {
    // <script defer> doesn't expose currentScript at execution time on all
    // browsers; fall back to a known relative path resolved against the
    // page URL. Pages always live at <hikes-root>/... so this matches.
    var here = new URL(location.href);
    // index.html sits at the hikes root; everything else is at least one
    // directory below. We rely on the marker meta tag, see template.
    var marker = document.querySelector('meta[name="hike-site-root"]');
    if (!marker || !marker.content) {
      console.warn("[sw-register] no document.currentScript and no <meta name=\"hike-site-root\">; skipping.");
      return;
    }
    registerAt(new URL(marker.content, here).toString());
    return;
  }

  var assetUrl = new URL(thisScript.src);                        // /.../routes/_assets/sw-register.js
  var hikesRoot = new URL("../../", assetUrl).toString();        // /.../  (with trailing slash)
  registerAt(hikesRoot);

  // 4. Auto-reload once when a new SW takes control of this page. Without
  //    this, a returning visitor sees the freshly-deployed SW activate in
  //    the background but the DOM they're looking at is still the OLD
  //    cached HTML — the fix doesn't show up until they hard-refresh.
  //    Fires exactly once per lifetime: the `refreshing` guard prevents an
  //    infinite reload loop if the browser races two controllerchange
  //    events. The event does NOT fire on the very first page load (there
  //    was no prior controller), so first-time visitors don't get an
  //    unexpected reload.
  var refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (refreshing) return;
    refreshing = true;
    if (window.console) console.info("[sw-register] new service worker took control — reloading for fresh content.");
    window.location.reload();
  });

  function registerAt(rootUrl) {
    var swUrl = rootUrl + "service-worker.js";
    navigator.serviceWorker
      .register(swUrl, { scope: rootUrl })
      .then(function (reg) {
        if (window.console) console.info("[sw-register] active, scope=" + reg.scope);
      })
      .catch(function (err) {
        if (window.console) console.warn("[sw-register] failed:", err);
      });
  }
})();
