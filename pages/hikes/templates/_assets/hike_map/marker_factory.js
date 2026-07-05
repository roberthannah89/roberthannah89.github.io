/* Marker factory. Configured once per page, called per POI to build a Leaflet
   divIcon. The two visible variants:
     • With weather → pill: <emoji> <temp°>, bordered in grade colour.
     • Without weather → grade-coloured dot.
   Optional corner badges:
     • showHasPage: amber ★ top-right when poi.hasPage
     • showFreezing: pale-blue ❄ bottom-right when poi.alt > forecast snow line
   Both pages consume this factory; the difference is showHasPage=true|false and
   which wxLookup (fuzzy on|off) is injected. */
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};

  window.HikeMap.MarkerFactory = function (cfg) {
    cfg = cfg || {};
    var wxLookup     = cfg.wxLookup;
    var showHasPage  = !!cfg.showHasPage;
    var showFreezing = cfg.showFreezing !== false;
    var gradeColors  = cfg.gradeColors || window.HikeMap.GRADE_COLORS;

    function gradeColor(g) { return window.HikeMap.gradeColor(g); }

    function makeIcon(poi, dayIndex) {
      var color = gradeColor(poi.grade);
      var wx    = wxLookup ? wxLookup.get(poi.lat, poi.lon, dayIndex) : null;
      var alt   = poi.alt != null ? poi.alt : poi.summitElev;
      var above = !!(showFreezing && alt && wx && wx.freezingLevel != null && alt > wx.freezingLevel);
      var star  = !!(showHasPage && poi.hasPage);

      var classes = 'hike-marker'
        + (wx && wx.code != null ? ' hike-marker--wx' : ' hike-marker--dot')
        + (star  ? ' hike-marker--has-page'       : '')
        + (above ? ' hike-marker--above-freezing' : '');

      if (wx && wx.code != null) {
        var emoji   = window.WeatherService.weatherIcon(wx.code);
        var tempStr = (wx.tempMax != null) ? Math.round(wx.tempMax) + '°' : '';
        var temp    = tempStr ? '<span class="hike-marker__temp">' + tempStr + '</span>' : '';
        return L.divIcon({
          className: '',
          html: '<div class="' + classes + '" style="border-color:' + color + ';background:' + color + '22">'
              + '<span class="hike-marker__wx">' + emoji + '</span>' + temp + '</div>',
          iconSize: [40, 28],
          iconAnchor: [20, 14],
        });
      }
      return L.divIcon({
        className: '',
        html: '<div class="' + classes + '" style="background:' + color + '"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
    }

    return { makeIcon: makeIcon };
  };
})();
