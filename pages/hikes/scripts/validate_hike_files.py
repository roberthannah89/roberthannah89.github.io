"""Verify that every hike has all required files.

Each hike directory should contain:
  - {hikename}.data.json
  - {hikename}.gpx
  - {hikename}.html
  - {hikename}.track.js

Reports missing files and hikes with incomplete sets.
"""

from __future__ import annotations

###########################################################################################################################################################################################################
# Imports
###########################################################################################################################################################################################################
import sys
from pathlib import Path

###########################################################################################################################################################################################################
# Constants
###########################################################################################################################################################################################################

REPO_ROOT = Path(__file__).resolve().parent.parent
HIKES_DIR = REPO_ROOT / "routes"
REQUIRED_EXTENSIONS = {".data.json", ".gpx", ".html", ".track.js"}

###########################################################################################################################################################################################################
# Main
###########################################################################################################################################################################################################


def _get_file_extension(filename: str, hike_name: str) -> str:
    """Extract full extension for multi-part extensions like .data.json.

    Parameters:
        filename: The filename to extract extension from
        hike_name: The base hike name (to remove and find the suffix)

    Returns:
        The extension (e.g., ".data.json", ".gpx", ".track.js")
    """
    # Remove the hike name prefix to get the extension part
    if filename.startswith(hike_name):
        return filename[len(hike_name):]
    return Path(filename).suffix


def validate_hike_files() -> int:
    """Check all hikes for required files.

    Returns:
        0 if all hikes are complete, 1 if any files are missing.
    """
    if not HIKES_DIR.exists():
        print(f"Error: hikes directory not found: {HIKES_DIR}")
        return 1

    # Get all hike directories (exclude _assets and other non-hike folders)
    hike_dirs = sorted([
        d for d in HIKES_DIR.iterdir()
        if d.is_dir() and not d.name.startswith("_")
    ])

    if not hike_dirs:
        print(f"No hikes found in {HIKES_DIR}")
        return 1

    all_complete = True

    for hike_dir in hike_dirs:
        hike_name = hike_dir.name
        existing_files = {
            _get_file_extension(f.name, hike_name)
            for f in hike_dir.glob(f"{hike_name}.*")
        }
        missing = REQUIRED_EXTENSIONS - existing_files

        if missing:
            all_complete = False
            missing_str = ", ".join(sorted(missing))
            print(f"❌ {hike_name}: missing {missing_str}")
        else:
            print(f"✓ {hike_name}")

    print()
    if all_complete:
        print(f"✅ All {len(hike_dirs)} hikes have complete file sets.")
        return 0
    else:
        incomplete = sum(
            1 for d in hike_dirs
            if (REQUIRED_EXTENSIONS - {
                _get_file_extension(f.name, d.name)
                for f in d.glob(f"{d.name}.*")
            })
        )
        print(f"⚠️  {incomplete} of {len(hike_dirs)} hikes are missing files.")
        return 1


_GENERIC_SAC_ROUTE_SOURCES = (
    '<tr><th>Route sources</th><td><a href="https://www.sac-cas.ch/"'
)


def validate_no_generic_sac_links() -> int:
    """Fail if any hike's rendered HTML links to the generic SAC portal.

    A generic ``href="https://www.sac-cas.ch/"`` in the Route sources cell
    means the hike is missing its top-level ``sources`` array, so the render
    fell back to ``SOURCE_URL_MAP``. The pipeline (``add_sac_hike_v2.py``)
    is supposed to populate ``sources`` — see ``_ensure_sources`` there.
    """
    offenders = []
    for hike_dir in sorted(HIKES_DIR.iterdir()):
        if not hike_dir.is_dir() or hike_dir.name.startswith("_"):
            continue
        html = hike_dir / f"{hike_dir.name}.html"
        if html.exists() and _GENERIC_SAC_ROUTE_SOURCES in html.read_text(encoding="utf-8"):
            offenders.append(hike_dir.name)
    if offenders:
        print()
        print(f"❌ {len(offenders)} hike(s) link to the generic SAC portal instead of the specific route page:")
        for name in offenders:
            print(f"   - {name}")
        print("   Add a top-level `sources` array to the data.json (see any working -sac hike) and re-render.")
        return 1
    return 0


if __name__ == "__main__":
    rc = validate_hike_files()
    rc |= validate_no_generic_sac_links()
    sys.exit(rc)
