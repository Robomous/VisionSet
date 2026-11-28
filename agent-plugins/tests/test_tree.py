from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import _support
from bundle import GENERATED, PLUGIN_ROOT, load_bundle, read_version, render, stale

EXPECTED = (
    "agent-plugins/README.md",
    "agent-plugins/packages/visionset/bundle.toml",
    "agent-plugins/packages/visionset/.claude-plugin/plugin.json",
    "agent-plugins/packages/visionset/.codex-plugin/plugin.json",
    "agent-plugins/packages/visionset/.mcp.json",
    "agent-plugins/packages/visionset/codex.mcp.json",
    "agent-plugins/packages/visionset/runtime/discover.py",
    "agent-plugins/packages/visionset/runtime/bootstrap.py",
    "agent-plugins/packages/visionset/runtime/launch.py",
    "agent-plugins/packages/visionset/skills",
    "agent-plugins/schemas/claude-plugin.schema.json",
    "agent-plugins/schemas/codex-plugin.schema.json",
    "agent-plugins/schemas/claude-mcp.schema.json",
    "agent-plugins/schemas/codex-mcp.schema.json",
    "agent-plugins/tools/bundle.py",
    "agent-plugins/tools/render_manifests.py",
    "agent-plugins/tools/validate_manifests.py",
)


class TreeTest(unittest.TestCase):
    def test_expected_paths_exist(self) -> None:
        missing = [path for path in EXPECTED if not (_support.REPO / path).exists()]
        self.assertEqual(missing, [])

    def test_committed_manifests_are_what_the_generator_writes(self) -> None:
        files = render(load_bundle(), read_version())
        self.assertEqual(sorted(files), sorted(GENERATED))
        self.assertEqual(stale(PLUGIN_ROOT, files), [])

    def test_a_version_change_is_drift(self) -> None:
        files = render(load_bundle(), "9.9.9")
        self.assertIn(".claude-plugin/plugin.json", stale(PLUGIN_ROOT, files))
        self.assertIn(".codex-plugin/plugin.json", stale(PLUGIN_ROOT, files))

    def test_a_hand_edit_is_drift(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            copy = Path(scratch) / "visionset"
            shutil.copytree(PLUGIN_ROOT, copy)
            manifest = copy / ".mcp.json"
            manifest.write_text(manifest.read_text(encoding="utf-8").replace("python3", "python"))
            files = render(load_bundle(), read_version())
            self.assertEqual(stale(copy, files), [".mcp.json"])

    def test_check_mode_passes_on_the_committed_tree(self) -> None:
        result = subprocess.run(
            [sys.executable, str(_support.TOOLS / "render_manifests.py"), "--check"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
