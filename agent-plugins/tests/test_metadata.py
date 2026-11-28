from __future__ import annotations

import json
import tomllib
import unittest
from collections.abc import Callable
from typing import Any

import _support
from bundle import (
    CLAUDE_MANIFEST,
    CODEX_MANIFEST,
    CONSOLE_SCRIPT,
    DISTRIBUTION,
    METADATA,
    PLUGIN_ROOT,
    REQUIRES_PYTHON,
    RUNTIME_BUNDLE,
    BundleError,
    load_metadata,
    parse_metadata,
    plugin_version,
    read_version,
)

PYPROJECT = tomllib.loads((_support.REPO / "pyproject.toml").read_text(encoding="utf-8"))


def generated(relative: str) -> dict[str, Any]:
    document: dict[str, Any] = json.loads((PLUGIN_ROOT / relative).read_text(encoding="utf-8"))
    return document


def metadata_data() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(METADATA.read_text(encoding="utf-8"))
    return data


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
                self.assertEqual(generated(relative)["version"], expected)

    def test_the_plugin_and_the_frontend_packages_spell_a_release_the_same_way(self) -> None:
        package = json.loads(
            (_support.REPO / "frontend" / "app" / "package.json").read_text(encoding="utf-8")
        )
        self.assertEqual(generated(CLAUDE_MANIFEST)["version"], package["version"])

    def test_metadata_names_no_version(self) -> None:
        text = METADATA.read_text(encoding="utf-8")
        version = read_version()
        self.assertNotIn(version, text)
        self.assertNotIn(plugin_version(version), text)

    def test_the_compatibility_range_is_exactly_the_current_version(self) -> None:
        runtime = generated(RUNTIME_BUNDLE)
        self.assertEqual(runtime["version"], read_version())
        self.assertEqual(runtime["compatibility"], f"=={read_version()}")


class PublisherTest(unittest.TestCase):
    def test_metadata_agrees_with_the_python_distribution(self) -> None:
        metadata = load_metadata()
        project = PYPROJECT["project"]
        self.assertEqual(metadata.publisher, project["authors"][0]["name"])
        self.assertEqual(metadata.license, project["license"])
        self.assertEqual(metadata.repository, project["urls"]["Homepage"])
        self.assertEqual(DISTRIBUTION, project["name"])
        self.assertIn(CONSOLE_SCRIPT, project["scripts"])
        self.assertEqual(REQUIRES_PYTHON, project["requires-python"])


class MetadataSchemaTest(unittest.TestCase):
    def test_unknown_keys_and_ranges_are_refused(self) -> None:
        mutations: list[Callable[[dict[str, Any]], object]] = [
            lambda data: data.update(version="1.0.0"),
            lambda data: data.update(compatibility="==0.0.1b4"),
            lambda data: data.update(compatibility="~={VERSION}"),
            lambda data: data.update(name="VisionSet"),
            lambda data: data.pop("license"),
            lambda data: data.update(publisher=" "),
        ]
        for index, mutate in enumerate(mutations):
            data = metadata_data()
            mutate(data)
            with self.subTest(mutation=index), self.assertRaises(BundleError):
                parse_metadata(data)


if __name__ == "__main__":
    unittest.main()
