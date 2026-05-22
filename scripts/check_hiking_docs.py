"""Validate that canonical hiking instructions mention current high-value CLI flags.

This is a lightweight drift check. It does not try to parse Markdown semantics;
it verifies that the auto-loaded instruction files mention the script entry
points and the key CLI flags that agents are expected to use.
"""

from __future__ import annotations

###########################################################################################################################################################################################################
# Imports
###########################################################################################################################################################################################################

import re
import subprocess
import sys
from pathlib import Path

###########################################################################################################################################################################################################
# Constants
###########################################################################################################################################################################################################

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTRUCTIONS_DIR = REPO_ROOT / "docs" / "hiking"

CHECKS = [
    {
        "script": REPO_ROOT / "scripts" / "add_hike.py",
        "doc": INSTRUCTIONS_DIR / "hiking-workflow.md",
        "required_tokens": [
            "scripts/add_hike.py",
            "--overwrite",
            "--skip-gpx",
            "--skip-render",
            "--probe",
            "--print-spec-template",
            "route_build",
        ],
    },
    {
        "script": REPO_ROOT / "scripts" / "build_hike_gpx.py",
        "doc": INSTRUCTIONS_DIR / "ROUTING-ELEVATION.md",
        "required_tokens": [
            "scripts/build_hike_gpx.py",
            "--peak-ll",
            "--trailhead-ll",
            "--via-ll",
            "--descend-via-ll",
            "--end-ll",
        ],
    },
]

###########################################################################################################################################################################################################
# Helpers
###########################################################################################################################################################################################################


def _help_flags(script: Path) -> set[str]:
    """Return the set of `--flag` tokens exposed by a script's argparse help."""
    result = subprocess.run(
        [sys.executable, str(script), "--help"],
        check=True,
        capture_output=True,
        text=True,
    )
    return set(re.findall(r"--[a-z0-9-]+", result.stdout))


def _assert_doc_mentions(doc_path: Path, token: str) -> None:
    """Raise if a token is absent from the instruction file text."""
    text = doc_path.read_text(encoding="utf-8")
    if token not in text:
        raise AssertionError(f"{doc_path.name}: missing '{token}'")


###########################################################################################################################################################################################################
# Main
###########################################################################################################################################################################################################


def main() -> None:
    """Run the drift checks against the canonical hiking instruction files."""
    failures: list[str] = []

    for check in CHECKS:
        script = check["script"]
        doc = check["doc"]
        flags = _help_flags(script)
        for token in check["required_tokens"]:
            try:
                if token.startswith("--") and token not in flags:
                    raise AssertionError(f"{script.name}: help output missing '{token}'")
                _assert_doc_mentions(doc, token)
            except AssertionError as exc:
                failures.append(str(exc))

    if failures:
        print("Instruction drift detected:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        raise SystemExit(1)

    print("Hiking instruction checks passed.")


if __name__ == "__main__":
    main()