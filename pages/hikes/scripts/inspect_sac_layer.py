"""Inspect a raw SAC v2 layer GeoJSON file.

Prints, for each route_id present in the file:
  - Number of features (split by alternative / style)
  - Per-feature: id, style, alternative, point count, LV95 endpoints, length

Usage
-----
    python scripts/inspect_sac_layer.py routes/<slug>/sac-layer-<id>.json
    python scripts/inspect_sac_layer.py routes/<slug>/sac-layer-<id>.json --route-id 4567
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path


def _length_lv95(coords: list[list[float]]) -> float:
    """Sum of LV95 segment lengths in metres."""
    total = 0.0
    for a, b in zip(coords, coords[1:]):
        total += ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
    return total


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("layer_path", type=Path)
    p.add_argument("--route-id", type=int,
                   help="Only show features for this route_id.")
    args = p.parse_args()

    layer = json.loads(args.layer_path.read_text(encoding="utf-8"))
    feats = layer.get("features", [])
    print(f"[layer] {args.layer_path.name}: {len(feats)} total features\n")

    by_route: dict[int, list[dict]] = defaultdict(list)
    for f in feats:
        rid = (f.get("properties") or {}).get("route_id")
        if rid is not None:
            by_route[rid].append(f)

    target_ids = [args.route_id] if args.route_id else sorted(by_route.keys())
    for rid in target_ids:
        rfs = by_route.get(rid, [])
        if not rfs:
            print(f"route_id={rid}: no features")
            continue
        alt = sum(1 for f in rfs if (f.get("properties") or {}).get("alternative"))
        dashed = sum(1 for f in rfs
                     if (f.get("properties") or {}).get("style") == "dashed")
        print(f"route_id={rid}: {len(rfs)} features "
              f"({alt} alternative, {dashed} dashed)")

        for f in rfs:
            props = f.get("properties") or {}
            coords = f.get("geometry", {}).get("coordinates", [])
            if not coords:
                print(f"  - id={props.get('id')} EMPTY")
                continue
            length = _length_lv95(coords)
            s, e = coords[0], coords[-1]
            print(f"  - id={props.get('id'):>7} "
                  f"style={props.get('style', '?'):>7} "
                  f"alt={str(bool(props.get('alternative'))):>5} "
                  f"pts={len(coords):>4}  "
                  f"length={length:>6.0f} m  "
                  f"start=({s[0]:.0f},{s[1]:.0f})  "
                  f"end=({e[0]:.0f},{e[1]:.0f})")
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
