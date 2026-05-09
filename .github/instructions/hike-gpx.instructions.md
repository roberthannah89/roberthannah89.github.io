---
applyTo: "**"
---

# GPX building — OSM routing + SwissTopo elevation

The full pipeline (routing + elevation + `track.js` sidecar) is implemented in
`skills/hiking/scripts/build_hike_gpx.py`. Prefer running that script over
doing the steps inline. It caches Overpass responses to `~/.cache/hiking-skill/overpass/`,
batches elevation calls, and emits both `<slug>.gpx` and `<slug>.track.js`.

```bash
cd /opt/code/website
~/venvs/dev/bin/python skills/hiking/scripts/build_hike_gpx.py \
  --slug <slug> --peak <Peak> --trailhead <Village> \
  --via <Wpt1> --via <Wpt2> \
  --bbox <s,w,n,e> --out-dir hikes/<slug>/
```

`--bbox` is optional when `--peak-ll` and `--trailhead-ll` are both provided (±0.05° auto-computed).

When OSM name lookup is flaky for intermediate waypoints, pass explicit waypoint
coordinates in the same order:

```bash
~/venvs/dev/bin/python skills/hiking/scripts/build_hike_gpx.py \
  --slug kreuzberge --peak "Chrüzberg" --trailhead Wasserauen \
  --peak-ll 47.262,9.432 --trailhead-ll 47.286,9.430 \
  --via Seealpsee --via-ll 47.283,9.417 \
  --via "Saxer Lücke" --via-ll 47.249,9.437 \
  --out-dir hikes/kreuzberge/
```

Supported explicit-coordinate flags:

- `--peak-ll`
- `--trailhead-ll`
- `--via-ll` (repeat once per `--via`, same order)
- `--descend-via-ll` (repeat once per `--descend-via`, same order)
- `--end-ll`

---

## Algorithm (for debugging or modifications)

### 1. Find ground-truth OSM nodes

```python
import urllib.parse, urllib.request, json
q = '[out:json];node["natural"="peak"]["name"="Zindlenspitz"];out;'
r = urllib.request.urlopen("https://overpass-api.de/api/interpreter",
                           data=urllib.parse.urlencode({"data": q}).encode())
print(json.load(r))   # gives lat, lon, ele
```

For the trailhead: use Nominatim or an Overpass `place=village` query.

### 2. Pull walkable ways in bbox

Query `highway=path|footway|track|service|unclassified|residential` in the route bbox.
Tracks and farm roads are needed for lower approaches — they often lack `sac_scale` but are walked.

### 3. Build graph + Dijkstra

- Keyed by rounded `(lat, lon)` tuples so shared endpoints connect.
- Cost: `edge_length_m × highway_multiplier × sac_penalty`
  - `path/footway` → ×1.0; `track` → ×1.2; roads → ×1.6–2.5
  - Penalize `alpine_hiking` and harder so the router picks easier of parallel trails.

### 4. Snap endpoints and sanity-check

- Snap start/end to nearest graph node (haversine). Snap distance should be < 50 m.
- Total distance should match published trip reports within ~10%.
- Hardest `sac_scale` traversed should equal the route's guidebook grade.

### 5. Write outputs

- `<slug>.gpx` — full track with `<trkpt lat=".." lon=".." />` per node + `<wpt>` markers.
- `<slug>.track.js` — ~200 points (Douglas-Peucker downsampled), with `[lat, lon, ele]` triples.

---

## Elevation pass

OSM routing gives lat/lon-only points. The HTML page expects `[lat, lon, ele]` triples.

**Switzerland — SwissTopo height API (preferred, accurate):**

```
GET https://api3.geo.admin.ch/rest/services/height?easting=<lv95_x>&northing=<lv95_y>
```

Requires LV95 (CH1903+) coordinates. Convert from WGS84 with the standard Swiss formula.

**Global fallback — Open-Elevation:**

```
POST https://api.open-elevation.com/api/v1/lookup
Body: { "locations": [{"latitude": ..., "longitude": ...}, ...] }
```

Free, no key, batch up to 100 per request. SRTM-based — reads ~50–100 m below actual
elevation on tall narrow peaks. Fine for the chart; use SAC/Wikipedia elevation for `peak.elev`.

If Open-Elevation 504s, swap to OpenTopoData:
`https://api.opentopodata.org/v1/srtm30m` — same JSON format.

---

## SwissTopo WMTS tile endpoint (for topo map images)

```
https://wmts.geo.admin.ch/1.0.0/<layer>/default/current/3857/<z>/<x>/<y>.jpeg
```

- Projection: Web Mercator (EPSG:3857) — standard slippy-map math.
- Recommended layer: `ch.swisstopo.pixelkarte-farbe` (colour topo).
- Others: `ch.swisstopo.pixelkarte-grau`, `ch.swisstopo.swissimage` (aerial),
  `ch.swisstopo.swisstlm3d-wanderwege` (hiking-trail overlay).
- Zoom 14 for a day hike; 15 for tight detail.
- Set a `User-Agent` header. Credit: **© swisstopo** (CC BY 3.0).

A static map generator is at `skills/hiking/scripts/make_topo_map.py`:

```bash
~/venvs/dev/bin/python skills/hiking/scripts/make_topo_map.py \
  --gpx hikes/<slug>/<slug>.gpx --out hikes/<slug>/map.png
```

Requires Pillow only (stdlib otherwise). Stitches tiles, draws track (white halo + red line),
marks waypoints with labelled red dots, adds title bar with attribution.
