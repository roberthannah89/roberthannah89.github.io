"""Shared constants for the hiking website pipeline."""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Physical / geodetic
# ---------------------------------------------------------------------------
EARTH_RADIUS_M = 6_371_000.0

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
# Guide pages (rendered as nav links on the index hero)
# Each entry: (href-relative-to-index, label)
# ---------------------------------------------------------------------------
GUIDE_PAGES: list[dict[str, str]] = [
    {"href": "planning.html",    "label": "Planning",
     "card_title": "Planning a hike",
     "card_desc": "Finding routes on the SAC portal, building custom routes in Komoot, and using the SwissTopo app for offline navigation."},
    {"href": "difficulty.html",  "label": "Trail grades",
     "card_title": "Trail grades (T1–T6)",
     "card_desc": "What the SAC mountain hiking scale actually means in practice — terrain, exposure, and equipment for each grade."},
    {"href": "weather.html",     "label": "Weather",
     "card_title": "Reading alpine weather",
     "card_desc": "MeteoSwiss vs Meteoblue, temperature at altitude, go/no-go criteria, and how to check webcams before committing."},
    {"href": "gear.html",        "label": "Gear & safety",
     "card_title": "Gear & safety",
     "card_desc": "What to pack, the Swiss trail marking system, emergency numbers, the Rega app, and the small habits that prevent avoidable incidents."},
    {"href": "regions.html",     "label": "Regions & cantons",
     "card_title": "Regions & cantons",
     "card_desc": "Where these hikes are — browsing by SAC guidebook region and Swiss canton, with an interactive map."},
    {"href": "classics.html",    "label": "50 Golden Classics",
     "card_title": "50 Golden Classics",
     "card_desc": "The 50 essential Swiss hikes — a curated list spanning every region and difficulty level, from gentle lakeside walks to committing alpine ridges."},
]

# ---------------------------------------------------------------------------
# Default disclaimer (for new hike scaffolds)
# ---------------------------------------------------------------------------
DEFAULT_DISCLAIMER = (
    "This page is an informal hike plan, not professional mountain-safety advice. "
    "Conditions change rapidly. Always check MeteoSwiss and SAC before setting out."
)

# ---------------------------------------------------------------------------
# Golden Classics — top 50 Swiss hikes
# Each entry: (name, region, grade, one-line description)
# ---------------------------------------------------------------------------
GOLDEN_CLASSICS: list[dict[str, str]] = [
    # Ranked roughly by international fame / recognition
    {"name": "Höhenweg Hohbalm",              "region": "Wallis",           "grade": "T2", "desc": "Zermatt panorama trail beneath the Matterhorn — arguably Switzerland's most iconic vista."},
    {"name": "Schynige Platte – First",       "region": "Berner Oberland",  "grade": "T2", "desc": "The definitive Oberland ridge traverse with Eiger, Mönch, and Jungfrau in your face the entire way."},
    {"name": "Aletsch Glacier panorama trail", "region": "Wallis",          "grade": "T2", "desc": "Walk along the rim of the longest glacier in the Alps from Bettmerhorn or Eggishorn."},
    {"name": "Oeschinensee",                   "region": "Berner Oberland", "grade": "T2", "desc": "UNESCO World Heritage lake set in a dramatic limestone cirque above Kandersteg."},
    {"name": "Rigi Kulm",                      "region": "Zentralschweiz",  "grade": "T2", "desc": "The Queen of the Mountains — panoramic summit above the lake, reachable by rack railway or on foot."},
    {"name": "Pilatus (Tomlishorn)",           "region": "Zentralschweiz",  "grade": "T4", "desc": "The dragon mountain above Lucerne — exposed summit ridge with chains and a legendary history."},
    {"name": "Lauterbrunnen – Mürren",         "region": "Berner Oberland", "grade": "T1", "desc": "Valley of 72 waterfalls to the car-free village, with Staubbach Falls and Jungfrau views."},
    {"name": "Bachalpsee",                     "region": "Berner Oberland", "grade": "T1", "desc": "Short walk from First gondola to a mirror-still lake reflecting the Schreckhorn and Wetterhorn."},
    {"name": "Europaweg (Grächen – Zermatt)",  "region": "Wallis",          "grade": "T3", "desc": "Two-day high trail with the Charles Kuonen suspension bridge and Matterhorn views."},
    {"name": "5-Seenweg (Pizol)",              "region": "Ostschweiz",      "grade": "T2", "desc": "Five glacial lakes in a single circuit above Bad Ragaz — from turquoise to emerald."},
    {"name": "Säntis",                         "region": "Alpstein",        "grade": "T3", "desc": "Highest Alpstein summit with 360° panorama across six countries."},
    {"name": "Hardergrat",                     "region": "Berner Oberland", "grade": "T4", "desc": "Legendary airy ridge from Interlaken to Brienz — one of Switzerland's most exposed day hikes."},
    {"name": "Faulhorn",                       "region": "Berner Oberland", "grade": "T2", "desc": "Classic panorama summit with a historic mountain hotel and sweeping Oberland views."},
    {"name": "Monte Rosa Hütte",              "region": "Wallis",           "grade": "T4", "desc": "Futuristic SAC hut reached via the Gorner glacier — otherworldly scenery."},
    {"name": "Äscherweg (Ebenalp – Seealpsee)","region": "Alpstein",        "grade": "T2", "desc": "Cliff-hugging Berggasthaus Aescher, prehistoric caves, and the jewel-green Seealpsee."},
    {"name": "Hohtürli (Via Alpina)",          "region": "Berner Oberland",  "grade": "T4", "desc": "Griesalp to Kandersteg over the Hohtürli pass with Blüemlisalp glacier panorama."},
    {"name": "Creux du Van",                   "region": "Jura",            "grade": "T2", "desc": "160-metre limestone amphitheatre in the Jura with resident ibex — Switzerland's Grand Canyon."},
    {"name": "Grosser Mythen",                 "region": "Zentralschweiz",  "grade": "T4", "desc": "Iconic pyramidal summit above Schwyz with a steep zigzag ascent and summit restaurant."},
    {"name": "Monte Tamaro – Monte Lema",      "region": "Ticino",          "grade": "T3", "desc": "Ridge traverse from Botta's chapel to Monte Lema with views over Lago di Lugano."},
    {"name": "Lötschentaler Höhenweg",         "region": "Wallis",          "grade": "T2", "desc": "Balcony trail in the Lötschental facing a wall of 4000 m peaks and hanging glaciers."},
    {"name": "Augstmatthorn",                  "region": "Berner Oberland", "grade": "T4", "desc": "Exposed ridge walk above Brienzersee with ibex colonies and a knife-edge finale."},
    {"name": "Rochers de Naye",                "region": "Fribourg / Vaud", "grade": "T2", "desc": "Cog railway summit above Montreux with alpine garden and sweeping Léman views."},
    {"name": "Muottas Muragl – Alp Languard",  "region": "Engadin",        "grade": "T2", "desc": "Panorama trail high above the Upper Engadin lakes with Bernina backdrop."},
    {"name": "Fronalpstock",                   "region": "Zentralschweiz",  "grade": "T3", "desc": "Above Vierwaldstättersee with views down the Swiss Path and across to Rütli."},
    {"name": "Stoos Ridge Trail",              "region": "Zentralschweiz",  "grade": "T3", "desc": "Ridge circuit from the world's steepest funicular to Klingenstock and Fronalpstock."},
    {"name": "Cabane de Tracuit",              "region": "Wallis",          "grade": "T4", "desc": "High approach to the Tracuit hut facing the Weisshorn and Bishorn — gateway to 4000ers."},
    {"name": "Greina Hochebene",               "region": "Graubünden",     "grade": "T3", "desc": "Remote high plateau with a Tibetan feel — one of the last untouched alpine landscapes."},
    {"name": "Piz Languard",                   "region": "Engadin",        "grade": "T3", "desc": "Bernina massif viewpoint above Pontresina with chamois and ibex sightings."},
    {"name": "Val Roseg",                      "region": "Engadin",        "grade": "T1", "desc": "Gentle valley walk from Pontresina to the Roseg glacier snout — glaciology in easy mode."},
    {"name": "Stanserhorn",                    "region": "Zentralschweiz",  "grade": "T2", "desc": "Cabrio cable car or hiking trail to an open-deck summit with Titlis and lake views."},
    {"name": "Blüemlisalphütte",              "region": "Berner Oberland", "grade": "T3", "desc": "Approach to the SAC hut perched below the Blüemlisalp glacier wall."},
    {"name": "Dent de Jaman",                  "region": "Fribourg / Vaud", "grade": "T2", "desc": "Above Montreux with Lake Geneva and the Savoy Alps — cheese-country panorama."},
    {"name": "Üssers Barrhorn",               "region": "Wallis",           "grade": "T4", "desc": "Highest trail summit in the Alps at 3610 m — the ultimate non-technical peak."},
    {"name": "Lisengrat",                      "region": "Alpstein",        "grade": "T3", "desc": "Churfirsten ridge traverse to Rotsteinpass with dramatic Alpstein scenery."},
    {"name": "Chasseral",                      "region": "Jura",            "grade": "T2", "desc": "Highest point of the Bernese Jura with views from the Vosges to the Bernese Alps."},
    {"name": "Niederhorn",                     "region": "Berner Oberland", "grade": "T2", "desc": "Gentle ridgeline above Lake Thun with marmot meadows and Eiger views."},
    {"name": "Geltenhütte",                    "region": "Berner Oberland", "grade": "T2", "desc": "Gentle approach through alpine meadows to an SAC hut beneath the Geltenhorn."},
    {"name": "Cardada – Cimetta",              "region": "Ticino",          "grade": "T1", "desc": "Above Locarno — panoramic terrace over Lago Maggiore to the snow peaks."},
    {"name": "Uri Rotstock",                   "region": "Zentralschweiz",  "grade": "T4", "desc": "Central Swiss classic with glacier-polished rock and a panoramic summit above the Surenenpass."},
    {"name": "Monte San Giorgio",              "region": "Ticino",          "grade": "T2", "desc": "UNESCO fossil mountain above Lake Lugano with Mediterranean flora and lake views."},
    {"name": "Cabane du Mont Fort",            "region": "Wallis",          "grade": "T3", "desc": "SAC hut above Verbier with front-row views of the Grand Combin and Mont Blanc."},
    {"name": "Piz Beverin",                    "region": "Graubünden",     "grade": "T4", "desc": "360° panorama summit in the Viamala region spanning from Tödi to Monte Rosa."},
    {"name": "Wildstrubel (Lämmerenhütte)",    "region": "Berner Oberland", "grade": "T3", "desc": "Approach to the Lämmerenhütte via the Gemmi pass with views of the Wildstrubel massif."},
    {"name": "Planurahuette",                  "region": "Glarnerland",    "grade": "T3", "desc": "Approach to the SAC hut at the foot of the Tödi — gateway to the Clariden region."},
    {"name": "Vorder Glärnisch",              "region": "Glarnerland",     "grade": "T4", "desc": "Steep ascent to the highest summit above Glarus with a birds-eye view of the Rhine valley."},
    {"name": "Wissigstock",                    "region": "Zentralschweiz",  "grade": "T4", "desc": "Alpine peak above the Maderanertal with glacier remnants and a remote feel."},
    {"name": "Zindlenspitz",                   "region": "Zentralschweiz",  "grade": "T4", "desc": "Technical scramble with chains to a tiny summit overlooking the Wägitalersee."},
    {"name": "Wiggis",                         "region": "Glarnerland",    "grade": "T4", "desc": "Long ridge above the Walensee with sustained views from Glarus to the Alpstein."},
    {"name": "Risetestock",                    "region": "Zentralschweiz",  "grade": "T4", "desc": "Quiet summit with big views above the Klausenpass road."},
    {"name": "Gross Fiescherhorn Hütte approach","region": "Berner Oberland","grade": "T3", "desc": "Dramatic glacier-flanked approach to one of the most remote SAC huts in the Oberland."},
]
