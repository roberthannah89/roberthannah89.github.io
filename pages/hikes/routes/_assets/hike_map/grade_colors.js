// GENERATED FROM ../../templates/_assets/hike_map/grade_colors.js — edit the template, not this file.
// scripts/render_hike.py sync_assets() overwrites this on every `make render` (and on CI).

/* Grade colours — the sole source of truth used by every marker and pill on
   both pages. Values match the T1–T6 SAC scale and are wired into
   marker_factory.js and marker_pill.css. */
(function () {
  'use strict';
  window.HikeMap = window.HikeMap || {};
  window.HikeMap.GRADE_COLORS = {
    1: '#5cbf6a',
    2: '#5cbf6a',
    3: '#e8a832',
    4: '#d97333',
    5: '#cc3333',
    6: '#8844cc',
  };
  window.HikeMap.gradeColor = function (grade) {
    var n = parseInt(String(grade || 'T1').replace(/^T/i, ''), 10) || 1;
    return window.HikeMap.GRADE_COLORS[n] || window.HikeMap.GRADE_COLORS[1];
  };
})();
