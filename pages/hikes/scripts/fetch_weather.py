#!/usr/bin/env python3
"""Fetch Open-Meteo forecasts for all SAC peaks and write templates/_assets/hike_map/weather-cache.js."""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

HIKES_ROOT = Path(__file__).resolve().parent.parent
SAC_ROUTES_JS = HIKES_ROOT / "guides" / "sac-routes.js"
CITIES_JS = HIKES_ROOT / "command-center" / "cities.js"
OUTPUT = HIKES_ROOT / "templates" / "_assets" / "hike_map" / "weather-cache.js"

BATCH_SIZE = 40
DELAY_BETWEEN = 2.0
MAX_RETRIES = 3
FORECAST_DAYS = 5

BASE_URL = "https://api.open-meteo.com/v1/forecast"
DAILY_PARAMS = "weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,sunrise,sunset"
# freezing_level_height is only exposed as an hourly variable by Open-Meteo
# (no daily aggregate exists). Fetch it hourly and roll up to a daily max
# below — the worst-case (highest) freezing level during the day is the right
# number for "will the peak be in snow?" since it's a conservative threshold.
HOURLY_PARAMS = "freezing_level_height"
# MeteoSwiss ICON-CH2 — 2km grid, 5-day forecast horizon, alpine-tuned.
# (ICON-CH1 is 1km but only 33h horizon, too short for multi-day filtering.)
# Open-Meteo serves MeteoSwiss's own model output via a clean API.
MODEL = "meteoswiss_icon_ch2"


def load_sac_routes():
    text = SAC_ROUTES_JS.read_text(encoding="utf-8")
    json_str = text.split("=", 1)[1].strip().rstrip(";")
    return json.loads(json_str)


def load_cities():
    """Read window.CITIES from cities.js so the city list has a single source
    of truth shared with the client. Same JSON-after-`=` shape as sac-routes.js."""
    if not CITIES_JS.exists():
        return []
    text = CITIES_JS.read_text(encoding="utf-8")
    # Strip JS line comments before the assignment so they don't confuse the
    # naive `split("=", 1)` parser used by load_sac_routes.
    after_eq = text.split("window.CITIES", 1)[1]
    json_str = after_eq.split("=", 1)[1].strip().rstrip(";")
    return json.loads(json_str)


def unique_peaks(routes):
    seen = {}
    peaks = []
    for poi in routes:
        lat, lon = poi.get("lat"), poi.get("lon")
        if not lat or not lon:
            continue
        key = f"{lat:.3f},{lon:.3f}"
        if key in seen:
            continue
        seen[key] = True
        peaks.append({"lat": lat, "lon": lon, "alt": poi.get("alt", 0)})
    return peaks


def fetch_batch(peaks):
    lats = ",".join(f"{p['lat']:.4f}" for p in peaks)
    lons = ",".join(f"{p['lon']:.4f}" for p in peaks)

    params = urllib.parse.urlencode({
        "latitude": lats,
        "longitude": lons,
        "daily": DAILY_PARAMS,
        "hourly": HOURLY_PARAMS,
        "timezone": "Europe/Zurich",
        "forecast_days": FORECAST_DAYS,
        "models": MODEL,
    })
    url = f"{BASE_URL}?{params}"

    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
                return data if isinstance(data, list) else [data]
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 429:
                wait = DELAY_BETWEEN * (2 ** (attempt + 1))
                print(f"  Rate limited, waiting {wait:.0f}s...")
                time.sleep(wait)
            else:
                raise
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            wait = DELAY_BETWEEN * (2 ** attempt)
            print(f"  Network error ({e}), waiting {wait:.0f}s before retry {attempt + 2}/{MAX_RETRIES}...")
            time.sleep(wait)
    print(f"  WARNING: batch failed after {MAX_RETRIES} retries ({last_err})")
    return None


def daily_freezing_level_max(daily_dates, hourly_times, hourly_values):
    """Roll hourly freezing_level_height up to one max value per forecast day.

    daily_dates  — list of YYYY-MM-DD strings (the daily.time array)
    hourly_times — list of YYYY-MM-DDTHH:MM strings
    hourly_values — list of metres (None for missing samples)

    Returns a list of ints (metres) aligned to daily_dates, with None where
    the day has no usable samples. Returns None if hourly data is missing
    entirely so the caller knows to skip the field.
    """
    if not daily_dates or not hourly_times or not hourly_values:
        return None
    by_day: dict[str, float] = {}
    for t, v in zip(hourly_times, hourly_values, strict=False):
        if v is None or not t:
            continue
        day = t.split("T", 1)[0]
        prev = by_day.get(day)
        if prev is None or v > prev:
            by_day[day] = v
    out: list[int | None] = []
    for day in daily_dates:
        val = by_day.get(day)
        out.append(int(round(val)) if val is not None else None)
    # Treat "every day is None" as "no data" so the field is dropped entirely.
    if all(x is None for x in out):
        return None
    return out


def main():
    routes = load_sac_routes()
    peaks = unique_peaks(routes)
    print(f"Found {len(peaks)} unique peaks from {len(routes)} SAC routes")

    # Reference cities — same cache, same lat/lon keying. Lets the client
    # render city weather pills using WeatherService.getForPeak unchanged.
    cities = load_cities()
    seen = {f"{p['lat']:.3f},{p['lon']:.3f}" for p in peaks}
    for c in cities:
        key = f"{c['lat']:.3f},{c['lon']:.3f}"
        if key in seen:
            continue
        seen.add(key)
        peaks.append({"lat": c["lat"], "lon": c["lon"], "alt": c.get("alt", 0)})
    if cities:
        print(f"  + {len(cities)} reference cities → {len(peaks)} total coordinates")

    cache = {}
    batches = [peaks[i:i + BATCH_SIZE] for i in range(0, len(peaks), BATCH_SIZE)]

    for idx, batch in enumerate(batches):
        print(f"  Batch {idx + 1}/{len(batches)} ({len(batch)} peaks)...")
        results = fetch_batch(batch)
        if results:
            for i, loc in enumerate(results):
                peak = batch[i]
                key = f"{peak['lat']:.3f},{peak['lon']:.3f}"
                daily = loc.get("daily") or {}
                # Roll up the hourly freezing_level_height series into a per-day
                # max so it aligns with the existing daily.time array and the
                # Day filter. Stored as integers (metres) to keep the cache
                # compact. Missing data → None per day (skipped client-side).
                hourly = loc.get("hourly") or {}
                fl_daily = daily_freezing_level_max(
                    daily.get("time") or [],
                    hourly.get("time") or [],
                    hourly.get("freezing_level_height") or [],
                )
                if fl_daily is not None:
                    daily["freezing_level_max"] = fl_daily
                cache[key] = {
                    "elevation": loc.get("elevation"),
                    "daily": daily,
                }
        if idx < len(batches) - 1:
            time.sleep(DELAY_BETWEEN)

    print(f"Cached weather for {len(cache)} peaks")

    iso_now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    # schema=2 adds daily.freezing_level_max (rolled up from hourly freezing_level_height).
    meta_json = json.dumps(
        {"updated": iso_now, "model": MODEL, "peaks": len(cache), "schema": 2},
        separators=(',', ':'),
    )
    js = f"// Auto-generated by fetch_weather.py — {time.strftime('%Y-%m-%d %H:%M')}\n"
    js += f"window.WEATHER_CACHE_META = {meta_json};\n"
    js += f"window.WEATHER_CACHE = {json.dumps(cache, separators=(',', ':'))};\n"
    OUTPUT.write_text(js, encoding="utf-8")
    size_kb = OUTPUT.stat().st_size / 1024
    print(f"Written to {OUTPUT} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
