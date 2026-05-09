# Topographic Route Map Recipe (SwissTopo WMTS)

> **Superseded.** Canonical reference:
> `/opt/code/website/.github/instructions/hike-gpx.instructions.md`
>
> Edit that file when tile endpoints or the routing algorithm change. This file is a redirect only.

When the user wants a real map with a route overlay (NOT ASCII art), generate a PNG by
stitching SwissTopo WMTS tiles and drawing the route in PIL.

## Tile endpoint

```
https://wmts.geo.admin.ch/1.0.0/<layer>/default/current/3857/<z>/<x>/<y>.jpeg
```

- Projection: Web Mercator (EPSG:3857) — same as OSM, so standard slippy-map math works.
- Useful layers:
  - `ch.swisstopo.pixelkarte-farbe` — color topographic map (recommended)
  - `ch.swisstopo.pixelkarte-grau` — greyscale topo (good for overlay clarity)
  - `ch.swisstopo.swissimage` — aerial imagery
  - `ch.swisstopo.swisstlm3d-wanderwege` — official hiking-trail overlay
- Zoom 14 is a good default for a single-peak day hike; 15 for tight detail.
- Set a `User-Agent` header on requests.
- swisstopo data is **CC BY 3.0** — credit "© swisstopo" in the map title.

## Generator script

A reusable generator lives at `scripts/make_topo_map.py` (in the hikes repo).
Run it with `--gpx route.gpx --out map.png`, or edit the `ROUTE_DEFAULT` list at the
bottom of the file. Requires `Pillow` only (stdlib otherwise). It:

1. Parses GPX `<trkpt>` and `<wpt>` (or uses `ROUTE_DEFAULT`).
2. Computes a tile-aligned bounding box with padding.
3. Downloads SwissTopo WMTS color tiles and stitches them.
4. Draws the track as a white halo + red line.
5. Marks waypoints with white-bordered red dots and label boxes.
6. Adds a title bar with attribution.

## Getting a real GPX (no login required)

**Do not eyeball intermediate waypoints.** The user can tell, and they're right to call
it out. Use this OSM-Overpass + Dijkstra recipe instead — it produces a real GPX track
that follows actual SAC-marked hiking trails.

> [!TIP]
> The whole pipeline below (route + elevations + downsampled track.js for the HTML page)
> is implemented in `scripts/build_hike_gpx.py` (in the hikes repo). Prefer running
> that script to executing the steps inline in chat — it caches Overpass responses to
> `~/.cache/hiking-skill/overpass/`, batches Open-Elevation calls, and emits both the GPX
> and the `<slug>.track.js` sidecar in one command. The prose below documents the algorithm
> for when you need to tweak it.

1. **Find ground-truth nodes** in OpenStreetMap for the start and the peak:

   ```python
   import urllib.parse, urllib.request, json
   q = '[out:json];node["natural"="peak"]["name"="Zindlenspitz"];out;'
   r = urllib.request.urlopen("https://overpass-api.de/api/interpreter",
                              data=urllib.parse.urlencode({"data": q}).encode())
   print(json.load(r))  # gives lat, lon, ele
   ```

   For the trailhead use Nominatim or an Overpass `place=village` query.

2. **Pull all walkable ways** in a small bbox around start + summit
   (`highway=path|footway|track|service|unclassified|residential`). Tracks and farm roads
   are needed for the lower approach — they often lack `sac_scale` but are still walked.

3. **Build an undirected graph** keyed by rounded `(lat, lon)` tuples so ways that share
   an endpoint connect.

4. **Cost function**: `edge_length_m × highway_multiplier × sac_penalty`. Prefer
   `path/footway` (×1.0) over `track` (×1.2) over road types (×1.6-2.5). Penalize
   `alpine_hiking` and harder so the router picks the easier of two parallel trails when
   they exist.

5. **Snap start/end** to the nearest graph node (haversine), run Dijkstra, reconstruct
   the polyline, write GPX with `<trkpt lat=".." lon=".."/>` per node, plus `<wpt>`
   markers for the named endpoints.

6. **Sanity-check** the result: snap distances should be < 50 m for both endpoints, total
   distance should match published trip reports within ~10%, and the hardest `sac_scale`
   traversed should equal the route's guidebook grade.

A working implementation is in the Zindlenspitz README workflow: produces a 9.52 km,
1078-point GPX from Innerthal village to the summit, snapping to within 5 m and 1 m
respectively, with `alpine_hiking` (T4) as the hardest segment near the summit ridge —
exactly matches the SAC route description.

GPX from OSM data must be credited "© OpenStreetMap contributors (ODbL)".

## Elevation pass (extension to "Getting a real GPX")

The OSM-Overpass + Dijkstra recipe above produces lat/lon-only trackpoints. The Hike Plan HTML page (see [hike-html-page.md](./hike-html-page.md)) expects `[lat, lon, ele]` triples to render the elevation profile. After routing, fetch elevations and emit triples.

**For points in Switzerland — SwissTopo height API (preferred, accurate):**

```
GET https://api3.geo.admin.ch/rest/services/height?easting=<lv95_x>&northing=<lv95_y>
```

Requires LV95 (CH1903+) coordinates. Convert from WGS84 with the standard Swiss formula or via a small lookup library.

**Global / fallback — Open-Elevation:**

```
POST https://api.open-elevation.com/api/v1/lookup
Body: { "locations": [{"latitude": ..., "longitude": ...}, ...] }
```

Free, no key, batch up to 100 per request. SRTM-based — fine for chart purposes, but reads ~50–100 m below actual summit elevation on tall, narrow peaks. Use catalog elevation (SAC/Wikipedia) for the Quick Facts table; SRTM is fine for the chart.

If Open-Elevation 504s, swap to OpenTopoData (`https://api.opentopodata.org/v1/srtm30m`) — same JSON format.

Emit `<ele>` in each `<trkpt>` of the GPX **and** `[lat, lon, ele]` triples in the sidecar `<slug>.track.js` file (loaded by the rendered HTML via `<script src="<slug>.track.js">`). The full GPX stays as `<slug>.gpx`; `build_hike_gpx.py` writes both.

## Sources to skip

- **hikr.org** — returns HTTP 403 to scripted fetchers
- **SAC Route Portal GPX** — requires SAC member login
- **Komoot/Wikiloc/AllTrails** — usually require login for GPX export
- **Google search** — blocks JS-less fetches; use `https://html.duckduckgo.com/html/?q=...`
  for scripted searches
