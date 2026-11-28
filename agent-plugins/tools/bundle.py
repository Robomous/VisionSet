"""The VisionSet agent-plugin bundle: `metadata.json` plus `VERSION`, rendered for each client.

Everything a client reads from the plugin root is produced by `render`. The generated files
are committed so a repository install needs no build step, and `render_manifests.py --check`
holds the committed bytes to what this module produces.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
METADATA = REPO / "agent-plugins" / "metadata.json"
PLUGIN_ROOT = REPO / "agent-plugins" / "packages" / "visionset"
VERSION_FILE = REPO / "VERSION"

CLAUDE_MANIFEST = ".claude-plugin/plugin.json"
CODEX_MANIFEST = ".codex-plugin/plugin.json"
CLAUDE_MCP = ".mcp.json"
CODEX_MCP = "codex.mcp.json"
RUNTIME_BUNDLE = "runtime/bundle.json"
GENERATED = (CLAUDE_MANIFEST, CODEX_MANIFEST, CLAUDE_MCP, CODEX_MCP, RUNTIME_BUNDLE)

DISTRIBUTION = "visionset"
CONSOLE_SCRIPT = "visionset"
REQUIRES_PYTHON = ">=3.11"
INTERPRETER = "python3"
LAUNCHER = "runtime/launch.py"

# The compatibility range is a PEP 440 specifier rendered from VERSION. While the project is
# 0.0.x it is exactly the current version; widening it is a change to the architecture
# decision, not to metadata.json alone.
VERSION_PLACEHOLDER = "{VERSION}"
COMPATIBILITY_TEMPLATES = ("==" + VERSION_PLACEHOLDER,)

# The same mapping `scripts/sync_versions.mjs` applies to the frontend packages, so the
# plugin and the npm packages carry one spelling of a release.
_PEP440 = re.compile(r"^(\d+\.\d+\.\d+)(?:\.?(dev|a|b|rc)(\d+))?$")
_PRERELEASE = {"a": "alpha", "b": "beta", "rc": "rc", "dev": "dev"}

_FIELDS = ("name", "description", "license", "repository", "publisher", "compatibility")


class BundleError(ValueError):
    pass


@dataclass(frozen=True)
class Metadata:
    name: str
    description: str
    license: str
    repository: str
    publisher: str
    compatibility: str


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


def parse_metadata(data: Any) -> Metadata:
    if not isinstance(data, dict):
        raise BundleError("metadata.json: expected an object")
    extra = set(data) - set(_FIELDS)
    if extra:
        raise BundleError(f"metadata.json: unknown key(s) {sorted(extra)}")
    for key in _FIELDS:
        value = data.get(key)
        if not isinstance(value, str) or not value.strip():
            raise BundleError(f"metadata.json: {key} must be a non-empty string")
    if data["compatibility"] not in COMPATIBILITY_TEMPLATES:
        raise BundleError(
            f"metadata.json: compatibility must be one of {list(COMPATIBILITY_TEMPLATES)}"
        )
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", data["name"]):
        raise BundleError("metadata.json: name must be kebab-case")
    return Metadata(**{key: data[key] for key in _FIELDS})


def load_metadata(path: Path = METADATA) -> Metadata:
    return parse_metadata(json.loads(path.read_text(encoding="utf-8")))


def compatibility_range(metadata: Metadata, pep440: str) -> str:
    return metadata.compatibility.replace(VERSION_PLACEHOLDER, pep440)


def _dump(document: dict[str, Any]) -> str:
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def render(metadata: Metadata, pep440: str) -> dict[str, str]:
    """Every generated file, keyed by its path relative to the plugin root."""
    manifest = {
        "name": metadata.name,
        "version": plugin_version(pep440),
        "description": metadata.description,
        "author": {"name": metadata.publisher},
        "homepage": metadata.repository,
        "repository": metadata.repository,
        "license": metadata.license,
    }
    codex = dict(manifest, skills="./skills/", mcpServers=f"./{CODEX_MCP}")
    # Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} in args and starts the server in the
    # project directory. Codex substitutes nothing and resolves `cwd` against its cached
    # copy of the plugin root, so its launcher path is relative to that.
    claude_server = {"command": INTERPRETER, "args": [f"${{CLAUDE_PLUGIN_ROOT}}/{LAUNCHER}"]}
    codex_server = {"command": INTERPRETER, "args": [f"./{LAUNCHER}"], "cwd": "."}
    runtime = {
        "distribution": DISTRIBUTION,
        "console_script": CONSOLE_SCRIPT,
        "version": pep440,
        "compatibility": compatibility_range(metadata, pep440),
        "requires_python": REQUIRES_PYTHON,
    }
    return {
        CLAUDE_MANIFEST: _dump(manifest),
        CODEX_MANIFEST: _dump(codex),
        CLAUDE_MCP: _dump({"mcpServers": {metadata.name: claude_server}}),
        CODEX_MCP: _dump({"mcpServers": {metadata.name: codex_server}}),
        RUNTIME_BUNDLE: _dump(runtime),
    }


def stale(root: Path, files: dict[str, str]) -> list[str]:
    """Generated paths whose committed bytes differ from `files`, are missing, or are orphans."""
    out = []
    for relative, text in files.items():
        target = root / relative
        if not target.is_file() or target.read_text(encoding="utf-8") != text:
            out.append(relative)
    for relative in GENERATED:
        if relative not in files and (root / relative).exists():
            out.append(relative)
    return sorted(out)
