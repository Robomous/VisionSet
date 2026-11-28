from __future__ import annotations

import json
import tomllib
import unittest
from collections.abc import Callable
from typing import Any

import _support
from bundle import (
    BUNDLE_TOML,
    CLAUDE_MANIFEST,
    CODEX_MANIFEST,
    PLUGIN_ROOT,
    BundleError,
    load_bundle,
    parse_bundle,
    plugin_version,
    read_version,
)
from validate_manifests import SCHEMAS, SchemaError, check, validate

PYPROJECT = tomllib.loads((_support.REPO / "pyproject.toml").read_text(encoding="utf-8"))


def manifest(relative: str) -> dict[str, Any]:
    document: dict[str, Any] = json.loads((PLUGIN_ROOT / relative).read_text(encoding="utf-8"))
    return document


def bundle_data() -> dict[str, Any]:
    return tomllib.loads(BUNDLE_TOML.read_text(encoding="utf-8"))


class VersionTest(unittest.TestCase):
    def test_the_mapping_matches_the_frontend_one(self) -> None:
        cases = {
            "0.0.1.dev0": "0.0.1-dev.0",
            "0.0.1a2": "0.0.1-alpha.2",
            "0.0.1b4": "0.0.1-beta.4",
            "0.0.1rc1": "0.0.1-rc.1",
            "0.0.1": "0.0.1",
            "1.2.3": "1.2.3",
        }
        for pep440, semver in cases.items():
            with self.subTest(pep440=pep440):
                self.assertEqual(plugin_version(pep440), semver)
        for bad in ("0.0.1.post1", "1.2", "0.0.1b", "v0.0.1"):
            with self.subTest(bad=bad), self.assertRaises(BundleError):
                plugin_version(bad)

    def test_every_manifest_carries_the_repository_version(self) -> None:
        expected = plugin_version(read_version())
        for relative in (CLAUDE_MANIFEST, CODEX_MANIFEST):
            with self.subTest(manifest=relative):
                self.assertEqual(manifest(relative)["version"], expected)

    def test_the_plugin_and_the_frontend_packages_spell_a_release_the_same_way(self) -> None:
        package = json.loads(
            (_support.REPO / "frontend" / "app" / "package.json").read_text(encoding="utf-8")
        )
        self.assertEqual(manifest(CLAUDE_MANIFEST)["version"], package["version"])

    def test_bundle_toml_names_no_version(self) -> None:
        text = BUNDLE_TOML.read_text(encoding="utf-8")
        version = read_version()
        self.assertNotIn(version, text)
        self.assertNotIn(plugin_version(version), text)


class PublisherTest(unittest.TestCase):
    def test_metadata_agrees_with_the_python_distribution(self) -> None:
        bundle = load_bundle()
        project = PYPROJECT["project"]
        self.assertEqual(bundle.publisher, project["authors"][0]["name"])
        self.assertEqual(bundle.license, project["license"])
        self.assertEqual(bundle.homepage, project["urls"]["Homepage"])
        self.assertEqual(bundle.distribution, project["name"])
        self.assertIn(bundle.console_script, project["scripts"])
        self.assertEqual(bundle.requires_python, project["requires-python"])


class BundleSchemaTest(unittest.TestCase):
    def test_unknown_keys_and_rules_are_refused(self) -> None:
        mutations: list[Callable[[dict[str, Any]], object]] = [
            lambda data: data["plugin"].update(version="1.0.0"),
            lambda data: data.update(extra={}),
            lambda data: data["runtime"].update(compatibility="compatible-release"),
            lambda data: data["runtime"].update(launcher="../outside.py"),
            lambda data: data["clients"].update(adapters=["cursor"]),
            lambda data: data["plugin"].pop("license"),
        ]
        for index, mutate in enumerate(mutations):
            data = bundle_data()
            mutate(data)
            with self.subTest(mutation=index), self.assertRaises(BundleError):
                parse_bundle(data)


class ManifestSchemaTest(unittest.TestCase):
    def test_committed_manifests_validate(self) -> None:
        self.assertEqual(validate(), [])

    def test_the_schemas_refuse_what_they_should(self) -> None:
        schema = json.loads((SCHEMAS / "codex-plugin.schema.json").read_text(encoding="utf-8"))
        good = manifest(CODEX_MANIFEST)
        self.assertEqual(check(good, schema, schema), [])
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
                self.assertNotEqual(check(document, schema, schema), [])

    def test_codex_servers_need_a_plugin_relative_cwd(self) -> None:
        schema = json.loads((SCHEMAS / "codex-mcp.schema.json").read_text(encoding="utf-8"))
        server = {"command": "python3", "args": ["./runtime/launch.py"]}
        for cwd, ok in ((".", True), ("./runtime", True), ("/tmp", False), ("..", False)):
            document = {"mcpServers": {"visionset": dict(server, cwd=cwd)}}
            with self.subTest(cwd=cwd):
                self.assertEqual(check(document, schema, schema) == [], ok)
        missing = {"mcpServers": {"visionset": server}}
        self.assertNotEqual(check(missing, schema, schema), [])

    def test_an_unsupported_keyword_is_an_error_not_a_pass(self) -> None:
        with self.assertRaises(SchemaError):
            check({}, {"oneOf": []}, {})


if __name__ == "__main__":
    unittest.main()
