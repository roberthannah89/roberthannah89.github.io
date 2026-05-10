# roberthannah89.github.io

Personal site, served from the `main` branch via GitHub Pages at
https://roberthannah89.github.io/.

## Layout

```
.
├── index.html            # landing page
├── docs/                 # all documentation (start here: docs/README.md)
├── scripts/              # Python build tools
├── templates/            # Jinja2 templates
├── hikes/                # interactive Swiss Alps hike plans
│   ├── index.html        # generated gallery
│   ├── guides/           # educational pages
│   └── routes/           # per-hike folders (data.json + GPX + map)
├── hike_data.schema.json # JSON schema for data.json validation
└── Makefile              # build interface (run `make help`)
```

## Quick Start

```bash
# Validate everything
make validate

# Render all hikes
make render

# Add a new hike
make new slug=myname name="My Hike" region="Region" canton="Canton" grade="T2" elev="1500"

# Serve locally
make serve
```

## Documentation

See [docs/README.md](./docs/README.md) for full documentation:
- **ARCHITECTURE.md** — system design
- **hiking/WORKFLOW.md** — step-by-step workflows
- **hiking/DATA-SCHEMA.md** — `data.json` field reference
- **hiking/ROUTING-ELEVATION.md** — GPX building
- **hiking/TROUBLESHOOTING.md** — common issues

CI runs validation + render on every push to `main`.
