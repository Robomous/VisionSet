"""``visionset inference`` — configuring where a model runs, from a terminal.

The SDK-first claim for this slice: a workspace can be made ready for
auto-labeling without a browser. Every rung here is reached by running commands,
never by calling the SDK — the SDK appears only to read state back.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from tests.cli._flow import ok, payload, run, workspace

from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    InferenceConnectionService,
    WorkspaceService,
)

LOCAL = (
    "inference",
    "create",
    "local-gd",
    "--type",
    "local",
    "--model",
    "some/model",
    "--revision",
    "abc123",
    "--device",
    "cpu",
    "--precision",
    "fp16",
)

HTTP = (
    "inference",
    "create",
    "remote",
    "--type",
    "http",
    "--model",
    "some/model",
    "--revision",
    "abc123",
    "--endpoint",
    "https://example.invalid/predict",
)


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


def _stored(root: Path) -> list[str]:
    with WorkspaceService.open(root) as service:
        return [one.name for one in InferenceConnectionService(service).list()]


# --- create -------------------------------------------------------------------


def test_create_writes_the_connection(root: Path) -> None:
    ok(root, *LOCAL)
    assert _stored(root) == ["local-gd"]


def test_the_new_id_is_the_only_thing_on_stdout(root: Path) -> None:
    result = run(root, *LOCAL)
    assert result.stdout.strip().count("\n") == 0
    assert "Created local connection" in result.stderr


def test_parameters_that_do_not_match_the_kind_exit_one(root: Path) -> None:
    result = run(
        root, "inference", "create", "x", "--type", "local", "--model", "m", "--revision", "r"
    )
    assert result.exit_code == 1, result.output
    assert result.stdout == ""
    assert "Error:" in result.stderr


def test_a_blank_name_exits_one(root: Path) -> None:
    result = run(
        root,
        "inference",
        "create",
        "   ",
        "--type",
        "http",
        "--model",
        "m",
        "--revision",
        "r",
        "--endpoint",
        "https://example.invalid",
    )
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


def test_a_taken_name_exits_one(root: Path) -> None:
    """Case-insensitively, which is the half a naive uniqueness check misses."""
    ok(root, *LOCAL)
    result = run(
        root,
        "inference",
        "create",
        "LOCAL-GD",
        "--type",
        "http",
        "--model",
        "m",
        "--revision",
        "r",
        "--endpoint",
        "https://example.invalid",
    )
    assert result.exit_code == 1, result.output
    assert "already exists" in result.stderr


# --- list ---------------------------------------------------------------------


def test_list_leads_with_the_id(root: Path) -> None:
    created = ok(root, *LOCAL)
    rows = ok(root, "inference", "list").splitlines()
    assert rows[0].split() == ["ID", "NAME", "TYPE", "MODEL", "SETUP"]
    assert rows[1].split()[0] == created


def test_an_empty_listing_still_prints_its_header(root: Path) -> None:
    result = run(root, "inference", "list")
    assert result.stdout.splitlines() == ["ID  NAME  TYPE  MODEL  SETUP"]
    assert "No inference connections" in result.stderr


def test_list_json_is_the_envelope(root: Path) -> None:
    ok(root, *LOCAL)
    ok(root, *HTTP)
    document = payload(root, "inference", "list")
    assert set(document) == {"items", "total"}
    assert document["total"] == 2
    assert [one["name"] for one in document["items"]] == ["local-gd", "remote"]


def test_json_puts_nothing_on_stdout_but_the_document(root: Path) -> None:
    result = run(root, *LOCAL, "--json")
    json.loads(result.stdout)
    assert result.stderr == ""


# --- show ---------------------------------------------------------------------


def test_show_resolves_by_name_or_by_id(root: Path) -> None:
    created = ok(root, *LOCAL)
    assert payload(root, "inference", "show", "local-gd")["id"] == created
    assert payload(root, "inference", "show", created)["name"] == "local-gd"


def test_show_declares_what_this_slice_can_perform(root: Path) -> None:
    """The declaration reaches the terminal, identical to the REST answer."""
    ok(root, *LOCAL)
    assert payload(root, "inference", "show", "local-gd")["allowed_actions"] == [
        "update",
        "delete",
    ]


def test_an_unknown_connection_exits_one(root: Path) -> None:
    result = run(root, "inference", "show", "nothing-here")
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


# --- update -------------------------------------------------------------------


def test_update_changes_only_what_is_named(root: Path) -> None:
    ok(root, *LOCAL, "--json")
    ok(root, "inference", "update", "local-gd", "--revision", "deadbeef")
    shown = payload(root, "inference", "show", "local-gd")
    assert shown["model_revision"] == "deadbeef"
    assert shown["device"] == "cpu"
    assert shown["model_id"] == "some/model"


def test_an_edit_the_kind_refuses_exits_one(root: Path) -> None:
    ok(root, *LOCAL)
    result = run(root, "inference", "update", "local-gd", "--endpoint", "https://example.invalid")
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


# --- delete -------------------------------------------------------------------


def test_delete_removes_it(root: Path) -> None:
    ok(root, *LOCAL)
    ok(root, "inference", "delete", "local-gd", "--yes")
    assert _stored(root) == []


def test_delete_says_what_survives(root: Path) -> None:
    """The blast radius is stated where somebody is about to act on it."""
    ok(root, *LOCAL)
    result = run(root, "inference", "delete", "local-gd", "--yes")
    assert "Deleted connection" in result.stderr


def test_declining_the_prompt_keeps_the_connection(root: Path) -> None:
    ok(root, *LOCAL)
    result = run(root, "inference", "delete", "local-gd")
    assert result.exit_code != 0
    assert _stored(root) == ["local-gd"]
