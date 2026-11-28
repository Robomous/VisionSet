from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

import _support  # noqa: F401
from bundle import CLAUDE_MCP, CODEX_MANIFEST, PLUGIN_ROOT
from validate_manifests import SCHEMAS, SchemaError, check, validate


def schema(name: str) -> dict[str, Any]:
    document: dict[str, Any] = json.loads((SCHEMAS / name).read_text(encoding="utf-8"))
    return document


class CopiedRootTest(unittest.TestCase):
    def setUp(self) -> None:
        self._scratch = tempfile.TemporaryDirectory()
        self.root = Path(self._scratch.name) / "visionset"
        shutil.copytree(PLUGIN_ROOT, self.root)

    def tearDown(self) -> None:
        self._scratch.cleanup()

    def test_the_copy_validates_before_it_is_broken(self) -> None:
        self.assertEqual(validate(self.root), [])

    def test_a_symlink_in_the_root_is_refused(self) -> None:
        os.symlink(self.root.parent, self.root / "skills" / "elsewhere")
        errors = validate(self.root)
        self.assertTrue(any("symlink" in error for error in errors), errors)

    def test_a_named_path_must_exist(self) -> None:
        (self.root / "runtime" / "launch.py").unlink()
        errors = validate(self.root)
        self.assertTrue(any("does not exist" in error for error in errors), errors)

    def test_a_named_path_must_stay_inside_the_root(self) -> None:
        (self.root.parent / "outside.py").write_text("", encoding="utf-8")
        declaration = self.root / CLAUDE_MCP
        document = json.loads(declaration.read_text(encoding="utf-8"))
        document["mcpServers"]["visionset"]["args"] = ["${CLAUDE_PLUGIN_ROOT}/../outside.py"]
        declaration.write_text(json.dumps(document), encoding="utf-8")
        errors = validate(self.root)
        self.assertTrue(any("escapes the plugin root" in error for error in errors), errors)


class SchemaTest(unittest.TestCase):
    def test_committed_files_validate(self) -> None:
        self.assertEqual(validate(), [])

    def test_the_schemas_refuse_what_they_should(self) -> None:
        codex = schema("codex-plugin.schema.json")
        good = json.loads((PLUGIN_ROOT / CODEX_MANIFEST).read_text(encoding="utf-8"))
        self.assertEqual(check(good, codex, codex), [])
        bad = [
            dict(good, version="0.0.1b4"),
            dict(good, name="VisionSet"),
            dict(good, mcpServers="../codex.mcp.json"),
            dict(good, unexpected=True),
            {key: value for key, value in good.items() if key != "license"},
            dict(good, author={"name": ""}),
        ]
        for index, document in enumerate(bad):
            with self.subTest(case=index):
                self.assertNotEqual(check(document, codex, codex), [])

    def test_codex_servers_need_a_plugin_relative_cwd(self) -> None:
        codex_mcp = schema("codex-mcp.schema.json")
        server = {"command": "python3", "args": ["./runtime/launch.py"]}
        for cwd, ok in ((".", True), ("./runtime", True), ("/tmp", False), ("..", False)):
            document = {"mcpServers": {"visionset": dict(server, cwd=cwd)}}
            with self.subTest(cwd=cwd):
                self.assertEqual(check(document, codex_mcp, codex_mcp) == [], ok)
        missing = {"mcpServers": {"visionset": server}}
        self.assertNotEqual(check(missing, codex_mcp, codex_mcp), [])

    def test_the_runtime_range_must_be_an_exact_pin(self) -> None:
        runtime = schema("runtime-bundle.schema.json")
        document = json.loads((PLUGIN_ROOT / "runtime" / "bundle.json").read_text("utf-8"))
        self.assertEqual(check(document, runtime, runtime), [])
        self.assertNotEqual(check(dict(document, compatibility=">=0.0.1"), runtime, runtime), [])

    def test_an_unsupported_keyword_is_an_error_not_a_pass(self) -> None:
        with self.assertRaises(SchemaError):
            check({}, {"oneOf": []}, {})


if __name__ == "__main__":
    unittest.main()
