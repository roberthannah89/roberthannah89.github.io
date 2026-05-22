# Troubleshooting

Common issues and solutions.

## Build & Rendering

### "schema validation error" when rendering

**Problem:** Rendering fails with JSON schema validation errors.

**Solution:**
1. Run `make validate` to see which hike has the error
2. Open the problem hike's `data.json`
3. Check for:
   - Missing required fields (see [DATA-SCHEMA.md](DATA-SCHEMA.md))
   - Malformed grade (must be `T1` through `T6`, not `T1-T6` or `tier1`)
   - Invalid waypoint `kind` (must be `"start"`, `"summit"`, or `"way"`)
   - Empty required fields

**Example fix:**
```json
// Before (invalid)
{
  "grade": "T1-T6",  // ❌ Wrong format
  "waypoints": [
    {"kind": "peak", ...}  // ❌ Should be "summit"
  ]
}

// After (valid)
{
  "grade": "T3",  // ✓
  "waypoints": [
    {"kind": "summit", ...}  // ✓
  ]
}
```

---

### "No module named 'jinja2'" or "'jsonschema'"

**Problem:** Python import error.

**Solution:**
```bash
# Install dependencies
~/venvs/dev/bin/pip install jinja2 jsonschema

# Or update from requirements.txt
~/venvs/dev/bin/pip install -r requirements.txt
```

---

### Generated HTML links to images broken

**Problem:** Hero image or photos show as broken links (404) on the page.

**Solution:**
1. Check URLs are correct:
   ```bash
   ~/venvs/dev/bin/python scripts/validate_images.py
   ```
2. If URLs reference Wikimedia Commons, they may need fixing:
   ```bash
   ~/venvs/dev/bin/python scripts/validate_images.py --fix
   ```
3. Re-render:
   ```bash
   make render slug=<slug>
   ```

See [IMAGE_SOURCING_TODO.md](../pages/hikes/IMAGE_SOURCING_TODO.md) for sourcing status.

---

### "Relative path ../guides doesn't work"

**Problem:** Links on hike pages to `guides/` are broken.

**Solution:**
The hike pages are in `pages/hikes/routes/<slug>/`, so relative paths must go up one level:
- ✓ `../guides/difficulty.html`
- ❌ `guides/difficulty.html`

This is already correct in the templates, so if you see this, check your data.json for any hardcoded links.

---

## GPX & Routing

### "No route found between points"

**Problem:** `build_hike_gpx.py` can't find a hiking route connecting coordinates.

**Causes:**
- Trailhead/peak coordinates outside Switzerland
- Bounding box too small
- Trail not mapped in OpenStreetMap
- Coordinates on a paved road (not hiking path)

**Solutions:**
1. Verify coordinates are in Switzerland (46–47°N, 7–9°E)
2. Expand bounding box:
   ```bash
   make gpx slug=<slug> peak="<name>" bbox="46.70,7.80,46.76,7.96" via="<points>"
   ```
3. Check OSM directly:
   - Go to https://overpass-turbo.eu
   - Search for `way[highway=path]` in your area
   - If no results, the trail may not be mapped (contact OSM to add it)
4. Manually create GPX:
   - Use Komoot or QGIS to trace the route
   - Save as GPX, place in `pages/hikes/routes/<slug>/<slug>.gpx`

---

### GPX is missing elevation data

**Problem:** Track shows coordinates but no elevation profile.

**Causes:**
- SwissTopo elevation API query failed
- Coordinates outside SwissTopo coverage (rare)

**Solution:**
```bash
# Re-run with verbose output
make gpx slug=<slug> peak="<name>" --bbox s,w,n,e 2>&1 | grep -i "elev\|error"
```

If elevation requests fail:
- Try smaller number of waypoints first
- Check coordinates are valid (not on water or outside CH)
- Manually edit GPX to add `<ele>` tags with known elevations

---

## Documentation Consistency

### "Hiking instruction checks failed"

**Problem:** `make check-docs` fails with missing tokens.

**Solution:**
Run to see details:
```bash
~/venvs/dev/bin/python scripts/check_hiking_docs.py
```

This verifies that hiking documentation (e.g., `docs/hiking/WORKFLOW.md`) mentions all CLI flags for key scripts.

If you added a new flag to `add_hike.py` or `build_hike_gpx.py`:
1. Update `docs/hiking/WORKFLOW.md` or appropriate doc
2. Add the flag to the text (it's matched by a simple string search)
3. Rerun `make check-docs`

---

## Map & Frontend

### "Map doesn't show" on generated page

**Problem:** Hike page loads but Leaflet map doesn't render.

**Causes:**
- `track.js` file not generated
- Leaflet CSS/JS not loaded
- JavaScript error in browser console

**Solutions:**
1. Check `track.js` exists:
   ```bash
   test -f pages/hikes/routes/<slug>/<slug>.track.js && echo "✓" || echo "✗"
   ```
   If missing, re-render:
   ```bash
   make render slug=<slug>
   ```

2. Check browser console (F12) for errors
3. Verify Leaflet loads from CDN (should see network request for `leaflet.css`, `leaflet.js`)
4. Clear browser cache and reload

---

### Weather strip shows "forecast unavailable"

**Problem:** Weather data doesn't load on hike index page.

**Causes:**
- Open-Meteo API is down or rate-limited
- Hike has no coordinates (lat/lon missing)
- Browser blocks API call (CORS issue)

**Solutions:**
1. Check hike has `peak.lat` and `peak.lon` in data.json
2. Open browser console to see if API error appears
3. Reload page (Open-Meteo may have been temporarily unreachable)
4. Check Open-Meteo status: https://api.open-meteo.com/

---

## CI/CD & Deployment

### "GitHub Actions build failed"

**Problem:** Push triggers workflow but it fails.

**Solution:**
1. Check GitHub Actions tab in repo
2. Click the failed workflow run
3. Look for errors in logs, typically:
   - Schema validation failed
   - Import error (missing dependency)
   - File not found
   - GPX build timed out

**Common fixes:**
- Add missing field to `data.json`
- Commit `requirements.txt` changes
- Ensure GPX file exists before rendering
- Check paths are correct (should be `scripts/`, `pages/hikes/routes/`)

---

## Data Issues

### "Duplicate hike slug"

**Problem:** Error when trying to add a hike with an existing slug.

**Solution:**
```bash
# Existing hike already has this slug; choose a different one
make new slug=mynewslug ...
```

Existing slugs: `augstmatthorn`, `chaeserrugg`, `cresta-sassal-mason`, `eiger-trail`, `glaernisch`, `hoher-kasten`, `hohturli-bluemlisalphuette`, `kreuzberge`, etc.

---

### "Invalid coordinates"

**Problem:** Coordinates are rejected or map shows wrong location.

**Solution:**
- Verify latitude is 45–47°N (Swiss Alps)
- Verify longitude is 5–10°E (Swiss Alps)
- Check you didn't swap lat/lon
- Example: Augstmatthorn peak = `46.7423° N, 7.9286° E`

Use an online tool to verify: https://maps.google.com or https://map.schweizmobil.ch

---

## Performance

### "Render takes too long"

**Problem:** `make render` is slow.

**Typical times:**
- Single hike: ~10–50ms
- All 20 hikes: ~180ms (parallel)

**If slower:**
- Check system load (`top` or `htop`)
- Ensure Python venv is active
- Check for slow network (image validation, API calls)

---

### "Out of memory"

**Problem:** Process killed during render (rare).

**Solution:**
- Build one hike at a time:
  ```bash
  for slug in augstmatthorn chaeserrugg eiger-trail; do
    make render slug=$slug
  done
  ```

---

## Getting Help

1. **Check the docs:**
   - Start with [docs/README.md](../docs/README.md)
   - See [WORKFLOW.md](WORKFLOW.md) for step-by-step workflows
   - Search for your error message above

2. **Check script help:**
   ```bash
   ~/venvs/dev/bin/python scripts/render_hike.py --help
   ~/venvs/dev/bin/python scripts/add_hike.py --help
   ```

3. **Check logs:**
   ```bash
   make validate 2>&1 | grep -i error
   make render slug=X 2>&1 | tail -20
   ```

4. **Check Makefile:**
   ```bash
   make help
   ```

5. **File an issue** on GitHub with:
   - Error message
   - Command you ran
   - Output of `make validate`

---

## Known Limitations

- **Overpass API:** Swiss trail routing may fail for very remote or recent trails
- **SwissTopo elevation:** Coordinates far outside Switzerland return errors
- **Image CDN:** Wikimedia Commons images may be slow to load; Hikr.org more reliable
- **Browser support:** Leaflet.js works on all modern browsers; IE11 not tested

---

## Still Stuck?

1. Check `docs/hiking/` for domain-specific docs
2. Run `make help` to see all available targets
3. Look at an existing hike (`pages/hikes/routes/*/data.json`) for structure examples
4. File an issue on GitHub
