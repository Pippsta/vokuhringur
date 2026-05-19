"""Append a single friend observation to observations.json.

Triggered by the register-awake workflow when the static page POSTs a
repository_dispatch event. The new timestamp arrives via the REGISTER_TS env
var (set from the workflow's `${{ github.event.client_payload.ts }}`).

Idempotent: if a friend record with the same normalized timestamp already
exists, exit cleanly without modifying the file.

This script never touches chess records — those are owned by the daily
refresh workflow. The two flows share the same `refresh-observations`
concurrency group at the workflow level, so they cannot race on push.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
JSON_PATH = HERE / "observations.json"


def normalize(raw: str) -> str:
    """Accepts ISO-8601 with or without milliseconds and a Z or +HH:MM offset.

    Returns 'YYYY-MM-DDTHH:MM:SSZ' (seconds precision, UTC), matching the
    format produced by convert.py and update_friend_in_json.py.
    """
    # datetime.fromisoformat handles offsets; strip a trailing 'Z' first.
    s = raw.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s).astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    raw_ts = os.environ.get("REGISTER_TS", "").strip()
    if not raw_ts:
        print("ERROR: REGISTER_TS env var is empty", file=sys.stderr)
        return 1
    try:
        ts = normalize(raw_ts)
    except ValueError as e:
        print(f"ERROR: cannot parse REGISTER_TS={raw_ts!r}: {e}", file=sys.stderr)
        return 1

    if not JSON_PATH.exists():
        print(f"ERROR: {JSON_PATH.name} not found", file=sys.stderr)
        return 1

    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    observations = data["observations"]

    already = any(
        o.get("ts") == ts and o.get("source") == "friend" for o in observations
    )
    if already:
        print(f"No-op: friend observation at {ts} already present.")
        # Still bump generated_at so the file is well-formed; should_commit.py
        # ignores generated_at-only changes and will suppress the commit.
        data["generated_at"] = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        JSON_PATH.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return 0

    observations.append({"ts": ts, "source": "friend"})
    observations.sort(key=lambda r: r["ts"])

    friend_count = sum(1 for o in observations if o.get("source") == "friend")
    chess_count = sum(1 for o in observations if o.get("source") == "chess")
    data["counts"]["by_source"] = {"chess": chess_count, "friend": friend_count}
    data["counts"].setdefault("input_rows", {})["friend"] = friend_count
    data["counts"]["total"] = len(observations)
    data["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    JSON_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(
        f"Appended friend observation at {ts}. "
        f"chess={chess_count} friend={friend_count} total={len(observations)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
