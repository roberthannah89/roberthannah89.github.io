# Routes TODO — SAC Scrape Candidates

Hikes from the published site that have SAC mountain-hiking routes available for scraping.

## In repo (canaries — kept while v2 pipeline is being validated)

| Hike | Pipeline | Notes |
|------|----------|-------|
| augstmatthorn | v1 (old API JSON) | Golden reference data.json; multi-doc references depend on this slug existing |
| federispitz | v2 (layer API + HTML scrape) | Only v2-extracted hike; baseline for v2 output |
| monte-rosa-huette | v1 | Point-to-point hut topology |
| saentis | v1 | Multi-waypoint scramble (T4+); rich content reference |
| schynige-platte-first | v1 | Only combined-route hike (two SAC routes merged via `combine_gpx.py`) |

## Awaiting re-extraction via v2 pipeline

Deleted on 2026-06-03 to free for clean v2 re-scrape. Old `sac-route-*.json` captures and rendered files are recoverable from git history (commit just before the delete). To restore one: `git log --all --diff-filter=D -- routes/<slug>/`, then `git checkout <commit>^ -- routes/<slug>/`.

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
| Fronalpstock | `fronalpstock-sz-568/mountain-hiking/` | |
| Cabane de Tracuit | `cabane-de-tracuit-cas-2147000273/mountain-hiking/` | 3256m hut, Bishorn base |
| Aletsch Panorama | `bettmerhorn-166/mountain-hiking/traverse-eggishorn-bettmerhorn-4255/` | T4 ridge traverse, Eggishorn–Bettmeralp |
| Europaweg | `europahuette-2147000092/mountain-hiking/von-randa-4088/` | Randa–Europahütte approach only (full Grächen–Zermatt traverse not available as single SAC route) |
| Zindlenspitz | `zindlenspitz-2260/mountain-hiking/bruennelistock-rossaelplispitz-and-zindlenspitz-4567/` | Multi-summit traverse |
| Piz Beverin | `piz-beverin-1019/mountain-hiking/` (route ID 5374) | |
| Planurahütte | `planurahuette-cas-2147000180/mountain-hiking/` (route ID 370) | |
| Rigi Kulm | `rigi-kulm-2147436173/mountain-hiking/` (route ID 907) | |
| Risetenstock | `risetenstock-2147000236/mountain-hiking/` (route ID 4347) | |
| Wiggis | `wiggis-3157/mountain-hiking/` (route ID 5353) | |
| Wissigstock | `wissigstock-2147000269/mountain-hiking/` (route ID 3840) | |
| Vorder Glärnisch | `vorder-glaernisch-2147000245/mountain-hiking/` (route ID 1369) | |
| Geltenhütte | `geltenhuette-cas-2147000094/mountain-hiking/` (route ID 418) | |

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
