"""``visionset schema draft`` — the sitting you can put down."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from tests.cli._flow import ok, payload, run, workspace

from visionset.kernel.services import WORKSPACE_ENV_VAR


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
    path = tmp_path / "draft.json"
    path.write_text(json.dumps({"classes": classes}), encoding="utf-8")
    return path


def test_show_on_a_project_with_no_draft_says_so(root: Path) -> None:
    result = run(root, "schema", "draft", "show", "-p", "road-signs")
    assert result.exit_code == 0
    assert "no curated draft" in result.stderr.lower()


def test_set_then_show_round_trips_a_half_typed_class(root: Path, tmp_path: Path) -> None:
    document = _document(tmp_path, [{"name": "car"}, {"name": ""}])
    assert ok(root, "schema", "draft", "set", str(document), "-p", "road-signs")
    body = payload(root, "schema", "draft", "show", "-p", "road-signs")
    assert body["revision"] == 1
    assert [c["name"] for c in body["classes"]] == ["car", ""]


def test_set_twice_advances_the_revision(root: Path, tmp_path: Path) -> None:
    document = _document(tmp_path, [{"name": "car"}])
    ok(root, "schema", "draft", "set", str(document), "-p", "road-signs")
    ok(root, "schema", "draft", "set", str(document), "-p", "road-signs", "--revision", "1")
    body = payload(root, "schema", "draft", "show", "-p", "road-signs")
    assert body["revision"] == 2


def test_a_bare_set_against_an_existing_draft_is_refused_and_names_the_revision(
    root: Path, tmp_path: Path
) -> None:
    # A writer that never read a revision has, by definition, not seen what it
    # is about to overwrite — the draft is shared with nobody attributed to it,
    # so a quiet overwrite here is exactly the client the refusal exists to stop.
    document = _document(tmp_path, [{"name": "car"}])
    ok(root, "schema", "draft", "set", str(document), "-p", "road-signs")
    result = run(root, "schema", "draft", "set", str(document), "-p", "road-signs")
    assert result.exit_code != 0
    assert "already has a curated schema draft at revision 1" in result.stderr
    assert "None" not in result.stderr


def test_publish_creates_the_version_and_clears_the_draft(root: Path, tmp_path: Path) -> None:
    document = _document(tmp_path, [{"name": "car", "geometries": ["bbox"]}])
    ok(root, "schema", "draft", "set", str(document), "-p", "road-signs")
    result = run(root, "schema", "draft", "publish", "-p", "road-signs")
    assert result.exit_code == 0, result.output
    assert result.stdout.strip().endswith("1")
    assert (
        "has no curated draft"
        in run(root, "schema", "draft", "show", "-p", "road-signs").stderr.lower()
    )


def test_publishing_an_unfinished_class_fails_and_names_it(root: Path, tmp_path: Path) -> None:
    document = _document(tmp_path, [{"name": ""}])
    ok(root, "schema", "draft", "set", str(document), "-p", "road-signs")
    result = run(root, "schema", "draft", "publish", "-p", "road-signs")
    assert result.exit_code != 0
    assert "classes.0" in result.stdout + result.stderr


def test_clear_removes_it(root: Path, tmp_path: Path) -> None:
    document = _document(tmp_path, [{"name": "car"}])
    ok(root, "schema", "draft", "set", str(document), "-p", "road-signs")
    assert ok(root, "schema", "draft", "clear", "-p", "road-signs") == ""
    assert (
        "has no curated draft"
        in run(root, "schema", "draft", "show", "-p", "road-signs").stderr.lower()
    )
