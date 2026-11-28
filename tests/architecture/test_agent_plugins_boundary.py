"""The Python distribution never reaches into `agent-plugins/`.

The plugin depends on VisionSet only as a console script run in a subprocess, and
`agent-plugins/tests/` holds that half. This is the other half: nothing the wheel is
built from names the plugin tree, so the dependency runs one way.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NAMES = ("agent-plugins", "agent_plugins")


def test_the_distribution_never_names_the_plugin_tree() -> None:
    tracked = subprocess.run(
        ["git", "ls-files", "-z", "src/visionset"],
        cwd=REPO,
        capture_output=True,
        check=True,
    ).stdout.decode()
    offenders = []
    for relative in filter(None, tracked.split("\0")):
        try:
            text = (REPO / relative).read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        if any(name in text for name in NAMES):
            offenders.append(relative)
    assert offenders == []
