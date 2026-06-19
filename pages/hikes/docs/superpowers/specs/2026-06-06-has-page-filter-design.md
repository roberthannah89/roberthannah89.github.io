# Has-page filter toggle — design

**Status:** Implemented in commit `8355fa0` (built up across `98d6aa0`, `749a08d`, `8355fa0`)

## Goal

Add a control to the command center that filters POIs down to those with a built hike page in this repo. The page-match logic already exists (`SidePanel.matchingHike`) and already drives the amber-ring styling on dots; this spec exposes it as a real filter.

## UI

Add one icon toggle to the bottom-bar's `#weather-toggles` row, alongside Hikes / SAC huts / Webcams.

- Icon: `⭐`
- Title: `Has page`
- Default: off
- Visual: reuse existing `.wx-toggle` button styling — no new CSS

Off = show all POIs. On = show only POIs whose `matchingHike()` returned a hit.

## State

Extend `Filters` state in `command-center/filters.js`:

```js
hasPage: null   // null = any (default), true = only POIs with a built page
```

Why `null/true` instead of `false/true`: matches the `null=any` convention used by `duration`, `elevation`, `gain`, `sky`, `tempMin`. The existing `showHikes`/`showHuts` booleans mean "include this POI *type*" — different semantics. `hasPage` is a curation filter, not a type filter.

## Filter logic

Add a `matchesHasPage(poi)` function in `filters.js`:

```js
function matchesHasPage(poi) {
  if (!state.hasPage) return true;
  return !!poi._hasPage;
}
```

Wire it into `matchesPoi`:

```js
return matchesType(poi) && matchesGrade(poi) && matchesDuration(poi)
    && matchesElevation(poi) && matchesGain(poi) && matchesHasPage(poi)
    && matchesWeather(poi);
```

## Data wiring

`createMarkers()` in `command-center.js` already computes `hasPage` once per POI and stashes it on `marker._hasPage`. `Filters.matchesPoi` operates on `poi`, not the marker, so we need the flag accessible from the POI.

Stash it on the POI itself at marker-creation time:

```js
var hasPage = !!(window.SidePanel && SidePanel.matchingHike && SidePanel.matchingHike(poi));
poi._hasPage = hasPage;       // new — for filter
marker._hasPage = hasPage;    // existing — for icon styling
```

Keeping both assignments is the minimal change. (Could later drop `marker._hasPage` and read `marker._poi._hasPage`, but that's out of scope here — it would touch every icon-render call site.)

## Toggle wiring

Extend the `toggles` array in `buildWeatherToggles()`:

```js
var toggles = [
  { id: 'hikes',   icon: '⛰️', label: 'Hikes',     stateKey: 'showHikes', defaultOn: true },
  { id: 'huts',    icon: '🏚️', label: 'SAC huts',  stateKey: 'showHuts',  defaultOn: true },
  { id: 'haspage', icon: '⭐', label: 'Has page',  stateKey: 'hasPage',   defaultOn: false },
  { id: 'webcams', icon: '📷', label: 'Webcams' }
];
```

The existing initialiser line `var on = t.stateKey ? !!s[t.stateKey] : !!t.defaultOn;` already does the right thing for `null` (→ false) and `true` (→ true), so no change needed there.

Add a branch to `toggleWeatherLayer(id, show)`:

```js
if (id === 'haspage') {
  Filters.setState('hasPage', show ? true : null);
  return;
}
```

Different from the `showHikes`/`showHuts` branches (which pass `show` straight through as a boolean) because the off-state for `hasPage` is `null`, not `false`.

## URL sync

Extend `KEY_MAP` in `command-center/url-sync.js`:

```js
hasPage: 'p'
```

Encode/decode rules:

- Encoder: the generic else-branch already handles non-array non-boolean values. `null` is filtered out by the top `v === null` guard. `true` would be encoded via `encodeURIComponent(true)` → `p=true`. That works but is ugly. Add a small special-case so `true` encodes as `p=1`:

  ```js
  } else if (v === true) {
    parts.push(KEY_MAP[k] + '=1');
  } else {
    parts.push(KEY_MAP[k] + '=' + encodeURIComponent(v));
  }
  ```

- Decoder: add a case for `hasPage`:

  ```js
  } else if (key === 'hasPage') {
    out[key] = raw === '1' || raw === 'true';
  ```

  (Accepting both keeps any link the encoder might have produced during dev valid.)

## Reset behaviour

`#filter-reset` clears the URL hash and reloads, so it picks up the default `hasPage: null` automatically. No code change.

## Out of scope

- **No tri-state** (Any / With / Without). User picked the simple toggle in brainstorming. If "show me POIs that *don't* have a page yet" becomes useful later, promote to a 3-state filter-bar group then.
- **No change to the amber-ring styling** on dots — the visual cue stays whether the filter is on or off.
- **No change to clustering or label-binding behaviour.** Filtered-out POIs already drop out of the cluster via the existing `_filtered` flag.

## Files touched

| File | Change |
|---|---|
| `command-center/filters.js` | Add `hasPage` to state, `matchesHasPage()`, wire into `matchesPoi`. |
| `command-center/command-center.js` | Stash `poi._hasPage` in `createMarkers`; add toggle entry + `toggleWeatherLayer` branch. |
| `command-center/url-sync.js` | Add `hasPage: 'p'` to `KEY_MAP`; special-case `true` in encoder; decode `hasPage`. |

No template, no CSS, no data-pipeline changes.

## Validation

After implementing:

1. Load the command center; toggle ⭐ on → only POIs with amber-ringed dots remain.
2. Toggle off → all POIs reappear.
3. Toggle on, copy the URL, open in a new tab → filter is preserved.
4. With ⭐ on, click Reset → toggle clears and all POIs reappear.
5. Combine with grade/duration filters → all filters AND together as expected.
