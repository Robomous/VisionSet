from __future__ import annotations

import ast
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import _support

RUNTIME_MODULES = sorted(path.stem for path in _support.python_files(_support.RUNTIME))
DYNAMIC = "<dynamic import>"
# Calls that load a module named at runtime. A literal first argument names the module; any
# other argument, or a loader that takes a path, is reported as DYNAMIC and allowed nowhere.
_BY_NAME = {"__import__", "import_module", "run_module"}
_BY_PATH = {"run_path", "spec_from_file_location", "spec_from_loader", "load_module"}


def _called_name(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def imported_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])
        elif isinstance(node, ast.Call):
            name = _called_name(node)
            if name in _BY_PATH:
                roots.add(DYNAMIC)
            elif name in _BY_NAME:
                first = node.args[0] if node.args else None
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    roots.add(first.value.split(".")[0])
                else:
                    roots.add(DYNAMIC)
    return roots


def floor_interpreter() -> str | None:
    if sys.version_info[:2] == (3, 11):
        return sys.executable
    return shutil.which("python3.11")


class DependencyDirectionTest(unittest.TestCase):
    def test_nothing_under_agent_plugins_imports_visionset(self) -> None:
        offenders = [
            str(path.relative_to(_support.REPO))
            for path in _support.python_files(_support.AGENT_PLUGINS)
            if imported_roots(path) & {"visionset", DYNAMIC}
        ]
        self.assertEqual(offenders, [])

    def test_runtime_imports_only_the_standard_library(self) -> None:
        allowed = set(sys.stdlib_module_names) | set(RUNTIME_MODULES) | {"__future__"}
        offenders = {
            str(path.relative_to(_support.REPO)): sorted(imported_roots(path) - allowed)
            for path in _support.python_files(_support.RUNTIME)
        }
        self.assertEqual({key: value for key, value in offenders.items() if value}, {})

    def test_the_scan_sees_every_import_shape(self) -> None:
        shapes = {
            "import visionset.cli": {"visionset"},
            "from visionset import kernel": {"visionset"},
            "__import__('visionset')": {"visionset"},
            "builtins.__import__('yaml')": {"yaml"},
            "from importlib import import_module\nimport_module('visionset.mcp')": {
                "importlib",
                "visionset",
            },
            "import importlib\nimportlib.import_module('yaml')": {"importlib", "yaml"},
            "runpy.run_module('visionset')": {"visionset"},
            "import_module(name)": {DYNAMIC},
            "__import__(f'vision{x}')": {DYNAMIC},
            "runpy.run_path('/x.py')": {DYNAMIC},
            "importlib.util.spec_from_file_location('m', p)": {DYNAMIC},
        }
        with tempfile.TemporaryDirectory() as scratch:
            probe = Path(scratch) / "probe.py"
            for source, expected in shapes.items():
                with self.subTest(source=source):
                    probe.write_text(source + "\n", encoding="utf-8")
                    self.assertEqual(imported_roots(probe), expected)

    def test_runtime_parses_at_the_interpreter_floor(self) -> None:
        for path in _support.python_files(_support.RUNTIME):
            with self.subTest(path=path.name):
                ast.parse(path.read_text(encoding="utf-8"), feature_version=(3, 11))

    def test_every_runtime_module_imports_on_a_bare_floor_interpreter(self) -> None:
        python = floor_interpreter()
        if python is None:
            self.skipTest("no Python 3.11 interpreter available")
        for module in RUNTIME_MODULES:
            with self.subTest(module=module):
                result = subprocess.run(
                    [
                        python,
                        "-I",
                        "-S",
                        "-c",
                        f"import sys; sys.path.insert(0, {str(_support.RUNTIME)!r}); "
                        f"import {module}",
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_launcher_keeps_stdout_for_the_protocol(self) -> None:
        for flags in (["-I", "-S"], ["-I"]):
            with self.subTest(flags=flags):
                result = subprocess.run(
                    [sys.executable, *flags, str(_support.RUNTIME / "launch.py")],
                    capture_output=True,
                    stdin=subprocess.DEVNULL,
                    check=False,
                )
                self.assertEqual(result.stdout, b"")
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr)


if __name__ == "__main__":
    unittest.main()
