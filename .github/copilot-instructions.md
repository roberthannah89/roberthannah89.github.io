# roberthannah89.github.io — Copilot Context

Personal static site: **roberthannah89.github.io** — Swiss Alps hike plans, notes, and an about page.
Deployed via GitHub Pages. Repo root on this machine: `/opt/code/website/` (Google Drive symlink).

**Python venv**: always use `~/venvs/dev/bin/python` (absolute path — never `python3` bare).
**Dependencies**: `jinja2`, `jsonschema` (see `requirements.txt`).

---

## Repository layout

```
website/
├── .github/
│   ├── copilot-instructions.md   ← YOU ARE HERE
│   └── workflows/pages.yml       ← CI: validate → render → deploy
├── Makefile                      ← Primary build interface (see below)
├── favicon.svg                   ← Mountain SVG, #ff5c5c, linked relatively in all pages
├── index.html                    ← Root landing (dark hero, 3 cards: Hikes/Notes/About)
├── about/index.html              ← Links-only page (GitHub, LinkedIn, Hikes, Notes)
├── notes/                        ← Static HTML essays (hand-written, not generated)
│   ├── index.html
│   ├── becoming-good-at-mathematics.html
│   ├── how-to-diet.html
│   ├── photography.html
│   ├── purchase-list.html
│   ├── sailing-list.html
│   └── systems.html
├── hikes/
│   ├── index.html                ← GENERATED — do not hand-edit
│   ├── _assets/                  ← Shared CSS/JS assets for hike pages
│   ├── <slug>/
│   │   ├── <slug>.data.json      ← SOURCE OF TRUTH — edit this
│   │   ├── <slug>.gpx            ← GPX track (built by build_hike_gpx.py)
│   │   ├── <slug>.track.js       ← Leaflet track data (built by build_hike_gpx.py)
│   │   └── <slug>.html           ← GENERATED — do not hand-edit
│   └── ... (one dir per hike)
└── skills/hiking/
    ├── scripts/
    │   ├── render_hike.py        ← Renders all hikes + hikes/index.html
    │   ├── build_hike_gpx.py     ← Builds GPX via OSM routing + SwissTopo elevation API
    │   └── new_hike.py           ← Scaffolds a new hike dir + pre-filled data.json
    └── templates/
        ├── hike_page.j2.html     ← Per-hike page Jinja2 template
        ├── index.j2.html         ← Hikes index Jinja2 template (cards + map + filters)
        └── hike_data.schema.json ← JSON schema for data.json validation
```

> ⚠️ **Template sync warning**: `skills/hiking/templates/` is the copy used by CI.
> A second copy lives at `/opt/code/hikes/templates/`. After editing one, sync the other with `cp`.

---

## Makefile — primary build interface

Run all targets from `/opt/code/website/`:

```
make help          # Print full usage with all variables and examples
make render        # Render all hike pages + hikes/index.html
make render slug=X # Render only one hike
make validate      # Validate all data.json against schema (no output written)
make probe         # Probe hike data sources
make serve         # render + python http.server (default port 8000)
make serve port=9000
make install-hooks # Install git pre-commit validation hook

make new slug=pizol name="Pizol 5-Seen" region="Glarus Alps" canton="St. Gallen" \
     grade=T2 elev=2844 trailhead=Wangs \
     peak_lat=46.985 peak_lon=9.393 \
     trailhead_lat=46.960 trailhead_lon=9.395 \
     via="Schwarzsee Baschalvasee Pizolsee Wildsee"

make gpx slug=pizol peak=Pizol trailhead=Wangs via="Schwarzsee Pizol"
```

`make new` with all four coordinates auto-runs `build_hike_gpx.py` (bbox computed automatically).
Use `make new ... --no-gpx` flag pattern if you want to skip GPX building.

---

## Adding a new hike — step by step

1. **Scaffold** with `make new slug=X name="..." ...` — creates `hikes/X/X.data.json` and
   runs GPX builder automatically if coordinates are provided.

2. **Fill in `data.json`** — the scaffold pre-fills most fields; complete:
   - `hero.image_url`, `hero.subtitle_html`, `hero.grade`
   - `intro_html` — 1–2 paragraphs, can include blockquote
   - `quick_facts` — array of `[label, html_value]` pairs
   - `photos` — array of `{url, lightbox_url, alt, caption_html}`
   - `sections` — detailed route write-up

3. **Verify all image URLs** — Wikimedia Commons URLs must be real filenames:
   ```bash
   # Find real filenames in a category:
   curl "https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers\
   &cmtitle=Category:Pizol&cmlimit=20&format=json" | python3 -m json.tool | grep title

   # Verify each URL returns 200 (not 404 or 301):
   curl -sI -A "Mozilla/5.0" "https://commons.wikimedia.org/wiki/Special:FilePath/Filename.jpg?width=1600"
   ```
   Use format: `https://commons.wikimedia.org/wiki/Special:FilePath/<Filename>?width=1600`

4. **Render**: `make render slug=X` — check output in `hikes/X/X.html`

5. **Preview**: `make serve` then open `http://localhost:8000/hikes/X/X.html`

6. **Commit & push**:
   ```bash
   git add -A && git commit -m "Add hike: <name>" && git push
   ```

---

## data.json structure — key fields

```json
{
  "slug": "pizol",
  "page": { "title": "Pizol — Hike Plan", "generated": "2026-05-09", "year": 2026 },
  "peak": { "name": "Pizol", "elev": 2844, "lat": 46.985, "lon": 9.393 },
  "index_card": {
    "region": "Glarus Alps",
    "canton": "St. Gallen",
    "distance": "14 km",
    "gain": "700 m",
    "time": "~5 h",
    "pill_class": "t2"
  },
  "trailhead": { "name": "Wangs", "elev": 960, "lat": 46.960, "lon": 9.395 },
  "hero": {
    "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Pizol.jpg?width=1600",
    "subtitle_html": "Wangs → 5 lakes → Pizol — <span class=\"pill t2\">SAC T2</span>",
    "grade": "T2"
  },
  "photos": [{ "url": "...", "lightbox_url": "...", "alt": "...", "caption_html": "..." }],
  "quick_facts": [["Summit elevation", "<strong>2844 m</strong>"], ...],
  "intro_html": "<p>...</p>",
  "sections": [{ "title": "Route", "body_html": "..." }]
}
```

`pill_class`: `t1`/`t2` = green (easy), `t3` = amber, `t4` = orange, `t5`/`t6` = red.

---

## Current hikes

| Slug | Name | Elev | Canton | Region | Grade | Distance | Gain | Time |
|------|------|------|--------|--------|-------|----------|------|------|
| `santis` | Säntis | 2502 m | Appenzell Innerrhoden | Alpstein | T4 | 14.8 km | 1730 m | 2 days |
| `lisengrat` | Säntis via Lisengrat | 2502 m | Appenzell Innerrhoden | Alpstein | T4 | 16.4 km | 1950 m | ~7–8 h |
| `zindlenspitz` | Zindlenspitz | 2097 m | Schwyz | Wägitaler Alps | T3 | 9.5 km | 1200 m | ~6 h |
| `augstmatthorn` | Augstmatthorn | 2137 m | Bern | Bernese Alps | T3 | 14 km | 1200 m | ~6 h |
| `schynige-first` | Faulhorn → First | 2680 m | Bern | Bernese Alps | T2 | 16 km | 600 m | ~6 h |

Cantons represented: Appenzell IR, Schwyz, Bern.
**Missing cantons (priority targets)**: St. Gallen, Glarus, Appenzell AR.

---

## Hike backlog

| Hike | Canton | Grade | Coords (peak) | Notes |
|------|--------|-------|---------------|-------|
| Pizol 5-Seen-Wanderung | St. Gallen | T2 | 46.985, 9.393 | Five alpine lakes; most-photographed eastern CH walk |
| Chäserrugg (Churfirsten) | St. Gallen | T3 | 47.168, 9.313 | Flat-topped ridge above Walensee; iconic silhouette |
| Walensee Höhenweg | SG / Glarus | T2 | — | Long traverse above turquoise lake; SM route 63 |
| Glärnisch from Braunwald | Glarus | T3 | 46.984, 8.990 | Car-free base; glaciated massif |
| Tödi / Fridolinshütte | Glarus | T4 | 46.814, 8.914 | Highest peak in Glarus; massive glacier approach |
| Hoher Kasten ridge | Appenzell AR | T2 | 47.277, 9.427 | Cable car to ridge; Rhine valley + Bodensee views |
| Kreuzberge / Saxer Lücke | Appenzell IR | T4 | 47.240, 9.430 | Cabled ridge east of Säntis; pairs with Lisengrat |

---

## Design system

```css
--bg: #0b0c10;       /* page background */
--bg-soft: #14161c;  /* card / panel background */
--fg: #e8e8ea;       /* primary text */
--fg-dim: #a0a4ad;   /* muted/secondary text */
--accent: #ff5c5c;   /* red — links, favicon, active states */
--border: #23262e;
```

**Map**: Leaflet 1.9.x from unpkg CDN. SwissTopo WMTS tiles, OSM fallback on `tileerror`.
Scroll-wheel zoom disabled. Hike markers are `L.circleMarker` (radius 9) coloured by canton:

| Canton | Colour |
|--------|--------|
| Appenzell Innerrhoden | `#ff5c5c` |
| Bern | `#4a9eff` |
| Schwyz | `#ff9b43` |
| St. Gallen *(not yet used)* | `#34d399` |
| Glarus *(not yet used)* | `#fbbf24` |
| Appenzell AR *(not yet used)* | `#c084fc` |

Add new cantons to `CANTON_COLORS` in `skills/hiking/templates/index.j2.html`.

**Weather**: Open-Meteo API, 7-day forecast, max temp + weather code per day, shown as strip on cards.

---

## CI / deployment

`.github/workflows/pages.yml` on every push to `main`:
1. `render_hike.py --validate-only` — fail fast on schema errors
2. `render_hike.py --probe` — render with live data probing
3. Upload entire repo as GitHub Pages artifact → deploy

Rendered HTML **is committed to git** (not gitignored) so CI can deploy without re-rendering.
Always run `make render` before committing.

---

## Gotchas & conventions

- **All internal hrefs must be relative** (`../index.html`, not `/`). Absolute paths break
  local `file://` browsing. Notes pages currently use `/favicon.svg` — known issue.
- **`hikes/index.html` is generated** — never edit it directly; it is overwritten by `make render`.
- **Per-hike `.html` files are generated** — same rule.
- **Wikimedia filenames are case-sensitive** — always verify via the API before hardcoding.
- **Template sync**: after editing `skills/hiking/templates/`, sync to `/opt/code/hikes/templates/`.
- **Git lock**: if you see `.git/index.lock`, remove it: `rm -f .git/index.lock`
