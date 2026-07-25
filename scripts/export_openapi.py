"""Export the server's OpenAPI spec to the repo-root openapi.json.

The committed openapi.json is a versioned public contract: CI regenerates it
and fails on drift, and the typed frontend client is generated from it.

Usage: uv run python scripts/export_openapi.py
"""

from __future__ import annotations

import json
from pathlib import Path

from visionset.server.main import app

REPO_ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    spec = app.openapi()
    out = REPO_ROOT / "openapi.json"
    out.write_text(json.dumps(spec, indent=2, sort_keys=True) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
