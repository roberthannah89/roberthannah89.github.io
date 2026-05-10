# Agent Knowledge Base

This folder contains all information that agents (Claude, Copilot) need to work with the website effectively. **Start here** for any hiking-related task.

---

## Quick Links

### Essential
- **[hiking-workflow.md](hiking-workflow.md)** — Full data.json schema, render/GPX scripts, image sourcing workflow
- **[hiking-resources.md](hiking-resources.md)** — Swiss sources, SAC grades, tools, planning references
- **[hiking-gpx-building.md](hiking-gpx-building.md)** — OSM routing + elevation API, Dijkstra algorithm

### Reference
- **[hike-gpx.instructions.md](hike-gpx.instructions.md)** (original, kept for reference)
- **[hike-resources.instructions.md](hike-resources.instructions.md)** (original, kept for reference)
- **[hike-workflow.instructions.md](hike-workflow.instructions.md)** (original, kept for reference)

---

## Common Tasks

### Add a new hike
1. Read: [hiking-workflow.md](hiking-workflow.md) → "Scaffold a new hike"
2. Run: `make new slug=<slug> name="<Name>" ...`
3. Fill in `hikes/<slug>/<slug>.data.json`
4. Read: [hiking-resources.md](hiking-resources.md) → "Image sourcing workflow"
5. Run: `make render`

### Update images
1. Find images: [hiking-resources.md](hiking-resources.md) → "Reliable image sources"
2. Validate: `python scripts/validate_images.py --slug <slug>`
3. Render: `make render`

### Build GPX for a hike
1. Reference: [hiking-gpx-building.md](hiking-gpx-building.md)
2. Run: `make gpx slug=<slug> peak=<Peak> trailhead=<Village> via="<Wpt1> <Wpt2>"`

### Validate all data
1. Run: `make validate`
2. Check output for data.json errors
3. Run: `python scripts/validate_images.py` for image URLs

---

## Scripts & Tools

See Makefile for all available targets. Key scripts live in:
- `scripts/` — domain-specific (render, build GPX, validate images)
- `scripts/` (root) — site-wide checks (coming soon)

Key executables:
- `render_hike.py` — Generate all hike HTML + index.html
- `build_hike_gpx.py` — Route GPX via OSM + elevation via SwissTopo
- `validate_images.py` — Check all image URLs (skips bot-blocking)
- `new_hike.py` — Scaffold new hike directory
- `add_hike.py` — One-command add: data.json + GPX + render
- `check_hiking_docs.py` — Validate instructions against CLI flags

---

## File Organization

```
website/
├── .github/copilot-instructions.md   ← Entry point (brief, links here)
├── docs/agent/                       ← YOU ARE HERE
│   ├── INDEX.md                      (this file)
│   ├── hiking-workflow.md            (detailed)
│   ├── hiking-resources.md           (Swiss reference)
│   └── hiking-*-full.md              (originals, for reference)
├── hikes/
│   ├── index.html                    (generated gallery)
│   ├── guides/                       (educational: difficulty, gear, planning, weather)
│   ├── routes/                       ← ACTUAL HIKE INSTANCES
│   │   ├── augstmatthorn/
│   │   ├── <slug>/
│   │   │   ├── <slug>.data.json      (source of truth)
│   │   │   ├── <slug>.html           (generated)
│   │   │   ├── <slug>.gpx            (route)
│   │   │   └── <slug>.track.js       (Leaflet map data)
│   │   └── _assets/                  (CSS/JS for all routes)
│   ├── _config.js                    (optional shared config)
│   └── IMAGE_SOURCING_TODO.md
├── docs/hiking/                    ← Infrastructure & tooling
│   ├── scripts/
│   ├── templates/
│   └── SKILL.md
└── README.md
```

---

## Environment

- **Python venv**: `~/venvs/dev` (auto-activated in `.bashrc`)
- **Website root**: `/opt/code/website` (symlink to Google Drive)
- **Profile repo** (global settings): `/opt/code/profile` (not used by this project)
