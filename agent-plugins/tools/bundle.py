"""The VisionSet agent-plugin bundle: `bundle.toml` plus `VERSION`, rendered for each client.

Everything a client reads from the plugin root is produced by `render`. The manifests are
committed so a repository install needs no build step, and `render_manifests.py --check`
holds the committed bytes to what this module produces.
"""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
PLUGIN_ROOT = REPO / "agent-plugins" / "packages" / "visionset"
BUNDLE_TOML = PLUGIN_ROOT / "bundle.toml"
VERSION_FILE = REPO / "VERSION"

CLAUDE_MANIFEST = ".claude-plugin/plugin.json"
CODEX_MANIFEST = ".codex-plugin/plugin.json"
CLAUDE_MCP = ".mcp.json"
CODEX_MCP = "codex.mcp.json"
GENERATED = (CLAUDE_MANIFEST, CODEX_MANIFEST, CLAUDE_MCP, CODEX_MCP)

ADAPTERS = ("claude-code", "codex")
COMPATIBILITY_RULES = ("exact",)

# The same mapping `scripts/sync_versions.mjs` applies to the frontend packages, so the
# plugin and the npm packages carry one spelling of a release.
_PEP440 = re.compile(r"^(\d+\.\d+\.\d+)(?:\.?(dev|a|b|rc)(\d+))?$")
_PRERELEASE = {"a": "alpha", "b": "beta", "rc": "rc", "dev": "dev"}


class BundleError(ValueError):
    pass


@dataclass(frozen=True)
class Bundle:
    name: str
    display_name: str
    description: str
    publisher: str
    license: str
    homepage: str
    repository: str
    keywords: tuple[str, ...]
    distribution: str
    console_script: str
    requires_python: str
    compatibility: str
    launcher: str
    interpreter: str
    adapters: tuple[str, ...]


def plugin_version(pep440: str) -> str:
    match = _PEP440.match(pep440)
    if match is None:
        raise BundleError(
            f"VERSION {pep440!r} is not X.Y.Z, X.Y.Z.devN, X.Y.ZaN, X.Y.ZbN or X.Y.ZrcN"
        )
    base, tag, number = match.groups()
    return base if tag is None else f"{base}-{_PRERELEASE[tag]}.{number}"


def read_version(path: Path = VERSION_FILE) -> str:
    return path.read_text(encoding="utf-8").strip()


_TABLES: dict[str, dict[str, type]] = {
    "plugin": {
        "name": str,
        "display_name": str,
        "description": str,
        "publisher": str,
        "license": str,
        "homepage": str,
        "repository": str,
        "keywords": list,
    },
    "runtime": {
        "distribution": str,
        "console_script": str,
        "requires_python": str,
        "compatibility": str,
        "launcher": str,
        "interpreter": str,
    },
    "clients": {"adapters": list},
}


def parse_bundle(data: dict[str, Any]) -> Bundle:
    unknown = set(data) - set(_TABLES)
    if unknown:
        raise BundleError(f"bundle.toml: unknown table(s) {sorted(unknown)}")
    values: dict[str, Any] = {}
    for table, fields in _TABLES.items():
        section = data.get(table)
        if not isinstance(section, dict):
            raise BundleError(f"bundle.toml: missing [{table}]")
        extra = set(section) - set(fields)
        if extra:
            raise BundleError(f"bundle.toml: unknown key(s) in [{table}]: {sorted(extra)}")
        for key, kind in fields.items():
            if key not in section:
                raise BundleError(f"bundle.toml: [{table}] {key} is required")
            value = section[key]
            if kind is str:
                if not isinstance(value, str) or not value.strip():
                    raise BundleError(f"bundle.toml: [{table}] {key} must be a non-empty string")
                values[key] = value
            else:
                if not isinstance(value, list) or not value:
                    raise BundleError(f"bundle.toml: [{table}] {key} must be a non-empty list")
                if not all(isinstance(item, str) and item for item in value):
                    raise BundleError(f"bundle.toml: [{table}] {key} must list non-empty strings")
                values[key] = tuple(value)
    if values["compatibility"] not in COMPATIBILITY_RULES:
        raise BundleError(f"bundle.toml: compatibility must be one of {list(COMPATIBILITY_RULES)}")
    if set(values["adapters"]) - set(ADAPTERS):
        raise BundleError(f"bundle.toml: adapters must be drawn from {list(ADAPTERS)}")
    launcher = values["launcher"]
    if launcher.startswith(("/", "./")) or ".." in Path(launcher).parts:
        raise BundleError(
            "bundle.toml: launcher is a path relative to the plugin root, without ./ or .."
        )
    return Bundle(**values)


def load_bundle(path: Path = BUNDLE_TOML) -> Bundle:
    with path.open("rb") as handle:
        return parse_bundle(tomllib.load(handle))


def _dump(document: dict[str, Any]) -> str:
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def _metadata(bundle: Bundle, version: str) -> dict[str, Any]:
    return {
        "name": bundle.name,
        "version": version,
        "description": bundle.description,
        "author": {"name": bundle.publisher},
        "homepage": bundle.homepage,
        "repository": bundle.repository,
        "license": bundle.license,
        "keywords": list(bundle.keywords),
    }


def render(bundle: Bundle, pep440: str) -> dict[str, str]:
    """Every generated file, keyed by its path relative to the plugin root."""
    version = plugin_version(pep440)
    metadata = _metadata(bundle, version)
    claude = {"name": bundle.name, "displayName": bundle.display_name}
    claude.update({key: value for key, value in metadata.items() if key != "name"})
    codex = dict(metadata, skills="./skills/", mcpServers=f"./{CODEX_MCP}")
    # Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} in args and starts the server in the
    # project directory. Codex substitutes nothing and resolves `cwd` against its cached
    # copy of the plugin root, so its launcher path is relative to that.
    claude_server = {
        "command": bundle.interpreter,
        "args": [f"${{CLAUDE_PLUGIN_ROOT}}/{bundle.launcher}"],
    }
    codex_server = {"command": bundle.interpreter, "args": [f"./{bundle.launcher}"], "cwd": "."}
    files = {
        CLAUDE_MANIFEST: _dump(claude),
        CODEX_MANIFEST: _dump(codex),
        CLAUDE_MCP: _dump({"mcpServers": {bundle.name: claude_server}}),
        CODEX_MCP: _dump({"mcpServers": {bundle.name: codex_server}}),
    }
    if "claude-code" not in bundle.adapters:
        del files[CLAUDE_MANIFEST], files[CLAUDE_MCP]
    if "codex" not in bundle.adapters:
        del files[CODEX_MANIFEST], files[CODEX_MCP]
    return files


def stale(root: Path, files: dict[str, str]) -> list[str]:
    """Generated paths whose committed bytes differ from `files`, or that are missing."""
    out = []
    for relative, text in files.items():
        target = root / relative
        if not target.is_file() or target.read_text(encoding="utf-8") != text:
            out.append(relative)
    for relative in GENERATED:
        if relative not in files and (root / relative).exists():
            out.append(relative)
    return sorted(out)
