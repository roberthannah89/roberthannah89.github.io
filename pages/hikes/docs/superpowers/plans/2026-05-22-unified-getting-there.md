# Unified "Getting There" Section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two separate transport sections (iframe-based live transit + static directions) with a single unified "Getting There" section using deep links for Google Maps (driving + transit) and SBB timetable.

**Architecture:** Remove the iframe embed and its API key dependency. Auto-generate three deep-link buttons (Google Maps driving, Google Maps transit, SBB timetable) from existing `trailhead` data in JS. Keep the manual `by_car_html` / `by_pt_html` content below the buttons. Break the `grid-2` wrapper that currently groups Getting There + Day Plans into two independent sections.

**Tech Stack:** Jinja2 templates, vanilla JavaScript, CSS

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `templates/hike_page.j2.html` | Modify (lines 57–73, 108–136) | Remove Section A, replace Section B with unified block, separate Day Plans |
| `routes/_assets/hike_page.js` | Modify (lines 139–157) | Simplify `setupTransit()`: remove iframe, add driving link, update SBB URL |
| `routes/_assets/hike_page.css` | Modify (lines 75–77) | Remove `.transit-embed` styles |

No new files. No data.json or schema changes. After all edits, `make render` regenerates all HTML.

---

### Task 1: Remove old transit section from template

**Files:**
- Modify: `templates/hike_page.j2.html:57-73`

- [ ] **Step 1: Delete Section A (live transit iframe)**

Delete lines 57–73 of `hike_page.j2.html`. This removes the entire "Getting there (live transit)" section including the iframe embed, the two old buttons (`gmaps-link`, `sbb-link`), and the attribution paragraph.

The old content being removed:

```html
<section>
  <h2>Getting there (live transit)</h2>
  <div id="transit-embed" class="transit-embed empty">
    <iframe id="transit-iframe" loading="lazy" allowfullscreen
            referrerpolicy="no-referrer-when-downgrade"
            title="Public transport directions"></iframe>
  </div>
  <div class="transit-actions">
    <a class="btn btn-primary" id="gmaps-link" target="_blank" rel="noopener">Plan on Google Maps</a>
    <a class="btn" id="sbb-link" target="_blank" rel="noopener">Plan on SBB</a>
  </div>
  <p class="attrib">
    Live transit from <span id="transit-origin"></span> to
    <strong id="transit-dest"></strong>. Iframe requires a Google Maps Embed API key
    in <code>_config.js</code>; the deep-link buttons work without one.
  </p>
</section>
```

After this deletion, the Interactive Route Map section (previously at line 75) shifts up.

- [ ] **Step 2: Verify template still parses**

Run: `cd "/mnt/c/Users/User/My Drive (roberthannah89@gmail.com)/Code/website/pages/hikes" && python -c "from jinja2 import Environment, FileSystemLoader; env = Environment(loader=FileSystemLoader('templates')); env.get_template('hike_page.j2.html'); print('OK')"`

Expected: `OK`

---

### Task 2: Replace Section B with unified Getting There block

**Files:**
- Modify: `templates/hike_page.j2.html:108-136` (line numbers after Task 1 deletion — these will be ~91–119 in the modified file)

- [ ] **Step 1: Replace the grid-2 wrapper containing Getting There + Day Plans**

Find the block that starts with `<div class="grid-2">` (containing Getting There and Day Plans) and replace it with two independent sections.

Replace this (old lines 108–136):

```html
<div class="grid-2">
  <section>
    <h2>Getting There</h2>
    <h3>By car</h3>
    {{ getting_there.by_car_html | safe }}
    <h3>{{ getting_there.get('by_pt_heading') or 'By public transport' }}</h3>
    {{ getting_there.by_pt_html | safe }}
  </section>

  <section>
{%- for plan in day_plans %}
...
{%- endfor %}
  </section>
</div>
```

With this:

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

<section>
{%- for plan in day_plans %}
{%- if plan.title %}
  <h2>{{ plan.title }}</h2>
{%- endif %}
{%- if plan.get('subheading') %}
  <h3>{{ plan.subheading }}</h3>
{%- endif %}
  <table>
    <tr><th>Time</th><th>Step</th></tr>
{%- for time, step in plan.rows %}
    <tr><td>{{ time }}</td><td>{{ step | safe }}</td></tr>
{%- endfor %}
  </table>
{%- if plan.get('footer_html') %}
  <p>{{ plan.footer_html | safe }}</p>
{%- endif %}
{%- endfor %}
</section>
```

Key differences from old layout:
- Getting There is a standalone `<section class="getting-there">` with transit-action buttons at top
- The car/PT detail columns use an internal `<div class="grid-2">` (two `<div>`s, not two `<section>`s)
- Day Plans is a standalone `<section>` no longer sharing a grid wrapper
- Three new button IDs: `gmaps-drive-link`, `gmaps-transit-link`, `sbb-link`
- Attribution line uses Jinja `{{ trailhead.name }}` instead of JS-populated `transit-dest`

- [ ] **Step 2: Verify template still parses**

Run: `cd "/mnt/c/Users/User/My Drive (roberthannah89@gmail.com)/Code/website/pages/hikes" && python -c "from jinja2 import Environment, FileSystemLoader; env = Environment(loader=FileSystemLoader('templates')); env.get_template('hike_page.j2.html'); print('OK')"`

Expected: `OK`

- [ ] **Step 3: Commit template changes**

```bash
git add templates/hike_page.j2.html
git commit -m "feat: unify Getting There section with deep-link buttons

Remove iframe-based transit embed (Section A) and merge with static
directions (Section B) into a single section with Google Maps driving,
Google Maps transit, and SBB timetable deep-link buttons.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Simplify setupTransit() in JavaScript

**Files:**
- Modify: `routes/_assets/hike_page.js:10-12,139-157`

- [ ] **Step 1: Remove mapsKey from config reads**

At line 11, remove the `mapsKey` variable since the iframe embed is gone.

Change lines 10–12 from:

```javascript
  const cfg = (window.HIKING_CONFIG || {});
  const mapsKey = cfg.mapsApiKey || "";
  const transitOrigin = cfg.defaultOrigin || "Zürich HB";
```

To:

```javascript
  const cfg = (window.HIKING_CONFIG || {});
  const transitOrigin = cfg.defaultOrigin || "Zürich HB";
```

- [ ] **Step 2: Replace setupTransit() function**

Replace lines 139–157 (the `setupTransit` function and its call) with:

```javascript
  function setupTransit() {
    const gmapsDrive   = document.getElementById("gmaps-drive-link");
    const gmapsTransit = document.getElementById("gmaps-transit-link");
    const sbbLink      = document.getElementById("sbb-link");
    const originLabel  = document.getElementById("transit-origin");

    if (originLabel) originLabel.textContent = transitOrigin;

    if (TRAILHEAD) {
      const dest = TRAILHEAD.lat + "," + TRAILHEAD.lon;
      const enc = encodeURIComponent;
      if (gmapsDrive)
        gmapsDrive.href = "https://www.google.com/maps/dir/?api=1&destination=" + enc(dest) + "&travelmode=driving";
      if (gmapsTransit)
        gmapsTransit.href = "https://www.google.com/maps/dir/?api=1&destination=" + enc(dest) + "&travelmode=transit";
    }

    if (sbbLink && TRANSIT_DEST) {
      const enc = encodeURIComponent;
      sbbLink.href = "https://www.sbb.ch/en/timetable.html?from=" + enc(transitOrigin) + "&to=" + enc(TRANSIT_DEST);
    }
  }
  setupTransit();
```

Key changes from old version:
- No more `embed`, `iframe`, `destLabel` element lookups
- No more `mapsKey` / iframe.src logic
- Google Maps links use `TRAILHEAD.lat,lon` (coordinates) instead of `TRANSIT_DEST` (text)
- Two separate Google Maps links: driving + transit (old had only transit)
- SBB link uses `sbb.ch/en/timetable.html?from=...&to=...` format (old used `sbb.ch/en?stops=...→...`)
- Guard on `TRAILHEAD` existence for Google links, `TRANSIT_DEST` for SBB link

- [ ] **Step 3: Commit JS changes**

```bash
git add routes/_assets/hike_page.js
git commit -m "feat: simplify setupTransit() — deep links only, add driving mode

Remove iframe embed logic and API key dependency. Use trailhead
coordinates for Google Maps (driving + transit), text-based
transit_dest for SBB timetable deep link.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Remove transit-embed CSS

**Files:**
- Modify: `routes/_assets/hike_page.css:75-77`

- [ ] **Step 1: Delete the three transit-embed CSS rules**

Remove these three lines (75–77):

```css
.transit-embed { position: relative; width: 100%; aspect-ratio: 16 / 9; margin: .8rem 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--card); }
.transit-embed iframe { width: 100%; height: 100%; border: 0; }
.transit-embed.empty { display: none; }
```

Also remove `.transit-embed iframe` from the print media query (line 114):

Change:

```css
  .map-controls, .transit-actions, .transit-embed iframe, .lightbox { display: none !important; }
```

To:

```css
  .map-controls, .transit-actions, .lightbox { display: none !important; }
```

- [ ] **Step 2: Commit CSS changes**

```bash
git add routes/_assets/hike_page.css
git commit -m "fix: remove unused transit-embed CSS styles

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Render and verify

- [ ] **Step 1: Run make render**

Run: `cd "/mnt/c/Users/User/My Drive (roberthannah89@gmail.com)/Code/website/pages/hikes" && make render`

Expected: all hike HTML files regenerated without errors.

- [ ] **Step 2: Spot-check a rendered page**

Run: `grep -A5 "Getting There" routes/faulhorn/faulhorn.html | head -20`

Expected: the unified section with `gmaps-drive-link`, `gmaps-transit-link`, `sbb-link` button IDs. No `transit-embed` or `transit-iframe`.

- [ ] **Step 3: Verify old elements are gone**

Run: `grep -r "transit-embed\|transit-iframe\|gmaps-link[^-]" routes/ --include="*.html" | head -5`

Expected: no matches. (The old `gmaps-link` ID is replaced by `gmaps-drive-link` and `gmaps-transit-link`.)

- [ ] **Step 4: Verify new elements are present**

Run: `grep -c "gmaps-drive-link" routes/*//*.html`

Expected: one match per hike HTML file (all rendered pages have the new button).

- [ ] **Step 5: Commit rendered output**

```bash
git add routes/ index.html guides/
git commit -m "chore: regenerate all pages with unified Getting There section

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

- [ ] **Step 6: Open a page in the browser and verify buttons work**

Serve locally: `cd "/mnt/c/Users/User/My Drive (roberthannah89@gmail.com)/Code/website/pages/hikes" && make serve`

Open `http://localhost:8000/routes/faulhorn/faulhorn.html` in a browser. Verify:
- Three buttons visible: "Google Maps (driving)", "Google Maps (transit)", "SBB Timetable"
- Each button opens correct deep link in new tab
- "By car" and "By public transport" columns render below
- Day Plans section renders separately (no longer in a shared grid)
- Old iframe embed is gone
