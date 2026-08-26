"""``visionset job`` — the seven commands that make the lifecycle drivable."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from tests.cli._flow import (
    ingested_batch,
    jobs_of,
    ok,
    payload,
    run,
    runner,
    started_batch,
    usage_error,
    workspace,
)
from tests.cli.test_batch_commands import _connection, _FakePool, _FakePredictor

from visionset.cli.main import app
from visionset.inference import prelabel as prelabel_module
from visionset.kernel.domain import AssetProgress, GeometryType
from visionset.kernel.services import WORKSPACE_ENV_VAR


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


@pytest.fixture()
def predicting(monkeypatch: pytest.MonkeyPatch) -> _FakePredictor:
    """``test_batch_commands``'s fixture, redefined here: an imported fixture
    shadowed by a same-named parameter reads as an unused import to ruff."""
    predictor = _FakePredictor()
    monkeypatch.setattr(
        prelabel_module,
        "resident",
        lambda: _FakePool(predictor, produces=frozenset({GeometryType.BBOX})),
    )
    return predictor


def _assets(root: Path, job: str) -> list[str]:
    return [line.split()[0] for line in ok(root, "job", "next", job, "-n", "100").splitlines()[1:]]


# --- list --------------------------------------------------------------------


def test_a_draft_batch_has_no_jobs(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    result = run(root, "job", "list", "--batch", batch)
    assert result.stdout.splitlines() == ["ID  STATE  ASSETS  ASSIGNEE"]
    assert "approve it first" in result.stderr


def test_list_leads_with_the_id(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path, jobs_of=3)
    rows = ok(root, "job", "list", "--batch", batch).splitlines()
    assert rows[0].split() == ["ID", "STATE", "ASSETS", "ASSIGNEE"]
    assert [line.split()[1:] for line in rows[1:]] == [
        ["pending", "3", "-"],
        ["pending", "3", "-"],
    ]


def test_list_json_names_the_batch_each_job_belongs_to(root: Path, tmp_path: Path) -> None:
    # ``task_group_id`` is absent and ``batch_id`` is here instead, because the
    # batch is what leads to the pinned schema the work is judged against.
    _, batch = started_batch(root, tmp_path)
    item = payload(root, "job", "list", "--batch", batch)["items"][0]
    assert item["batch_id"] == batch
    assert "task_group_id" not in item


# --- next --------------------------------------------------------------------


def test_next_hands_back_the_assets_awaiting_annotation(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path, jobs_of=3)
    job = jobs_of(root, batch)[0]
    assert len(_assets(root, job)) == 3


def test_next_bounds_what_it_returns(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]
    assert payload(root, "job", "next", job, "-n", "2")["total"] == 2


def test_next_is_stable_across_two_calls(root: Path, tmp_path: Path) -> None:
    # Order is the stored position, not insertion luck.
    _, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]
    assert _assets(root, job) == _assets(root, job)


def test_a_count_of_zero_exits_two(root: Path, tmp_path: Path) -> None:
    # ``next_pending`` refuses a non-positive count with a bare ``ValueError``.
    _, batch = started_batch(root, tmp_path)
    assert run(root, "job", "next", jobs_of(root, batch)[0], "-n", "0").exit_code == 2


def test_next_says_so_when_nothing_is_left(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]
    ok(root, "job", "start", job)
    for asset in _assets(root, job):
        ok(root, "job", "mark", job, asset, "--progress", "annotated")
    result = run(root, "job", "next", job)
    assert result.exit_code == 0, result.output
    assert "nothing left" in result.stderr


# --- progress ----------------------------------------------------------------


def test_progress_names_every_state_the_enum_has(root: Path, tmp_path: Path) -> None:
    # The columns are read off ``AssetProgress``, so a sixth state cannot be
    # silently missing from the table.
    _, batch = started_batch(root, tmp_path)
    header = ok(root, "job", "progress", jobs_of(root, batch)[0]).splitlines()[0].split()
    assert header == [state.value.upper() for state in AssetProgress] + ["TOTAL"]


def test_progress_json_agrees_with_the_wire_shape(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path, jobs_of=3)
    counts = payload(root, "job", "progress", jobs_of(root, batch)[0])
    assert counts["unannotated"] == 3
    assert counts["total"] == 3


# --- start, mark, complete ---------------------------------------------------


def test_start_takes_a_pending_job(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path)
    assert payload(root, "job", "start", jobs_of(root, batch)[0])["state"] == "in_progress"


def test_mark_records_the_state(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]
    ok(root, "job", "start", job)
    asset = _assets(root, job)[0]
    assert payload(root, "job", "mark", job, asset, "--progress", "skipped") == {
        "asset_id": asset,
        "progress": "skipped",
    }


def test_an_unknown_progress_state_exits_two_listing_the_real_ones(
    root: Path, tmp_path: Path
) -> None:
    # Typer renders the ``StrEnum`` as a Click choice, so the refusal names every
    # legal value without this module restating them.
    _, batch = started_batch(root, tmp_path)
    result = run(root, "job", "mark", jobs_of(root, batch)[0], str(uuid4()), "--progress", "bogus")
    assert result.exit_code == 2, result.output
    assert "annotated" in usage_error(result)


def test_marking_an_asset_that_is_not_in_the_job_exits_one(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]
    ok(root, "job", "start", job)
    result = run(root, "job", "mark", job, str(uuid4()), "--progress", "annotated")
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


def test_marking_into_a_batch_nobody_opened_exits_one(root: Path, tmp_path: Path) -> None:
    # The batch gate fires before the value is even looked at.
    _, batch = ingested_batch(root, tmp_path)
    ok(root, "batch", "approve", batch)
    job = jobs_of(root, batch)[0]
    result = run(root, "job", "mark", job, str(uuid4()), "--progress", "annotated")
    assert result.exit_code == 1, result.output


def test_completing_with_an_unsettled_asset_exits_one(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]
    ok(root, "job", "start", job)
    result = run(root, "job", "complete", job)
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


def test_completing_a_job_does_not_complete_its_batch(root: Path, tmp_path: Path) -> None:
    # One machine in two places is one too many: ``batch complete`` derives that
    # itself, and refuses while any job is outstanding.
    name, batch = started_batch(root, tmp_path, jobs_of=3)
    job = jobs_of(root, batch)[0]
    ok(root, "job", "start", job)
    for asset in _assets(root, job):
        ok(root, "job", "mark", job, asset, "--progress", "annotated")
    ok(root, "job", "complete", job)
    assert payload(root, "batch", "list", "-p", name)["items"][0]["state"] == "in_annotation"


# --- pre-label ---------------------------------------------------------------


def test_job_pre_label_writes_the_named_jobs_untouched_assets(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = started_batch(root, tmp_path, jobs_of=3)
    job, other = jobs_of(root, batch)
    connection = _connection(root)

    result = run(root, "job", "pre-label", job, connection)

    assert result.exit_code == 0, result.output
    assert result.stdout == "3\n"
    assert "Pre-labeling 1/3 asset(s)." in result.stderr
    assert "Pre-labeled 3 asset(s), wrote 3 annotation(s)." in result.stderr
    assert payload(root, "job", "progress", job)["pre_labeled"] == 3
    assert payload(root, "job", "progress", other)["pre_labeled"] == 0


def test_job_pre_label_json_emits_the_job_id(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]

    outcome = payload(root, "job", "pre-label", job, _connection(root))

    assert outcome["job_id"] == job
    assert outcome["annotations_written"] == 6


def test_job_pre_label_refuses_a_completed_job(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]
    ok(root, "job", "start", job)
    for asset in _assets(root, job):
        ok(root, "job", "mark", job, asset, "--progress", "annotated")
    ok(root, "job", "complete", job)

    result = run(root, "job", "pre-label", job, _connection(root))

    assert result.exit_code == 1, result.output
    assert result.stdout == ""


def test_job_help_lists_pre_label() -> None:
    assert "pre-label" in runner.invoke(app, ["job", "--help"]).stdout
