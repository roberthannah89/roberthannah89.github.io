# Data Schema

This document describes the structure of `<slug>.data.json` files that define each hike.

## Overview

Each hike is defined by a JSON file: `pages/hikes/routes/<slug>/<slug>.data.json`

**Example:**
```
pages/hikes/routes/augstmatthorn/augstmatthorn.data.json
```

The file is validated against `templates/templates/hike_data.schema.json` (JSON Schema Draft 7) before rendering.

## Top-Level Structure

```json
{
  "slug": "augstmatthorn",
  "page": { ... },
  "peak": { ... },
  "trailhead": { ... },
  "hero": { ... },
  "index_card": { ... },
  "quick_facts": [ ... ],
  "photos": [ ... ],
  "waypoints": [ ... ],
  "routes": [ ... ],
  "getting_there": { ... },
  "day_plans": [ ... ],
  "weather": { ... },
  "webcams": [ ... ],
  "trip_reports": { ... },
  "gear": [ ... ],
  "safety_html": "<p>...</p>",
  "resources_html": "<p>...</p>",
  "disclaimer_html": "<p>...</p>"
}
```

## Field Reference

### `slug` (string)

URL-safe identifier for the hike. Used to create folder and file names.

**Required:** No (optional but recommended)  
**Example:** `"augstmatthorn"`

---

### `page` (object)

**Required fields:**
- `title` (string): Display title on the page
- `generated` (string, YYYY-MM-DD): Date the page was last rendered
- `reports_updated` (string, YYYY-MM-DD): Date trip reports were last updated

**Optional fields:**
- `year` (integer): Publication year

**Example:**
```json
{
  "title": "Augstmatthorn",
  "generated": "2025-05-09",
  "reports_updated": "2025-04-15",
  "year": 2025
}
```

---

### `peak` (object)

Summit location and metadata.

**Required fields:**
- `name` (string): Peak name
- `elev` (number): Elevation in metres
- `lat` (number): Latitude (WGS84)
- `lon` (number): Longitude (WGS84)

**Example:**
```json
{
  "name": "Augstmatthorn",
  "elev": 1737,
  "lat": 46.7423,
  "lon": 7.9286
}
```

---

### `trailhead` (object)

Starting point for the hike.

**Required fields:**
- `name` (string): Location name
- `lat` (number): Latitude
- `lon` (number): Longitude
- `transit_dest` (string): SBB/transit destination (e.g., "Habkern")

**Optional fields:**
- `elev` (number): Elevation in metres

**Example:**
```json
{
  "name": "Habkern",
  "elev": 950,
  "lat": 46.7320,
  "lon": 7.8640,
  "transit_dest": "Habkern"
}
```

---

### `hero` (object)

Hero image and page header subtitle.

**Required fields:**
- `image_url` (string): URL to hero image (min 1600×900 px recommended)
- `subtitle_html` (string): HTML subtitle (can include `<em>`, `<strong>`)
- `grade` (string): SAC trail difficulty (T1–T6)

**Optional fields:**
- `auto_subtitle` (boolean): If true, auto-generate subtitle from peak/trailhead

**Example:**
```json
{
  "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Augstmatthorn.jpg?width=2560",
  "subtitle_html": "A scenic <strong>ridge walk</strong> in the <em>Bernese Oberland</em>",
  "grade": "T3",
  "auto_subtitle": false
}
```

---

### `index_card` (object)

Summary information shown on the hike gallery page.

**Required fields:**
- `region` (string): Geographic region
- `time` (string): Estimated duration (e.g., "~6 h")

**Optional fields:**
- `distance` (string): Distance (e.g., "14 km")
- `gain` (string): Elevation gain (e.g., "1200 m")
- `pill_class` (string): CSS class for grade pill (e.g., "t3")
- `photo_url` (string): Thumbnail for gallery

**Example:**
```json
{
  "region": "Bernese Alps (Brienzergrat)",
  "time": "~6 h",
  "distance": "14 km",
  "gain": "1200 m",
  "pill_class": "t3",
  "photo_url": "..."
}
```

---

### `quick_facts` (array)

Quick reference facts shown at top of page.

**Structure:** Array of `[label, html_value]` pairs

**Example:**
```json
[
  ["Grade", "SAC T3"],
  ["Duration", "~6 hours (round trip)"],
  ["Distance", "14 km"],
  ["Elevation Gain", "1200 m"],
  ["Peak Elevation", "1737 m"]
]
```

---

### `photos` (array)

Gallery photos displayed on the page.

**Required fields per photo:**
- `url` (string): Photo URL (min 2000×1500 px recommended)
- `alt` (string): Alt text for accessibility
- `caption_html` (string): HTML caption

**Optional fields:**
- `lightbox_url` (string): URL for lightbox view (defaults to `url`)

**Example:**
```json
[
  {
    "url": "https://hikr.org/photo-123.jpg",
    "alt": "Augstmatthorn ridge looking north",
    "caption_html": "The Augstmatthorn ridge from <strong>Suggiture</strong>",
    "lightbox_url": "https://hikr.org/photo-123-large.jpg"
  }
]
```

---

### `waypoints` (array)

Map waypoints (start, summit, intermediate points).

**Required fields per waypoint:**
- `lat` (number): Latitude
- `lon` (number): Longitude
- `label` (string): Display name
- `kind` (string): One of `"start"`, `"summit"`, `"way"`

**Example:**
```json
[
  {
    "lat": 46.7320,
    "lon": 7.8640,
    "label": "Habkern",
    "kind": "start"
  },
  {
    "lat": 46.7423,
    "lon": 7.9286,
    "label": "Augstmatthorn",
    "kind": "summit"
  }
]
```

---

### `routes` (array)

Route options (different variations or difficulty levels).

**Required fields per route:**
- `title_html` (string): Route title (can include HTML)
- `grade` (string): SAC grade (T1–T6)
- `bullets_html` (array): Bullet points describing the route

**Optional fields:**
- `grade_label` (string): Custom label (e.g., "Scramble")
- `pill_class` (string): CSS class for grade pill

**Example:**
```json
[
  {
    "title_html": "<strong>Direct route</strong> via ridge",
    "grade": "T3",
    "grade_label": "Ridge scramble",
    "bullets_html": [
      "Ascend Lombachalp meadow",
      "Follow ridge crest to summit",
      "Exposed in places"
    ]
  },
  {
    "title_html": "Easier route via <em>Chäserrugg</em>",
    "grade": "T2",
    "bullets_html": [
      "Longer but less exposed",
      "Suitable for beginners"
    ]
  }
]
```

---

### `getting_there` (object)

Transportation information.

**Required fields:**
- `by_car_html` (string): Driving directions
- `by_pt_html` (string): Public transit directions

**Optional fields:**
- `by_pt_heading` (string): Custom heading (defaults to "By Train")

**Example:**
```json
{
  "by_car_html": "<p>From Lucerne, take A2 south towards Gotthard, exit at ... parking at Habkern Dorf.</p>",
  "by_pt_html": "<p><strong>Luzern</strong> → train 1h 15m → <strong>Habkern</strong> (BLS)</p>"
}
```

---

### `day_plans` (array)

Itinerary or timing breakdown.

**Required fields per plan:**
- `rows` (array): Array of `[time/segment, description]` pairs

**Optional fields:**
- `title` (string): Plan title (e.g., "Recommended Schedule")
- `subheading` (string): Subtitle
- `footer_html` (string): Footer note

**Example:**
```json
[
  {
    "title": "Recommended Day Schedule",
    "rows": [
      ["06:30", "Depart Habkern, ascend Lombachalp"],
      ["08:30", "Cross Lombachalp meadow"],
      ["09:15", "Ridge scramble begins"],
      ["10:30", "Summit (Augstmatthorn, 1737 m)"],
      ["12:30", "Descend (easier route via Chäserrugg)"],
      ["14:00", "Return to Habkern"]
    ],
    "footer_html": "<em>Times are estimates; actual duration depends on fitness and conditions.</em>"
  }
]
```

---

### `weather` (object)

Weather patterns and seasonal information.

**Required fields:**
- `lapse_rate` (object): Temperature gradient information
- `sources_html` (array): HTML list of weather forecast sources
- `season_html` (string): Recommended season

**Lapse Rate fields:**
- `valley_ref` (string): Reference valley (e.g., "Luzern")
- `summit_above_ref_m` (number): Elevation difference
- `temp_drop_c` (number): Expected temperature drop
- `example_html` (string): Example calculation

**Example:**
```json
{
  "lapse_rate": {
    "valley_ref": "Luzern valley (435 m)",
    "summit_above_ref_m": 1302,
    "temp_drop_c": 8,
    "example_html": "If it's 20°C in Luzern, expect ~12°C on the summit."
  },
  "sources_html": [
    "<a href=\"https://meteoswiss.ch\">MeteoSwiss</a>",
    "<a href=\"https://meteotest.ch\">Meteotest</a>"
  ],
  "season_html": "June–September (summer); year-round possible in dry winters"
}
```

---

### `webcams` (array)

Live webcams of or near the hike.

**Required fields per webcam:**
- `url` (string): Webcam URL
- `label` (string): Display name

**Optional fields:**
- `fallback` (boolean): If true, show only when primary fails

**Example:**
```json
[
  {
    "url": "https://www.jungfrauweb.com/",
    "label": "Jungfrau webcam",
    "fallback": false
  }
]
```

---

### `trip_reports` (object)

Real trip reports from hikers.

**Required fields:**
- `hikr_index_url` (string): Link to Hikr.org page
- `takeaways_html` (array): Key takeaways (array of HTML strings)
- `reports` (array): Individual report entries

**Report fields:**
- `url` (string): Original report URL
- `title` (string): Report title
- `season` (string): Season hiked (e.g., "June 2023")
- `grade` (string): Grade hiked (T1–T6)
- `bullets_html` (array): Key points

**Optional fields:**
- `grade_label` (string): Custom grade description
- `pill_class` (string): CSS class

**Example:**
```json
{
  "hikr_index_url": "https://hikr.org/tour/augstmatthorn",
  "takeaways_html": [
    "Best weather typically June–August",
    "Ridge sections exposed but well-marked",
    "Strong afternoon thunderstorm risk"
  ],
  "reports": [
    {
      "url": "https://hikr.org/tour/123456",
      "title": "Clear weather, excellent visibility",
      "season": "June 2024",
      "grade": "T3",
      "bullets_html": [
        "Departed early to avoid afternoon storms",
        "Ridge sections had some snow patches in June",
        "No technical difficulty, just exposure"
      ]
    }
  ]
}
```

---

### `gear` (array)

Gear recommendations.

**Structure:** Array of objects with categories

**Example:**
```json
[
  {
    "title": "Essential",
    "items_html": [
      "Hiking boots with good ankle support",
      "Weatherproof jacket",
      "Sun protection (hat, sunscreen)"
    ]
  },
  {
    "title": "Recommended",
    "items_html": [
      "Trekking poles (useful on descent)",
      "Headlamp (if starting early)",
      "Snacks and water (2 litres minimum)"
    ]
  }
]
```

---

### `safety_html` (string, required)

Safety considerations and hazards.

**Example:**
```html
<ul>
  <li><strong>Exposure:</strong> Ridge sections have significant exposure; not suitable for those afraid of heights</li>
  <li><strong>Weather:</strong> Afternoon thunderstorms common; start early and descend by 14:00</li>
  <li><strong>Scrambling:</strong> T3 grade requires some hand use; not a simple walking trail</li>
</ul>
```

---

### `resources_html` (string, required)

Useful references and links.

**Example:**
```html
<ul>
  <li><a href="https://map.schweizmobil.ch">SwissMobil maps</a> — official hiking route database</li>
  <li><a href="https://www.hikr.org">Hikr.org</a> — community trip reports</li>
  <li><a href="https://www.sac-cas.ch">SAC (Swiss Alpine Club)</a> — trail standards and hut info</li>
</ul>
```

---

### `disclaimer_html` (string, required)

Legal disclaimer.

**Example:**
```html
<p><strong>Disclaimer:</strong> This guide is provided as-is without warranty. Always verify current trail conditions, obtain updated weather forecasts, and assess your own skills and fitness before attempting any hike. The author assumes no responsibility for injuries or damages.</p>
```

---

## Validation

All fields are validated before rendering:

```bash
~/venvs/dev/bin/python scripts/render_hike.py --validate-only
```

**Common validation errors:**
- Missing required fields
- Invalid grade format (must be T1–T6)
- Malformed HTML strings
- Duplicate waypoint labels
- Missing image URLs

Fix the error, then revalidate.

## Creating a New Hike

Use the scaffold command:

```bash
make new slug=myname name="My Hike" region="Region" canton="Canton" grade="T2" elev="1500"
```

This creates a pre-filled template with all required fields as stubs (often marked `TODO`).

Then:
1. Edit `pages/hikes/routes/myname/myname.data.json`
2. Fill in your content
3. Run `make validate` to check
4. Run `make render` to generate HTML

## Examples

All 20 existing hikes have complete `data.json` files:

- [Augstmatthorn](../pages/hikes/routes/augstmatthorn/augstmatthorn.data.json)
- [Chäserrugg](../pages/hikes/routes/chaeserrugg/chaeserrugg.data.json)
- And more in `pages/hikes/routes/*/`

Use these as templates when creating new hikes.
