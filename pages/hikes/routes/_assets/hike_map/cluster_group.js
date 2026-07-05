// GENERATED FROM ../../templates/_assets/hike_map/cluster_group.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

/* Cluster group factory. Emits an L.markerClusterGroup whose cluster icon is
   the CC-style pill: <count> <dominant-sky-emoji> <avg-temp>. Both pages
   construct this via ClusterGroupFactory({ wxLookup, dayIndexGetter }). */
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};

  window.HikeMap.SKY_TINTS = {
    'clear':         { bg: 'rgba(232, 168, 50, 0.85)',  border: '#e8a832', color: '#1a1810' },
    'partly-cloudy': { bg: 'rgba(168, 152, 120, 0.85)', border: '#a89878', color: '#1a1810' },
    'cloudy':        { bg: 'rgba(60, 60, 70, 0.85)',    border: '#6a6a78', color: '#f0e8d8' },
    'rain':          { bg: 'rgba(80, 130, 200, 0.85)',  border: '#5082c8', color: '#f0e8d8' },
    'snow':          { bg: 'rgba(220, 230, 240, 0.85)', border: '#dce6f0', color: '#1a1810' },
    'storm':         { bg: 'rgba(180, 60, 60, 0.85)',   border: '#b43c3c', color: '#f0e8d8' },
  };

  window.HikeMap.ClusterGroupFactory = function (cfg) {
    cfg = cfg || {};
    var wxLookup        = cfg.wxLookup;
    var skyTints        = cfg.skyTints || window.HikeMap.SKY_TINTS;
    var dayIndexGetter  = cfg.dayIndexGetter || function () { return 0; };
    var WS              = window.WeatherService;

    function dominantWeather(cluster) {
      if (!WS || !wxLookup) return null;
      var counts = {}, tempSum = 0, tempN = 0;
      var day = dayIndexGetter();
      cluster.getAllChildMarkers().forEach(function (m) {
        var poi = m._poi || m._hike;   // both pages tag markers; keep compatibility
        if (!poi) return;
        var wx = wxLookup.get(poi.lat, poi.lon, day);
        if (!wx) return;
        var cat = WS.skyCategory(wx.code);
        if (cat) counts[cat] = (counts[cat] || 0) + 1;
        if (typeof wx.tempMax === 'number') { tempSum += wx.tempMax; tempN++; }
      });
      var best = null, max = 0;
      Object.keys(counts).forEach(function (k) { if (counts[k] > max) { best = k; max = counts[k]; } });
      if (!best) return null;
      var defn = WS.SKY_CATEGORIES.find(function (c) { return c.key === best; });
      return { tint: skyTints[best], emoji: defn ? defn.icon : '', temp: tempN ? tempSum / tempN : null };
    }

    return L.markerClusterGroup({
      maxClusterRadius: 45,
      disableClusteringAtZoom: 13,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      chunkedLoading: true,
      iconCreateFunction: function (cluster) {
        var count = cluster.getChildCount();
        var info  = dominantWeather(cluster);
        var style = info && info.tint
          ? 'background:' + info.tint.bg + ';border-color:' + info.tint.border + ';color:' + info.tint.color
          : '';
        var emoji   = info && info.emoji ? info.emoji : '';
        var tempStr = info && info.temp !== null ? Math.round(info.temp) + '°' : '';
        return L.divIcon({
          html: '<div style="' + style + '">'
              + '<span class="cl-n">' + count + '</span>'
              + (emoji   ? '<span class="cl-wx">' + emoji   + '</span>' : '')
              + (tempStr ? '<span class="cl-t">'  + tempStr + '</span>' : '')
              + '</div>',
          className: 'marker-cluster',
          iconSize: L.point(64, 28),
        });
      },
    });
  };
})();
