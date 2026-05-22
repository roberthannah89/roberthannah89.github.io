# Route Building & Elevation Data

This document explains how GPX routes are built and how elevation data is obtained.

## Overview

The hiking website generates GPX route files from coordinates using the **OpenStreetMap Overpass API** and enriches them with elevation data from **SwissTopo**.

## Build Process

### Step 1: Prepare Coordinates

You provide:
- **Peak location:** latitude, longitude
- **Trailhead:** latitude, longitude
- **Via points** (optional): intermediate waypoints

### Step 2: Query OpenStreetMap (Overpass API)

The `build_hike_gpx.py` script queries the Overpass API to find a hiking route connecting these points:

```
GET https://overpass-api.de/api/interpreter?data=[out:xml];...
```

**Query strategy:**
- Search for `way[highway=path]`, `way[highway=track]`, etc. within a bounding box
- Order results by distance to find the shortest connecting route
- Build a connected path from trailhead → via points → peak

**Limitations:**
- Works best for well-documented Swiss trails (most are mapped)
- May fail for off-trail or very remote locations
- May include forest roads or sub-optimal routing (manual GPX editing possible)

### Step 3: Fetch Elevation Data (SwissTopo API)

For each coordinate in the route, SwissTopo elevation API is queried:

```
GET https://api3.geo.admin.ch/rest/services/height?easting=<x>&northing=<y>
```

**Coordinates system:** SwissTopo uses **LV95** (Swiss coordinates), not latitude/longitude.

**Conversion:**
- WGS84 (lat/lon) → LV95 (Swiss grid) — automatic in build script
- Elevation returned in metres above sea level

### Step 4: Generate GPX File

The script combines:
- OSM routing (latitude/longitude waypoints)
- Elevation data (metres)

Output: `<slug>.gpx` (standard GPX 1.1 format)

```xml
<?xml version="1.0"?>
<gpx version="1.1" creator="hiking-website-builder">
  <trk>
    <name>Augstmatthorn</name>
    <trkseg>
      <trkpt lat="46.742" lon="7.928">
        <ele>1737</ele>
        <name>Peak</name>
      </trkpt>
      ...
    </trkseg>
  </trk>
</gpx>
```

### Step 5: Generate Track.js (Leaflet Format)

The `render_hike.py` script parses the GPX file and converts it to a Leaflet-compatible JavaScript file:

```javascript
// pages/hikes/routes/augstmatthorn/augstmatthorn.track.js
window.HIKE_TRACK = {
  routeCoordinates: [
    [46.7423, 7.9286],
    [46.7424, 7.9285],
    ...
  ],
  stats: {
    distance_km: 14.2,
    ascent_m: 1200,
    descent_m: 1200,
    elevation_min: 1100,
    elevation_max: 2137
  }
};
```

This is embedded in the hike page for Leaflet to render the route overlay.

## API Details

### Overpass API

**Endpoint:** `https://overpass-api.de/api/interpreter`

**Query syntax:**
```
[bbox:s,w,n,e];
(way[highway=path];way[highway=track];);
out geom;
```

**Rate limits:**
- No hard limit, but excessive queries will be throttled
- Recommended: max ~1 query per 3 seconds per IP
- Keep bounding boxes reasonable (0.1° × 0.1° is good)

**Response:** XML with way geometries and node coordinates

### SwissTopo Elevation API

**Endpoint:** `https://api3.geo.admin.ch/rest/services/height`

**Parameters:**
- `easting`: LV95 X coordinate (Swiss grid)
- `northing`: LV95 Y coordinate (Swiss grid)

**Example:**
```
GET https://api3.geo.admin.ch/rest/services/height?easting=2683141&northing=1247594
```

**Response:**
```json
{
  "height": 1737,
  "easting": 2683141,
  "northing": 1247594
}
```

**Limits:**
- Max ~1000 requests per minute
- Batch queries accepted (separate multiple requests with `&easting=x1&northing=y1&easting=x2&northing=y2`)

### WGS84 ↔ LV95 Conversion

Swiss coordinates (LV95) are based on a different map projection. Conversion is required:

- **WGS84** (standard): latitude/longitude (used by GPS, Google Maps)
- **LV95** (SwissTopo): Swiss grid coordinates (X, Y)

The build script includes a conversion library (usually `pyproj`) to handle this automatically.

**Manual conversion example:**
- Input: 46.7423°N, 7.9286°E
- Output: X=2683141, Y=1247594

## Manual GPX Editing

Sometimes the auto-generated route isn't perfect. You can:

1. **Export from Komoot:** Komoot has excellent Swiss hiking routing; export as GPX
2. **Edit in JOSM:** OpenStreetMap's editor; review and fix ways if needed
3. **Validate:** Run `make validate` to ensure GPX is well-formed

Place the hand-edited GPX in `pages/hikes/routes/<slug>/<slug>.gpx` and re-render:
```bash
make render slug=<slug>
```

## Troubleshooting

### "No route found between points"

- Check bounding box is large enough (`--bbox s,w,n,e`)
- Verify peak/trailhead coordinates are accurate
- Try adding fewer via points first, then add more later

### Elevation data missing

- Some coordinates may be outside SwissTopo coverage (rare in Swiss Alps)
- Check coordinates are in Switzerland (should be 45–47°N, 5–10°E)
- Rerun with `--probe` to see raw elevation responses

### GPX validation fails

- Use a tool like QGIS to inspect the GPX file for malformed segments
- Ensure all coordinates have both latitude and longitude

## CLI Reference: `scripts/build_hike_gpx.py`

```bash
~/venvs/dev/bin/python scripts/build_hike_gpx.py \
    --slug <slug> \
    --peak "<PeakName>" \
    --trailhead "<TrailheadName>" \
    --via "<Waypoint1>" --via "<Waypoint2>" \
    --bbox <s>,<w>,<n>,<e> \
    --out-dir pages/hikes/routes/<slug>/
```

**Endpoint resolution flags** (use lat/lon overrides when Overpass name lookup is ambiguous):

| Flag | Purpose |
|------|---------|
| `--peak-ll <lat,lon>` | Override peak coordinates (skip Overpass name lookup) |
| `--trailhead-ll <lat,lon>` | Override trailhead coordinates |
| `--via-ll <lat,lon>` | Override an ascent waypoint (repeatable, paired with `--via`) |
| `--descend-via <name>` | Optional descent-only waypoint name |
| `--descend-via-ll <lat,lon>` | Override descent waypoint coordinates |
| `--end <name>` | End point if different from trailhead (point-to-point routes) |
| `--end-ll <lat,lon>` | Override end-point coordinates |

**Tuning:** `--track-points` (downsampled GPX point count, default ~400), `--elev-points` (elevation lookup count).

## References

- [Overpass API Documentation](https://wiki.openstreetmap.org/wiki/Overpass_API)
- [SwissTopo GEO Admin API](https://www.geo.admin.ch/en/news/geo-admin-api-geolocation.html)
- [GPX 1.1 Format Spec](https://www.topografix.com/gpx.asp)
- [Leaflet.js Documentation](https://leafletjs.com)
