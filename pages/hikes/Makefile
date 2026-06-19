# =============================================================================
# hikes2 — Swiss Alpine Hike Pages
# =============================================================================
# Manual workflow: you supply GPX + photos; scripts validate and render HTML.
#
# Scripts:    scripts/
# Hike data:  routes/<slug>/
# Python:     ~/venvs/dev/bin/python  (hardcoded venv — do not change)
# =============================================================================

.DEFAULT_GOAL := help

PYTHON  := ~/venvs/dev/bin/python
SCRIPTS := scripts
port    ?= 8000

.PHONY: help new new-gpx render validate serve weather avalanche inspect-sac check-gaps combine-gpx swiss-border add-sac 3d-previews

# -----------------------------------------------------------------------------
## help : Print usage summary (default target)
help:
	@echo ""
	@echo "Usage: make <target> [var=value ...]"
	@echo ""
	@echo "Targets:"
	@echo "  help           Show this help message (default)"
	@echo "  new            Scaffold a new hike directory (manual metadata)"
	@echo "  new-gpx        Scaffold from existing GPX (auto-extracts stats)"
	@echo "  render         Render all hike HTML pages"
	@echo "  3d-previews    Generate static 3D-map preview JPEGs (headless Chromium; slow)"
	@echo "  validate       Validate hike data without writing output"
	@echo "  serve          Render then serve the site on localhost"
	@echo ""
	@echo "Command-center data:"
	@echo "  weather        Pre-bake MeteoSwiss ICON-CH2 forecasts → weather-cache.js"
	@echo "  avalanche      Fetch SLF avalanche bulletin → slf-cache.js (winter only)"
	@echo ""
	@echo "Utilities:"
	@echo "  inspect-sac    Print SAC JSON structure (json=<path>)"
	@echo "  check-gaps     Check GPX track connectivity (gpx=<path>)"
	@echo "  combine-gpx    Stitch two GPX tracks (gpx1=... gpx2=... output=...)"
	@echo "  swiss-border   Regenerate swiss_border.js from GADM"
	@echo "  add-sac        Add a hike via the v2 SAC pipeline (URL=... SLUG=... REGION=... CANTON=... GRADE=...)"
	@echo ""
	@echo "Variables for 'new':"
	@echo "  slug            (required) URL-safe hike slug, e.g. lisengrat"
	@echo "  name            (required) Display name, e.g. \"Lisengrat\""
	@echo "  region          (required) Hiking region, e.g. \"Alpstein\""
	@echo "  canton          (required) Canton name, e.g. \"Appenzell\""
	@echo "  grade           (required) SAC grade, e.g. T3"
	@echo "  elev            (required) Summit elevation in metres, e.g. 2262"
	@echo "  trailhead       (required) Trailhead name, e.g. \"Wasserauen\""
	@echo ""
	@echo "Example:"
	@echo "  make new slug=lisengrat name=\"Lisengrat\" region=\"Alpstein\" canton=\"Appenzell\" grade=T3 elev=2262 trailhead=\"Wasserauen\""
	@echo "  make render"
	@echo "  make serve"
	@echo ""

# -----------------------------------------------------------------------------
## new : Scaffold a new hike directory with an empty data.json
new:
	$(PYTHON) $(SCRIPTS)/new_hike.py \
	  $(if $(slug),--slug $(slug)) \
	  $(if $(name),--name "$(name)") \
	  $(if $(region),--region "$(region)") \
	  $(if $(canton),--canton "$(canton)") \
	  $(if $(grade),--grade $(grade)) \
	  $(if $(elev),--elev $(elev)) \
	  $(if $(trailhead),--trailhead "$(trailhead)")

# -----------------------------------------------------------------------------
## new-gpx : Scaffold a new hike from an existing GPX file (auto-extracts stats)
new-gpx:
	$(PYTHON) $(SCRIPTS)/new_hike.py \
	  $(if $(gpx),--gpx $(gpx)) \
	  $(if $(slug),--slug $(slug)) \
	  $(if $(name),--name "$(name)") \
	  $(if $(region),--region "$(region)") \
	  $(if $(canton),--canton "$(canton)") \
	  $(if $(grade),--grade $(grade)) \
	  $(if $(elev),--elev $(elev)) \
	  $(if $(trailhead),--trailhead "$(trailhead)") \
	  $(if $(add_elevation),--add-elevation)

# -----------------------------------------------------------------------------
## render : Render all hike HTML pages from data.json + GPX + templates
render:
	$(PYTHON) $(SCRIPTS)/render_hike.py

# -----------------------------------------------------------------------------
## 3d-previews : Screenshot each <slug>.3d.html to <slug>.3d-preview.jpg (slow).
##             : Pass slug=foo (or "a b") to restrict to specific hikes.
3d-previews:
	$(PYTHON) $(SCRIPTS)/render_3d_previews.py $(if $(slug),--only $(slug))

# -----------------------------------------------------------------------------
## validate : Validate hike data completeness and schema (no output written)
validate:
	$(PYTHON) $(SCRIPTS)/validate_hike_files.py
	$(PYTHON) $(SCRIPTS)/render_hike.py --validate-only

# -----------------------------------------------------------------------------
## serve : Render then serve the site locally (open http://localhost:$(port)/)
serve: render
	python3 -m http.server $(port)

# -----------------------------------------------------------------------------
## weather : Fetch weather forecasts for all SAC peaks (run before using command center)
weather:
	$(PYTHON) $(SCRIPTS)/fetch_weather.py

# -----------------------------------------------------------------------------
## avalanche : Fetch the current SLF avalanche bulletin (run before opening the command center in winter)
avalanche:
	$(PYTHON) $(SCRIPTS)/fetch_slf_avalanche.py

# -----------------------------------------------------------------------------
## inspect-sac : Print SAC JSON structure (photos, segments, waypoints, metadata)
inspect-sac:
	$(PYTHON) $(SCRIPTS)/inspect_sac_json.py $(json)

# -----------------------------------------------------------------------------
## check-gaps : Check GPX track connectivity (threshold in metres, default 100)
check-gaps:
	$(PYTHON) $(SCRIPTS)/check_gpx_gaps.py $(gpx) $(if $(threshold),$(threshold))

# -----------------------------------------------------------------------------
## combine-gpx : Stitch two GPX tracks end-to-end
combine-gpx:
	$(PYTHON) $(SCRIPTS)/combine_gpx.py \
	  $(if $(gpx1),--gpx1 $(gpx1)) \
	  $(if $(gpx2),--gpx2 $(gpx2)) \
	  $(if $(output),--output $(output)) \
	  $(if $(reverse2),--reverse2) \
	  $(if $(name),--name "$(name)")

# -----------------------------------------------------------------------------
## swiss-border : Regenerate swiss_border.js from GADM boundary data
swiss-border:
	$(PYTHON) $(SCRIPTS)/make_swiss_boundary.py

# -----------------------------------------------------------------------------
## add-sac : Add a hike via the v2 SAC pipeline (post-2026-06 architecture)
add-sac:
	$(PYTHON) $(SCRIPTS)/add_sac_hike_v2.py \
	  $(if $(URL),--url '$(URL)') \
	  $(if $(SLUG),--slug '$(SLUG)') \
	  $(if $(REGION),--region '$(REGION)') \
	  $(if $(CANTON),--canton '$(CANTON)') \
	  $(if $(GRADE),--grade '$(GRADE)')
