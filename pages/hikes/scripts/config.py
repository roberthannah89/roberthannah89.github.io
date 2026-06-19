"""Shared constants for the hiking website pipeline."""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Physical / geodetic
# ---------------------------------------------------------------------------
EARTH_RADIUS_M = 6_371_000.0
LAPSE_RATE_C_PER_KM = 6.5  # standard environmental lapse rate; used to correct forecast temp to the trail's actual elevation

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
