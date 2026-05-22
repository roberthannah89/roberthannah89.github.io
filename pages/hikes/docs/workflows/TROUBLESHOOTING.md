# Troubleshooting

Common issues and solutions for the hikes repo.

---

## Validation & Rendering

### "schema validation error" when rendering

**Problem:** `make render` or `make validate` fails with JSON schema errors.

**Solution:**
1. Run `make validate` to see which hike has the error and what field is wrong
2. Open `routes/<slug>/<slug>.data.json`
3. Check for:
   - Missing required fields (see `docs/schemas/DATA-SCHEMA.md`)
   - Malformed grade — must be `T1` through `T6` (not `T1-T6` or `"tier1"`)
   - Invalid waypoint `kind` — must be `"start"`, `"summit"`, or `"way"`
   - Empty required strings

```json
// Before (invalid)
{ "grade": "T1-T6", "waypoints": [{"kind": "peak"}] }

// After (valid)
{ "grade": "T3", "waypoints": [{"kind": "summit"}] }
```

---

### "No module named 'jinja2'" or "'jsonschema'"

```bash
~/venvs/dev/bin/pip install -r requirements.txt
```

---

### "GPX file not found"

**Problem:** Render fails because `<slug>.gpx` is missing.

**Solution:** You must supply the GPX manually — there is no auto-generation in this repo.

1. Get the GPX track from SAC (use the browser extraction method) or your GPS device
2. Place it at `routes/<slug>/<slug>.gpx`
3. Re-run `make render`

---

### "Missing files" from `validate_hike_files.py`

Every hike directory must have all 4 files:

| File | How to get it |
|---|---|
| `<slug>.data.json` | You write this |
| `<slug>.gpx` | You provide this |
| `<slug>.html` | Run `make render` |
| `<slug>.track.js` | Run `make render` |

If `.html` or `.track.js` are missing, run `make render`.
If `.gpx` is missing, you need to provide it.

---

## Map Issues

### Map doesn't show on generated page

**Causes:**
- `<slug>.track.js` not generated
- JavaScript error in browser console

**Solutions:**
1. Check `<slug>.track.js` exists — if not, run `make render`
2. Open browser console (F12) for errors
3. Verify Leaflet loads from CDN (check network tab for `leaflet.css`, `leaflet.js`)
4. Clear browser cache and reload

---

### Map shows wrong location / pins in the ocean

**Problem:** Waypoint or peak coordinates are wrong.

**Solution:**
- Swiss Alps lat: `46–47°N`, lon: `7–10°E`
- Check you haven't swapped lat/lon
- Verify on https://map.schweizmobil.ch

---

## Data Issues

### Broken image links on page

Photos are URLs in `data.json` — this repo does not store images. If links break:

1. Open `routes/<slug>/<slug>.data.json`
2. Find the broken URL and replace it with a working one
3. Run `make render`

Reliable sources: Hikr.org (`https://f.hikr.org/files/...`), SAC, or your own hosted photos.
Avoid Wikimedia Commons — bot detection makes their URLs unreliable.

---

### Hero image is blank or broken

If `hero.image_url` is set to `"TODO"` or an empty string, the render script automatically
populates it from `photos[0].url`. Ensure `photos` has at least one entry.

---

### "Duplicate hike slug"

Choose a unique slug. Existing slugs: list your `routes/` directory:

```bash
ls routes/
```

---

## Performance

Typical render times:
- Single hike: ~50ms
- 10 hikes: ~100ms (parallel)

If `make render` is slow, check system load (`htop`). The render itself is CPU-bound
in Python — no network calls are made during render.

---

## Getting Help

```bash
make help                                       # show all targets
make validate                                   # show schema/file errors
~/venvs/dev/bin/python scripts/render_hike.py --help
```

Useful references:
- `docs/schemas/DATA-SCHEMA.md` — every field explained
- `docs/workflows/HIKING-WORKFLOW.md` — step-by-step workflow
- `routes/augstmatthorn/augstmatthorn.data.json` — golden reference (fully populated)
