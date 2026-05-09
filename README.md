# roberthannah89.github.io

Personal site, served from the `main` branch via GitHub Pages at
https://roberthannah89.github.io/.

## Layout

```
.
├── index.html               # landing page
├── hikes/                   # interactive Swiss Alps hike plans
│   ├── santis/, zindlenspitz/   # per-hike folders (data.json + GPX + map)
│   ├── _assets/             # generated, shared CSS/JS for hike pages
│   └── index.html           # generated landing for the hike index
└── skills/
    └── hiking/              # Claude/Copilot "skill" — the hiking domain
                             # workflow + render tooling. Symlinked into
                             # ~/.claude/skills/hiking/ on dev machines.
```

## Updating the hike pages

Each hike's source of truth is `hikes/<slug>/<slug>.data.json` + the GPX file.
Render with:

```bash
python skills/hiking/scripts/render_hike.py
```

Generates `hikes/<slug>/<slug>.html` and `hikes/index.html` in parallel,
auto-rebuilds the index from all `*.data.json` files. CI runs this on every
push.

See [skills/hiking/hike-html-page.md](./skills/hiking/hike-html-page.md) for the
data-JSON schema and the new-hike workflow.

## Local symlink for Claude

```bash
ln -sfn /opt/code/website/skills/hiking ~/.claude/skills/hiking
```

This makes the skill content + render tooling available to Claude in any
workspace, while keeping a single source of truth in this repo.
