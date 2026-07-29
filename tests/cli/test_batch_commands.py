"""``visionset batch`` — the one-way lifecycle, and the gate into the trunk."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from tests.cli._flow import (
    completed_batch,
    ingested_batch,
    jobs_of,
    ok,
    payload,
    run,
    started_batch,
    workspace,
)

from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    DatasetService,
    ProjectService,
    WorkspaceService,
)


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


def _trunk_size(root: Path, name: str) -> int:
    with WorkspaceService.open(root) as service:
        project = ProjectService(service).get_by_name(name)
        dataset = ProjectService(service).get_dataset(project.id)
        return len(DatasetService(service).assets(dataset.id))


# --- list --------------------------------------------------------------------


def test_list_leads_with_the_id_and_names_the_state(root: Path, tmp_path: Path) -> None:
    name, batch = ingested_batch(root, tmp_path)
    rows = ok(root, "batch", "list", "-p", name).splitlines()
    assert rows[0].split() == ["ID", "NAME", "STATE", "SCHEMA", "ASSETS", "ANNOTATED", "SETTLED"]
    assert rows[1].split()[:5] == [batch, "stills", "draft", "-", "6"]


def test_a_draft_shows_no_pinned_schema(root: Path, tmp_path: Path) -> None:
    # Approval is what pins a version, and it never moves after — so a draft
    # showing one would be a claim nothing supports.
    name, _ = ingested_batch(root, tmp_path)
    assert payload(root, "batch", "list", "-p", name)["items"][0]["schema_version"] is None


def test_list_json_carries_the_progress_counts(root: Path, tmp_path: Path) -> None:
    name, _ = started_batch(root, tmp_path)
    progress = payload(root, "batch", "list", "-p", name)["items"][0]["progress"]
    assert progress == {
        "unannotated": 6,
        "annotated": 0,
        "skipped": 0,
        "review_pending": 0,
        "accepted": 0,
        "total": 6,
    }


def test_an_empty_listing_still_prints_its_header(root: Path, tmp_path: Path) -> None:
    ok(root, "project", "create", "empty")
    result = run(root, "batch", "list", "-p", "empty")
    assert len(result.stdout.splitlines()) == 1
    assert "no batches yet" in result.stderr


# --- approve -----------------------------------------------------------------


def test_approve_with_no_flag_cuts_one_job(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    result = run(root, "batch", "approve", batch)
    assert result.exit_code == 0, result.output
    assert "in 1 job(s)" in result.stderr
    assert len(jobs_of(root, batch)) == 1


def test_jobs_of_cuts_by_size(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    ok(root, "batch", "approve", batch, "--jobs-of", "3")
    assert len(jobs_of(root, batch)) == 2


def test_the_last_job_takes_the_remainder(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    ok(root, "batch", "approve", batch, "--jobs-of", "4")
    sizes = [
        int(line.split()[2]) for line in ok(root, "job", "list", "--batch", batch).splitlines()[1:]
    ]
    assert sizes == [4, 2]


def test_approve_pins_the_active_schema_version(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    assert payload(root, "batch", "approve", batch)["schema_version"] == 1


def test_jobs_of_zero_exits_two(root: Path, tmp_path: Path) -> None:
    # ``BySize.size`` is ``gt=0`` and a pydantic error would print a traceback,
    # so Click's ``min=1`` has to catch it first.
    _, batch = ingested_batch(root, tmp_path)
    result = run(root, "batch", "approve", batch, "--jobs-of", "0")
    assert result.exit_code == 2, result.output


def test_approving_twice_exits_one(root: Path, tmp_path: Path) -> None:
    # One-way: there is no route back to draft, because the jobs are already cut
    # against the pin.
    _, batch = ingested_batch(root, tmp_path)
    ok(root, "batch", "approve", batch)
    assert run(root, "batch", "approve", batch).exit_code == 1


def test_a_malformed_batch_id_exits_two(root: Path) -> None:
    # Click's ``UUID`` type, and the same call the API makes: a malformed id is
    # 422 rather than 404, because the request could not have named anything.
    assert run(root, "batch", "approve", "not-a-uuid").exit_code == 2


def test_an_unknown_batch_id_exits_one(root: Path) -> None:
    assert run(root, "batch", "approve", str(uuid4())).exit_code == 1


# --- start, complete ---------------------------------------------------------


def test_start_opens_an_approved_batch(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    ok(root, "batch", "approve", batch)
    assert payload(root, "batch", "start", batch)["state"] == "in_annotation"


def test_starting_a_draft_exits_one(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    assert run(root, "batch", "start", batch).exit_code == 1


def test_complete_with_an_outstanding_job_exits_one(root: Path, tmp_path: Path) -> None:
    # Derived means recomputed, not automatic.
    _, batch = started_batch(root, tmp_path)
    result = run(root, "batch", "complete", batch)
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


def test_complete_closes_a_finished_batch(root: Path, tmp_path: Path) -> None:
    name, _ = completed_batch(root, tmp_path)
    assert payload(root, "batch", "list", "-p", name)["items"][0]["state"] == "completed"


# --- promote -----------------------------------------------------------------


def test_promote_moves_the_finished_assets_into_the_trunk(root: Path, tmp_path: Path) -> None:
    name, batch = completed_batch(root, tmp_path)
    ids = ok(root, "batch", "promote", batch).splitlines()
    assert len(ids) == 6
    assert _trunk_size(root, name) == 6


def test_promoting_twice_adds_nothing(root: Path, tmp_path: Path) -> None:
    # A union against current membership, so a retried command is safe and the
    # change log stays quiet.
    name, batch = completed_batch(root, tmp_path)
    ok(root, "batch", "promote", batch)
    assert payload(root, "batch", "promote", batch) == {"items": [], "total": 0}
    assert _trunk_size(root, name) == 6


def test_promoting_an_unfinished_batch_exits_one(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path)
    result = run(root, "batch", "promote", batch)
    assert result.exit_code == 1, result.output
    assert result.stdout == ""
