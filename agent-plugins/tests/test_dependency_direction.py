from __future__ import annotations

import ast
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import _support

RUNTIME_SIBLINGS = {path.stem for path in _support.python_files(_support.RUNTIME)}


def imported_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])
        elif isinstance(node, ast.Call) and getattr(node.func, "attr", None) in (
            "import_module",
            "__import__",
        ):
            for argument in node.args[:1]:
                if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                    roots.add(argument.value.split(".")[0])
    return roots


class DependencyDirectionTest(unittest.TestCase):
    def test_nothing_under_agent_plugins_imports_visionset(self) -> None:
        offenders = [
            str(path.relative_to(_support.REPO))
            for path in _support.python_files(_support.AGENT_PLUGINS)
            if "visionset" in imported_roots(path)
        ]
        self.assertEqual(offenders, [])

    def test_runtime_imports_only_the_standard_library(self) -> None:
        allowed = set(sys.stdlib_module_names) | RUNTIME_SIBLINGS | {"__future__"}
        offenders = {
            str(path.relative_to(_support.REPO)): sorted(imported_roots(path) - allowed)
            for path in _support.python_files(_support.RUNTIME)
        }
        self.assertEqual({key: value for key, value in offenders.items() if value}, {})

    def test_the_scan_sees_an_import_it_should_refuse(self) -> None:
        source = "import os\nfrom visionset.cli import main\nimportlib.import_module('yaml')\n"
        with tempfile.TemporaryDirectory() as scratch:
            probe = Path(scratch) / "probe.py"
            probe.write_text(source, encoding="utf-8")
            self.assertEqual(imported_roots(probe), {"os", "visionset", "yaml"})

    def test_runtime_parses_at_the_interpreter_floor(self) -> None:
        for path in _support.python_files(_support.RUNTIME):
            with self.subTest(path=path.name):
                ast.parse(path.read_text(encoding="utf-8"), feature_version=(3, 11))

    def test_the_launcher_keeps_stdout_for_the_protocol(self) -> None:
        result = subprocess.run(
            [sys.executable, "-I", "-S", str(_support.RUNTIME / "launch.py")],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            check=False,
        )
        self.assertEqual(result.stdout, b"")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(result.stderr)


if __name__ == "__main__":
    unittest.main()
