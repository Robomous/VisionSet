"""``visionset schema apply`` — a JSON document, refused in the right place.

Three failure modes and three exit codes, which is the point of the module: a
file that is not JSON and a document the domain will not accept are **usage**
errors at exit 2, while a change the *project's history* refuses is a domain
error at exit 1. Only the last is a ``VisionSetError``, and only the last can be
retried with a flag.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from tests.cli._flow import (
    SCHEMA_DOCUMENT,
    ok,
    payload,
    run,
    schema_file,
    usage_error,
    workspace,
)

from visionset.kernel.services import WORKSPACE_ENV_VAR
from visionset.server.models import SchemaVersionCreate


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    root = workspace(tmp_path)
    ok(root, "project", "create", "road-signs")
    return root


def _document(tmp_path: Path, classes: list[dict]) -> Path:
    path = tmp_path / "custom.json"
    path.write_text(json.dumps({"classes": classes}), encoding="utf-8")
    return path


# --- applying ----------------------------------------------------------------


def test_apply_creates_version_one(root: Path, tmp_path: Path) -> None:
    assert ok(root, "schema", "apply", str(schema_file(tmp_path)), "-p", "road-signs") == "1"


def test_applying_again_creates_the_next_version(root: Path, tmp_path: Path) -> None:
    # Versions are 1..N and none of them changes, so an unchanged document still
    # adds one — there is no edit and no rollback.
    file = schema_file(tmp_path)
    ok(root, "schema", "apply", str(file), "-p", "road-signs")
    assert ok(root, "schema", "apply", str(file), "-p", "road-signs") == "2"


def test_the_classes_survive_the_round_trip(root: Path, tmp_path: Path) -> None:
    document = payload(root, "schema", "apply", str(schema_file(tmp_path)), "-p", "road-signs")
    assert [c["name"] for c in document["classes"]] == ["sign"]
    assert document["classes"][0]["attributes"][0]["name"] == "occluded"


def test_apply_records_the_version_as_curated(root: Path, tmp_path: Path) -> None:
    """Applying an authored document from a file is the curated act by construction.

    Asserted through ``--json`` rather than by reading the database, because the
    projection is what a caller can actually see — and it is the same field the
    REST wire publishes.
    """
    document = payload(root, "schema", "apply", str(schema_file(tmp_path)), "-p", "road-signs")
    assert document["provenance"] == "curated"


def test_the_same_document_is_a_valid_request_body(tmp_path: Path) -> None:
    # The cross-surface claim, tested rather than promised: one schema file works
    # against ``visionset schema apply`` and against
    # ``POST /projects/{id}/schema/versions``.
    SchemaVersionCreate.model_validate(SCHEMA_DOCUMENT)


# --- refusing a bad file: exit 2 ---------------------------------------------


def test_a_file_that_is_not_json_exits_two(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Narrowed so the rich panel Typer renders a usage error in is *guaranteed*
    # to wrap the message — see the sibling in ``test_ingest_commands.py`` and
    # ``usage_error`` itself for why an unforced wrap point is not a test (#535).
    monkeypatch.setenv("COLUMNS", "40")
    path = tmp_path / "broken.json"
    path.write_text("{not json", encoding="utf-8")
    result = run(root, "schema", "apply", str(path), "-p", "road-signs")
    assert result.exit_code == 2, result.output
    assert "not valid JSON" in usage_error(result)


def test_a_document_with_no_classes_key_exits_two(root: Path, tmp_path: Path) -> None:
    path = tmp_path / "empty.json"
    path.write_text(json.dumps({"labels": []}), encoding="utf-8")
    result = run(root, "schema", "apply", str(path), "-p", "road-signs")
    assert result.exit_code == 2, result.output
    assert "classes" in usage_error(result)


def test_a_file_that_is_not_there_exits_two(root: Path, tmp_path: Path) -> None:
    result = run(root, "schema", "apply", str(tmp_path / "absent.json"), "-p", "road-signs")
    assert result.exit_code == 2, result.output


def test_a_select_with_no_options_exits_two_in_the_domains_words(
    root: Path, tmp_path: Path
) -> None:
    # The document parses *through* ``LabelClass``, so the kernel's own validator
    # is what refuses — nothing about attributes is restated in the CLI.
    path = _document(
        tmp_path,
        [
            {
                "name": "sign",
                "geometry": "bbox",
                "attributes": [{"name": "condition", "kind": "select"}],
            }
        ],
    )
    result = run(root, "schema", "apply", str(path), "-p", "road-signs")
    assert result.exit_code == 2, result.output
    assert "options" in usage_error(result)


def test_a_blank_class_name_exits_two_and_says_where(root: Path, tmp_path: Path) -> None:
    path = _document(tmp_path, [{"name": "   ", "geometry": "bbox"}])
    result = run(root, "schema", "apply", str(path), "-p", "road-signs")
    assert result.exit_code == 2, result.output
    assert "classes.0.name" in usage_error(result)


def test_an_unimplemented_geometry_exits_one(root: Path, tmp_path: Path) -> None:
    # ``mask`` is a legal ``GeometryType`` member, so the document parses; it is
    # the *service* that refuses it. A domain refusal, therefore exit 1.
    path = _document(tmp_path, [{"name": "road", "geometry": "mask"}])
    result = run(root, "schema", "apply", str(path), "-p", "road-signs")
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


# --- refusing a narrowing change: exit 1, retryable with a flag ---------------


def test_removing_a_class_exits_one_until_the_flag(root: Path, tmp_path: Path) -> None:
    ok(root, "schema", "apply", str(schema_file(tmp_path)), "-p", "road-signs")
    narrowed = _document(tmp_path, [{"name": "lane", "geometry": "bbox"}])
    refused = run(root, "schema", "apply", str(narrowed), "-p", "road-signs")
    assert refused.exit_code == 1, refused.output
    assert ok(root, "schema", "apply", str(narrowed), "-p", "road-signs", "--allow-destructive")


# --- list --------------------------------------------------------------------


def test_list_is_empty_for_a_schemaless_project(root: Path) -> None:
    result = run(root, "schema", "list", "-p", "road-signs")
    assert result.stdout.splitlines() == ["VERSION  CLASSES  GEOMETRIES"]
    assert "no schema yet" in result.stderr


def test_list_names_each_versions_geometries(root: Path, tmp_path: Path) -> None:
    ok(root, "schema", "apply", str(schema_file(tmp_path)), "-p", "road-signs")
    rows = ok(root, "schema", "list", "-p", "road-signs").splitlines()
    assert rows[1].split() == ["1", "1", "bbox"]


def test_list_json_is_the_envelope(root: Path, tmp_path: Path) -> None:
    ok(root, "schema", "apply", str(schema_file(tmp_path)), "-p", "road-signs")
    document = payload(root, "schema", "list", "-p", "road-signs")
    assert document["total"] == 1
    assert document["items"][0]["version"] == 1
