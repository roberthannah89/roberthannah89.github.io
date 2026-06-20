# Offline Support — Design Memo

> Status: **prototype + design proposal**. The code in `manifest.webmanifest` /
> `service-worker.js` is intentionally minimal; this document is the contract
> for what to build next.

The hiking site is currently served via `file://` for local development. That
is a hard ceiling on what "offline" can mean today: Service Workers,
`fetch()`, the Cache API, IndexedDB, and `BeforeInstallPromptEvent` all
require a secure context (HTTPS or `http://localhost`). **Offline support is
gated on publishing the site.** Everything below assumes the site is live at
`https://roberthannah89.github.io/pages/hikes/` (the repo already targets
GitHub Pages — see root `README.md`).

---

## 1. What "offline" should mean for this site

The user story is concrete:

> "I plan a hike at home on Friday, open the hike page, tap **Save for
> offline**. On Sunday the cable car has no signal. I open the same URL from
> my home screen on the ridge and still see the route, the topo map under
> it, the elevation profile, photos, transit/return info, and the printed
> field-reference."

That sets the **must-work-offline** scope:

| Capability                              | Source                            | Offline? |
|-----------------------------------------|-----------------------------------|----------|
| Hike HTML page                          | `routes/<slug>/<slug>.html`       | **yes**  |
| GPX track on map                        | `routes/<slug>/<slug>.track.js`   | **yes**  |
| Elevation profile + grade colouring     | inlined into `<slug>.track.js`    | **yes**  |
| Map basemap (SwissTopo topo + trails)   | swisstopo WMTS                    | **yes — within hike bbox, zooms 12–16** |
| Photos in gallery                       | `sac-cas.ch/processed/...`        | **yes — cached on first load** |
| Field-reference table (GPS coords)      | inlined HTML                      | **yes**  |
| `index.html` gallery (read-only)        | `index.html` + `hikes.js`         | **yes**  |
| Difficulty / planning / gear guides     | `guides/*.html`                   | **yes**  |
| 3D terrain view                         | MapLibre + SwissTopo DEM          | **no — heavy + lazy-loaded, skip** |
| Live weather forecast                   | `api.open-meteo.com`              | **no — degrade**  |
| SBB / Google Maps transit deep-links    | external URL                      | **no — link visible, opens nothing** |
| Avalanche bulletin, webcams (CC)        | external                          | **no — degrade**  |
| Command Center cross-hike weather sort  | depends on live forecast          | **no — degrade**  |

Out of scope on purpose: anything that requires fresh data to be useful
(weather, transit times, avalanche). The trail itself does not change
hour-to-hour, so we cache it; the weather does, so we don't pretend.

---

## 2. Hosting

GitHub Pages is already the deployment target (`README.md` at repo root):
`https://roberthannah89.github.io/`. That is sufficient — HTTPS, a stable
origin, real URLs (no `file://`). No change required.

Things to confirm at publish time:

- **Service-Worker scope.** A SW registered at
  `/pages/hikes/service-worker.js` controls everything under `/pages/hikes/`.
  Register it from `index.html` and each hike page; the same SW file handles
  both. Do *not* register at site root unless we want to claim the rest of
  the personal site.
- **MIME types.** GitHub Pages serves `.webmanifest` as
  `application/manifest+json` and `.js` as `application/javascript`
  out-of-the-box. Confirmed safe.
- **HSTS / mixed content.** All embedded assets are already HTTPS (SwissTopo
  WMTS, SAC photos, unpkg). No fix needed.

Cloudflare Pages or Netlify would also work and offer `_headers` files for
explicit caching control, but the marginal benefit is small and we'd lose
the "same repo, one push, it ships" simplicity. **Recommendation: stay on
GitHub Pages.**

---

## 3. Map tiles — the hard part

SwissTopo tiles are 256×256 PNG/JPEG, served per-`{z}/{x}/{y}`. The bbox of
a typical hike is small (a few km square), but tile counts grow as 4^z. A
realistic budget per hike, computed for the augstmatthorn route bbox
(~0.05° × 0.05°):

| Zoom | Tiles in bbox | ~Bytes/tile | Subtotal |
|------|---------------|-------------|----------|
| 11   | 1             | 30 KB       | 30 KB    |
| 12   | 2             | 40 KB       | 80 KB    |
| 13   | 6             | 50 KB       | 300 KB   |
| 14   | 20            | 60 KB       | 1.2 MB   |
| 15   | 70            | 70 KB       | 4.9 MB   |
| 16   | 260           | 80 KB       | 21 MB    |
| 17   | 1,000         | 90 KB       | 90 MB    |

Realistic working set for navigation is **zooms 12–16** (overview to "where
am I on this contour"). Going to 17 quadruples the storage with diminishing
value — switzerland's 1:25k topo is already drawn at z15-z16.

**Three options for tile caching:**

**(a) Pre-bundled tile slice per hike (build time).**
Run `python scripts/fetch_tiles.py --slug <slug> --zooms 12-16` once,
write tiles into `routes/<slug>/tiles/<z>/<x>/<y>.jpeg`, rewrite the
`L.tileLayer` URL on hike pages to use the local path (with a remote
fallback for tiles outside the bbox). Ships ~5–10 MB per hike. Works on
`file://` immediately (no SW needed). Bumps repo size; with 77 hikes that's
~400 MB — too big for git, must go to git-LFS or to a separate
`tiles.roberthannah89.github.io` host. **Verdict: heavy, but the only
option that works without a network on first visit.**

**(b) Service-Worker cache-on-visit.**
First time the user opens the hike page online, the SW intercepts every
WMTS request and caches the response. When they go offline, the same tiles
return from cache. The "Save for offline" button pre-warms by iterating
the bbox and `fetch()`-ing every tile in the chosen zoom range — this is
the same data as (a) but stored in the browser's Cache API, paid for by
the device, not the repo.

Caveats:
- Per-origin storage quota (~6% of free disk on Chrome, ~1 GB on Safari);
  77 hikes × 7 MB = ~500 MB which is fine for one user but uncomfortably
  close to Safari's limit if every hike is pre-warmed.
- Tiles are opaque cross-origin responses (`fetch(url, { mode: 'no-cors' })`
  returns an "opaque" Response). Opaque responses count toward storage at
  their padded size (sometimes inflated 7×). Workaround: enable CORS on
  swisstopo (they already do — `Access-Control-Allow-Origin: *`), then use
  `mode: 'cors'` so storage accounting matches actual bytes.
- Eviction: browsers evict caches under storage pressure. Use the
  [Storage API](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
  `navigator.storage.persist()` after the user explicitly opts in via "Save
  for offline" — this asks the OS to keep the data even under pressure.

**(c) Punt to a real offline-maps app.**
Add a button "Open in swisstopo app" that deep-links the GPX +
[swisstopo's mobile-deep-link](https://www.swisstopo.admin.ch/en/swisstopo-application).
The user already prefers swisstopo for actual navigation (per
`guides/gear.html`). Our site stays the *planning* tool; the phone uses
the dedicated app on-trail.

**Recommendation: (b) cache-on-visit + "Save for offline" pre-warm, with a
prominent (c) link to the swisstopo app as the primary recommendation.**

Why: (a) is the heaviest engineering lift (build-script changes, repo bloat,
hosting fork). (b) requires no schema changes, scales naturally, and is the
right answer for the casual "I forgot to download in the app" case. (c) is
what serious hikers should be using anyway — own the cliché:
*this site is for planning; for navigation, use swisstopo*.

The build-time precompute (option a) is a one-week project worth doing
later, if traffic warrants it. It's not the right first move.

---

## 4. Other assets to cache

Everything **inside the SW scope** (`/pages/hikes/`), keyed by URL:

### Precache (install-time, mandatory)

These are tiny and shared across hikes — fetch them all once at SW install:

- `index.html`
- `hikes.js` (gallery data, ~50 KB)
- `routes/_assets/map_shared.{js,css}`
- `routes/_assets/hike_page.{js,css}`
- `routes/_assets/swiss_border.js` (510 KB — biggest single shared file)
- `routes/_assets/favicon*.{ico,png,svg}`
- `guides/*.html` (planning, weather, gear, difficulty)
- `manifest.webmanifest`

Vendored libraries (currently loaded from `unpkg.com`):

- `leaflet@1.9.4/dist/leaflet.{js,css}` — ~150 KB combined
- `maplibre-gl@4.7.1/dist/maplibre-gl.{js,css}` — ~800 KB; lazy-loaded only
  for 3D view, **skip** for offline budget

**Action item:** stop CDN-loading Leaflet at runtime. Self-host
`routes/_assets/vendor/leaflet.{js,css}` so the SW can precache them and so
the page works first-load on a captive-wifi/poor-signal trailhead.
Maplibre stays CDN — it's only for 3D and 3D isn't an offline scenario.

### Cache-on-visit (per-hike)

When the user lands on a hike page or hits **Save for offline**:

- `routes/<slug>/<slug>.html`
- `routes/<slug>/<slug>.track.js`
- `routes/<slug>/<slug>.gpx`
- `routes/<slug>/<slug>.3d-preview.jpg`
- All photo URLs referenced from `data.json` (`p.url` and `p.lightbox_url`)
- All SwissTopo WMTS tiles within the hike's bbox at zooms 12–16
- *(Not* `data.json` itself — it's already inlined into the HTML by
  `render_hike.py`; nothing fetches it at runtime.)

Hero image (`hero.image_url`) is also typically an external photo URL —
same cache rule applies.

### Never cache

- `api.open-meteo.com/v1/forecast` — always live; respond with cached
  stale-with-warning if offline.
- SBB / Google Maps deep-links — those are external navigations, not
  fetches. The buttons stay visible and just won't open anything useful.
- `command-center/weather-cache.js` — refreshed every render; treat as
  network-first.

---

## 5. Graceful degradation when offline

The forecast section currently shows "Loading forecast…" forever if the
fetch fails. Fix it:

- Wrap `fetchHourly()` in `hike_page.js:844` with a `try/catch`. On
  failure, render: *"Forecast unavailable offline. Last update at home:
  [date+time stored in localStorage on prior successful fetch]. Tap to
  retry."*
- Same pattern for any other live data: cache the last successful payload
  in `localStorage` keyed by URL, render with a staleness indicator.
- Transit buttons: leave clickable. Tapping them with no network is a
  no-op the OS handles; the user understands.
- 3D view: hide the **Load interactive 3D view** button when
  `navigator.onLine === false`. The preview image is already cached on
  first visit; show it with a "3D view requires internet" caption.

This pattern is generic; centralise it as a tiny helper in
`hike_page.js`:

```js
async function fetchWithFallback(url, key) {
  try {
    const r = await fetch(url);
    const data = await r.json();
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
    return { data, stale: false };
  } catch (e) {
    const cached = localStorage.getItem(key);
    if (!cached) throw e;
    const { at, data } = JSON.parse(cached);
    return { data, stale: true, cachedAt: new Date(at) };
  }
}
```

---

## 6. Storage budget

Rough working numbers (Augstmatthorn = representative T3 day-hike):

| Asset                          | Bytes      |
|--------------------------------|------------|
| HTML                           | 220 KB     |
| `.track.js` (inlined GPX+segs) | 50 KB      |
| `.gpx`                         | 12 KB      |
| `.3d-preview.jpg`              | 170 KB     |
| Photos (10 SAC images)         | ~3 MB      |
| **Per-hike subtotal**          | **~3.5 MB**|
| SwissTopo tiles z12–16         | ~6 MB      |
| **Per-hike with tiles**        | **~10 MB** |

Shared precache (paid once):

| Asset                              | Bytes  |
|------------------------------------|--------|
| Leaflet (self-hosted)              | 150 KB |
| `map_shared.js + .css`             | 8 KB   |
| `hike_page.js + .css`              | 80 KB  |
| `swiss_border.js`                  | 510 KB |
| `hikes.js` gallery data            | ~50 KB |
| Guides (4 HTML pages)              | ~150 KB|
| **Total shared**                   | **~1 MB** |

So:

- **One hike installed offline: ~11 MB.** Trivially within budget.
- **All 77 hikes pre-warmed: ~750 MB.** Pushes against Safari/iOS limits;
  acceptable on Android/desktop; not a realistic workflow regardless
  (nobody pre-loads every hike).
- **Realistic mobile user with 5 hikes saved: ~55 MB.** Comparable to a
  single Spotify playlist. **Worth installing as a PWA: yes.**

The "Save for offline" button on the hike page should report estimated
bytes ("~10 MB") before pre-warming so users know what they're paying.

---

## 7. Update strategy

Static-site updates land via `make render`. The SW needs to know when the
cached HTML is stale. Pattern:

- **App shell (HTML, CSS, JS, guides, vendor):** version-pinned by SW.
  Bump `SW_VERSION` constant in `service-worker.js` on each deploy; old
  cache is purged in the `activate` handler. Easy to automate as a
  `make render` step that injects `SW_VERSION = "<git-sha>"`.
- **Per-hike content (HTML, track, photos, tiles):** stale-while-revalidate.
  Serve the cached copy instantly; in the background re-fetch and update
  the cache for next visit. The user gets fresh data on the *second* visit
  after a content change, which matches the reality that they planned the
  hike at home before they cared.
- **Live data (weather, transit):** network-first with cache fallback.
  Always try live; fall back to last good. Stamp UI with "last updated at
  HH:MM".

When `make render` runs, it bumps the SW version. Browsers re-fetch the SW
on next page load (and at most every 24h regardless), notice the version
change, install fresh, and on the *next* navigation the new SW takes over.
We can add a small "Site updated — refresh to see changes" toast if we
want eager updates; keep it muted (no annoying full-page reloads).

---

## 8. Phased rollout

Listed in increasing engineering cost:

1. **Ship the manifest + minimal SW.** Site becomes installable as a PWA.
   Precache the app shell. *(This commit.)*
2. **Self-host Leaflet** in `routes/_assets/vendor/`. Stop being a captive
   of unpkg's uptime.
3. **Cache-on-visit for hike content.** Every navigated hike page caches
   its own HTML + track + photos. No user action required.
4. **"Save for offline" button.** Pre-warms tiles for the hike's bbox at
   chosen zoom range. Shows estimated size; uses `navigator.storage.persist()`.
5. **Graceful degradation pass.** Wrap every live `fetch()` with
   `fetchWithFallback`; render stale-data badges.
6. **Settings page.** Show what's cached, total storage, per-hike eviction
   button, "Clear all caches".

(1) and (2) are this PR. (3)–(6) are future work. The design memo above
should be the contract for them.

---

## 9. What this prototype actually delivers

- `pages/hikes/manifest.webmanifest` — minimal PWA manifest, installable.
- `pages/hikes/service-worker.js` — cache-first for static assets,
  network-first for everything else, no-op safe on `file://`.
- `templates/_assets/sw-register.js` — small registrar that's safe to
  include from every page; bails out on `file://` and on unsupported
  browsers.
- Hook-up in `templates/hike_page.j2.html` and `templates/index.j2.html`.

The SW will not activate when the page is opened from `file://` because
`navigator.serviceWorker` is undefined in that protocol. The registrar logs
a one-line debug message and returns. This is intentional: the same code
ships to GitHub Pages and the SW lights up there.

---

## 10. The gating decision for the user

**Publish the site.** Until `https://roberthannah89.github.io/pages/hikes/`
is live, none of this matters. The repo is already set up for GitHub Pages
(per repo-root `README.md`), so this should be a one-command
`git push origin main` plus a one-time toggle of "Pages → main branch" in
the GitHub repo settings.

Once live, the next two decisions are:

- **Tile caching path:** confirm (b) cache-on-visit + (c) swisstopo-app
  link is the right combo, vs. doing the heavy (a) build-time precompute.
- **Per-hike asset budget:** ok with ~10 MB per saved hike, or should we
  cap photo cache (e.g. cache thumbnails only)?

Everything else (vendor self-hosting, fallback pass, settings page) is
mechanical and follows from the design above.
