#!/usr/bin/env python3
"""Build /opt/code/hikes/santis.html by transforming the Zindlenspitz template.

Reads the template (already copied to santis.html), rewrites Zindlenspitz-specific
fields with Säntis content, and replaces the TRACK array with the routed GPX.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import date

HTML_PATH = "/opt/code/hikes/santis.html"
GPX_PATH = "/opt/code/hikes/santis.gpx"
TODAY = "2026-05-08"


def read_gpx_track(path: str):
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    tree = ET.parse(path)
    root = tree.getroot()
    track = []
    for tp in root.iter(f"{{{ns['g']}}}trkpt"):
        ele = tp.find(f"{{{ns['g']}}}ele")
        track.append((
            float(tp.get("lat")),
            float(tp.get("lon")),
            float(ele.text) if ele is not None else None,
        ))
    return track


def fmt_track(track):
    """Format as '[lat,lon,ele]' lines for the JS TRACK constant."""
    lines = []
    for lat, lon, ele in track:
        if ele is None:
            lines.append(f"    [{lat:.6f},{lon:.6f},null],")
        else:
            lines.append(f"    [{lat:.6f},{lon:.6f},{int(round(ele))}],")
    return "\n".join(lines)


def main():
    track = read_gpx_track(GPX_PATH)
    print(f"loaded {len(track)} trackpoints")

    with open(HTML_PATH) as f:
        html = f.read()

    # ----- Per-hike JS constants block --------------------------------------
    new_js_constants = """  // ---- Per-hike data (swap these for a new hike) ----
  const SUMMIT          = { lat: 47.2494, lon: 9.3433, elev: 2502, name: "Säntis" };
  const TRAILHEAD       = { lat: 47.2856, lon: 9.4286, name: "Wasserauen" };
  const TRANSIT_DEST    = "Wasserauen, Switzerland";
  const HIKR_INDEX_URL  = "https://www.hikr.org/dir/Saentis_55798/";
  const GPX_FILENAME    = "santis.gpx";
  const REPORTS_UPDATED = "2026-05-08";
  const PAGE_GENERATED  = "2026-05-08";
  const WEBCAMS = [
    {
      url: "https://www.foto-webcam.eu/webcam/wildhaus/current/1200.jpg",
      label: "Wildhaus / Gamserrugg — direct view toward Säntis and Schafberg from the south-east.",
      fallback: false
    },
    {
      url: "https://www.foto-webcam.eu/webcam/hoherkasten/current/1200.jpg",
      label: "Hoher Kasten — eastern Alpstein, view across to Säntis and the Rheintal.",
      fallback: false
    },
    {
      url: "https://www.meteoblue.com/en/weather/webcams/saentis_switzerland",
      label: "Meteoblue webcams near Säntis (link only — Meteoblue blocks iframe embedding). Roundshot Säntis is also useful for summit conditions.",
      fallback: true
    }
  ];"""

    # Find and replace the existing constants block
    old_js_re = re.compile(
        r"  // ---- Per-hike data \(swap these for a new hike\) ----\n.*?  \];",
        re.DOTALL,
    )
    html = old_js_re.sub(new_js_constants, html, count=1)

    # ----- WAYPOINTS array --------------------------------------------------
    new_wpts = """  const WAYPOINTS = [
    [47.2856, 9.4286, "Wasserauen (868 m)", "start"],
    [47.2671, 9.4090, "Seealpsee (1141 m)", "way"],
    [47.2559, 9.3855, "Meglisalp (1517 m)", "way"],
    [47.2494, 9.3433, "Säntis (2502 m)", "summit"],
    [47.2561, 9.3193, "Schwägalp (1352 m)", "way"],
  ];"""
    html = re.sub(
        r"  const WAYPOINTS = \[\n.*?  \];",
        new_wpts,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- TRACK array ------------------------------------------------------
    track_block = (
        f"  // Inlined from santis.gpx ({len(track)} trackpoints, OSM/Overpass routed)\n"
        f"  // © OpenStreetMap contributors (ODbL); elevations © swisstopo\n"
        f"  const TRACK = [\n"
        f"{fmt_track(track)}\n"
        f"  ];"
    )
    html = re.sub(
        r"  // Inlined from zindlenspitz\.gpx.*?  \];",
        lambda m: track_block,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- HTML title -------------------------------------------------------
    html = html.replace(
        "<title>Zindlenspitz (2097 m) — Hike Plan</title>",
        "<title>Säntis (2502 m) — Hike Plan</title>",
    )

    # ----- Hero background image -------------------------------------------
    html = html.replace(
        "background: url('https://commons.wikimedia.org/wiki/Special:FilePath/Zindlenspitz01.jpg?width=1600') center/cover;",
        "background: url('https://commons.wikimedia.org/wiki/Special:FilePath/Schw%C3%A4galp-S%C3%A4ntis_-_panoramio_(10).jpg?width=1600') center/cover;",
    )

    # ----- Hero h1 + subtitle ----------------------------------------------
    html = html.replace(
        '<h1>Zindlenspitz <span style="font-weight:400; opacity:.85;">2097 m</span></h1>\n    <p>Standard route from Innerthal — <span class="pill t3">SAC T3</span> · ~1200 m gain · ~9.5 km one-way · ~6 h round-trip</p>',
        '<h1>Säntis <span style="font-weight:400; opacity:.85;">2502 m</span></h1>\n    <p>Wasserauen → Lisengrat → Schwägalp traverse — <span class="pill t5">SAC T4</span> · ~1900 m gain · ~14.8 km · 2-day with hut overnight</p>',
    )

    # ----- Cable-car closure callout (insert right after hero) -------------
    closure_banner = """
<section style="margin-top: 1.5rem;">
  <blockquote style="border-left-color: #c41e1e; background: #fff4f4;">
    <strong>⚠ 2026 cable-car closure.</strong> The Säntis-Schwebebahn (Schwägalp ↔ Säntis)
    is shut for the entire 2026 summer for a full renewal of the lift. The popular
    "hike up, ride down" day-trip is <strong>not viable in 2026</strong>. This page is
    therefore planned as a <strong>2-day traverse</strong> with overnight at
    Berggasthaus Meglisalp, descending on foot to Schwägalp on day 2 (then PostBus to
    Urnäsch / Herisau / Gossau).
    Verify status before going at
    <a href="https://saentisbahn.ch/" target="_blank" rel="noopener">saentisbahn.ch</a>.
  </blockquote>
</section>
"""
    # Insert just after the opening of <main>
    html = html.replace("<main>\n\n", "<main>\n" + closure_banner + "\n", 1)

    # ----- Opening blockquote (replaces the "Zindlenspitz is one of..." quote)
    new_quote = """  <blockquote>
    "From Wasserauen the trail rises gently to Seealpsee, climbs steadily through
    Meglisalp to the Rotsteinpass, and finishes along the Lisengrat — a narrow,
    cabled limestone ridge with breathtaking drops on both sides. The most rewarding
    way up Säntis."<br>
    — <em>Alpstein guidebook (paraphrased)</em>
  </blockquote>
  <p>
    The <strong>Lisengrat</strong> is the iconic ridge between Rotsteinpass and the Säntis
    summit — a continuously cabled traverse that defines the SAC <strong>T4</strong> grade
    of this route. The moves themselves are reasonable when dry; the grade comes from the
    exposure. After rain or snowfall the ridge becomes "quickly precarious."
  </p>"""
    html = re.sub(
        r"  <blockquote>\s+\"Zindlenspitz is one of.*?</p>",
        new_quote,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Quick Facts table -----------------------------------------------
    new_quick_facts = """    <tr><th>Summit elevation</th><td><strong>2502 m</strong> (2501.9 m on official cadastre)</td></tr>
    <tr><th>Range</th><td>Alpstein subrange of the Appenzell Alps</td></tr>
    <tr><th>Cantons (tri-canton point)</th><td>Appenzell Ausserrhoden / Appenzell Innerrhoden / St. Gallen</td></tr>
    <tr><th>Valleys</th><td><strong>Schwendetal</strong> (E, Wasserauen 868 m) / <strong>Schwägalp</strong> (NW, 1352 m) / <strong>Toggenburg</strong> (S, Wildhaus)</td></tr>
    <tr><th>Prominence</th><td><strong>2015 m</strong> — 13th most prominent peak in the Alps</td></tr>
    <tr><th>Dominance</th><td>25.78 km → Magerrain</td></tr>
    <tr><th>Coordinates</th><td>47°14′58″ N, 9°20′36″ E (CH1903 744178 / 234920)</td></tr>
    <tr><th>Activity</th><td>Alpine hiking (Bergwandern, with cabled ridge)</td></tr>
    <tr><th>Standard SAC grade</th><td><span class="pill t5">T4</span> Lisengrat ridge — exposed, secured</td></tr>
    <tr><th>Distance</th><td>14.8 km point-to-point (Wasserauen → Säntis → Schwägalp)</td></tr>
    <tr><th>Total ascent / descent</th><td>~1900 m gain · ~1250 m descent</td></tr>
    <tr><th>Format</th><td>2-day with overnight at Berggasthaus Meglisalp (1517 m)</td></tr>
    <tr><th>Nearest village</th><td>Schwende-Rüte / Wasserauen (Appenzell Innerrhoden)</td></tr>"""
    html = re.sub(
        r"    <tr><th>Summit elevation</th><td><strong>2097 m</strong></td></tr>.*?<tr><th>Nearest village</th><td>Innerthal \(Wägital, SZ\)</td></tr>",
        new_quick_facts,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Photos -----------------------------------------------------------
    new_photos = """  <div class="photo-grid">
    <figure>
      <a href="#lightbox-1"><img src="https://commons.wikimedia.org/wiki/Special:FilePath/Blick_vom_S%C3%A4ntis_ins_Alpsteinmassiv_Richtung_Appenzell_und_Bodensee.jpg?width=600" alt="View from Säntis summit toward the Alpstein, Appenzell, and Bodensee"></a>
      <figcaption>Summit panorama south-east into the Alpstein toward Appenzell and the Bodensee.</figcaption>
    </figure>
    <figure>
      <a href="#lightbox-2"><img src="https://commons.wikimedia.org/wiki/Special:FilePath/Schw%C3%A4galp-S%C3%A4ntis_-_panoramio_(10).jpg?width=600" alt="Säntis north face from Schwägalp"></a>
      <figcaption>Säntis north face seen from the Schwägalp pass — the cable-car side.</figcaption>
    </figure>
    <figure>
      <a href="#lightbox-3"><img src="https://commons.wikimedia.org/wiki/Special:FilePath/LisengratPanorama02.jpg?width=600" alt="Lisengrat ridge between Rotsteinpass and Säntis"></a>
      <figcaption>Panorama along the Lisengrat ridge — cabled limestone crest, the route's defining T4 section.</figcaption>
    </figure>
    <figure>
      <a href="#lightbox-4"><img src="https://commons.wikimedia.org/wiki/Special:FilePath/Seealpsee_and_S%C3%A4ntis.jpg?width=600" alt="Seealpsee with Säntis behind"></a>
      <figcaption>Seealpsee on the Wasserauen approach, with the Säntis massif rising behind.</figcaption>
    </figure>
  </div>
  <a class="lightbox" id="lightbox-1" href="#"><img src="https://commons.wikimedia.org/wiki/Special:FilePath/Blick_vom_S%C3%A4ntis_ins_Alpsteinmassiv_Richtung_Appenzell_und_Bodensee.jpg?width=1600" alt=""></a>
  <a class="lightbox" id="lightbox-2" href="#"><img src="https://commons.wikimedia.org/wiki/Special:FilePath/Schw%C3%A4galp-S%C3%A4ntis_-_panoramio_(10).jpg?width=1600" alt=""></a>
  <a class="lightbox" id="lightbox-3" href="#"><img src="https://commons.wikimedia.org/wiki/Special:FilePath/LisengratPanorama02.jpg?width=1600" alt=""></a>
  <a class="lightbox" id="lightbox-4" href="#"><img src="https://commons.wikimedia.org/wiki/Special:FilePath/Seealpsee_and_S%C3%A4ntis.jpg?width=1600" alt=""></a>
  <p class="attrib">All photos: Wikimedia Commons (CC BY-SA / public domain — see file pages).</p>"""
    html = re.sub(
        r"  <div class=\"photo-grid\">\s+<figure>\s+<a href=\"#lightbox-1\"><img src=\"https://commons\.wikimedia\.org/wiki/Special:FilePath/Zindlenspitz.*?Wikimedia Commons \(CC BY-SA / public domain — see file pages\)\.</p>",
        new_photos,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Map legend ------------------------------------------------------
    html = html.replace(
        '<span class="start">Start (Innerthal)</span>\n    <span class="summit">Summit (Zindlenspitz)</span>',
        '<span class="start">Start (Wasserauen)</span>\n    <span class="summit">Summit (Säntis)</span>',
    )

    # ----- Routes section --------------------------------------------------
    new_routes = """  <h2>Routes</h2>
  <h3>1. Wasserauen → Lisengrat → Säntis (planned route) <span class="pill t5">T4</span></h3>
  <ul>
    <li><strong>Day 1 — Wasserauen to Meglisalp</strong> (~1.5–2 h, ~650 m gain). Train terminus
        Wasserauen (868 m) → Seealpsee (1141 m, lakeshore) → Meglisalp (1517 m, historic alp/inn).
        Easy T2 hiking. Overnight at <a href="https://meglisalp.ch/" target="_blank" rel="noopener">Berggasthaus Meglisalp</a>.</li>
    <li><strong>Day 2 — Meglisalp to Säntis to Schwägalp</strong> (~7–8 h moving, ~1000 m gain
        + 1150 m descent). Meglisalp → Rotsteinpass (2120 m, ~2.5 h, T2/T3) → Lisengrat
        ridge → Säntis summit (2502 m, ~1 h on the ridge). Descend on foot via the north
        flank (Tierwies / Wagenlücke) to Schwägalp (1352 m, ~2.5–3 h, T3).</li>
    <li><strong>Lisengrat:</strong> ~1.5–2 km cabled ridge, T4 / via-ferrata grade A. Steel cables
        and pegs in exposed sections. Big drops on both sides. ~50 min – 1.5 h depending on
        traffic and conditions. <strong>Quickly precarious when wet or snowy.</strong></li>
  </ul>
  <h3>2. Schwägalp → Säntis (cable-car-down day-trip) <span class="pill t3">T3</span> — not 2026</h3>
  <ul>
    <li>Schwägalp (1352 m) → Tierwies → Wagenlücke → Säntis summit. ~3.5–4.5 h, ~1150 m gain.
        Standard "tourist hike" up the north flank.</li>
    <li>Normally finished with the Schwebebahn down to Schwägalp. <strong>Not available in
        2026 — cable car closed for renewal.</strong></li>
  </ul>
  <h3>3. Lisengrat-only via-ferrata loop <span class="pill t5">T4</span></h3>
  <ul>
    <li>Cable car up to Säntis (when running) → Lisengrat → Rotsteinpass → cable car back via
        Schwägalp. The fastest taste of the ridge if you don't want a long approach.</li>
  </ul>"""
    html = re.sub(
        r"  <h2>Routes \(from the SAC Route Portal\)</h2>.*?</ul>(?=\s*</section>)",
        new_routes,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Getting There + Day Plan grid -----------------------------------
    new_grid_2_first = """  <section>
    <h2>Getting There</h2>
    <h3>By car</h3>
    <p>Drive to Wasserauen (Schwende-Rüte, AI). Pay parking at the train terminus.
       <strong>Car-shuttle problem:</strong> the route ends at Schwägalp, ~25 km away by road —
       leave one car at Schwägalp or rely on the PostBus from Schwägalp to Urnäsch/Gossau
       and the train back.</p>
    <h3>By public transport (recommended for point-to-point)</h3>
    <ul>
      <li>Train: Zürich HB → Gossau SG → Appenzell → <strong>Wasserauen</strong> (≈2 h end-to-end).</li>
      <li>Day 2 finish: Schwägalp → PostBus 791 to Urnäsch → train Urnäsch → Gossau → Zürich
          (≈2.5 h end-to-end).</li>
      <li>Plan via <a href="https://www.sbb.ch/en" target="_blank">sbb.ch</a> — point-to-point
          works seamlessly on the SBB-PostBus combined ticket.</li>
    </ul>
  </section>"""
    new_grid_2_second = """  <section>
    <h2>Day Plan (T4 traverse, 2 days)</h2>
    <h3>Day 1 — Wasserauen to Meglisalp</h3>
    <table>
      <tr><th>Time</th><th>Step</th></tr>
      <tr><td>~12:00</td><td>Train Zürich HB → Wasserauen (arrives ~13:50)</td></tr>
      <tr><td>~14:00</td><td>Start hiking at Wasserauen (868 m)</td></tr>
      <tr><td>~15:00</td><td>Seealpsee (1141 m) — short break, lake views</td></tr>
      <tr><td>~16:30</td><td>Berggasthaus Meglisalp (1517 m) — overnight, dinner</td></tr>
    </table>
    <h3>Day 2 — Meglisalp to Säntis to Schwägalp</h3>
    <table>
      <tr><th>Time</th><th>Step</th></tr>
      <tr><td>~06:30</td><td>Breakfast at Meglisalp; depart ~07:00</td></tr>
      <tr><td>~09:30</td><td>Rotsteinpass (2120 m) — Lisengrat begins</td></tr>
      <tr><td>~10:30–11:30</td><td>Säntis summit (2502 m) — Lisengrat ~1 h on the ridge</td></tr>
      <tr><td>~12:00–12:30</td><td>Summit break; weather check; restaurant if open</td></tr>
      <tr><td>~15:00–15:30</td><td>Schwägalp (1352 m) — descent ~2.5–3 h via Tierwies</td></tr>
      <tr><td>~16:00</td><td>PostBus 791 to Urnäsch; train back to Zürich</td></tr>
    </table>
    <p><strong>Earlier start essential</strong> if afternoon storms are forecast — the Lisengrat
       is a fully exposed ridge and lightning is the dominant hazard on the day.</p>
  </section>"""
    # Replace the entire grid-2 block (Getting There + Day Plan)
    html = re.sub(
        r"  <section>\s+<h2>Getting There</h2>.*?<p>Earlier start if combining with the trilogy or if afternoon storms are forecast\.</p>\s+</section>",
        new_grid_2_first + "\n\n" + new_grid_2_second,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Weather: lapse-rate + sources ----------------------------------
    html = html.replace(
        "Forecast modeled at 2097 m (summit coordinates) via",
        "Forecast modeled at 2502 m (summit coordinates) via",
    )
    html = html.replace(
        "Temps are summit-level; valley will be ~11 °C warmer.",
        "Temps are summit-level; the valley (Wasserauen 868 m) will be ~10 °C warmer.",
    )
    new_lapse = """  <h3>Lapse-rate temperature estimate</h3>
  <p>Mountain temperature drops about <strong>6.5 °C per 1000 m</strong>.</p>
  <ul>
    <li><strong>Valley reference:</strong> Appenzell / Wasserauen, ~870 m.</li>
    <li><strong>Summit:</strong> 2502 m → ~1630 m above the reference → subtract ~<strong>11 °C</strong>.</li>
    <li>Example: valley forecast 12–22 °C → summit ≈ <strong>+1 °C to +11 °C</strong>.</li>
    <li>Pack for the cold end: hat, gloves, windproof, insulating layer.
        Säntis weather station has set Swiss low-temperature records — wind chill is real here.</li>
  </ul>
  <h3>Sources to check</h3>
  <ul>
    <li><a href="https://www.meteoswiss.admin.ch/" target="_blank">MeteoSwiss</a> — most accurate Swiss forecast (use Schwende or Wasserauen point).</li>
    <li><a href="https://www.meteoblue.com/en/weather/week/saentis_switzerland" target="_blank">Meteoblue Säntis</a> — forecast + nearby webcams.</li>
    <li>Säntis hosts an official MeteoSwiss summit weather station — its live readings are public on the MeteoSwiss site.</li>
    <li>Thunderstorms in the forecast → <strong>postpone or cancel.</strong> The Lisengrat is a fully exposed knife-edge ridge; lightning + wet rock = unsurvivable.</li>
  </ul>"""
    html = re.sub(
        r"  <h3>Lapse-rate temperature estimate</h3>.*?Wägital is steep limestone; lightning \+ wet rock = bad\.</li>\s+</ul>",
        new_lapse,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Snow / season ---------------------------------------------------
    html = html.replace(
        "<p><strong>Summer hike only.</strong> Best window: late June to mid-October, depending on snow.</p>",
        "<p><strong>Summer hike only.</strong> Best window: <strong>July to early October</strong> for snow-free, dry Lisengrat conditions. Snow can linger on the ridge into early summer; the cabled sections become serious in any snow or ice.</p>",
    )

    # ----- Elevation Profile attribution -----------------------------------
    html = html.replace(
        f'Computed from the inlined GPX track (1078 points, OSM-routed via Dijkstra; elevations from Open-Elevation / SRTM).',
        f'Computed from the inlined GPX track ({len(track)} points, OSM/Overpass routed via Dijkstra; elevations from SwissTopo Height API).',
    )

    # ----- Trip Reports (key takeaways + 3 cards) --------------------------
    new_takeaways = """  <h3>Key takeaways</h3>
  <div class="trip-takeaways">
    <ul>
      <li><strong>Lisengrat is rock-solid when dry</strong> — the cabled sections feel reasonable in T4 terms; it's the exposure (500 m+ drops on both sides), not the moves, that defines the grade.</li>
      <li><strong>Wet rock changes everything</strong> — multiple reports flag the ridge as <em>"quickly precarious"</em> after rain or snow. Cabled holds become slippery; bypass on a marginal weather day.</li>
      <li><strong>Crowds are real</strong> mid-summer; the Säntis summit is a tourist hub (restaurant, weather station) and the Lisengrat cables back up with traffic on weekends. Start early or pick a weekday.</li>
      <li><strong>Optimal window: July to early October</strong> for snow-free, dry conditions on the ridge. Late November is occasionally usable if conditions are unusually dry.</li>
    </ul>
  </div>"""
    html = re.sub(
        r"  <h3>Key takeaways</h3>\s+<div class=\"trip-takeaways\">.*?</div>",
        new_takeaways,
        html,
        count=1,
        flags=re.DOTALL,
    )

    new_reports = """  <h3>Recent reports</h3>
  <div class="trip-reports">
    <article class="trip-report">
      <header>
        <a href="https://www.hikr.org/tour/post190912.html" target="_blank" rel="noopener">Schwägalp – Girenspitz – Säntis – Lisengrat – Rotsteinpass – Unterwasser</a>
        · <time>Nov 2024</time> · <span class="pill t5">T4</span>
      </header>
      <ul>
        <li>Late-autumn full traverse exploiting unusually good November weather.</li>
        <li>Companion stat (Bergfex): 17.8 km, 1243 m gain, 8 h 12 min.</li>
        <li>Continuous cabling on the ridge; route was dry — no specific snow notes.</li>
      </ul>
    </article>
    <article class="trip-report">
      <header>
        <a href="https://www.hikr.org/tour/post180561.html" target="_blank" rel="noopener">Lisengrat – Rotsteinpass – Meglisalp – Seealpsee: a rock & wildflower tour</a>
        · <time>Jul 2023</time> · <span class="pill t5">T3+/T4</span>
      </header>
      <ul>
        <li>Combined the ridge traverse with the wildflower-heavy descent through Meglisalp / Seealpsee.</li>
        <li>Used the Säntisbahn up; descended via the Wasserauen-side route — same ridge as our planned ascent.</li>
        <li>"Steel-cable secured throughout the ridge" — straightforward in dry conditions.</li>
      </ul>
    </article>
    <article class="trip-report">
      <header>
        <a href="https://www.hikr.org/tour/post27120.html" target="_blank" rel="noopener">Säntis über Lisengrat (Wildhaus → Schafboden → Rotsteinpass → Säntis)</a>
        · <time>summer</time> · <span class="pill t5">T4</span>
      </header>
      <ul>
        <li>South-side variant from Wildhaus / Toggenburg — different approach, same Lisengrat finish.</li>
        <li>"Well-secured" cabled path — author confirms the modern cabling has tamed historical T4+ moves.</li>
        <li>Useful comparison if you want a different Day 1 (Wildhaus → Schafboden hut overnight).</li>
      </ul>
    </article>
  </div>
  <p class="attrib">
    Trip reports © their respective authors on
    <a href="https://www.hikr.org/" target="_blank" rel="noopener">hikr.org</a>
    (search index: <a id="hikr-link" href="" target="_blank" rel="noopener">peak page</a>).
    Summaries condensed from web-search snippets — hikr.org blocks scripted fetchers, so verify against the linked reports before relying on conditions notes. Last updated <time id="reports-updated"></time>.
  </p>"""
    html = re.sub(
        r"  <h3>Recent reports</h3>\s+<div class=\"trip-reports\">.*?</p>\s*</section>",
        new_reports + "\n</section>",
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Gear Checklist (add via-ferrata items for the Lisengrat) --------
    new_gear = """  <section>
    <h2>Gear Checklist</h2>
    <h3>Mandatory</h3>
    <ul>
      <li>Sturdy hiking boots (B/B+, ankle support — the Lisengrat is rocky and exposed)</li>
      <li>2–3 L water + electrolytes (top up at Meglisalp Day 2 morning)</li>
      <li>Food + emergency snack (Meglisalp serves dinner + breakfast; pack lunch for Day 2)</li>
      <li>Sun: hat, sunglasses, SPF 30+ — exposure on the ridge is total</li>
      <li>Layers: base + insulating + windproof / rainproof shell</li>
      <li>Hat + gloves (Säntis weather station has held Swiss low-temp records)</li>
      <li>Headlamp (Day 2 may start before full daylight)</li>
      <li>Phone with offline SwissTopo map + GPX</li>
      <li>Small first-aid kit</li>
      <li>Cash / card for hut and PostBus</li>
      <li>Sleeping-bag liner (hut requirement at Meglisalp)</li>
    </ul>
    <h3>Recommended for the Lisengrat</h3>
    <ul>
      <li>Helmet — light alpine helmet for rockfall on the ridge in busy conditions</li>
      <li>Trekking poles (collapsible — strap to pack on the cabled sections)</li>
      <li>Light gloves for grip on cold cables</li>
      <li>A short via-ferrata set is overkill for T4 / grade A but reasonable if you're nervous on exposure</li>
    </ul>
    <h3>Optional</h3>
    <ul>
      <li>Power bank</li>
      <li>Whistle</li>
      <li>Lightweight bivvy / emergency blanket</li>
    </ul>
  </section>"""
    html = re.sub(
        r"  <section>\s+<h2>Gear Checklist</h2>.*?<li>Significantly more time and an early start</li>\s+</ul>\s+</section>",
        new_gear,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Safety & Hazards ------------------------------------------------
    new_safety = """  <section>
    <h2>Safety &amp; Hazards</h2>
    <ul>
      <li><strong>Lisengrat exposure:</strong> 500 m+ drops on both sides; cabled but committing. Sure-footedness and head for heights mandatory.</li>
      <li><strong>Wet rock:</strong> the cabled sections become slippery fast. Postpone in or just after rain.</li>
      <li><strong>Thunderstorms:</strong> the ridge is a 1.5+ km fully exposed knife-edge. Lightning + steel cables + wet rock = unsurvivable. Watch the afternoon convection forecast and turn around at the first sign of buildup.</li>
      <li><strong>Snow / ice:</strong> shoulder-season snow patches on the north flank descent (Tierwies) can persist into July. If patches block the trail, do not bypass on steep grass.</li>
      <li><strong>Cattle:</strong> Meglisalp pastures host mother cows with calves — give space, no eye contact.</li>
      <li><strong>Phone reception:</strong> good on the summit (cell tower), patchy in Schwendetal. Download maps offline.</li>
      <li><strong>2026 cable-car closure:</strong> no descent option from the summit — you must walk to Schwägalp. If conditions deteriorate, the alternative is to retreat the way you came (Lisengrat → Rotsteinpass → Meglisalp / Seealpsee → Wasserauen).</li>
      <li><strong>Emergency:</strong> Rega <strong>1414</strong> or <strong>112</strong>. The Säntis summit has staff and a restaurant — useful safety net if conditions go bad.</li>
      <li>This is a <strong>summer route</strong>. Winter ascent involves serious avalanche terrain on the north flank and ice on the Lisengrat.</li>
    </ul>
  </section>"""
    html = re.sub(
        r"  <section>\s+<h2>Safety &amp; Hazards</h2>.*?Winter ascent involves avalanche terrain\.</li>\s+</ul>\s+</section>",
        new_safety,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Resources & Links ------------------------------------------------
    new_resources = """  <h2>Resources &amp; Links</h2>
  <ul>
    <li><a href="https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/?keywords=Säntis" target="_blank">SAC Route Portal — Säntis search</a></li>
    <li><a href="https://meglisalp.ch/" target="_blank">Berggasthaus Meglisalp — bookings &amp; menus</a> (Day 1 overnight)</li>
    <li><a href="https://www.berggasthaus-rotsteinpass.ch/" target="_blank">Berggasthaus Rotsteinpass</a> (alternative overnight at the foot of the Lisengrat)</li>
    <li><a href="https://saentisbahn.ch/" target="_blank">Säntis-Schwebebahn — closure status &amp; reopening</a> (closed 2026)</li>
    <li><a href="https://www.hikr.org/dir/Saentis_55798/" target="_blank">Trip reports &amp; photos (hikr.org, German)</a></li>
    <li><a href="https://de.wikipedia.org/wiki/Säntis" target="_blank">German Wikipedia — Säntis</a></li>
    <li><a href="https://map.geo.admin.ch/?lang=en&topic=ech&zoom=11&E=2744178&N=1234920&crosshair=marker&layers=ch.swisstopo.swisstlm3d-wanderwege" target="_blank">SwissTopo viewer (centered on summit)</a></li>
    <li><a href="https://www.meteoswiss.admin.ch/" target="_blank">MeteoSwiss</a> — official Säntis summit station readings</li>
    <li><a href="https://www.meteoblue.com/en/weather/week/saentis_switzerland" target="_blank">Meteoblue Säntis</a></li>
    <li><a href="https://www.sbb.ch/en" target="_blank">SBB timetable</a> (Wasserauen / Schwägalp PostBus)</li>
    <li>Swiss alpine rescue (Rega): <strong>1414</strong></li>
  </ul>"""
    html = re.sub(
        r"  <h2>Resources &amp; Links</h2>\s+<ul>.*?<li>Swiss alpine rescue \(Rega\): <strong>1414</strong></li>\s+</ul>",
        new_resources,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Disclaimer ------------------------------------------------------
    new_disclaimer = """  <h2>Disclaimer</h2>
  <p>
    Compiled from the SAC Route Portal, German Wikipedia, hikr.org references, and
    direct probing of foto-webcam.eu / saentisbahn.ch. <strong>Not professional
    mountain-safety advice.</strong> Conditions in the Alps change rapidly. Always
    re-check MeteoSwiss, the SAC situation warnings, the Säntis-Schwebebahn closure
    status, and any trail closures before setting out. The Lisengrat is a real T4
    objective — if you're unsure on exposure, hire a guide or pick the Schwägalp-side
    T3 ascent (when the cable car is running again).
  </p>"""
    html = re.sub(
        r"  <h2>Disclaimer</h2>\s+<p>.*?go with someone experienced\s+or hire a guide\.\s+</p>",
        new_disclaimer,
        html,
        count=1,
        flags=re.DOTALL,
    )

    # ----- Map fallback filename ------------------------------------------
    html = html.replace(
        "Open <code>zindlenspitz.html</code>",
        "Open <code>santis.html</code>",
    )

    with open(HTML_PATH, "w") as f:
        f.write(html)

    # quick sanity checks
    leftover = []
    for marker in ("Zindlenspitz", "Innerthal", "Wägital", "1078 points"):
        if marker in html:
            count = html.count(marker)
            leftover.append(f"{marker}: {count}")
    if leftover:
        print("WARNING: leftover Zindlenspitz refs:", leftover)
    else:
        print("clean: no Zindlenspitz references remain")

    print(f"wrote {HTML_PATH} ({len(html):,} bytes)")


if __name__ == "__main__":
    main()
