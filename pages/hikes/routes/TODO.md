# Routes TODO — SAC Scrape Candidates

Hikes from the published site that have SAC mountain-hiking routes available for scraping.

## Done

| Hike | SAC Route URL | Notes |
|------|---------------|-------|
| Pilatus / Tomlishorn | `tomlishorn-1988/mountain-hiking/alter-tomliweg-807/` | |
| Lisengrat (Rotsteinpass → Säntis) | `berggasthaus-rotsteinpass-2147000224/mountain-hiking/` | |
| Faulhorn (Schynige Platte) | `berghotel-faulhorn-2147436041/mountain-hiking/von-der-schynige-platte-4543/` | |
| Greina Plateau | `pass-crap-passo-della-greina-2874/mountain-hiking/` | |
| Gross Mythen | `gross-mythen-1267/mountain-hiking/` | T5 (Schafweg / Rot Grätli) |
| Üssers Barrhorn | `uessers-barrhorn-145/mountain-hiking/` | Highest T3 in the Alps (3610m) |
| Monte Tamaro | `monte-tamaro-1928/mountain-hiking/` | Tamaro–Lema traverse |
| Piz Languard | `piz-languard-1012/mountain-hiking/` | Engadin panorama |
| Creux du Van (Le Soliat) | `le-soliat-creux-du-van-4041/mountain-hiking/` | Jura amphitheater, ibex colony |
| Uri Rotstock | `uri-rotstock-2092/mountain-hiking/` | Central CH, 2928m |
| Fronalpstock | `fronalpstock-sz-568/mountain-hiking/` | Added as new pick |
| Cabane de Tracuit | `cabane-de-tracuit-cas-2147000273/mountain-hiking/` | 3256m hut, Bishorn base |
| Aletsch Panorama | `bettmerhorn-166/mountain-hiking/traverse-eggishorn-bettmerhorn-4255/` | T4 ridge traverse, Eggishorn–Bettmeralp |
| Europaweg | `europahuette-2147000092/mountain-hiking/von-randa-4088/` | Randa–Europahütte approach only (full Grächen–Zermatt traverse not available as single SAC route) |
| Schynige Platte–First | `berghaus-maenndlenen-2147000162/mountain-hiking/von-schynige-platte-1467/` + `von-first-1469/` | Two SAC routes combined via `combine_gpx.py`; full traverse via Faulhorn & Bachalpsee |

## Golden classics — need non-SAC GPX

Top-10 classics from `guides/classics.html` that have no SAC mountain-hiking routes.
These are leisure/panorama trails below the SAC portal's scope. GPX must come from
SwitzerlandMobility, Komoot, or a GPS device.

| Hike | Classics rank | Grade | Why no SAC route |
|------|:---:|:---:|--------|
| Höhenweg Hohbalm | #1 | T2 | Panorama traverse, no summit/hut endpoint |
| Oeschinensee | #4 | T2 | Lake destination; only route through it (Fründenhütte, route 474) is closed |
| Lauterbrunnen–Mürren | #7 | T1 | Valley-to-village path, below SAC threshold |
| Bachalpsee | #8 | T1 | Waypoint on route 1469 (First→Männdlenen), no standalone route |
| 5-Seenweg Pizol | #10 | T2 | Cable-car-to-cable-car circuit; SAC has Pizol summit (T4+) but not the 5-lakes trail |

## Could not scrape

| Hike | Reason |
|------|--------|
| Pizol | No mountain-hiking routes on SAC (only ski-touring) |
| Hoher Kasten | No mountain-hiking routes on SAC |
| Schilthorn | SAC route is actually for Drättehorn, not Schilthorn summit |
| Pizzo di Claro | Only alpine hiking (berg-und-alpinwandern), no standard mountain-hiking routes |

## No SAC mountain-hiking routes

These hikes exist on the published site but have no scrapable SAC mountain-hiking data.

| Hike | Reason |
|------|--------|
| Chäserrugg | Ski-touring only on SAC |
| Sassal Mason / Cresta | Ski-touring only on SAC |
| Eiger Trail | Tourist trail, no dedicated SAC route |
| Glärnisch / Bächistock | Alpinism only (glacier route) |
| Gornergrat–Riffelalp | Railway viewpoint, not a hiking summit |
| Hardergrat | No dedicated page; Augstmatthorn endpoint already in repo |
| Kreuzberge | Climbing destination only |
| Tödi | Alpinism only (glacier/high tour) |
| Walensee Höhenweg / Leistchamm | Ski-touring only on SAC |
| Dreibündenstein | Ski-touring only on SAC |
| Chasseral | Snowshoe/ski only on SAC |
