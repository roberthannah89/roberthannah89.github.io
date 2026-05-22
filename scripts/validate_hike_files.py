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
HIKES_DIR = REPO_ROOT / "pages" / "hikes" / "routes"
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


if __name__ == "__main__":
    sys.exit(validate_hike_files())
