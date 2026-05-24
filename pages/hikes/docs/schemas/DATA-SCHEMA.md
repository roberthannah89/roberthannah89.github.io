# Data Schema

This document describes the structure of `<slug>.data.json` files that define each hike.

## Overview

Each hike is defined by a JSON file: `routes/<slug>/<slug>.data.json`

**Example:**
```
routes/augstmatthorn/augstmatthorn.data.json
```

The file is validated against `templates/hike_data.schema.json` (JSON Schema Draft 7) before rendering.

## Top-Level Structure

```json
{
  "slug": "augstmatthorn",
  "sources": [ ... ],
  "page": { ... },
  "peak": { ... },
  "trailhead": { ... },
  "hero": { ... },
  "index_card": { ... },
  "intro_html": "<p>...</p>",
  "quick_facts": [ ... ],
  "photos": [ ... ],
  "waypoints": [ ... ],
  "routes": [ ... ],
  "getting_there": { ... },
  "day_plans": [ ... ],
  "weather": { ... },
  "resources_html": [ "..." ],
  "elev_chart_attrib_html": "...",
  "photos_attrib_html": "..."
}
```

## Field Reference

### `slug` (string)

URL-safe identifier for the hike. Used to create folder and file names.

**Required:** No (optional but recommended)  
**Example:** `"augstmatthorn"`

---

### `sources` (array, optional)

Golden sources: the authoritative websites this hike page is based on. Each entry names a source and links to it.

**Required fields per source:**
- `name` (string): Source name (e.g. "SAC Route Portal")
- `url` (string): URL to the source page

**Example:**
```json
[
  {
    "name": "SAC Route Portal",
    "url": "https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/"
  },
  {
    "name": "hikr.org",
    "url": "https://www.hikr.org/dir/Augstmatthorn_8848/"
  },
  {
    "name": "SwissTopo",
    "url": "https://map.geo.admin.ch/?zoom=11&X=754000&Y=263000&lang=en"
  }
]
```

---

### `page` (object)

**Required fields:**
- `title` (string): Display title on the page
- `generated` (string, YYYY-MM-DD): Date the page was last rendered
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

**Optional fields:**
- `elev` (number): Elevation in metres
- `sbb_url` (string): SBB timetable link (extracted from SAC route JSON by `extract_sac_route.py`). If absent, the page falls back to constructing a link from the trailhead name.

Google Maps directions are derived automatically from the trailhead coordinates.

**Example:**
```json
{
  "name": "Randa, Bahnhof",
  "elev": 1439,
  "lat": 46.1013,
  "lon": 7.784,
  "sbb_url": "https://www.sbb.ch/en/buying/pages/fahrplan/fahrplan.xhtml?language=en&von=&nach=Randa"
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
- `canton` (string): Swiss canton (e.g., "Bern")
- `distance` (string): Distance (e.g., "14 km")
- `gain` (string): Elevation gain (e.g., "1200 m")
- `route_type` (string): Route shape (e.g., "out-and-back", "loop")

**Example:**
```json
{
  "region": "Bernese Alps (Brienzergrat)",
  "canton": "Bern",
  "time": "~6 h",
  "distance": "14 km",
  "gain": "1200 m",
  "route_type": "out-and-back"
}
```

---

### `intro_html` (string, optional)

Introductory paragraphs about the hike, rendered above the quick facts. Can include `<p>`, `<blockquote>`, `<strong>`, `<em>` tags.

**Example:**
```html
"<p>The <strong>Augstmatthorn</strong> (2137 m) is the eastern signature peak of the Brienzergrat...</p>"
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
- `source` (string): Where the route was discovered/documented (e.g., "hikr.org", "SAC Route Portal")

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
    ],
    "source": "hikr.org (https://www.hikr.org/dir/Augstmatthorn_8848/)"
  },
  {
    "title_html": "Easier route via <em>Chäserrugg</em>",
    "grade": "T2",
    "bullets_html": [
      "Longer but less exposed",
      "Suitable for beginners"
    ],
    "source": "SAC Route Portal"
  }
]
```

---

### `getting_there` (object)

Transportation information.

**Required fields:**
- `by_car_html` (string): Driving directions
- `by_pt_html` (string): Public transit directions

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

Seasonal information for the hike.

**Required fields:**
- `season_html` (string): Recommended season

**Example:**
```json
{
  "season_html": "June–September (summer); year-round possible in dry winters"
}
```

---

### `resources_html` (array of strings, required)

Useful references and links. Each string is one list item (typically an `<a>` tag with description).

**Example:**
```json
[
  "<a href=\"https://map.schweizmobil.ch\">SwissMobil maps</a> — official hiking route database",
  "<a href=\"https://www.hikr.org\">Hikr.org</a> — community trip reports",
  "<a href=\"https://www.sac-cas.ch\">SAC (Swiss Alpine Club)</a> — trail standards and hut info"
]
```

---

### `elev_chart_attrib_html` (string, optional)

Attribution text for the elevation chart data source.

**Example:** `"Computed from the inlined GPX track (OSM-routed via Dijkstra; elevations from SwissTopo height API)."`

---

### `photos_attrib_html` (string, optional)

Attribution text for the photo gallery sources.

---

## Validation Rules

Common validation errors:
- Missing required fields
- Invalid grade format — must be `T1` through `T6`
- Invalid waypoint `kind` — must be `"start"`, `"summit"`, or `"way"`
- Type mismatches (e.g., string where array expected)

See `docs/workflows/HIKING-WORKFLOW.md` for how to run validation and create new hikes.

## Golden Reference

The Augstmatthorn data file is the fully populated example:

- [augstmatthorn.data.json](../../routes/augstmatthorn/augstmatthorn.data.json)

Use it as the template when populating fields for a new hike.
