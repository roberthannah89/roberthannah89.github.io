/* Service Worker for the hike site.
 *
 * Scope: registered from /pages/hikes/ — controls index.html, every
 * routes/<slug>/*.html, the guides/*.html pages, and all shared assets
 * under routes/_assets/.
 *
 * It will NOT activate on file:// because navigator.serviceWorker is
 * undefined in that protocol; the registrar (sw-register.js) bails out
 * before reaching this file. This SW only runs once the site is published
 * to https://roberthannah89.github.io/pages/hikes/ (or any other HTTPS
 * origin / http://localhost dev server).
 *
 * Strategy (see docs/design/offline.md for the full design):
 *   - App shell (HTML, CSS, JS, guides, favicons, manifest):
 *     CACHE-FIRST, version-pinned. Bump SW_VERSION on each deploy to
 *     force a refresh.
 *   - Per-hike content (route HTML, track.js, gpx, photos, SwissTopo
 *     tiles): CACHE-FIRST after first visit, cached in a separate
 *     versionless "runtime" cache so SW_VERSION bumps don't blow it away.
 *   - Live data (open-meteo, SAC, anything not in shell or runtime
 *     allowlist): NETWORK-FIRST with no fallback — the SW just steps
 *     out of the way and lets the page handle failure.
 *
 * This is the prototype. It does NOT yet:
 *   - intercept SwissTopo WMTS tiles (the runtime cache pattern below
 *     supports it; the URL pattern is just commented out until we agree
 *     on the tile-budget policy).
 *   - pre-warm tiles via a "Save for offline" button.
 *   - report cache size or evict per hike.
 * See docs/design/offline.md §8 for the phased plan.
 */

const SW_VERSION = "v0-prototype-2026-06-19";
const SHELL_CACHE = `hikes-shell-${SW_VERSION}`;
const RUNTIME_CACHE = "hikes-runtime";   // versionless on purpose

// Files that must be present for the site to render at all. Listed
// relative to the SW scope (/pages/hikes/). Kept short and conservative:
// the bigger this list, the more likely the SW install fails on a flaky
// network. Per-page assets are picked up by the runtime cache instead.
const SHELL_ASSETS = [
  "./index.html",
  "./manifest.webmanifest",
  "./hikes.js",
  "./routes/_assets/map_shared.js",
  "./routes/_assets/map_shared.css",
  "./routes/_assets/hike_page.js",
  "./routes/_assets/hike_page.css",
  "./routes/_assets/swiss_border.js",
  "./routes/_assets/favicon.ico",
  "./routes/_assets/favicon-192.png",
  "./routes/_assets/favicon-512.png",
];

// External origins we are willing to cache opaquely on first visit
// (cache-first, never updated until SW_VERSION changes). Any request to
// an origin NOT in this list is left to network-first.
const RUNTIME_HOST_ALLOWLIST = [
  "unpkg.com",                // leaflet (TODO: self-host then drop from here)
  "www.sac-cas.ch",           // hike photos
  // "wmts.geo.admin.ch",     // SwissTopo tiles — re-enable when tile budget policy lands
];

// URLs we never cache, even if same-origin (live data).
const NEVER_CACHE_HOSTS = [
  "api.open-meteo.com",
];

/* ----- install: precache the app shell --------------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll() is atomic — if any single request fails the whole install
      // fails. That's the right behaviour for the shell.
      cache.addAll(SHELL_ASSETS)
    ).then(() => self.skipWaiting())
  );
});

/* ----- activate: purge old shell caches -------------------------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("hikes-shell-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ----- fetch: routing -------------------------------------------------- */
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only GET; let POSTs etc. pass through untouched.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Live data → never intercept.
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return;

  // Same-origin shell hit? Cache-first against SHELL_CACHE.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // Cross-origin and allow-listed? Cache-first against RUNTIME_CACHE.
  if (RUNTIME_HOST_ALLOWLIST.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // Everything else: don't intercept.
});

/* ----- helpers --------------------------------------------------------- */
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: false });
  if (cached) return cached;

  try {
    const fresh = await fetch(req);
    // Don't cache error responses — would freeze a 404 forever.
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    // Genuinely offline and not cached. Let the page handle the failure.
    throw err;
  }
}

/* ----- messages from page ---------------------------------------------- */
// Hook for the future "Save for offline" button — pass a list of URLs
// from the page; the SW pre-warms them into the runtime cache. Inert
// until a page actually posts the message.
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "PREWARM" && Array.isArray(msg.urls)) {
    event.waitUntil(prewarm(msg.urls));
  }
});

async function prewarm(urls) {
  const cache = await caches.open(RUNTIME_CACHE);
  await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await fetch(u, { cache: "reload" });
        if (r && r.ok) await cache.put(u, r);
      } catch (_) {
        // Best-effort; ignore individual failures.
      }
    })
  );
}
