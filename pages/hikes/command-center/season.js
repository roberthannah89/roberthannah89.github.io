/* Season heuristic — estimates a "recommended hiking window" for each POI
   from its peak altitude and best SAC grade. Pure, deterministic, no data
   guessing per route.

   No authoritative per-route month data exists in the SAC search API (the
   only field, `discipline_season`, just says "summer"/"winter" and would
   require re-scraping each of ~960 route detail pages individually). Instead
   we derive a window from data we already have. Rules — strictly:

     Tier            Condition (whichever yields the highest tier wins)
     ─────────────   ──────────────────────────────────────────────────
     Year-round      alt < 1500 m  AND grade ≤ T2
     Lowland         alt < 1500 m  AND grade ≥ T3        → Apr–Nov
     Sub-alpine      1500 ≤ alt < 2000 m                 → May–Nov
     Alpine          2000 ≤ alt < 2500 m  OR grade = T4  → Jun–Oct
     High alpine     2500 ≤ alt < 3000 m  OR grade = T5  → Jun–Oct
     Glacial         alt ≥ 3000 m  OR grade = T6         → Jul–Sep

   The heuristic intentionally errs on the safe side: a route's tier is
   the MAXIMUM of its altitude tier and its grade tier (high grade widens
   the closed season even at moderate elevation; high elevation widens it
   even at modest grade). POIs missing altitude default to "Year-round";
   the filter can't reasonably exclude something with no signal.

   Source field on the returned object is always `'heuristic'`. Future:
   - SAC hut `opening` codes (per-month 0/1/2) → authoritative for huts
   - Per-route HTML scrape for `discipline_season` → authoritative coarse summer/winter
   When those land, return `source: 'sac'` and a derived window.

   IIFE + window-global pattern — see weather.js / webcams.js. Pages are
   opened via file://, so ES modules are not viable. */
(function () {
  'use strict';

  // Month indices are 1-based to match common date conventions (Jan = 1).
  // Year-round is encoded as start=1, end=12 so the UI can label it explicitly.
  var TIER_WINDOWS = {
    'year_round':  { start: 1,  end: 12, label: 'Year-round' },
    'lowland':     { start: 4,  end: 11, label: 'Apr–Nov'    },
    'sub_alpine':  { start: 5,  end: 11, label: 'May–Nov'    },
    'alpine':      { start: 6,  end: 10, label: 'Jun–Oct'    },
    'high_alpine': { start: 6,  end: 10, label: 'Jun–Oct'    },
    'glacial':     { start: 7,  end: 9,  label: 'Jul–Sep'    }
  };

  // SAC grade → tier name. T4 lifts to alpine, T5 to high_alpine, T6 to
  // glacial — independent of altitude. We use the WORST tier between the
  // altitude- and grade-derived tiers, since both push the season inward.
  //
  // Note on `lowland`: only reachable when BOTH altTier=lowland AND gradeTier
  // stays in lowland (T1/T2). But we override that combo to `year_round`
  // in tierFor(), so in practice `lowland` is dead branch in the current
  // taxonomy. Kept in the table for documentation completeness and to give
  // a sensible answer if the heuristic ever decouples the altitude floor
  // from grade.
  var GRADE_TIER = {
    1: 'lowland',
    2: 'lowland',
    3: 'sub_alpine',  // T3 implies real terrain — push to sub_alpine minimum
    4: 'alpine',
    5: 'high_alpine',
    6: 'glacial'
  };

  var TIER_ORDER = ['year_round', 'lowland', 'sub_alpine', 'alpine', 'high_alpine', 'glacial'];

  function altTier(alt) {
    if (alt == null) return null;
    if (alt < 1500) return 'lowland';        // base; year_round only if grade also low
    if (alt < 2000) return 'sub_alpine';
    if (alt < 2500) return 'alpine';
    if (alt < 3000) return 'high_alpine';
    return 'glacial';
  }

  function bestGradeNum(poi) {
    // Mirror Filters.bestGrade / Filters.gradeNum without depending on Filters
    // (season.js loads before filters.js — see index.html order).
    if (!poi || !poi.routes) return 1;
    var best = 'T1';
    for (var i = 0; i < poi.routes.length; i++) {
      var g = poi.routes[i].grade;
      if (g && g > best) best = g;
    }
    return parseInt((best || 'T1').replace('T', ''), 10) || 1;
  }

  function tierFor(poi) {
    var alt = poi && poi.alt;
    var g = bestGradeNum(poi);
    var aTier = altTier(alt);

    // Year-round: only when BOTH signals are low. Sub-alpine altitude with T1/T2
    // grade also stays modest — bumped to sub_alpine ('May–Nov') by altTier.
    if (aTier === 'lowland' && g <= 2) return 'year_round';

    var gTier = GRADE_TIER[g] || 'lowland';

    // Take the higher tier (closer to glacial = more restrictive window).
    var aIdx = TIER_ORDER.indexOf(aTier || 'year_round');
    var gIdx = TIER_ORDER.indexOf(gTier);
    return TIER_ORDER[Math.max(aIdx, gIdx)];
  }

  // Public: window for a POI. Always returns { start, end, label, source, tier }.
  function windowFor(poi) {
    var tier = tierFor(poi);
    var w = TIER_WINDOWS[tier] || TIER_WINDOWS.year_round;
    return {
      start: w.start,
      end: w.end,
      label: w.label,
      tier: tier,
      source: 'heuristic'
    };
  }

  // True if the POI is in season for the given 1-based month (defaults to today).
  function isInSeason(poi, month) {
    if (poi == null) return true;
    var m = month != null ? month : currentMonth();
    var w = windowFor(poi);
    // Window is inclusive on both ends and never crosses Dec→Jan (we don't
    // have a winter-only sport here), so a simple range check is enough.
    return m >= w.start && m <= w.end;
  }

  function currentMonth() {
    return new Date().getMonth() + 1;
  }

  // Month abbreviation for the "currently in season" filter label.
  var MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function currentMonthLabel() {
    return MONTH_ABBR[currentMonth()];
  }

  window.Season = {
    windowFor: windowFor,
    isInSeason: isInSeason,
    currentMonth: currentMonth,
    currentMonthLabel: currentMonthLabel,
    MONTH_ABBR: MONTH_ABBR
  };
})();
