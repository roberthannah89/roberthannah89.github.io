"""Shared constants for the hiking website pipeline."""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Physical / geodetic
# ---------------------------------------------------------------------------
EARTH_RADIUS_M = 6_371_000.0
# standard environmental lapse rate; used to correct forecast temp to the trail's actual elevation
LAPSE_RATE_C_PER_KM = 6.5

# ---------------------------------------------------------------------------
# GPX processing
# ---------------------------------------------------------------------------
ELEV_SMOOTH_M = 3  # ignore elevation changes smaller than this (GPS noise)
LOOP_THRESHOLD_M = 500  # start/end closer than this → route is a loop

# ---------------------------------------------------------------------------
# Naismith's rule (hiking time estimate)
# ---------------------------------------------------------------------------
NAISMITH_SPEED_KMH = 5.0  # horizontal speed (km/h)
NAISMITH_ASCENT_MH = 600.0  # vertical ascent rate (m/h)

# ---------------------------------------------------------------------------
# Index-card photo thumbnail width (px)
# ---------------------------------------------------------------------------
INDEX_PHOTO_WIDTH = 400

# ---------------------------------------------------------------------------
# Difficulty blurbs (SAC grade → one-line description)
# ---------------------------------------------------------------------------
DIFFICULTY_BLURBS: dict[str, str] = {
    "T1": "Hiking on well-marked paths with no technical difficulty.",
    "T2": "Mountain hiking on marked trails with uneven terrain and some sustained ascent.",
    "T3": "Demanding mountain hiking with possible exposure and a real need for sure-footedness.",
    "T4": "Alpine hiking with exposure, rougher terrain, and sections that are not suitable for beginners.",
    "T5": "Demanding alpine hiking with exposure, scrambling, and route-finding.",
    "T6": "Difficult alpine hiking close to mountaineering terrain.",
}

# ---------------------------------------------------------------------------
# Source keyword → base URL (for route source → hyperlink conversion)
# ---------------------------------------------------------------------------
SOURCE_URL_MAP: dict[str, str] = {
    "hikr.org": "https://www.hikr.org/",
    "SAC Route Portal": "https://www.sac-cas.ch/",
    "SAC": "https://www.sac-cas.ch/",
    "Switzerland Mobility": "https://www.schweizmobil.ch/",
    "Wikimedia Commons": "https://commons.wikimedia.org/",
    "Pizolbahnen": "https://pizol.com/",
    "Jungfrau Region": "https://www.jungfrau.ch/",
}


# ---------------------------------------------------------------------------
# Default disclaimer (for new hike scaffolds)
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Default disclaimer (for new hike scaffolds)
# ---------------------------------------------------------------------------
DEFAULT_DISCLAIMER = (
    "This page is an informal hike plan, not professional mountain-safety advice. "
    "Conditions change rapidly. Always check MeteoSwiss and SAC before setting out."
)

# ---------------------------------------------------------------------------
# Peak Viewer prototype (scripts/build_ch_peaks.py)
# ---------------------------------------------------------------------------
# Public Overpass instance. Kumi.systems is faster than the default main-
# instance and slightly more permissive with long-running queries.
OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"

# How close an OSM peak must be to a SAC summit for the join to consider it.
SAC_JOIN_DISTANCE_M = 100

# Fuzzy name-match ratio (0..1). Below this we treat the pair as different
# peaks even if they're within SAC_JOIN_DISTANCE_M metres.
SAC_JOIN_NAME_THRESHOLD = 0.7

# ---------------------------------------------------------------------------
# SLF avalanche bulletin (EAWS CAAML V6.0 GeoJSON endpoint)
# ---------------------------------------------------------------------------
# Live GeoJSON: features carry merged region polygons + dangerRatings.
# Returns an empty FeatureCollection in the off-season (June-October).
SLF_BULLETIN_GEOJSON_URL = "https://aws.slf.ch/api/bulletin/caaml/en/geojson"

# EAWS danger-level keyword → 1-5 numeric scale.
SLF_DANGER_LEVELS: dict[str, int] = {
    "low": 1,
    "moderate": 2,
    "considerable": 3,
    "high": 4,
    "very_high": 5,
}

# Official EAWS / SLF colours (matching the WhiteRisk app CSS vars).
# Level 5 is rendered as a black-on-red chequer in print bulletins; for a
# semi-transparent map fill we use the dark red (#640000) WhiteRisk uses.
SLF_DANGER_COLORS: dict[int, str] = {
    1: "#ccff66",  # low — light green
    2: "#ffff00",  # moderate — yellow
    3: "#ff9900",  # considerable — orange
    4: "#ff0000",  # high — red
    5: "#640000",  # very high — dark red (EAWS uses black+red chequer)
}

SLF_DANGER_LABELS: dict[int, str] = {
    1: "Low",
    2: "Moderate",
    3: "Considerable",
    4: "High",
    5: "Very High",
}
