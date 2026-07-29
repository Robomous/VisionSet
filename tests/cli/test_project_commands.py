"""``visionset project`` — creating, listing, and being addressable by name.

Name-or-id addressing is exercised here rather than in ``_resolve``'s own module,
because what matters is that a *command* accepts both.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from tests.cli._flow import ok, payload, run, workspace

from visionset.kernel.services import WORKSPACE_ENV_VAR, ProjectService, WorkspaceService


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


def _stored(root: Path) -> list[str]:
    with WorkspaceService.open(root) as service:
        return [p.name for p in ProjectService(service).list()]


# --- create ------------------------------------------------------------------


def test_create_writes_the_project(root: Path) -> None:
    ok(root, "project", "create", "road-signs")
    assert _stored(root) == ["road-signs"]


def test_the_new_id_is_the_only_thing_on_stdout(root: Path) -> None:
    result = run(root, "project", "create", "road-signs")
    assert result.stdout.strip().count("\n") == 0
    assert "Created project" in result.stderr


def test_create_carries_a_description(root: Path) -> None:
    assert (
        payload(root, "project", "create", "x", "--description", "field trial")["description"]
        == "field trial"
    )


def test_a_blank_name_exits_one(root: Path) -> None:
    result = run(root, "project", "create", "   ")
    assert result.exit_code == 1, result.output
    assert result.stdout == ""
    assert "Error:" in result.stderr


def test_a_repeated_name_exits_one(root: Path) -> None:
    ok(root, "project", "create", "road-signs")
    result = run(root, "project", "create", "ROAD-SIGNS")
    assert result.exit_code == 1, result.output
    assert _stored(root) == ["road-signs"]


# --- list --------------------------------------------------------------------


def test_list_leads_with_the_id(root: Path) -> None:
    # The rule the whole shell idiom rests on: ``awk '{print $1}'`` must be
    # stable even when a name holds internal whitespace, which normalization
    # deliberately preserves.
    created = ok(root, "project", "create", "road signs east")
    rows = ok(root, "project", "list").splitlines()
    assert rows[0].split() == ["ID", "NAME", "DESCRIPTION"]
    assert rows[1].split()[0] == created


def test_an_empty_listing_still_prints_its_header(root: Path) -> None:
    result = run(root, "project", "list")
    assert result.stdout.splitlines() == ["ID  NAME  DESCRIPTION"]
    assert "No projects" in result.stderr


def test_list_json_is_the_envelope(root: Path) -> None:
    ok(root, "project", "create", "a")
    ok(root, "project", "create", "b")
    document = payload(root, "project", "list")
    assert set(document) == {"items", "total"}
    assert document["total"] == 2
    assert [item["name"] for item in document["items"]] == ["a", "b"]


def test_an_empty_listing_json_is_an_object(root: Path) -> None:
    assert payload(root, "project", "list") == {"items": [], "total": 0}


def test_json_puts_nothing_on_stdout_but_the_document(root: Path) -> None:
    result = run(root, "project", "create", "a", "--json")
    json.loads(result.stdout)
    assert result.stderr == ""


# --- addressing --------------------------------------------------------------


def test_a_project_is_reachable_by_name(root: Path) -> None:
    ok(root, "project", "create", "road-signs")
    assert ok(root, "schema", "list", "--project", "road-signs") == "VERSION  CLASSES  GEOMETRIES"


def test_a_project_is_reachable_by_id(root: Path) -> None:
    created = ok(root, "project", "create", "road-signs")
    assert ok(root, "schema", "list", "--project", created) == "VERSION  CLASSES  GEOMETRIES"


def test_a_name_matches_ignoring_case(root: Path) -> None:
    # The comparison the unique index makes, and the reason ``get_by_name`` is a
    # kernel read rather than a scan written here.
    ok(root, "project", "create", "Road-Signs")
    assert run(root, "schema", "list", "--project", "road-SIGNS").exit_code == 0


def test_an_unknown_project_exits_one(root: Path) -> None:
    result = run(root, "schema", "list", "--project", "nope")
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr
