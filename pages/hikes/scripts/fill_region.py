"""Fill index_card.region for hikes whose region is TODO.

Looks up the BAFU biogeographical region for each peak via the SwissTopo
Identify API (same data source fetch_geodata.py uses to build
regions.geojson) and writes the English sub-region name back into
routes/<slug>/<slug>.data.json.

Usage:
    python scripts/fill_region.py                # patch every TODO
    python scripts/fill_region.py --slug pizol   # patch one hike
    python scripts/fill_region.py --dry-run      # report without writing
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ROUTES_DIR = REPO_ROOT / "routes"

sys.path.insert(0, str(REPO_ROOT / "scripts"))
from fetch_geodata import UNTERREGION_DE_TO_EN

IDENTIFY_URL = (
    "https://api3.geo.admin.ch/rest/services/api/MapServer/identify"
    "?geometryType=esriGeometryPoint"
    "&geometry={lon},{lat}"
    "&tolerance=0"
    "&layers=all:ch.bafu.biogeographische_regionen"
    "&sr=4326"
    "&returnGeometry=false"
)


def lookup_region(lat: float, lon: float) -> str | None:
    url = IDENTIFY_URL.format(lon=lon, lat=lat)
    with urllib.request.urlopen(url, timeout=15) as resp:
        data = json.loads(resp.read())
    for r in data.get("results", []):
        attrs = r.get("attributes") or r.get("properties") or {}
        de = attrs.get("unterregionname_de")
        if de:
            return UNTERREGION_DE_TO_EN.get(de, de)
    return None


def iter_hikes(slug_filter: str | None):
    for d in sorted(ROUTES_DIR.iterdir()):
        if not d.is_dir() or d.name.startswith("_"):
            continue
        if slug_filter and d.name != slug_filter:
            continue
        f = d / f"{d.name}.data.json"
        if f.exists():
            yield d.name, f


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--slug", help="Only patch this hike (default: all TODO)")
    p.add_argument("--dry-run", action="store_true", help="Show what would change without writing")
    p.add_argument("--force", action="store_true", help="Overwrite even non-TODO regions")
    args = p.parse_args(argv)

    patched = skipped = failed = 0
    for slug, f in iter_hikes(args.slug):
        data = json.loads(f.read_text(encoding="utf-8"))
        ic = data.get("index_card") or {}
        current = ic.get("region", "")
        if current and current != "TODO" and not args.force:
            skipped += 1
            continue
        peak = data.get("peak") or {}
        lat, lon = peak.get("lat"), peak.get("lon")
        if lat is None or lon is None:
            print(f"  {slug}: no peak coords, skipping", file=sys.stderr)
            failed += 1
            continue
        try:
            region = lookup_region(lat, lon)
        except Exception as e:
            print(f"  {slug}: lookup failed: {e}", file=sys.stderr)
            failed += 1
            continue
        if not region:
            print(f"  {slug}: no region matched at ({lat},{lon})", file=sys.stderr)
            failed += 1
            continue
        print(f"  {slug:30s} {current!r:8s} -> {region!r}")
        if args.dry_run:
            continue
        ic["region"] = region
        data["index_card"] = ic
        f.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        patched += 1

    print(f"\n[fill_region] patched={patched} skipped={skipped} failed={failed}"
          + (" (dry-run)" if args.dry_run else ""))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
