"""A batch's view of the pre-labeling run most recently asked against it.

The half of "a reopened dialog can tell what happened" that has no HTTP in it: a
job row is where a run's progress and outcome live, and `PreLabelRun` is that
row read as the thing it is about. `tests/kernel/test_connection_jobs.py` is the
same projection over a connection instead of a batch; this file is its sibling.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from visionset.kernel.domain import (
    PRE_LABEL_JOB_TYPE,
    WEIGHT_DOWNLOAD_JOB_TYPE,
    BackgroundJob,
    BackgroundJobOutcome,
    BackgroundJobSpec,
    BackgroundJobState,
    PreLabelRun,
    connection_job_payload,
    pre_label_job_payload,
)
from visionset.kernel.services import BatchService, WorkspaceService


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws", name="prelabel-runs")
    try:
        yield made
    finally:
        made.close()


@pytest.fixture()
def batches(workspace: WorkspaceService) -> BatchService:
    return BatchService(workspace)


def enqueue_run(workspace: WorkspaceService, batch_id: UUID) -> BackgroundJob:
    return workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=PRE_LABEL_JOB_TYPE,
            payload=pre_label_job_payload(batch_id, uuid4(), 0.35),
            idempotent=True,
        )
    )


# --- the mapping ----------------------------------------------------------------


def test_a_job_row_reads_as_assets() -> None:
    """`processed` and `total` are the run's assets, named once, here."""
    batch_id = uuid4()
    job = BackgroundJob(
        type=PRE_LABEL_JOB_TYPE,
        payload=pre_label_job_payload(batch_id, uuid4(), 0.35),
        state=BackgroundJobState.RUNNING,
        processed=12,
        total=48,
    )

    run = PreLabelRun.of(job)

    assert run.batch_id == batch_id
    assert run.job_id == job.id
    assert run.state is BackgroundJobState.RUNNING
    assert (run.assets_processed, run.assets_total) == (12, 48)


def test_progress_is_clamped_to_its_total() -> None:
    """The two counts can disagree by a cosmetic amount; a listing must not 500."""
    job = BackgroundJob(
        type=PRE_LABEL_JOB_TYPE,
        payload=pre_label_job_payload(uuid4(), uuid4(), 0.35),
        processed=50,
        total=48,
    )

    assert PreLabelRun.of(job).assets_processed == 48


def test_the_type_refuses_progress_above_its_total() -> None:
    with pytest.raises(ValueError, match="cannot have processed"):
        PreLabelRun(
            batch_id=uuid4(),
            job_id=uuid4(),
            state=BackgroundJobState.RUNNING,
            assets_processed=50,
            assets_total=48,
        )


def test_another_kind_of_job_is_not_a_pre_label_run() -> None:
    job = BackgroundJob(
        type=WEIGHT_DOWNLOAD_JOB_TYPE, payload=connection_job_payload(uuid4()), processed=3
    )

    with pytest.raises(ValueError, match="not a 'annotation.pre_label'"):
        PreLabelRun.of(job)


def test_a_job_naming_no_batch_is_refused() -> None:
    job = BackgroundJob(type=PRE_LABEL_JOB_TYPE, payload={}, processed=3)

    with pytest.raises(ValueError, match="names no batch"):
        PreLabelRun.of(job)


# --- the handler's own outcome ---------------------------------------------------


def test_the_outcome_is_null_before_the_job_settles() -> None:
    """A queued or running job has no result yet — nothing to read it out of."""
    job = BackgroundJob(
        type=PRE_LABEL_JOB_TYPE,
        payload=pre_label_job_payload(uuid4(), uuid4(), 0.35),
        state=BackgroundJobState.RUNNING,
        processed=3,
        total=8,
    )

    run = PreLabelRun.of(job)

    assert run.stopped_early is None
    assert run.assets_labeled is None
    assert run.regions_discarded is None
    assert run.regions_out_of_bounds is None
    assert run.annotations_replaced is None


def test_a_succeeded_run_carries_the_handlers_outcome() -> None:
    job = BackgroundJob(
        type=PRE_LABEL_JOB_TYPE,
        payload=pre_label_job_payload(uuid4(), uuid4(), 0.35),
        state=BackgroundJobState.SUCCEEDED,
        processed=8,
        total=8,
        result={
            "assets_considered": 8,
            "assets_labeled": 6,
            "annotations_written": 9,
            "model_ref": "some/model@abc123",
            "stopped_early": False,
            "assets_skipped": 1,
            "regions_discarded": 2,
            "regions_out_of_bounds": 1,
            "annotations_replaced": 4,
        },
    )

    run = PreLabelRun.of(job)

    assert run.stopped_early is False
    assert run.assets_labeled == 6
    assert run.regions_discarded == 2
    assert run.regions_out_of_bounds == 1
    assert run.annotations_replaced == 4


def test_a_pre_label_result_ignores_boolean_and_malformed_counts() -> None:
    job = BackgroundJob(
        type=PRE_LABEL_JOB_TYPE,
        payload=pre_label_job_payload(uuid4(), uuid4(), 0.35),
        state=BackgroundJobState.SUCCEEDED,
        result={
            "assets_labeled": True,
            "regions_discarded": "two",
            "regions_out_of_bounds": 1.0,
            "annotations_replaced": True,
        },
    )

    run = PreLabelRun.of(job)

    assert run.assets_labeled is None
    assert run.regions_discarded is None
    assert run.regions_out_of_bounds is None
    assert run.annotations_replaced is None


def test_a_failed_run_keeps_the_sentence_and_has_no_outcome() -> None:
    """A failure never reaches the point of building a result dict."""
    job = BackgroundJob(
        type=PRE_LABEL_JOB_TYPE,
        payload=pre_label_job_payload(uuid4(), uuid4(), 0.35),
        state=BackgroundJobState.FAILED,
        error="the model server is unreachable",
        processed=3,
        total=8,
    )

    run = PreLabelRun.of(job)

    assert run.error == "the model server is unreachable"
    assert run.stopped_early is None
    assert run.assets_labeled is None


def test_a_cancelled_run_still_carries_its_outcome() -> None:
    """Stopping partway is a coherent outcome, not the absence of one."""
    job = BackgroundJob(
        type=PRE_LABEL_JOB_TYPE,
        payload=pre_label_job_payload(uuid4(), uuid4(), 0.35),
        state=BackgroundJobState.CANCELLED,
        processed=12,
        total=48,
        result={
            "stopped_early": True,
            "assets_labeled": 4,
            "regions_discarded": 0,
            "regions_out_of_bounds": 0,
        },
    )

    run = PreLabelRun.of(job)

    assert run.state is BackgroundJobState.CANCELLED
    assert (run.assets_processed, run.assets_total) == (12, 48)
    assert run.stopped_early is True
    assert run.assets_labeled == 4


# --- what a batch reports, through the service ------------------------------------


def test_a_batch_with_no_pre_label_run_reports_none(batches: BatchService) -> None:
    assert batches.latest_pre_label_job(uuid4()) is None
    assert batches.pre_label_runs() == {}


def test_a_queued_run_is_already_visible(
    workspace: WorkspaceService, batches: BatchService
) -> None:
    batch_id = uuid4()
    job = enqueue_run(workspace, batch_id)

    run = batches.latest_pre_label_job(batch_id)

    assert run is not None
    assert run.job_id == job.id
    assert run.state is BackgroundJobState.QUEUED


def test_a_settled_run_stays_readable(workspace: WorkspaceService, batches: BatchService) -> None:
    """`live_job`'s counterpart is state-restricted; this one is not, on purpose:
    a dialog reopened after a run finished needs *that* run, not only a live one.
    """
    batch_id = uuid4()
    job = enqueue_run(workspace, batch_id)
    workspace.job_queue.claim("worker-1")
    workspace.job_queue.finish(
        job.id,
        BackgroundJobOutcome(
            state=BackgroundJobState.SUCCEEDED,
            result={
                "stopped_early": False,
                "assets_labeled": 3,
                "regions_discarded": 1,
                "regions_out_of_bounds": 2,
            },
            processed=5,
            total=5,
        ),
    )

    run = batches.latest_pre_label_job(batch_id)

    assert run is not None
    assert run.state is BackgroundJobState.SUCCEEDED
    assert run.assets_labeled == 3
    assert run.regions_discarded == 1
    assert run.regions_out_of_bounds == 2


def test_a_cancelled_run_reports_how_far_it_got(
    workspace: WorkspaceService, batches: BatchService
) -> None:
    batch_id = uuid4()
    job = enqueue_run(workspace, batch_id)
    workspace.job_queue.claim("worker-1")
    workspace.job_queue.finish(
        job.id,
        BackgroundJobOutcome(
            state=BackgroundJobState.CANCELLED,
            result={
                "stopped_early": True,
                "assets_labeled": 4,
                "regions_discarded": 0,
                "regions_out_of_bounds": 0,
            },
            processed=12,
            total=48,
        ),
    )

    run = batches.latest_pre_label_job(batch_id)

    assert run is not None
    assert run.state is BackgroundJobState.CANCELLED
    assert (run.assets_processed, run.assets_total) == (12, 48)
    assert run.stopped_early is True


def test_a_failed_run_keeps_the_sentence_that_says_why(
    workspace: WorkspaceService, batches: BatchService
) -> None:
    batch_id = uuid4()
    job = enqueue_run(workspace, batch_id)
    workspace.job_queue.claim("worker-1")
    workspace.job_queue.finish(
        job.id,
        BackgroundJobOutcome(
            state=BackgroundJobState.FAILED, error="the model server is unreachable"
        ),
    )

    run = batches.latest_pre_label_job(batch_id)

    assert run is not None
    assert run.state is BackgroundJobState.FAILED
    assert run.error == "the model server is unreachable"


def test_the_newest_run_is_the_one_reported(
    workspace: WorkspaceService, batches: BatchService
) -> None:
    """A batch pre-labeled twice reports the second attempt, not the first."""
    batch_id = uuid4()
    enqueue_run(workspace, batch_id)
    second = enqueue_run(workspace, batch_id)

    run = batches.latest_pre_label_job(batch_id)

    assert run is not None
    assert run.job_id == second.id


def test_another_batchs_run_is_not_returned(
    workspace: WorkspaceService, batches: BatchService
) -> None:
    mine, theirs = uuid4(), uuid4()
    enqueue_run(workspace, theirs)

    assert batches.latest_pre_label_job(mine) is None


def test_pre_label_runs_reads_the_queue_once_for_every_batch(
    workspace: WorkspaceService, batches: BatchService
) -> None:
    """One query answers every row of a listing rather than one per batch."""
    one, two = uuid4(), uuid4()
    job_one = enqueue_run(workspace, one)
    job_two = enqueue_run(workspace, two)

    runs = batches.pre_label_runs()

    assert runs[one].job_id == job_one.id
    assert runs[two].job_id == job_two.id


def test_a_run_naming_no_batch_is_skipped(
    workspace: WorkspaceService, batches: BatchService
) -> None:
    """A batch listing is the wrong place to discover a malformed row."""
    made = uuid4()
    workspace.job_queue.enqueue(
        BackgroundJobSpec(type=PRE_LABEL_JOB_TYPE, payload={}, idempotent=True)
    )
    enqueue_run(workspace, made)

    assert set(batches.pre_label_runs()) == {made}


def test_other_job_types_are_not_read_as_pre_label_runs(
    workspace: WorkspaceService, batches: BatchService
) -> None:
    workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=WEIGHT_DOWNLOAD_JOB_TYPE, payload=connection_job_payload(uuid4()), idempotent=True
        )
    )

    assert batches.pre_label_runs() == {}
