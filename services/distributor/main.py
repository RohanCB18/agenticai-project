"""Vercel entrypoint. The agent lives in src/munshi_distributor; Vercel loads `app` from here."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

from munshi_distributor.app import app  # noqa: E402

__all__ = ["app"]
