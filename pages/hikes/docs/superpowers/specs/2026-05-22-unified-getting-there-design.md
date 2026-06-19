# Unified "Getting There" Section

**Status:** Implemented in commit `fa6bfd7`

Replace the two existing transport sections (live transit iframe + static directions) with a single, unified "Getting There" section using deep links and manual direction notes.

## Current state

The hike page template has two transport sections:

- **Section A** (lines 57–73): "Getting there (live transit)" — Google Maps iframe embed (requires API key) + deep-link buttons (Google Maps transit, SBB)
- **Section B** (lines 108–115): "Getting There" — manual `by_car_html` and `by_pt_html` content from `data.json`

Problems: Section A requires a Google Maps API key for the iframe to work; car directions are missing from the links; the two sections are redundant and separated on the page; SBB link format is suboptimal.

## Design

### Remove

- The entire Section A block (lines 57–73 in `hike_page.j2.html`): iframe embed, `transit-embed` div, API key dependency
- The `transit-embed` CSS styles
- The iframe logic in `setupTransit()` in `hike_page.js`

### New unified section

Position: after the routes section, before day plans (replacing current Section B location at lines 108–115).

#### Template (`hike_page.j2.html`)

```html
<section class="getting-there">
  <h2>Getting There</h2>
  <div class="transit-actions">
    <a class="btn" id="gmaps-drive-link" target="_blank" rel="noopener">Google Maps (driving)</a>
    <a class="btn" id="gmaps-transit-link" target="_blank" rel="noopener">Google Maps (transit)</a>
    <a class="btn btn-primary" id="sbb-link" target="_blank" rel="noopener">SBB Timetable</a>
  </div>
  <p class="attrib">
    Directions from <span id="transit-origin"></span> to
    <strong>{{ trailhead.name }}</strong>
  </p>
  <div class="grid-2">
    <div>
      <h3>By car</h3>
      {{ getting_there.by_car_html | safe }}
    </div>
    <div>
      <h3>{{ getting_there.get('by_pt_heading') or 'By public transport' }}</h3>
      {{ getting_there.by_pt_html | safe }}
    </div>
  </div>
</section>
```

Currently, lines 108–135 wrap Getting There and Day Plans in a single `<div class="grid-2">` (two-column layout). This design breaks them apart:

- Getting There becomes its own full-width `<section>` with transit-action buttons at the top, then an internal `<div class="grid-2">` for the car/PT detail columns
- Day Plans becomes its own standalone `<section>` immediately after (no longer sharing a grid wrapper with Getting There)

#### JavaScript (`hike_page.js`)

Simplified `setupTransit()`:

```javascript
function setupTransit() {
  const gmapsDrive   = document.getElementById("gmaps-drive-link");
  const gmapsTransit = document.getElementById("gmaps-transit-link");
  const sbbLink      = document.getElementById("sbb-link");
  const originLabel  = document.getElementById("transit-origin");

  if (originLabel) originLabel.textContent = transitOrigin;

  const enc = encodeURIComponent;
  const dest = TRAILHEAD.lat + "," + TRAILHEAD.lon;

  if (gmapsDrive)
    gmapsDrive.href = "https://www.google.com/maps/dir/?api=1"
      + "&destination=" + enc(dest) + "&travelmode=driving";

  if (gmapsTransit)
    gmapsTransit.href = "https://www.google.com/maps/dir/?api=1"
      + "&destination=" + enc(dest) + "&travelmode=transit";

  if (sbbLink && TRANSIT_DEST)
    sbbLink.href = "https://www.sbb.ch/en/timetable.html"
      + "?from=" + enc(transitOrigin)
      + "&to=" + enc(TRANSIT_DEST);
}
```

- Google Maps links use `trailhead.lat/lon` for pin-point accuracy
- SBB link uses `transit_dest` text (station name) for reliable timetable lookup
- Origin comes from `window.HIKING_CONFIG.defaultOrigin` (defaults to "Zürich HB")
- No API key dependency

#### CSS changes

- Remove `.transit-embed` and `.transit-embed.empty` styles
- The `.transit-actions` and `.btn` styles should already work — verify they're adequate for three buttons

### Data flow

No new `data.json` fields. All data already exists:

| Data | Source | Used by |
|---|---|---|
| `trailhead.lat` | `data.json` → `window.HIKE.trailhead.lat` | Google Maps links |
| `trailhead.lon` | `data.json` → `window.HIKE.trailhead.lon` | Google Maps links |
| `transit_dest` | `data.json` → `window.HIKE.transit_dest` | SBB link |
| `transitOrigin` | `_config.js` → `window.HIKING_CONFIG.defaultOrigin` | All links (origin) |
| `trailhead.name` | `data.json` (Jinja) | Attribution line |
| `getting_there.by_car_html` | `data.json` (Jinja) | Manual driving notes |
| `getting_there.by_pt_html` | `data.json` (Jinja) | Manual PT notes |

### Files changed

1. `templates/hike_page.j2.html` — remove Section A, replace Section B with unified block
2. `routes/_assets/hike_page.js` — simplify `setupTransit()`, remove iframe logic
3. `routes/_assets/hike_page.css` — remove `.transit-embed` styles (if present)
4. Re-run `make render` to regenerate all hike HTML pages

### Edge cases

- If `transit_dest` is missing/TODO: SBB button gets no `href`, remains inert
- If `trailhead.lat/lon` is missing: Google Maps buttons get no `href` — but these are required fields in the schema, so this shouldn't happen
- If `by_car_html` or `by_pt_html` is "TODO": renders as-is (existing behavior)
- No-JS: buttons render but without `href` attributes (JS sets them). The manual direction text still renders via Jinja.

### What's NOT changing

- `data.json` schema — no new fields
- `render_hike.py` — no changes needed
- `config.py` — no new constants (URLs are standard, not project-specific)
- `_config.js` — still used for `defaultOrigin`
