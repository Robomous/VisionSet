from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import _support
from bundle import (
    CODEX_MANIFEST,
    CODEX_MCP,
    GENERATED,
    PLUGIN_ROOT,
    load_metadata,
    read_version,
    render,
    stale,
)

EXPECTED = (
    "agent-plugins/README.md",
    "agent-plugins/metadata.json",
    "agent-plugins/packages/visionset/.claude-plugin/plugin.json",
    "agent-plugins/packages/visionset/.codex-plugin/plugin.json",
    "agent-plugins/packages/visionset/.mcp.json",
    "agent-plugins/packages/visionset/codex.mcp.json",
    "agent-plugins/packages/visionset/runtime/bundle.json",
    "agent-plugins/packages/visionset/runtime/discover.py",
    "agent-plugins/packages/visionset/runtime/bootstrap.py",
    "agent-plugins/packages/visionset/runtime/launch.py",
    "agent-plugins/packages/visionset/skills",
    "agent-plugins/schemas/claude-plugin.schema.json",
    "agent-plugins/schemas/codex-plugin.schema.json",
    "agent-plugins/schemas/claude-mcp.schema.json",
    "agent-plugins/schemas/codex-mcp.schema.json",
    "agent-plugins/schemas/runtime-bundle.schema.json",
    "agent-plugins/tools/bundle.py",
    "agent-plugins/tools/render_manifests.py",
    "agent-plugins/tools/validate_manifests.py",
)


def current() -> dict[str, str]:
    return render(load_metadata(), read_version())


def render_check(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(_support.TOOLS / "render_manifests.py"),
            "--check",
            "--root",
            str(root),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


class TreeTest(unittest.TestCase):
    def test_expected_paths_exist(self) -> None:
        missing = [path for path in EXPECTED if not (_support.REPO / path).exists()]
        self.assertEqual(missing, [])

    def test_committed_files_are_what_the_generator_writes(self) -> None:
        files = current()
        self.assertEqual(sorted(files), sorted(GENERATED))
        self.assertEqual(stale(PLUGIN_ROOT, files), [])

    def test_a_version_change_is_drift(self) -> None:
        drift = stale(PLUGIN_ROOT, render(load_metadata(), "9.9.9"))
        for relative in (".claude-plugin/plugin.json", CODEX_MANIFEST, "runtime/bundle.json"):
            self.assertIn(relative, drift)

    def test_a_hand_edit_is_drift(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            copy = Path(scratch) / "visionset"
            shutil.copytree(PLUGIN_ROOT, copy)
            manifest = copy / ".mcp.json"
            manifest.write_text(manifest.read_text(encoding="utf-8").replace("python3", "python"))
            self.assertEqual(stale(copy, current()), [".mcp.json"])

    def test_a_file_the_generator_no_longer_writes_is_drift(self) -> None:
        files = {key: value for key, value in current().items() if key != CODEX_MCP}
        self.assertEqual(stale(PLUGIN_ROOT, files), [CODEX_MCP])

    def test_check_mode_passes_on_the_committed_tree(self) -> None:
        result = render_check(PLUGIN_ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_mode_fails_on_drift_and_names_the_file(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            copy = Path(scratch) / "visionset"
            shutil.copytree(PLUGIN_ROOT, copy)
            (copy / CODEX_MANIFEST).write_text("{}\n", encoding="utf-8")
            result = render_check(copy)
            self.assertEqual(result.returncode, 1)
            self.assertIn(CODEX_MANIFEST, result.stderr)
            self.assertEqual((copy / CODEX_MANIFEST).read_text(encoding="utf-8"), "{}\n")

    def test_no_generated_declaration_allows_destructive_tools(self) -> None:
        for relative, text in current().items():
            with self.subTest(file=relative):
                self.assertNotIn("allow-destructive", text)
                committed = (PLUGIN_ROOT / relative).read_text(encoding="utf-8")
                self.assertNotIn("allow-destructive", committed)


if __name__ == "__main__":
    unittest.main()
