"""``create_project`` / ``list_projects`` / ``get_project`` / ``delete_project``."""

from __future__ import annotations

from pathlib import Path

import pytest
from tests.mcp._flow import call, call_destructive, error, ingested, payload, project, workspace

from visionset.kernel.services import ProjectService, WorkspaceService


def test_creating_a_project_returns_it_with_the_dataset_that_is_its_trunk(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace(monkeypatch, tmp_path)
    result = payload(call("create_project", name="road-signs", description="signage"))
    assert result["project"]["name"] == "road-signs"
    assert result["project"]["description"] == "signage"
    # The dataset id is folded in precisely so an agent never has to fetch it.
    assert result["dataset"]["project_id"] == result["project"]["id"]


def test_a_project_name_collides_case_insensitively(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project(monkeypatch, tmp_path)
    refusal = error(call("create_project", name="ROAD-SIGNS"))
    assert "road-signs" in refusal["message"]
    assert refusal["retry_with"] is None


def test_a_blank_name_is_refused_in_the_envelope(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace(monkeypatch, tmp_path)
    assert error(call("create_project", name="   "))["message"]


def test_listing_an_empty_workspace_is_a_collection_and_not_an_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace(monkeypatch, tmp_path)
    assert payload(call("list_projects")) == {"items": [], "total": 0}


def test_a_project_is_reachable_by_name_and_by_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    by_name = payload(call("get_project", project=named))
    by_id = payload(call("get_project", project=by_name["project"]["id"]))
    assert by_name == by_id


def test_a_project_name_differing_only_in_case_still_resolves(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The opposite rule to a release tag, and both live in the kernel beside the
    # index that enforces them.
    project(monkeypatch, tmp_path)
    assert payload(call("get_project", project="ROAD-Signs"))["project"]["name"] == "road-signs"


def test_progress_counts_work_and_a_draft_batch_carries_none(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Progress is tallied over *jobs*, and approval is what creates them — so a
    # project whose only batch is still a draft reports zero even though it holds
    # three assets. That is the honest answer to "how much work is there", and it
    # is why `list_batches` carries `asset_count` separately.
    named, _ = ingested(monkeypatch, tmp_path, count=3)
    assert payload(call("get_project", project=named))["progress"]["total"] == 0


def test_get_project_reports_progress_once_a_batch_is_approved(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named, batch_id = ingested(monkeypatch, tmp_path, count=3)
    payload(call("approve_batch", batch_id=batch_id))
    progress = payload(call("get_project", project=named))["progress"]
    assert progress["total"] == 3
    assert progress["unannotated"] == 3


def test_an_unknown_project_is_refused_rather_than_invented(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace(monkeypatch, tmp_path)
    assert "nope" in error(call("get_project", project="nope"))["message"]


def test_delete_without_confirm_changes_nothing_and_names_the_flag(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "ws"
    named = project(monkeypatch, tmp_path)
    refusal = error(call_destructive("delete_project", project=named))
    assert refusal["retry_with"] == "confirm"
    # The refusal is only worth anything if the project is still there afterwards.
    with WorkspaceService.open(root) as service:
        assert [p.name for p in ProjectService(service).list()] == [named]


def test_delete_with_confirm_removes_the_project(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "ws"
    named = project(monkeypatch, tmp_path)
    assert (
        payload(call_destructive("delete_project", project=named, confirm=True))["deleted"]["name"]
        == named
    )
    with WorkspaceService.open(root) as service:
        assert ProjectService(service).list() == []


def test_deleting_something_that_is_not_there_says_so_with_or_without_confirm(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace(monkeypatch, tmp_path)
    for confirm in (False, True):
        assert (
            "nope"
            in error(call_destructive("delete_project", project="nope", confirm=confirm))["message"]
        )


def test_no_workspace_configured_is_refused_with_a_remedy_a_client_can_act_on(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The kernel's own sentence ends in "use WorkspaceService.init", a Python call
    # an agent cannot make; the hint names what whoever configured the server has
    # to do instead.
    monkeypatch.setenv("VISIONSET_WORKSPACE", str(tmp_path / "nothing-here"))
    monkeypatch.chdir(tmp_path)
    refusal = error(call("list_projects"))
    assert "VISIONSET_WORKSPACE" in (refusal["hint"] or "")
    assert "visionset mcp --workspace" in (refusal["hint"] or "")
