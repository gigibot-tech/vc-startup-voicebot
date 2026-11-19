"""App version shown in the UI: ``<day>.<month>.<commit count>`` (e.g. ``19.11.14``).

Derived from git, so it goes up by itself with every commit — no hook, no file to bump
(``core.hooksPath`` may be owned by another tool, and a stored counter would conflict on merge).
Day.month is the date of the latest commit; the last number counts all commits.
Without git (zip / container) fall back to the ``APP_VERSION`` env var, then the package version.
A ``+`` marks uncommitted changes.
"""

from __future__ import annotations

import os
import subprocess
from functools import lru_cache
from pathlib import Path

from startup_voice import __version__


def _git(*args: str, cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=5, check=True
    ).stdout.strip()


@lru_cache(maxsize=1)
def app_version() -> str:
    env = (os.getenv("APP_VERSION") or "").strip()
    if env:
        return env
    here = Path(__file__).resolve().parent
    try:
        date = _git("log", "-1", "--format=%cd", "--date=format:%d.%m", cwd=here)
        count = _git("rev-list", "--count", "HEAD", cwd=here)
        dirty = "+" if _git("status", "--porcelain", "--untracked-files=no", cwd=here) else ""
        return f"{date}.{count}{dirty}"
    except Exception:
        return __version__
