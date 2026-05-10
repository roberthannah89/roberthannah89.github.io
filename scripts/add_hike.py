"""Create or update a hike from a compact JSON spec.

This is the agent-friendly fast path for adding hikes in parallel. A spec file
contains the small set of required summary fields plus only the data sections
you actually want to override; the script fills the rest from the existing
template, optionally builds the GPX/track, and renders the page.

Usage
-----
    python scripts/add_hike.py --spec /tmp/eiger-trail.spec.json
    python scripts/add_hike.py --spec /tmp/eiger-trail.spec.json --probe
    python scripts/add_hike.py --print-spec-template

Minimal spec
------------
    {
      "slug": "eiger-trail",
      "name": "Eiger Trail",
      "region": "Bernese Oberland",
      "canton": "Bern",
      "grade": "T2",
      "elev": 2320,
      "peak": {
        "name": "Eigergletscher",
        "lat": 46.5771,
        "lon": 8.0051
      },
      "trailhead": {
        "name": "Alpiglen",
        "lat": 46.5936,
        "lon": 7.9820,
        "elev": 1616,
        "transit_dest": "Alpiglen"
      },
      "route_build": {
        "via": ["Fallbodensee"],
        "end_name": "Eigergletscher"
      },
      "index_card": {
        "time": "2.5–3.5 h"
      },
      "intro_html": "<p>TODO: short route summary.</p>"
    }

Notes
-----
- Reserved top-level keys: slug, name, region, canton, grade, elev, route_build.
- All other top-level keys are merged directly into the generated data.json.
- For `route_build.via` / `route_build.descend_via`, each item may be either a
  string name or an object like `{"name": "Saxer Luecke", "lat": 47.258, "lon": 9.438}`.
"""

from __future__ import annotations

###########################################################################################################################################################################################################
# Imports
###########################################################################################################################################################################################################

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from new_hike import build_template

###########################################################################################################################################################################################################
# Public API
###########################################################################################################################################################################################################

__all__ = ["main"]

###########################################################################################################################################################################################################
# Constants
###########################################################################################################################################################################################################

RESERVED_TOP_LEVEL_KEYS = {
    "slug",
    "name",
    "region",
    "canton",
    "grade",
    "elev",
    "route_build",
}

SPEC_TEMPLATE = {
    "slug": "eiger-trail",
    "name": "Eiger Trail",
    "region": "Bernese Oberland",
    "canton": "Bern",
    "grade": "T2",
    "elev": 2320,
    "peak": {
        "name": "Eigergletscher",
        "lat": 46.5771,
        "lon": 8.0051,
    },
    "trailhead": {
        "name": "Alpiglen",
        "lat": 46.5936,
        "lon": 7.9820,
        "elev": 1616,
        "transit_dest": "Alpiglen",
    },
    "route_build": {
        "via": [
            "Fallbodensee",
            {
                "name": "Eigergletscher",
                "lat": 46.5771,
                "lon": 8.0051,
            },
        ],
        "end_name": "Eigergletscher",
    },
    "index_card": {
        "distance": "6.4 km",
        "gain": "780 m descent",
        "time": "2.5–3.5 h",
    },
    "hero": {
        "grade": "T2",
    },
    "intro_html": "<p>TODO: short route summary.</p>",
}

###########################################################################################################################################################################################################
# Helpers
###########################################################################################################################################################################################################


def _deep_merge(base: Any, override: Any) -> Any:
    """Recursively merge dictionaries; non-dicts replace the base value."""
    if isinstance(base, dict) and isinstance(override, dict):
        merged = dict(base)
        for key, value in override.items():
            merged[key] = _deep_merge(merged.get(key), value) if key in merged else value
        return merged
    return override


def _find_todo_fields(data: object, prefix: str = "") -> list[str]:
    """Recursively collect JSON paths whose string value contains 'TODO'."""
    todos: list[str] = []
    if isinstance(data, dict):
        for key, value in data.items():
            child_prefix = f"{prefix}.{key}" if prefix else key
            todos.extend(_find_todo_fields(value, child_prefix))
    elif isinstance(data, list):
        for index, value in enumerate(data):
            todos.extend(_find_todo_fields(value, f"{prefix}[{index}]"))
    elif isinstance(data, str) and "TODO" in data:
        todos.append(prefix)
    return todos


def _require(spec: dict[str, Any], key: str) -> Any:
    """Return a required key from the spec or exit with a clear message."""
    if key not in spec:
        raise SystemExit(f"ERROR: spec is missing required key '{key}'.")
    return spec[key]


def _repo_root() -> Path:
    """Return the website repository root from this script location."""
    return Path(__file__).resolve().parent.parent.parent.parent


def _load_spec(path: Path) -> dict[str, Any]:
    """Load and validate the top-level JSON object from a spec file."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit("ERROR: spec file must contain a top-level JSON object.")
    return data


def _append_named_points(cmd: list[str], items: list[Any], name_flag: str, ll_flag: str) -> None:
    """Append repeated named waypoint flags and optional explicit coordinates."""
    for item in items:
        if isinstance(item, str):
            cmd.extend([name_flag, item])
            continue
        if not isinstance(item, dict):
            raise SystemExit(
                f"ERROR: {name_flag} entries must be strings or objects with name/lat/lon."
            )
        name = _require(item, "name")
        cmd.extend([name_flag, str(name)])
        if "lat" in item or "lon" in item:
            if "lat" not in item or "lon" not in item:
                raise SystemExit(
                    f"ERROR: {name_flag} object '{name}' must provide both lat and lon."
                )
            cmd.extend([ll_flag, f"{float(item['lat'])},{float(item['lon'])}"])


def _build_data_from_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Create the final data.json payload by merging the spec onto the template."""
    slug = str(_require(spec, "slug"))
    name = str(_require(spec, "name"))
    region = str(_require(spec, "region"))
    canton = str(_require(spec, "canton"))
    grade = str(_require(spec, "grade"))
    elev = int(_require(spec, "elev"))

    trailhead = _require(spec, "trailhead")
    peak = _require(spec, "peak")
    if not isinstance(trailhead, dict) or not isinstance(peak, dict):
        raise SystemExit("ERROR: spec.peak and spec.trailhead must be objects.")

    template = build_template(
        slug=slug,
        name=name,
        region=region,
        canton=canton,
        grade=grade,
        elev=elev,
        trailhead=str(_require(trailhead, "name")),
        peak_lat=float(_require(peak, "lat")),
        peak_lon=float(_require(peak, "lon")),
        trailhead_lat=float(_require(trailhead, "lat")),
        trailhead_lon=float(_require(trailhead, "lon")),
    )

    merge_payload = {
        key: value
        for key, value in spec.items()
        if key not in RESERVED_TOP_LEVEL_KEYS
    }
    return _deep_merge(template, merge_payload)


def _write_data_file(path: Path, data: dict[str, Any], overwrite: bool) -> None:
    """Write the rendered data.json payload to disk."""
    if path.exists() and not overwrite:
        raise SystemExit(
            f"ERROR: {path} already exists. Re-run with --overwrite to replace it."
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _run_build_gpx(spec: dict[str, Any], hike_dir: Path, data: dict[str, Any]) -> int:
    """Run build_hike_gpx.py for the hike spec, returning the exit code."""
    route_build = spec.get("route_build", {})
    if route_build is None:
        return 0
    if not isinstance(route_build, dict):
        raise SystemExit("ERROR: route_build must be an object when provided.")
    if route_build.get("enabled", True) is False:
        return 0

    peak = data["peak"]
    trailhead = data["trailhead"]
    gpx_script = Path(__file__).resolve().parent / "build_hike_gpx.py"
    cmd = [
        sys.executable,
        str(gpx_script),
        "--slug",
        str(data["slug"]),
        "--peak",
        str(route_build.get("peak_name") or peak.get("name") or spec["name"]),
        "--trailhead",
        str(route_build.get("trailhead_name") or trailhead["name"]),
        "--peak-ll",
        f"{float(peak['lat'])},{float(peak['lon'])}",
        "--trailhead-ll",
        f"{float(trailhead['lat'])},{float(trailhead['lon'])}",
        "--out-dir",
        str(hike_dir),
    ]

    via_items = route_build.get("via", [])
    descend_via_items = route_build.get("descend_via", [])
    if not isinstance(via_items, list) or not isinstance(descend_via_items, list):
        raise SystemExit("ERROR: route_build.via and route_build.descend_via must be lists.")
    _append_named_points(cmd, via_items, "--via", "--via-ll")
    _append_named_points(cmd, descend_via_items, "--descend-via", "--descend-via-ll")

    end_name = route_build.get("end_name") or route_build.get("end")
    end_ll = route_build.get("end_ll")
    if end_name:
        cmd.extend(["--end", str(end_name)])
    if end_ll is not None:
        if isinstance(end_ll, list) and len(end_ll) == 2:
            cmd.extend(["--end-ll", f"{float(end_ll[0])},{float(end_ll[1])}"])
        elif isinstance(end_ll, dict) and {"lat", "lon"}.issubset(end_ll):
            cmd.extend(["--end-ll", f"{float(end_ll['lat'])},{float(end_ll['lon'])}"])
        else:
            raise SystemExit("ERROR: route_build.end_ll must be [lat, lon] or {lat, lon}.")

    bbox = route_build.get("bbox")
    if bbox is not None:
        if not isinstance(bbox, list) or len(bbox) != 4:
            raise SystemExit("ERROR: route_build.bbox must be [south, west, north, east].")
        cmd.extend(["--bbox", ",".join(str(float(value)) for value in bbox)])

    if "track_points" in route_build:
        cmd.extend(["--track-points", str(int(route_build["track_points"]))])
    if "elev_points" in route_build:
        cmd.extend(["--elev-points", str(int(route_build["elev_points"]))])

    print("\n[GPX] Running:")
    print("  " + " ".join(cmd))
    return subprocess.run(cmd).returncode


def _run_render(slug: str, probe: bool) -> int:
    """Render the hike page for one slug, optionally probing URLs."""
    render_script = Path(__file__).resolve().parent / "render_hike.py"
    cmd = [sys.executable, str(render_script), "--slug", slug]
    if probe:
        cmd.append("--probe")
    print("\n[RENDER] Running:")
    print("  " + " ".join(cmd))
    return subprocess.run(cmd).returncode


###########################################################################################################################################################################################################
# CLI entry point
###########################################################################################################################################################################################################


def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Create or update a hike from a compact JSON spec.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--spec", type=Path, help="Path to a JSON hike spec file.")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite an existing <slug>.data.json file.")
    parser.add_argument("--skip-gpx", action="store_true", help="Write data.json only; do not run build_hike_gpx.py.")
    parser.add_argument("--skip-render", action="store_true", help="Write data.json (and maybe GPX) only; do not render HTML.")
    parser.add_argument("--probe", action="store_true", help="Pass --probe to render_hike.py.")
    parser.add_argument("--print-spec-template", action="store_true", help="Print an example spec JSON and exit.")
    args = parser.parse_args()
    if not args.print_spec_template and args.spec is None:
        parser.error("--spec is required unless --print-spec-template is used.")
    return args


def main() -> None:
    """CLI entry point for spec-driven hike creation."""
    args = _parse_args()

    if args.print_spec_template:
        print(json.dumps(SPEC_TEMPLATE, indent=2, ensure_ascii=False))
        return

    spec = _load_spec(args.spec)
    data = _build_data_from_spec(spec)

    repo_root = _repo_root()
    slug = str(data["slug"])
    hike_dir = repo_root / "pages" / "hikes" / "routes" / slug
    out_path = hike_dir / f"{slug}.data.json"
    _write_data_file(out_path, data, overwrite=args.overwrite)
    print(f"✓ Wrote {out_path}")

    gpx_exit = 0
    if not args.skip_gpx:
        gpx_exit = _run_build_gpx(spec, hike_dir, data)
        if gpx_exit != 0:
            print(
                f"WARNING: GPX generation failed (exit {gpx_exit}). Data file is still written.",
                file=sys.stderr,
            )

    render_exit = 0
    if not args.skip_render:
        render_exit = _run_render(slug, probe=args.probe)

    todos = _find_todo_fields(data)
    print(f"\nTODO fields remaining: {len(todos)}")
    for field in todos[:25]:
        print(f"  • {field}")
    if len(todos) > 25:
        print(f"  … {len(todos) - 25} more")

    if render_exit != 0:
        raise SystemExit(render_exit)
    if gpx_exit != 0:
        raise SystemExit(gpx_exit)


if __name__ == "__main__":
    main()