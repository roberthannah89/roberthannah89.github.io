# Agent Instructions

Single source of truth for AI coding agents (Copilot, Claude, Cursor, Codex, Aider, etc.) working in this repo.
This is a Swiss Alps hiking website with interactive Leaflet.js maps, dynamically rendered from `data.json` files.

> **Read the docs first.** Before changing anything non-trivial, skim the linked docs in the [Documentation Map](#documentation-map) below. They contain critical schema, workflow, and troubleshooting details that are NOT duplicated here.

## Shipping changes

This is a solo repo — **do not open pull requests**. When you finish work in a worktree, commit and push directly to `main` (fast-forward from your branch's HEAD is fine). No draft PRs, no review branches. If you're in a worktree, exit and clean it up once the commits are on `main`.

## Quick Reference

- **Python venv:** `~/venvs/dev/bin/python`
- **Build:** `make render` (renders all hike pages)
- **Validate:** `make validate` (checks hike data and docs)
- **Serve:** `make serve port=8000`
- **Help:** `make help` for full target list
- **Pre-commit hook:** runs schema validation, docs checks, and image/URL validation via `--probe` mode

## Documentation Map

Agents: **read the relevant doc before editing related code.** Each doc is the authority for its area.

| Area | Authoritative doc |
|------|-------------------|
| System design, folder layout, CI/deploy | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| How to add/edit a hike (step-by-step) | [docs/hiking/hiking-workflow.md](docs/hiking/hiking-workflow.md) |
| `data.json` schema and field reference | [docs/hiking/DATA-SCHEMA.md](docs/hiking/DATA-SCHEMA.md) |
| GPX building, routing, elevation profiles | [docs/hiking/ROUTING-ELEVATION.md](docs/hiking/ROUTING-ELEVATION.md) |
| Common errors and gotchas | [docs/hiking/TROUBLESHOOTING.md](docs/hiking/TROUBLESHOOTING.md) |
| Image extraction (quick) | [docs/image-extraction-quick-reference.md](docs/image-extraction-quick-reference.md) |
| Image extraction (strategies) | [docs/image-extraction-strategies.md](docs/image-extraction-strategies.md) |
| Docs index | [docs/README.md](docs/README.md) |
| JSON schema source | [templates/hike_data.schema.json](templates/hike_data.schema.json) |

## Keep Docs in Sync

After completing any task, **consider whether the change should be reflected in the docs** so future work (by you or another agent) inherits it. Update when the change affects:

- **Folder/file structure** → `README.md`, `docs/README.md`, `docs/ARCHITECTURE.md`
- **Build commands or Makefile targets** → `Makefile` help, `README.md`, this file
- **`data.json` schema or fields** → `templates/hike_data.schema.json`, `docs/hiking/DATA-SCHEMA.md`
- **Script CLI flags** → `docs/hiking/hiking-workflow.md` or `docs/hiking/ROUTING-ELEVATION.md` (then `make check-docs` to verify)
- **Workflow steps for adding/editing hikes** → `docs/hiking/hiking-workflow.md`
- **Common errors or gotchas you hit** → `docs/hiking/TROUBLESHOOTING.md`
- **CI/deploy behavior** → `.github/workflows/pages.yml` + `docs/ARCHITECTURE.md`
- **Pre-commit hook checks** → `.git/hooks/pre-commit` + this file

If a change is purely cosmetic, a one-off fix, or doesn't affect future work — skip the doc update. When in doubt, briefly mention what you'd update and ask.

## Key Commands

```bash
# Add a new hike
make new slug=myname name="My Hike" region="Region" canton="Canton" grade="T2" elev="1500"

# Build GPX route
make gpx slug=myname peak="Peak Name" bbox="46.70,7.84,46.75,7.95"

# Render pages
make render

# Validate everything
make validate

# Serve locally
make serve port=8000
```

## Structure

```
website/
├── index.html                (landing page)
├── pages/                    ← user-facing site (about, notes, hikes)
│   └── hikes/
│       ├── index.html        (generated gallery)
│       ├── guides/           (educational pages)
│       └── routes/           (hike instances)
├── docs/                     ← Full documentation (READ FIRST)
├── scripts/                  ← Python build tools
├── templates/                ← Jinja2 templates + hike_data.schema.json
└── Makefile
```

## Conventions

- **Generated files (never edit by hand):** `pages/hikes/index.html`, `pages/hikes/routes/*/*.html`, `*.track.js`
- **Source of truth:** `pages/hikes/routes/<slug>/<slug>.data.json`
- **Templates:** `templates/*.j2.html` — edit here, then `make render`
- **Internal hrefs must be relative** (e.g. `../guides/difficulty.html`)
- **Wikimedia filenames are case-sensitive** — verify via the API before hardcoding
- **Run `make render` before committing** — rendered HTML is committed to git for CI

## Images for New Hikes

Source hero images and photos from **hikr.org** — large community-contributed library with proper usage rights:

1. Visit the hike's hikr page: `https://www.hikr.org/tour/<id>/` or search `https://www.hikr.org/region/?gid=...`
2. Look for high-quality summit/route photos in the gallery
3. Right-click image → **Copy image link**
4. Use the direct hikr URL in `data.json` (e.g. `https://f.hikr.org/files/123456.jpg`)
5. For responsive display: use `width=600` for thumbnail and `width=1600` for lightbox
6. If no good hikr images exist, fall back to **Wikimedia Commons** with proper `width=` parameters

**Pre-commit hook will reject broken image URLs** — verify links work before commit.
See [docs/image-extraction-quick-reference.md](docs/image-extraction-quick-reference.md) and [docs/image-extraction-strategies.md](docs/image-extraction-strategies.md) for deeper guidance.

## When Stuck

1. Check [docs/hiking/TROUBLESHOOTING.md](docs/hiking/TROUBLESHOOTING.md)
2. Run `make help` for full Makefile target list
3. Check `scripts/check_hiking_docs.py` output for documentation drift

---

> **Tool-specific files** in this repo (`.github/copilot-instructions.md`, etc.) are symlinks to this file. Edit `AGENTS.md` only.
