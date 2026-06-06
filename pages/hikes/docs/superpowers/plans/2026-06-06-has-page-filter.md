# Has-page filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `⭐` bottom-bar toggle to the command center that filters POIs to only those with a built hike page in this repo.

**Architecture:** Three small client-side edits — `filters.js` (new state field + match function), `command-center.js` (stash `poi._hasPage`, register toggle), `url-sync.js` (encode/decode the new state). No new files, no CSS, no template changes. The `SidePanel.matchingHike()` logic that already drives the amber-ring styling is reused as the data source.

**Tech Stack:** Plain browser JS (no build step), Playwright for verification (run via the `mcp__playwright__*` tools in Claude).

**Spec:** `docs/superpowers/specs/2026-06-06-has-page-filter-design.md`

**Testing note:** The command center has no JS unit test framework. Verification is browser-based — load the page via `file://`, drive it with Playwright, observe DOM/state. Each task ends with a concrete verification step.

---

## Task 1: Add `hasPage` state field and filter logic to `filters.js`

**Files:**
- Modify: `command-center/filters.js`

- [ ] **Step 1: Add `hasPage` to the state initializer**

In `filters.js` around line 5-20, add a new field next to the other null-default filters. The block currently reads:

```js
var state = {
  grades: [],        // [] = any, or ['T3','T4'] etc
  duration: null,    // null=any, 'short', 'medium', 'long'
  elevation: null,   // null=any, 'low', 'mid', 'high'  (peak altitude)
  gain: null,        // null=any, 'easy', 'mod', 'hard', 'epic'  (vertical ascent)
  showHikes: true,   // include peaks/summits/traverses
  showHuts: true,    // include SAC huts
  weatherDay: 0,     // day index for weather filters
  sky: null,         // null = any; or one of 'clear'|'partly-cloudy'|'cloudy'|'rain'|'snow'|'storm' (threshold — "this weather or better")
  tempMin: null,     // null=any, or number (°C threshold)
```

Add a new line immediately after `gain`:

```js
  hasPage: null,     // null=any (default), true=only POIs with a built hike page in this repo
```

- [ ] **Step 2: Add the `matchesHasPage` function**

Insert this function in `filters.js` immediately before `function matchesWeather(poi)` (around line 120):

```js
  function matchesHasPage(poi) {
    if (!state.hasPage) return true;
    return !!poi._hasPage;
  }
```

- [ ] **Step 3: Wire `matchesHasPage` into `matchesPoi`**

The current `matchesPoi` (around line 147) reads:

```js
  function matchesPoi(poi) {
    return matchesType(poi) && matchesGrade(poi) && matchesDuration(poi)
        && matchesElevation(poi) && matchesGain(poi) && matchesWeather(poi);
  }
```

Replace it with:

```js
  function matchesPoi(poi) {
    return matchesType(poi) && matchesGrade(poi) && matchesDuration(poi)
        && matchesElevation(poi) && matchesGain(poi) && matchesHasPage(poi)
        && matchesWeather(poi);
  }
```

- [ ] **Step 4: Verify the file still loads (smoke check)**

Run:

```bash
node --check /opt/code/website/pages/hikes/command-center/filters.js
```

Expected: no output (syntax OK).

- [ ] **Step 5: Commit**

```bash
git add command-center/filters.js
git commit -m "command-center: add hasPage filter state + matcher"
```

---

## Task 2: Stash `_hasPage` on the POI object in `command-center.js`

**Files:**
- Modify: `command-center/command-center.js`

**Why:** `Filters.matchesPoi` operates on `poi`, but the `hasPage` flag currently only lives on the marker. The cheapest fix: stash it on the POI itself alongside the existing marker assignment.

- [ ] **Step 1: Add `poi._hasPage = hasPage;`**

In `command-center.js` inside `createMarkers()`, the current block (around line 99-110) reads:

```js
      var grade = Filters.bestGrade(poi);
      var color = gradeColor(grade);
      // Subtle amber ring on markers whose hike has a built page in this repo.
      // Reuses SidePanel.matchingHike so we don't drift from the panel's link logic.
      var hasPage = !!(window.SidePanel && SidePanel.matchingHike && SidePanel.matchingHike(poi));

      var marker = L.marker([poi.lat, poi.lon], {
        icon: makeHikeIcon(color, 'dot', null, null, hasPage)
      });

      marker._poi = poi;
      marker._color = color;
      marker._hasPage = hasPage;
      marker._filtered = false;
```

Add one line after the `var hasPage = ...` computation:

```js
      var hasPage = !!(window.SidePanel && SidePanel.matchingHike && SidePanel.matchingHike(poi));
      poi._hasPage = hasPage;
```

Leave `marker._hasPage = hasPage;` in place — it's still used by `refreshMarkerIcons`.

- [ ] **Step 2: Verify the file still loads**

Run:

```bash
node --check /opt/code/website/pages/hikes/command-center/command-center.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add command-center/command-center.js
git commit -m "command-center: stash _hasPage on poi for filter access"
```

---

## Task 3: Register the ⭐ toggle in the bottom bar

**Files:**
- Modify: `command-center/command-center.js`

- [ ] **Step 1: Add the toggle to `buildWeatherToggles`**

In `command-center.js`, the current `toggles` array inside `buildWeatherToggles()` (around line 681) reads:

```js
    var toggles = [
      { id: 'hikes',   icon: '⛰️', label: 'Hikes',    stateKey: 'showHikes', defaultOn: true },
      { id: 'huts',    icon: '🏚️', label: 'SAC huts', stateKey: 'showHuts',  defaultOn: true },
      { id: 'webcams', icon: '📷', label: 'Webcams' }
    ];
```

Replace with:

```js
    var toggles = [
      { id: 'hikes',   icon: '⛰️', label: 'Hikes',    stateKey: 'showHikes', defaultOn: true },
      { id: 'huts',    icon: '🏚️', label: 'SAC huts', stateKey: 'showHuts',  defaultOn: true },
      { id: 'haspage', icon: '⭐', label: 'Has page', stateKey: 'hasPage',   defaultOn: false },
      { id: 'webcams', icon: '📷', label: 'Webcams' }
    ];
```

The existing line that reads each toggle's initial state — `var on = t.stateKey ? !!s[t.stateKey] : !!t.defaultOn;` — already maps `null` → `false` and `true` → `true`, so no other change is needed here.

- [ ] **Step 2: Add a `haspage` branch to `toggleWeatherLayer`**

The current `toggleWeatherLayer` function (around line 763) reads:

```js
  function toggleWeatherLayer(id, show) {
    if (id === 'hikes') {
      Filters.setState('showHikes', show);
      return;
    }
    if (id === 'huts') {
      Filters.setState('showHuts', show);
      return;
    }
    if (id === 'webcams') {
```

Insert a new branch between `huts` and `webcams`:

```js
    if (id === 'huts') {
      Filters.setState('showHuts', show);
      return;
    }
    if (id === 'haspage') {
      // Off-state is null (no filter), not false — see hasPage state semantics.
      Filters.setState('hasPage', show ? true : null);
      return;
    }
    if (id === 'webcams') {
```

- [ ] **Step 3: Verify the file still loads**

Run:

```bash
node --check /opt/code/website/pages/hikes/command-center/command-center.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add command-center/command-center.js
git commit -m "command-center: add ⭐ Has-page toggle to bottom bar"
```

---

## Task 4: URL sync for `hasPage`

**Files:**
- Modify: `command-center/url-sync.js`

- [ ] **Step 1: Add `hasPage` to `KEY_MAP`**

The current `KEY_MAP` (around line 8) reads:

```js
  var KEY_MAP = {
    grades:     'g',
    duration:   'dur',
    elevation:  'el',
    gain:       'gn',
    showHikes:  'h',
    showHuts:   'u',
    weatherDay: 'd',
    sky:        'sk',
    tempMin:    't',
    display:    'dp'
  };
```

Add a `hasPage` entry — choose `p` (unused so far):

```js
  var KEY_MAP = {
    grades:     'g',
    duration:   'dur',
    elevation:  'el',
    gain:       'gn',
    showHikes:  'h',
    showHuts:   'u',
    weatherDay: 'd',
    sky:        'sk',
    tempMin:    't',
    display:    'dp',
    hasPage:    'p'
  };
```

- [ ] **Step 2: Encode `true` as `1` in the encoder**

The current encoder block (around line 31-48) reads:

```js
      } else if (typeof v === 'boolean') {
        // Only encode if not the default (true)
        if (v === false) parts.push(KEY_MAP[k] + '=0');
      } else {
        parts.push(KEY_MAP[k] + '=' + encodeURIComponent(v));
      }
```

The existing boolean branch is tuned for `showHikes`/`showHuts` (default true → encode only when false). Our `hasPage` is a non-boolean state (null/true), so it falls through to the else branch and would encode as `p=true`. Cleaner to emit `p=1`. Insert a `v === true` case **before** the existing boolean branch (so a literal `true` is caught first):

```js
      } else if (v === true) {
        // hasPage and similar null/true filters — encode the active state as "=1".
        parts.push(KEY_MAP[k] + '=1');
      } else if (typeof v === 'boolean') {
        // showHikes/showHuts: default is true, so only encode when false.
        if (v === false) parts.push(KEY_MAP[k] + '=0');
      } else {
        parts.push(KEY_MAP[k] + '=' + encodeURIComponent(v));
      }
```

Note: this is safe because the existing booleans (`showHikes`, `showHuts`) default to `true` and the original code never encoded `true` for them — it only encoded `false`. The new branch preserves that behaviour for them (they never reach the `=1` branch in practice because their default-true means they're left in default state) — wait: re-check. If `showHikes` is `true`, the new branch would now encode it as `h=1`, which is a regression.

Use a stricter check instead — only treat `hasPage` specially. Replace the encoder addition with:

```js
      } else if (k === 'hasPage') {
        if (v === true) parts.push(KEY_MAP[k] + '=1');
      } else if (typeof v === 'boolean') {
        // Only encode if not the default (true)
        if (v === false) parts.push(KEY_MAP[k] + '=0');
      } else {
        parts.push(KEY_MAP[k] + '=' + encodeURIComponent(v));
      }
```

(The outer `if (v === null || v === undefined || v === '') return;` already filters out `hasPage: null`, so the `hasPage` branch only fires when `v === true`.)

- [ ] **Step 3: Decode `hasPage` in the decoder**

The current decoder branches (around line 60-69) read:

```js
      if (key === 'grades' || key === 'display') {
        out[key] = raw.split(',').filter(Boolean);
      } else if (key === 'showHikes' || key === 'showHuts') {
        out[key] = raw !== '0';
      } else if (key === 'weatherDay' || key === 'tempMin') {
        out[key] = parseFloat(raw);
      } else {
        out[key] = raw;
      }
```

Add a `hasPage` case before the catch-all `else`:

```js
      if (key === 'grades' || key === 'display') {
        out[key] = raw.split(',').filter(Boolean);
      } else if (key === 'showHikes' || key === 'showHuts') {
        out[key] = raw !== '0';
      } else if (key === 'weatherDay' || key === 'tempMin') {
        out[key] = parseFloat(raw);
      } else if (key === 'hasPage') {
        out[key] = raw === '1' || raw === 'true';
      } else {
        out[key] = raw;
      }
```

- [ ] **Step 4: Verify the file still loads**

Run:

```bash
node --check /opt/code/website/pages/hikes/command-center/url-sync.js
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add command-center/url-sync.js
git commit -m "command-center: url-sync support for hasPage filter"
```

---

## Task 5: Browser verification (Playwright)

**Files:** none changed in this task — purely verification.

**Why a separate task:** All three edits land before this so any regression we see in the browser maps to the whole feature, not a half-applied change.

- [ ] **Step 1: Open the command center**

Use the Playwright MCP tools (`mcp__playwright__browser_navigate`) to load:

```
file:///opt/code/website/pages/hikes/command-center/index.html
```

Wait for the loading overlay to disappear (`mcp__playwright__browser_wait_for` on the disappearance of `#loading-overlay` visibility, or `browser_snapshot` and confirm overlay has the `hidden` class).

- [ ] **Step 2: Confirm the ⭐ toggle is present**

Take a snapshot (`mcp__playwright__browser_snapshot`). Confirm the bottom-bar `#weather-toggles` contains a button with title `Has page` and the ⭐ icon, between SAC huts and Webcams.

- [ ] **Step 3: Measure baseline visible-route count**

Read the text content of `#route-count` (use `browser_evaluate` with `() => document.getElementById('route-count').innerText`). Record the visible-destinations number. Call this `N_all`.

- [ ] **Step 4: Toggle ⭐ on**

Click the `Has page` toggle (`mcp__playwright__browser_click`). Confirm:

- The button gains the `.active` class (use `browser_evaluate` to read `document.querySelector('[title="Has page"]').classList.contains('active')`).
- `#route-count` updates to a smaller number `N_pages` (`N_pages < N_all`).
- The URL now ends with `#p=1` (`browser_evaluate` → `window.location.hash`).

Record `N_pages` and check it equals the number of entries in `window.HIKES` whose POI is also in `window.SAC_ROUTES`:

```js
() => {
  return (window.HIKES || []).filter(h => {
    if (!h) return false;
    return (window.SAC_ROUTES || []).some(p => {
      if (h.sac_route_id && (p.routes || []).some(r => r.id === h.sac_route_id)) return true;
      if (h.sac_peak_id && h.sac_peak_id === p.id) return true;
      return false;
    });
  }).length;
}
```

Expected: `N_pages` matches (or is within a couple — the fallback name/coord match in `matchingHike` may add a few extras; manual sanity-check is enough).

- [ ] **Step 5: Verify URL persistence**

Reload the page (`browser_navigate` to the same URL — the hash carries). After loading completes:

- The `Has page` toggle should be `.active`.
- `#route-count` should equal `N_pages` from Step 4.

- [ ] **Step 6: Toggle off and confirm restore**

Click the toggle again. Confirm:

- Button loses `.active`.
- `#route-count` returns to `N_all`.
- URL hash no longer contains `p=1` (it may be empty or contain other state).

- [ ] **Step 7: Test interaction with another filter**

Click a grade button (e.g. `T3`). Note the count `N_t3`. Then turn ⭐ on. Confirm the new count is `≤ N_t3` and `≤ N_pages` (intersection).

- [ ] **Step 8: Test reset**

Turn ⭐ on, then click `#filter-reset`. The page reloads; after load, the toggle should be off and `#route-count` should equal `N_all`.

- [ ] **Step 9: If all checks pass, commit nothing — verification is complete.**

If any check fails, fix the underlying bug, recommit that file, and re-run the verification task.

---

## Self-review notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| UI (⭐ in bottom-bar) | Task 3 |
| State field `hasPage: null` | Task 1 step 1 |
| `matchesHasPage` + wiring | Task 1 steps 2-3 |
| `poi._hasPage` stash | Task 2 |
| Toggle wiring | Task 3 |
| URL `KEY_MAP` entry | Task 4 step 1 |
| Encoder special-case | Task 4 step 2 |
| Decoder case | Task 4 step 3 |
| Reset behaviour | Verified in Task 5 step 8 (no code change — relies on existing reload behaviour) |
| Validation checklist | Task 5 |

**Type consistency:** state key `hasPage` and URL short key `p` used identically everywhere. `poi._hasPage` (POI-level, used by filter) vs `marker._hasPage` (marker-level, used by icon render) are both intentionally present.

**No placeholders, no TBDs, no "similar to" references.**
