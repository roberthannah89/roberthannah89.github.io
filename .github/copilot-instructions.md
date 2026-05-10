# Hiking Website — Agent Instructions

This is a Swiss Alps hiking website with interactive Leaflet.js maps, dynamically rendered from `data.json` files.

## Keep Docs in Sync

After completing any task, **consider whether the change should be reflected in the docs** so future work (by you or another agent) inherits it. Update when the change affects:

- **Folder/file structure** → `README.md`, `docs/README.md`, `docs/ARCHITECTURE.md`
- **Build commands or Makefile targets** → `Makefile` help, `README.md`, `.github/copilot-instructions.md`
- **`data.json` schema or fields** → `templates/hike_data.schema.json`, `docs/hiking/DATA-SCHEMA.md`
- **Script CLI flags** → `docs/hiking/hiking-workflow.md` or `ROUTING-ELEVATION.md` (then `make check-docs` to verify)
- **Workflow steps for adding/editing hikes** → `docs/hiking/hiking-workflow.md`
- **Common errors or gotchas you hit** → `docs/hiking/TROUBLESHOOTING.md`
- **CI/deploy behavior** → `.github/workflows/pages.yml` + `docs/ARCHITECTURE.md`
- **Pre-commit hook checks** (schema, docs, image validation) → `.git/hooks/pre-commit` + this file

If a change is purely cosmetic, a one-off fix, or doesn't affect future work — skip the doc update. When in doubt, briefly mention what you'd update and ask.

## Quick Reference

- **Repo root:** `/opt/code/website`
- **Python venv:** `~/venvs/dev/bin/python`
- **Build:** `make render` (renders all hike pages)
- **Validate:** `make validate` (checks hike data and docs)
- **Pre-commit hook:** runs schema validation, docs checks, and image/URL validation via `--probe` mode

## Full Documentation

👉 **Start here:** [`docs/README.md`](../docs/README.md)

This file links to:
- **ARCHITECTURE.md** — folder structure and system design
- **hiking/hiking-workflow.md** — step-by-step workflows
- **hiking/DATA-SCHEMA.md** — hike data format
- **hiking/ROUTING-ELEVATION.md** — GPX building details
- **hiking/TROUBLESHOOTING.md** — common issues

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
├── index.html                ( landing page)
├── pages/                    ← user-facing site (about, notes, hikes)
│   └── hikes/
│       ├── index.html        (generated gallery)
│       ├── guides/           (educational pages)
│       └── routes/           (hike instances)
├── docs/                     ← Full documentation (START HERE)
├── scripts/                  ← Python build tools
├── templates/                ← Jinja2 templates + hike_data.schema.json
└── Makefile
```

## Conventions

- **Generated files** (never edit by hand): `pages/hikes/index.html`, `pages/hikes/routes/*/*.html`, `*.track.js`
- **Source of truth:** `pages/hikes/routes/<slug>/<slug>.data.json`
- **Templates:** `templates/*.j2.html` (edit here, then `make render`)
- **Internal hrefs must be relative** (e.g. `../guides/difficulty.html`)
- **Wikimedia filenames are case-sensitive** — verify via the API before hardcoding
- **Run `make render` before committing** — rendered HTML is committed to git for CI

## When Stuck

1. Check [`docs/hiking/TROUBLESHOOTING.md`](../docs/hiking/TROUBLESHOOTING.md)
2. Run `make help` for full Makefile target list
3. Check `scripts/check_hiking_docs.py` output for documentation drift
