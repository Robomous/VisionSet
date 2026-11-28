"""Validate the committed client manifests against `agent-plugins/schemas/` and the plugin root.

    python3 agent-plugins/tools/validate_manifests.py

The schemas use a small subset of JSON Schema 2020-12, and the subset is enforced: a
keyword this module does not implement is an error rather than a silent pass. The clients'
own validators (`claude plugin validate`) are a separate, later gate.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

from bundle import (
    CLAUDE_MANIFEST,
    CLAUDE_MCP,
    CODEX_MANIFEST,
    CODEX_MCP,
    GENERATED,
    PLUGIN_ROOT,
    REPO,
    RUNTIME_BUNDLE,
)

SCHEMAS = REPO / "agent-plugins" / "schemas"
SCHEMA_FOR = {
    CLAUDE_MANIFEST: "claude-plugin.schema.json",
    CODEX_MANIFEST: "codex-plugin.schema.json",
    CLAUDE_MCP: "claude-mcp.schema.json",
    CODEX_MCP: "codex-mcp.schema.json",
    RUNTIME_BUNDLE: "runtime-bundle.schema.json",
}

_ANNOTATIONS = {"$schema", "$id", "$comment", "$defs", "title", "description"}
_KEYWORDS = {
    "type",
    "required",
    "properties",
    "additionalProperties",
    "items",
    "pattern",
    "minLength",
    "const",
    "enum",
    "minimum",
    "$ref",
}
_TYPES: dict[str, tuple[type, ...]] = {
    "object": (dict,),
    "array": (list,),
    "string": (str,),
    "boolean": (bool,),
    "integer": (int,),
    "number": (int, float),
}


class SchemaError(Exception):
    pass


def _is(value: Any, kind: str) -> bool:
    if kind not in _TYPES:
        raise SchemaError(f"unsupported type {kind!r}")
    if isinstance(value, bool) and kind in ("integer", "number"):
        return False
    return isinstance(value, _TYPES[kind])


def check(value: Any, schema: dict[str, Any], root: dict[str, Any], at: str = "$") -> list[str]:
    unsupported = set(schema) - _KEYWORDS - _ANNOTATIONS
    if unsupported:
        raise SchemaError(f"{at}: unsupported schema keyword(s) {sorted(unsupported)}")
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/$defs/"):
            raise SchemaError(f"{at}: only local #/$defs/ references are supported, got {ref!r}")
        return check(value, root["$defs"][ref.removeprefix("#/$defs/")], root, at)
    errors: list[str] = []
    if "type" in schema and not _is(value, schema["type"]):
        return [f"{at}: expected {schema['type']}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{at}: must be {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{at}: must be one of {schema['enum']!r}")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{at}: shorter than {schema['minLength']}")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            errors.append(f"{at}: does not match {schema['pattern']!r}")
    if "minimum" in schema and isinstance(value, (int, float)) and value < schema["minimum"]:
        errors.append(f"{at}: below {schema['minimum']}")
    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            errors += check(item, schema["items"], root, f"{at}[{index}]")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{at}: missing {key!r}")
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in properties:
                errors += check(item, properties[key], root, f"{at}.{key}")
            elif extra is False:
                errors.append(f"{at}: unexpected key {key!r}")
            elif isinstance(extra, dict):
                errors += check(item, extra, root, f"{at}.{key}")
    return errors


def _relative_paths(document: Any) -> list[str]:
    found: list[str] = []
    if isinstance(document, dict):
        for item in document.values():
            found += _relative_paths(item)
    elif isinstance(document, list):
        for item in document:
            found += _relative_paths(item)
    elif isinstance(document, str):
        for prefix in ("./", "${CLAUDE_PLUGIN_ROOT}/"):
            if document.startswith(prefix):
                found.append(document.removeprefix(prefix))
    return found


def contained(root: Path, document: Any) -> list[str]:
    """Every plugin-relative path a document names exists inside `root`."""
    errors = []
    resolved_root = root.resolve()
    for relative in _relative_paths(document):
        target = (root / relative).resolve()
        if ".." in Path(relative).parts or not target.is_relative_to(resolved_root):
            errors.append(f"{relative!r} escapes the plugin root")
        elif not target.exists():
            errors.append(f"{relative!r} does not exist in the plugin root")
    return errors


def symlinks(root: Path) -> list[str]:
    """Clients drop a link that leaves the root when they copy a plugin, so none is allowed."""
    return sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_symlink())


def validate(root: Path = PLUGIN_ROOT, schemas: Path = SCHEMAS) -> list[str]:
    errors = [f"symlink in the plugin root: {path}" for path in symlinks(root)]
    for relative in GENERATED:
        target = root / relative
        if not target.is_file():
            errors.append(f"{relative}: missing")
            continue
        document = json.loads(target.read_text(encoding="utf-8"))
        schema = json.loads((schemas / SCHEMA_FOR[relative]).read_text(encoding="utf-8"))
        errors += [f"{relative}: {message}" for message in check(document, schema, schema)]
        errors += [f"{relative}: {message}" for message in contained(root, document)]
    return errors


def main() -> int:
    errors = validate()
    for message in errors:
        print(f"error: {message}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
