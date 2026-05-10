"""Exit 0 if the freshly-built observations.json is substantively unchanged
from HEAD's version (ignoring `generated_at`). Exit 1 if a commit should happen.

Used by .github/workflows/refresh.yml to suppress no-op commits triggered only
by the `generated_at` timestamp bump that convert.py writes on every run.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

NEW = Path("observations.json")


def main() -> int:
    new = json.loads(NEW.read_text(encoding="utf-8"))
    try:
        old_raw = subprocess.run(
            ["git", "show", "HEAD:observations.json"],
            capture_output=True, text=True, check=True,
        ).stdout
        old = json.loads(old_raw)
    except subprocess.CalledProcessError:
        # File didn't exist at HEAD (or git command failed) — treat as a change.
        return 1

    same = (
        new.get("observations") == old.get("observations")
        and new.get("counts") == old.get("counts")
    )
    return 0 if same else 1


if __name__ == "__main__":
    sys.exit(main())
