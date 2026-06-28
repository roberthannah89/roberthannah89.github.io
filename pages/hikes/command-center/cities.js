// Major Swiss cities — reference points to sanity-check the forecast cache
// against MeteoSwiss / Google for a known location. Not hikes. Their lat/lon
// are baked into weather-cache.js by fetch_weather.py (which reads this same
// file via load_cities()), so they share the WEATHER_CACHE lookup path used
// by peaks.
//
// Coverage spans cantons + elevations so a glance can verify forecast
// behaviour across regimes: lowland lakeshore (ZH/GE/LU), valley (Sion/Chur),
// south of the Alps (Lugano), and alpine resorts (Zermatt/Davos/St. Moritz/
// Andermatt). Altitudes are approximate city-centre values.
//
// The array below MUST stay strict-JSON (double-quoted keys + strings) — the
// load_cities() helper in fetch_weather.py parses it with json.loads.
window.CITIES = [
  {"name": "Zürich",      "lat": 47.377, "lon": 8.541, "alt": 408},
  {"name": "Geneva",      "lat": 46.204, "lon": 6.143, "alt": 375},
  {"name": "Bern",        "lat": 46.948, "lon": 7.447, "alt": 540},
  {"name": "Lucerne",     "lat": 47.050, "lon": 8.309, "alt": 436},
  {"name": "Lugano",      "lat": 46.004, "lon": 8.951, "alt": 273},
  {"name": "Sion",        "lat": 46.233, "lon": 7.361, "alt": 512},
  {"name": "Chur",        "lat": 46.850, "lon": 9.532, "alt": 593},
  {"name": "Interlaken",  "lat": 46.686, "lon": 7.863, "alt": 568},
  {"name": "Andermatt",   "lat": 46.636, "lon": 8.593, "alt": 1437},
  {"name": "Davos",       "lat": 46.803, "lon": 9.837, "alt": 1560},
  {"name": "Zermatt",     "lat": 46.021, "lon": 7.749, "alt": 1606},
  {"name": "St. Moritz",  "lat": 46.498, "lon": 9.840, "alt": 1822}
];
