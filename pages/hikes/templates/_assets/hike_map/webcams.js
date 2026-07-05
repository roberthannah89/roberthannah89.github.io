/* Webcam layer — self-contained Leaflet layer of Windy webcam markers.
   Reads from window.WINDY_WEBCAMS (see webcams_windy_data.js).
   Exposes window.WebcamLayer.create() returning an L.layerGroup. */
(function () {
  'use strict';

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

  function create() {
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
  }

  window.WebcamLayer = {
    create: create,
    DISPLAY_LIMIT: DISPLAY_LIMIT
  };
})();
