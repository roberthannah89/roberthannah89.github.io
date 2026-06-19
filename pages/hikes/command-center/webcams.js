/* Webcam layer — self-contained Leaflet layer of Windy webcam markers.
   Reads from window.WINDY_WEBCAMS (see webcams_windy_data.js).
   Exposes WebcamLayer.create() returning an L.layerGroup. */

// Cap markers to top N by views to keep the map uncluttered.
var DISPLAY_LIMIT = 80;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relativeTime(iso) {
  if (!iso) return '';
  var then = Date.parse(iso);
  if (isNaN(then)) return '';
  var diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  var min = Math.round(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return 'Updated ' + min + ' min ago';
  var hr = Math.round(min / 60);
  if (hr < 24) return 'Updated ' + hr + ' hour' + (hr === 1 ? '' : 's') + ' ago';
  var day = Math.round(hr / 24);
  return 'Updated ' + day + ' day' + (day === 1 ? '' : 's') + ' ago';
}

function makeIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="webcam-marker">📷</div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14]
  });
}

function popupHtml(cam) {
  var nameEsc = esc(cam.name);
  var thumbEsc = esc(cam.thumb);
  var urlEsc = esc(cam.url);
  var locParts = [];
  if (cam.city) locParts.push(esc(cam.city));
  if (cam.region) locParts.push(esc(cam.region));
  var loc = locParts.join(' &middot; ');
  var rel = relativeTime(cam.updated);

  return (
    '<div class="webcam-popup">' +
      '<div class="webcam-popup__name">' + nameEsc + '</div>' +
      (loc ? '<div class="webcam-popup__loc">' + loc + '</div>' : '') +
      '<div class="webcam-popup__thumb-wrap">' +
        '<img class="webcam-popup__thumb" src="' + thumbEsc + '" ' +
          'alt="' + nameEsc + ' webcam" loading="lazy" ' +
          'onerror="this.parentNode.classList.add(\'webcam-popup__thumb-wrap--err\');this.remove();" />' +
      '</div>' +
      (rel ? '<div class="webcam-popup__updated">' + esc(rel) + '</div>' : '') +
      '<a class="webcam-popup__link" href="' + urlEsc + '" ' +
        'target="_blank" rel="noopener">View live &rarr;</a>' +
    '</div>'
  );
}

// Lazy-load webcams_windy_data.js by injecting a classic <script> tag — the
// file sets window.WINDY_WEBCAMS as a side effect. We do this on demand so
// the ~100 KB blob isn't downloaded until the user opens the webcams layer.
var dataPromise = null;
function ensureData() {
  if (window.WINDY_WEBCAMS) return Promise.resolve();
  if (dataPromise) return dataPromise;
  dataPromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'webcams_windy_data.js';
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('Failed to load webcams_windy_data.js')); };
    document.head.appendChild(s);
  }).catch(function (err) {
    console.warn(err);
    // Reset so a later toggle re-attempts the load.
    dataPromise = null;
  });
  return dataPromise;
}

// Returns a Promise resolving to an L.LayerGroup of webcam markers. The data
// blob is fetched on first call only; subsequent calls reuse window globals.
function create() {
  return ensureData().then(function () {
    var group = L.layerGroup();
    var cams = window.WINDY_WEBCAMS || [];
    if (!cams.length) return group;

    // Data is already sorted by views (per fetch script), but sort defensively.
    var sorted = cams.slice().sort(function (a, b) {
      return (b.views || 0) - (a.views || 0);
    });
    var top = sorted.slice(0, DISPLAY_LIMIT);

    var icon = makeIcon();
    top.forEach(function (cam) {
      if (typeof cam.lat !== 'number' || typeof cam.lon !== 'number') return;
      var marker = L.marker([cam.lat, cam.lon], {
        icon: icon,
        title: cam.name,
        riseOnHover: true
      });
      marker.bindPopup(popupHtml(cam), {
        maxWidth: 280,
        minWidth: 240,
        className: 'webcam-popup-wrapper',
        closeButton: true
      });
      group.addLayer(marker);
    });

    return group;
  });
}

export const WebcamLayer = {
  create: create,
  DISPLAY_LIMIT: DISPLAY_LIMIT
};
