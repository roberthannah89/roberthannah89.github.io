# Website — Copilot Instructions

Personal static site deployed to **roberthannah89.github.io** via GitHub Pages.
Repo root: `/opt/code/website/` (symlink target on Google Drive).
Python venv: `~/venvs/dev/bin/python` — always use the absolute path.

---

## Site structure

```
website/
  index.html              # Root landing page (dark hero, 3 cards: Hikes / Notes / About)
  favicon.svg             # Mountain triangle SVG (#ff5c5c)
  about/index.html        # Links-only about page
  hikes/                  # Per-hike dirs + rendered index
    index.html            # Rendered hike index (DO NOT hand-edit — generated)
    <slug>/
      <slug>.data.json    # Source of truth for all hike content
      <slug>.gpx          # GPX track
      <slug>.track.js     # JS track data for Leaflet map
      <slug>.html         # Rendered page (DO NOT hand-edit — generated)
  notes/                  # Static HTML notes pages
  skills/hiking/
    scripts/
      render_hike.py      # Main render script — renders all hikes + index
      build_hike_gpx.py   # Builds GPX from OSM routing + SwissTopo elevation
      new_hike.py         # Scaffolds a new hike dir + skeleton data.json
    templates/
      hike_page.j2.html   # Per-hike page Jinja2 template
      index.j2.html       # Hikes index Jinja2 template
      hike_data.schema.json
```

> **Template sync warning**: The website keeps its OWN template copies at
> `skills/hiking/templates/`. A canonical copy also lives at `/opt/code/hikes/templates/`.
> After editing either copy, sync with `cp`.

---

## Build & deploy workflow

```bash
# Render all hikes + index locally
~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py

# Then commit everything and push — CI deploys automatically
git add -A && git commit -m "..." && git push
```

CI (`.github/workflows/pages.yml`) runs `render_hike.py --probe` on every push to `main`
and deploys the whole repo as a static site. Rendered HTML is gitignored locally but
committed to git for CI to pick up (they are not in `.gitignore`).

---

## Adding a new hike

1. **Scaffold**: `~/venvs/dev/bin/python skills/hiking/scripts/new_hike.py --slug <slug>`
2. **Fill in** `hikes/<slug>/<slug>.data.json` — see existing files for structure
3. **Build GPX**: `~/venvs/dev/bin/python skills/hiking/scripts/build_hike_gpx.py --slug <slug> ...`
4. **Render**: `~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py`
5. **Verify images**: all `photo.url` values must be real Wikimedia Commons URLs —
   verify with `curl -sI -A "Mozilla/5.0" "<url>"` (look for `200 OK`, not 301/404)
6. **Commit & push**

### data.json key fields (index_card)

```json
"index_card": {
  "region": "Alpstein",
  "canton": "Appenzell Innerrhoden",
  "distance": "14.8 km",
  "gain": "1730 m",
  "time": "2 days",
  "pill_class": "t4"
}
```

`pill_class` values: `t1`–`t6` (maps to SAC T-grade, controls card colour).

---

## Current hikes

| Slug | Peak | Elev | Canton | Region | Grade | Stats |
|------|------|------|--------|--------|-------|-------|
| `santis` | Säntis | 2502 m | Appenzell Innerrhoden | Alpstein | T4 | 14.8 km · 1730 m · 2 days |
| `lisengrat` | Säntis via Lisengrat | 2502 m | Appenzell Innerrhoden | Alpstein | T4 | 16.4 km · 1950 m · ~7–8 h |
| `zindlenspitz` | Zindlenspitz | 2097 m | Schwyz | Wägitaler Alps | T3 | 9.5 km · 1200 m · ~6 h |
| `augstmatthorn` | Augstmatthorn | 2137 m | Bern | Bernese Alps | T3 | 14 km · 1200 m · ~6 h |
| `schynige-first` | Faulhorn → Bachalpsee → First | 2680 m | Bern | Bernese Alps | T2 | 16 km · 600 m · ~6 h |

---

## Design system

```css
--bg: #0b0c10        /* page background */
--bg-soft: #14161c   /* card background */
--fg: #e8e8ea        /* primary text */
--fg-dim: #a0a4ad    /* muted text */
--accent: #ff5c5c    /* red accent (favicon, links) */
--border: #23262e
--radius: 14px
```

Leaflet 1.9.x from unpkg. SwissTopo WMTS tiles with OSM fallback on `tileerror`.
Open-Meteo API for 5-day weather forecasts. Scroll-wheel zoom disabled on maps.

Canton colours on map markers (circleMarker, radius 9):
- Appenzell Innerrhoden → `#ff5c5c`
- Bern → `#4a9eff`
- Schwyz → `#ff9b43`

---

## Hike backlog / ideas

Eastern Switzerland focus (cantons not yet covered: **St. Gallen**, **Glarus**, **Appenzell AR**):

| Hike | Canton | Grade | Notes |
|------|--------|-------|-------|
| Pizol 5-Seen-Wanderung | St. Gallen | T2 | Five alpine lakes, most photographed walk in eastern CH |
| Chäserrugg / Churfirsten ridge | St. Gallen | T3 | Flat-topped ridge above Walensee, iconic silhouette |
| Walensee Höhenweg | SG / Glarus | T2 | Long traverse above turquoise lake, SwitzerlandMobility route 63 |
| Glärnisch circuit from Braunwald | Glarus | T3 | Car-free base, glaciated massif |
| Tödi approach / Fridolinshütte | Glarus | T4 | Highest peak in Glarus, massive glacier approach |
| Hoher Kasten ridge | Appenzell AR | T2 | Cable car to ridge, Rhine valley + Lake Constance views |
| Kreuzberge / Saxer Lücke | Appenzell IR | T4 | Cabled ridge east of Säntis, pairs with Lisengrat |

---

## Known conventions & gotchas

- **Wikimedia image URLs**: use `Special:FilePath/<filename>?width=1600` format.
  Always verify real filenames via the Wikimedia Commons API before committing:
  `https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:<name>&cmlimit=20&format=json`
- **Local file:// browsing**: all internal hrefs must be relative (e.g. `../index.html`,
  not `/`). Absolute paths break local browsing.
- **Rendered HTML is not gitignored**: `hikes/index.html` and `hikes/<slug>/<slug>.html`
  are committed so CI can deploy them. Always re-render before pushing.
- **Favicon**: `favicon.svg` at repo root. Linked as relative path in all pages.
  Notes pages use `/favicon.svg` (absolute) — may break in local file:// context.
