# =============================================================================
# Hiking website build tooling — convenience Makefile
# =============================================================================
# Run all targets from /opt/code/website/.
#
# Scripts:    skills/hiking/scripts/
# Hike data:  hikes/<slug>/
# Python:     ~/venvs/dev/bin/python  (hardcoded venv — do not change)
# =============================================================================

.DEFAULT_GOAL := help

PYTHON  := ~/venvs/dev/bin/python
SCRIPTS := skills/hiking/scripts
port    ?= 8000

.PHONY: help new gpx render validate check-docs probe serve install-hooks

# -----------------------------------------------------------------------------
## help : Print usage summary (default target)
help:
	@echo ""
	@echo "Usage: make <target> [var=value ...]"
	@echo ""
	@echo "Targets:"
	@echo "  help           Show this help message (default)"
	@echo "  new            Scaffold a new hike directory via new_hike.py"
	@echo "  gpx            Build a GPX route via build_hike_gpx.py"
	@echo "  render         Render hike HTML pages via render_hike.py"
	@echo "  validate       Validate hike data only (no output written)"
	@echo "  check-docs     Validate hiking instructions against current CLI flags"
	@echo "  probe          Probe hike data sources"
	@echo "  serve          Render then serve the site on localhost"
	@echo "  install-hooks  Install git pre-commit validation hook"
	@echo ""
	@echo "Variables for 'new':"
	@echo "  slug            (required) URL-safe hike slug, e.g. augstmatthorn"
	@echo "  name            (required) Display name, e.g. \"Augstmatthorn\""
	@echo "  region          Hiking region, e.g. \"Bernese Oberland\""
	@echo "  canton          Canton name, e.g. Bern"
	@echo "  grade           SAC trail grade, e.g. T3"
	@echo "  elev            Summit elevation in metres, e.g. 1737"
	@echo "  trailhead       Trailhead name, e.g. Habkern"
	@echo "  peak_lat        (optional) Peak latitude"
	@echo "  peak_lon        (optional) Peak longitude"
	@echo "  trailhead_lat   (optional) Trailhead latitude"
	@echo "  trailhead_lon   (optional) Trailhead longitude"
	@echo "  via             (optional) Space-separated single-word waypoints"
	@echo ""
	@echo "Variables for 'gpx':"
	@echo "  slug            (required) Hike slug"
	@echo "  peak            (required) Peak name"
	@echo "  trailhead       Trailhead name"
	@echo "  bbox            Bounding box, e.g. 46.70,7.84,46.75,7.95"
	@echo "  via             Space-separated single-word waypoints"
	@echo ""
	@echo "Variables for 'render' / 'probe':"
	@echo "  slug            (optional) Limit to a single hike"
	@echo ""
	@echo "Variables for 'serve':"
	@echo "  port            HTTP port (default: 8000)"
	@echo ""
	@echo "Examples:"
	@echo "  make new slug=augstmatthorn name=\"Augstmatthorn\" region=\"Bernese Oberland\" \\"
	@echo "       canton=Bern grade=T3 elev=1737 trailhead=Habkern \\"
	@echo "       peak_lat=46.72 peak_lon=7.88 via=\"Lombachalp Augstmatthorn\""
	@echo ""
	@echo "  make gpx slug=augstmatthorn peak=Augstmatthorn trailhead=Habkern \\"
	@echo "       via=\"Lombachalp Augstmatthorn\" bbox=46.70,7.84,46.75,7.95"
	@echo ""
	@echo "  make render slug=augstmatthorn"
	@echo "  make validate"
	@echo "  make serve port=8080"
	@echo ""

# -----------------------------------------------------------------------------
## new : Scaffold a new hike directory (requires slug, name)
new:
	@test -n "$(slug)" || (echo "ERROR: 'slug' is required — e.g. make new slug=augstmatthorn name=\"Augstmatthorn\" ..."; exit 1)
	@test -n "$(name)" || (echo "ERROR: 'name' is required — e.g. make new slug=$(slug) name=\"My Hike\" ..."; exit 1)
	$(PYTHON) $(SCRIPTS)/new_hike.py \
		--slug "$(slug)" \
		--name "$(name)" \
		$(if $(region),--region "$(region)") \
		$(if $(canton),--canton "$(canton)") \
		$(if $(grade),--grade "$(grade)") \
		$(if $(elev),--elev "$(elev)") \
		$(if $(trailhead),--trailhead "$(trailhead)") \
		$(if $(peak_lat),--peak-lat $(peak_lat)) \
		$(if $(peak_lon),--peak-lon $(peak_lon)) \
		$(if $(trailhead_lat),--trailhead-lat $(trailhead_lat)) \
		$(if $(trailhead_lon),--trailhead-lon $(trailhead_lon)) \
		$(foreach v,$(via),--via $(v))

# -----------------------------------------------------------------------------
## gpx : Build a GPX route for a hike (requires slug, peak)
gpx:
	@test -n "$(slug)" || (echo "ERROR: 'slug' is required — e.g. make gpx slug=augstmatthorn peak=Augstmatthorn ..."; exit 1)
	@test -n "$(peak)" || (echo "ERROR: 'peak' is required — e.g. make gpx slug=$(slug) peak=<PeakName> ..."; exit 1)
	$(PYTHON) $(SCRIPTS)/build_hike_gpx.py \
		--slug "$(slug)" \
		--peak "$(peak)" \
		$(if $(trailhead),--trailhead "$(trailhead)") \
		$(if $(bbox),--bbox "$(bbox)") \
		$(foreach v,$(via),--via $(v)) \
		--out-dir "hikes/$(slug)/"

# -----------------------------------------------------------------------------
## render : Render hike HTML pages (pass slug= to limit to one hike)
render:
	$(PYTHON) $(SCRIPTS)/render_hike.py $(if $(slug),--slug $(slug))

# -----------------------------------------------------------------------------
## validate : Validate hike data without writing any output
validate:
	$(PYTHON) $(SCRIPTS)/check_hiking_docs.py
	$(PYTHON) $(SCRIPTS)/render_hike.py --validate-only

# -----------------------------------------------------------------------------
## check-docs : Validate canonical hiking instructions against current scripts
check-docs:
	$(PYTHON) $(SCRIPTS)/check_hiking_docs.py

# -----------------------------------------------------------------------------
## probe : Probe hike data sources (pass slug= to limit to one hike)
probe:
	$(PYTHON) $(SCRIPTS)/render_hike.py --probe $(if $(slug),--slug $(slug))

# -----------------------------------------------------------------------------
## serve : Render then serve the site locally (open http://localhost:$(port)/hikes/)
serve: render
	python3 -m http.server $(port)

# -----------------------------------------------------------------------------
## install-hooks : Write and activate .git/hooks/pre-commit validation hook
install-hooks:
	@printf '#!/bin/sh\n~/venvs/dev/bin/python skills/hiking/scripts/check_hiking_docs.py\n~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py --validate-only\n' > .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@printf '✓ .git/hooks/pre-commit installed\n'
