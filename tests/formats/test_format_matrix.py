"""The verification descriptor against the installed plugins and the tests it cites.

``verification.json`` is a set of claims: that a built-in format exists in a
direction, that it writes what it declares, and that a named test proves it.
Each claim is checked here against the thing it describes, so a plugin added
without an entry, an entry left behind by a removed plugin, a capability that
drifted, or a citation of a test that does not exist all fail the suite.
"""

from __future__ import annotations

import ast
import re
import tomllib
from functools import cache
from pathlib import Path
from typing import Any

import pytest

from visionset.formats.matrix import (
    COUNTING_GATES,
    EVIDENCE_KINDS,
    GATES,
    IMPLEMENTED,
    NO_RECORDED_EVIDENCE,
    VALIDATED,
    build,
    format_matrix,
    is_built_in,
    load_descriptor,
)
from visionset.formats.registry import ALIASES, exporters, importers
from visionset.kernel.domain import IMPLEMENTED_GEOMETRIES, GeometryType
from visionset.kernel.ports import supported_modalities_of

REPO_ROOT = Path(__file__).resolve().parents[2]

DESCRIPTOR = load_descriptor()
ENTRIES: dict[str, Any] = DESCRIPTOR["formats"]

BUILT_IN_EXPORTERS = {name: one for name, one in exporters().items() if is_built_in(one)}
BUILT_IN_IMPORTERS = {name: one for name, one in importers().items() if is_built_in(one)}

ENTRY_KEYS = {"task", "dialects", "export", "import"}
EXPORT_KEYS = {"lossy", "geometries", "degraded_geometries", "modalities", "evidence", "notes"}
IMPORT_KEYS = {"geometries", "modalities", "evidence", "notes"}
EVIDENCE_KEYS = {"kind", "test", "gate", "reader", "external", "requires"}
MODALITIES = {"image", "point_cloud"}

CITATIONS = [
    (name, direction, index, one)
    for name, entry in sorted(ENTRIES.items())
    for direction in ("export", "import")
    if entry[direction] is not None
    for index, one in enumerate(entry[direction]["evidence"])
]


@cache
def _test_functions(path: Path) -> frozenset[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return frozenset(
        node.name
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")
    )


@cache
def _format_smoke_files() -> frozenset[str]:
    """The test files CI's format-smoke job runs, read off its pytest line."""
    workflow = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    job = workflow.split("\n  format-smoke:\n", 1)[1].split("\n  # ", 1)[0]
    return frozenset(re.findall(r"tests/\S+\.py", job))


# --- the descriptor's own shape ---------------------------------------------------


def test_the_descriptor_is_versioned() -> None:
    assert isinstance(DESCRIPTOR["version"], int) and DESCRIPTOR["version"] >= 1
    assert set(DESCRIPTOR) == {"version", "formats"}


@pytest.mark.parametrize("name", sorted(ENTRIES))
def test_every_entry_uses_only_known_fields(name: str) -> None:
    entry = ENTRIES[name]
    assert set(entry) == ENTRY_KEYS, name
    assert entry["task"] and entry["dialects"], name
    assert entry["export"] is not None or entry["import"] is not None, name
    if entry["export"] is not None:
        assert set(entry["export"]) <= EXPORT_KEYS, name
        assert EXPORT_KEYS - {"notes"} <= set(entry["export"]), name
    if entry["import"] is not None:
        assert set(entry["import"]) <= IMPORT_KEYS, name
        assert IMPORT_KEYS - {"notes"} <= set(entry["import"]), name


# --- the descriptor against the installed plugins ---------------------------------


def test_every_installed_built_in_exporter_has_an_entry() -> None:
    missing = sorted(
        name for name in BUILT_IN_EXPORTERS if (ENTRIES.get(name) or {}).get("export") is None
    )
    assert missing == []


def test_every_installed_built_in_importer_has_an_entry() -> None:
    missing = sorted(
        name for name in BUILT_IN_IMPORTERS if (ENTRIES.get(name) or {}).get("import") is None
    )
    assert missing == []


@pytest.mark.parametrize("name", sorted(ENTRIES))
def test_every_entry_names_what_is_installed_in_each_direction(name: str) -> None:
    entry = ENTRIES[name]
    assert (entry["export"] is not None) == (name in BUILT_IN_EXPORTERS), name
    assert (entry["import"] is not None) == (name in BUILT_IN_IMPORTERS), name


@pytest.mark.parametrize("name", sorted(BUILT_IN_EXPORTERS))
def test_an_export_entry_says_what_the_plugin_declares(name: str) -> None:
    plugin = BUILT_IN_EXPORTERS[name]
    recorded = ENTRIES[name]["export"]
    assert recorded["lossy"] is plugin.lossy
    assert recorded["geometries"] == sorted(one.value for one in plugin.supported_geometries)
    assert recorded["degraded_geometries"] == sorted(
        one.value for one in plugin.degraded_geometries
    )
    assert recorded["modalities"] == sorted(supported_modalities_of(plugin))


@pytest.mark.parametrize("name", sorted(BUILT_IN_IMPORTERS))
def test_an_import_entry_records_geometries_the_domain_can_hold(name: str) -> None:
    recorded = ENTRIES[name]["import"]
    implemented = {one.value for one in IMPLEMENTED_GEOMETRIES}
    assert recorded["geometries"], name
    assert recorded["geometries"] == sorted(recorded["geometries"]), name
    assert set(recorded["geometries"]) <= implemented, name
    assert recorded["modalities"] and set(recorded["modalities"]) <= MODALITIES, name


# --- the evidence against the tests it cites ---------------------------------------


@pytest.mark.parametrize(
    ("name", "direction", "index", "evidence"),
    CITATIONS,
    ids=[f"{name}-{direction}-{index}" for name, direction, index, _ in CITATIONS],
)
def test_every_citation_names_a_test_that_exists(
    name: str, direction: str, index: int, evidence: dict[str, Any]
) -> None:
    assert set(evidence) <= EVIDENCE_KEYS
    assert evidence["kind"] in EVIDENCE_KINDS
    assert evidence["gate"] in GATES
    path, _, function = evidence["test"].partition("::")
    assert path.startswith("tests/") and function, evidence["test"]
    module = REPO_ROOT / path
    assert module.is_file(), path
    assert function in _test_functions(module), evidence["test"]


@pytest.mark.parametrize(
    ("name", "direction", "index", "evidence"),
    [one for one in CITATIONS if one[3]["kind"] == "independent_reader"],
)
def test_an_independent_reader_is_named_and_says_whether_it_is_external(
    name: str, direction: str, index: int, evidence: dict[str, Any]
) -> None:
    assert evidence["reader"]
    assert isinstance(evidence["external"], bool)


def test_reader_fields_belong_to_independent_readers_only() -> None:
    stray = [
        one["test"]
        for _, _, _, one in CITATIONS
        if one["kind"] != "independent_reader" and ({"reader", "external"} & set(one))
    ]
    assert stray == []


def test_an_optional_requirement_is_a_dependency_group_kept_out_of_dev() -> None:
    groups = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))[
        "dependency-groups"
    ]
    required = {one["requires"] for _, _, _, one in CITATIONS if "requires" in one}
    assert required
    assert required <= set(groups) - {"dev"}


def test_format_smoke_evidence_is_a_file_that_job_runs_and_needs_its_group() -> None:
    smoke = [one for _, _, _, one in CITATIONS if one["gate"] == "format-smoke"]
    assert smoke
    for one in smoke:
        assert one["test"].partition("::")[0] in _format_smoke_files(), one["test"]
        assert one.get("requires"), one["test"]


def test_a_test_with_an_optional_requirement_is_never_cited_under_the_default_gate() -> None:
    misgated = [
        one["test"] for _, _, _, one in CITATIONS if "requires" in one and one["gate"] == "python"
    ]
    assert misgated == []


def test_no_citation_claims_a_schema_check_nothing_performs() -> None:
    """No built-in is validated against a published schema yet; an entry saying so is false."""
    assert [one["test"] for _, _, _, one in CITATIONS if one["kind"] == "schema"] == []


# --- the matrix ------------------------------------------------------------------


def test_every_installed_plugin_is_one_row_per_direction() -> None:
    matrix = format_matrix()
    keys = [(row.format, row.direction) for row in matrix.rows]
    assert len(keys) == len(set(keys))
    assert sorted(keys) == sorted(
        [(name, "export") for name in exporters()] + [(name, "import") for name in importers()]
    )
    assert matrix.descriptor_version == DESCRIPTOR["version"]


def test_every_built_in_row_is_validated_by_a_test_ci_runs() -> None:
    rows = [row for row in format_matrix().rows if row.format in ENTRIES]
    assert rows
    for row in rows:
        assert row.status == VALIDATED, (row.format, row.direction)
        assert any(one.gate in COUNTING_GATES for one in row.evidence)


def test_availability_names_the_direction_a_format_lacks() -> None:
    rows = {(row.format, row.direction): row for row in format_matrix().rows}
    assert rows[("coco", "export")].availability == "both"
    assert rows[("tusimple", "export")].availability == "export_only"
    assert rows[("nuscenes", "import")].availability == "import_only"
    assert ("tusimple", "import") not in rows
    assert ("nuscenes", "export") not in rows


def test_an_alias_is_listed_on_the_format_it_resolves_to() -> None:
    rows = {(row.format, row.direction): row for row in format_matrix().rows}
    for alias, canonical in ALIASES.items():
        assert alias not in {row.format for row in rows.values()}
        assert alias in rows[(canonical, "export")].aliases
        assert alias in rows[(canonical, "import")].aliases


def test_a_geometry_is_supported_degraded_or_unsupported_and_never_two() -> None:
    implemented = {one.value for one in IMPLEMENTED_GEOMETRIES}
    for row in format_matrix().rows:
        if row.format not in ENTRIES:
            continue
        groups = (row.geometries, row.degraded_geometries, row.unsupported_geometries)
        assert sum(len(one) for one in groups) == len(set().union(*groups))
        assert set().union(*groups) == implemented, (row.format, row.direction)


def test_an_exporter_row_carries_the_plugin_s_own_declarations() -> None:
    installed = exporters()
    for row in format_matrix().rows:
        if row.direction != "export":
            continue
        plugin = installed[row.format]
        assert row.lossy is plugin.lossy
        assert row.geometries == tuple(sorted(one.value for one in plugin.supported_geometries))
        assert row.targets == tuple(sorted(one.name for one in plugin.targets))


def test_a_third_party_plugin_with_no_entry_has_no_recorded_evidence() -> None:
    rows = {(row.format, row.direction): row for row in format_matrix().rows}
    dummy = rows[("dummy", "export")]
    assert dummy.status == NO_RECORDED_EVIDENCE
    assert dummy.evidence == ()
    assert dummy.task is None and dummy.dialects == ()
    assert dummy.geometries


def test_a_third_party_plugin_under_a_built_in_name_inherits_no_evidence() -> None:
    class Impostor:
        format_name = "coco"
        lossy = False
        supported_geometries = frozenset({GeometryType.BBOX})
        degraded_geometries: frozenset[GeometryType] = frozenset()
        targets = exporters()["coco"].targets

        def export(self, *args: object, **kwargs: object) -> None:
            return None

        def read(self, src: Path) -> None:
            return None

    impostor = Impostor()
    (export_row, import_row) = build({"coco": impostor}, {"coco": impostor}).rows  # type: ignore[dict-item]
    for row in (export_row, import_row):
        assert row.status == NO_RECORDED_EVIDENCE
        assert row.evidence == ()
    assert import_row.geometries == () and import_row.unsupported_geometries == ()


def test_an_entry_whose_only_evidence_is_opt_in_is_implemented_not_validated() -> None:
    descriptor = {
        "version": 1,
        "formats": {
            "coco": {
                **ENTRIES["coco"],
                "export": {
                    **ENTRIES["coco"]["export"],
                    "evidence": [
                        {"kind": "round_trip", "test": "tests/x.py::test_x", "gate": "opt-in"}
                    ],
                },
            }
        },
    }
    (row,) = build({"coco": exporters()["coco"]}, {}, descriptor).rows
    assert row.status == IMPLEMENTED
