"""Shared paths for the agent-plugin contract tests, and the tools directory on `sys.path`.

The suite runs on a bare interpreter (`python -I -S -m unittest`), so nothing here may
need more than the standard library.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
AGENT_PLUGINS = REPO / "agent-plugins"
TOOLS = AGENT_PLUGINS / "tools"
RUNTIME = AGENT_PLUGINS / "packages" / "visionset" / "runtime"

if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def python_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*.py") if "__pycache__" not in path.parts)
