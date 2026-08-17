"""A connection's view of the background work running against it.

The half of "observable from anywhere" that has no HTTP in it: a job row is where
a run's progress lives, and `ConnectionJob` is that row read as the thing it is
about. `tests/server/test_inference.py` drives the same projection through the
wire; this file is the projection.

What it holds that nothing else can see is the mapping itself. A job row counts in
whatever unit its handler works in — bytes for a transfer, files for a re-read —
and exactly one place says which for each type. So a client reads `bytes_done` or
`files_read` and knows what it has, rather than reading `processed` and looking up
a job type to find out what it counted.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from visionset.kernel.domain import (
    INTEGRITY_CHECK_JOB_TYPE,
    WEIGHT_DOWNLOAD_JOB_TYPE,
    BackgroundJob,
    BackgroundJobOutcome,
    BackgroundJobSpec,
    BackgroundJobState,
    ConnectionType,
    InferenceConnection,
    IntegrityCheck,
    WeightDownload,
    connection_job_payload,
)
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

GIGABYTE = 1_000_000_000


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws", name="downloads")
    try:
        yield made
    finally:
        made.close()


@pytest.fixture()
def connections(workspace: WorkspaceService) -> InferenceConnectionService:
    return InferenceConnectionService(workspace)


def a_local(connections: InferenceConnectionService, name: str = "sam") -> InferenceConnection:
    return connections.create(
        name,
        connection_type=ConnectionType.LOCAL,
        model_id="some/model",
        model_revision="abc123",
        device="cpu",
        precision="fp32",
    )


def a_job(
    workspace: WorkspaceService, connection: InferenceConnection, job_type: str
) -> BackgroundJob:
    return workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=job_type, payload=connection_job_payload(connection.id), idempotent=True
        )
    )


def a_download(workspace: WorkspaceService, connection: InferenceConnection) -> BackgroundJob:
    return a_job(workspace, connection, WEIGHT_DOWNLOAD_JOB_TYPE)


def a_check(workspace: WorkspaceService, connection: InferenceConnection) -> BackgroundJob:
    return a_job(workspace, connection, INTEGRITY_CHECK_JOB_TYPE)


# --- the mapping --------------------------------------------------------------


def test_a_job_row_reads_as_bytes() -> None:
    """`processed` and `total` are the transfer's bytes, named once, here."""
    connection_id = uuid4()
    job = BackgroundJob(
        type=WEIGHT_DOWNLOAD_JOB_TYPE,
        payload=connection_job_payload(connection_id),
        state=BackgroundJobState.RUNNING,
        processed=3 * GIGABYTE,
        total=4 * GIGABYTE,
    )

    download = WeightDownload.of(job)

    assert download.connection_id == connection_id
    assert download.job_id == job.id
    assert download.state is BackgroundJobState.RUNNING
    assert (download.bytes_done, download.bytes_total) == (3 * GIGABYTE, 4 * GIGABYTE)


def test_a_total_that_could_not_be_read_travels_as_null() -> None:
    """Sizing and fetching fail independently, so a bar goes indeterminate rather
    than a download being refused for want of a number to describe it."""
    job = BackgroundJob(
        type=WEIGHT_DOWNLOAD_JOB_TYPE,
        payload=connection_job_payload(uuid4()),
        processed=GIGABYTE,
        total=None,
    )

    download = WeightDownload.of(job)

    assert download.bytes_total is None
    assert download.bytes_done == GIGABYTE


def test_progress_is_clamped_to_its_total() -> None:
    """A bar that fills past its own end reads as a defect in the product.

    The two numbers come from different places — one measured off the disk, the
    other published by the hub — so they can disagree by a blob without either
    being wrong. Clamped rather than refused, because a cosmetic disagreement
    must not turn a connection listing into a 500.
    """
    job = BackgroundJob(
        type=WEIGHT_DOWNLOAD_JOB_TYPE,
        payload=connection_job_payload(uuid4()),
        processed=5 * GIGABYTE,
        total=4 * GIGABYTE,
    )

    assert WeightDownload.of(job).bytes_done == 4 * GIGABYTE


def test_the_type_refuses_progress_above_its_total() -> None:
    """The invariant the clamp exists to satisfy, stated on the model itself."""
    with pytest.raises(ValueError, match="cannot have fetched"):
        WeightDownload(
            connection_id=uuid4(),
            job_id=uuid4(),
            state=BackgroundJobState.RUNNING,
            bytes_done=5,
            bytes_total=4,
        )


def test_another_kind_of_job_is_not_a_download() -> None:
    """The integrity check counts files over the same snapshot, and reading its
    row as bytes would report a handful where gigabytes belong."""
    job = BackgroundJob(
        type=INTEGRITY_CHECK_JOB_TYPE, payload=connection_job_payload(uuid4()), processed=3
    )

    with pytest.raises(ValueError, match="not a 'inference.download_weights'"):
        WeightDownload.of(job)


# --- what a connection reports ------------------------------------------------


def test_a_connection_with_no_download_reports_none(
    connections: InferenceConnectionService,
) -> None:
    assert connections.connection_jobs().downloads == {}
    assert a_local(connections).id not in connections.connection_jobs().downloads


def test_a_queued_download_is_already_visible(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """Before a worker has touched it, which is the point: a client that saw
    nothing until bytes moved would show a pressed button and no explanation."""
    made = a_local(connections)
    job = a_download(workspace, made)

    download = connections.connection_jobs().downloads[made.id]

    assert download.job_id == job.id
    assert download.state is BackgroundJobState.QUEUED
    assert (download.bytes_done, download.bytes_total) == (0, None)


def test_a_running_download_reports_how_far_it_has_got(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """A poll mid-transfer, which is the whole feature.

    Written against the row rather than through a route because that is where a
    handler's `ProgressReporter` writes: what a client polls is this, projected.
    """
    made = a_local(connections)
    a_download(workspace, made)
    workspace.job_queue.claim("worker-1")
    with workspace.unit_of_work() as uow:
        running = uow.jobs.list()[0]
        uow.jobs.update(running.model_copy(update={"processed": GIGABYTE, "total": 4 * GIGABYTE}))

    download = connections.connection_jobs().downloads[made.id]

    assert download.state is BackgroundJobState.RUNNING
    assert download.bytes_total is not None
    assert 0 < download.bytes_done < download.bytes_total


def test_a_settled_download_stays_readable(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """Because *what happened last time* is asked as often as *is it running*.

    Dropping the record the moment a job settles would leave a transfer that
    failed while nobody was watching sitting at `not_set_up` with no sentence
    saying why.
    """
    made = a_local(connections)
    job = a_download(workspace, made)
    workspace.job_queue.claim("worker-1")
    workspace.job_queue.finish(
        job.id,
        BackgroundJobOutcome(state=BackgroundJobState.FAILED, error="the disk filled"),
    )

    download = connections.connection_jobs().downloads[made.id]

    assert download.state is BackgroundJobState.FAILED
    assert download.error == "the disk filled"


def test_the_newest_download_is_the_one_reported(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """A connection downloaded twice reports the second attempt, not the first."""
    made = a_local(connections)
    a_download(workspace, made)
    second = a_download(workspace, made)

    assert connections.connection_jobs().downloads[made.id].job_id == second.id


def test_each_connection_gets_its_own(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    one, two = a_local(connections, "one"), a_local(connections, "two")
    for connection in (one, two):
        a_download(workspace, connection)

    downloads = connections.connection_jobs().downloads

    assert downloads[one.id].connection_id == one.id
    assert downloads[two.id].connection_id == two.id


def test_a_download_naming_no_connection_is_skipped(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """A listing of connections is the wrong place to discover a malformed row."""
    made = a_local(connections)
    workspace.job_queue.enqueue(BackgroundJobSpec(type=WEIGHT_DOWNLOAD_JOB_TYPE))
    a_download(workspace, made)

    assert set(connections.connection_jobs().downloads) == {made.id}


def test_other_job_types_are_not_read_as_downloads(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    made = a_local(connections)
    a_check(workspace, made)

    assert connections.connection_jobs().downloads == {}


# --- the check, over the same files and counting a different thing -------------


def test_a_check_reads_as_files() -> None:
    """Where a download's row is bytes, this one's is files.

    The two units meet nowhere: each names what its handler actually counted, so a
    client never has to look up a job type to know what it is holding.
    """
    connection_id = uuid4()
    job = BackgroundJob(
        type=INTEGRITY_CHECK_JOB_TYPE,
        payload=connection_job_payload(connection_id),
        state=BackgroundJobState.RUNNING,
        processed=7,
        total=11,
    )

    check = IntegrityCheck.of(job)

    assert check.connection_id == connection_id
    assert check.state is BackgroundJobState.RUNNING
    assert (check.files_read, check.files_total) == (7, 11)


def test_a_download_is_not_a_check() -> None:
    """Reading a transfer's row as files would report gigabytes as a file count."""
    job = BackgroundJob(
        type=WEIGHT_DOWNLOAD_JOB_TYPE, payload=connection_job_payload(uuid4()), processed=4_000_000
    )

    with pytest.raises(ValueError, match="not a 'inference.check_integrity'"):
        IntegrityCheck.of(job)


def test_a_check_before_the_listing_arrives_has_no_total() -> None:
    """A check learns its total from the hub's listing, which it reads first.

    The window is short and it is real, so `null` has to be renderable rather than
    impossible — the rule `BackgroundJob.total` already states.
    """
    job = BackgroundJob(type=INTEGRITY_CHECK_JOB_TYPE, payload=connection_job_payload(uuid4()))

    assert IntegrityCheck.of(job).files_total is None


def test_a_check_is_clamped_to_its_total() -> None:
    with pytest.raises(ValueError, match="cannot have read"):
        IntegrityCheck(
            connection_id=uuid4(),
            job_id=uuid4(),
            state=BackgroundJobState.RUNNING,
            files_read=12,
            files_total=11,
        )
    job = BackgroundJob(
        type=INTEGRITY_CHECK_JOB_TYPE,
        payload=connection_job_payload(uuid4()),
        processed=12,
        total=11,
    )
    assert IntegrityCheck.of(job).files_read == 11


def test_a_running_check_reports_how_far_it_has_got(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """A poll mid-check, which is the whole feature — and the reload it survives."""
    made = a_local(connections)
    a_check(workspace, made)
    workspace.job_queue.claim("worker-1")
    with workspace.unit_of_work() as uow:
        running = uow.jobs.list()[0]
        uow.jobs.update(running.model_copy(update={"processed": 3, "total": 11}))

    check = connections.connection_jobs().checks[made.id]

    assert check.state is BackgroundJobState.RUNNING
    assert check.files_total is not None
    assert 0 < check.files_read < check.files_total


def test_a_failed_check_keeps_the_sentence_that_says_why(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """The purge has already happened by the time a reader sees this.

    So the row's own state is the verdict and this is the explanation — which is
    exactly what used to be lost when the only thing watching was the tab that
    pressed the item.
    """
    made = a_local(connections)
    job = a_check(workspace, made)
    workspace.job_queue.claim("worker-1")
    workspace.job_queue.finish(
        job.id,
        BackgroundJobOutcome(
            state=BackgroundJobState.FAILED, error="model.safetensors does not match"
        ),
    )

    check = connections.connection_jobs().checks[made.id]

    assert check.state is BackgroundJobState.FAILED
    assert check.error == "model.safetensors does not match"


# --- the two kinds together ----------------------------------------------------


def test_both_kinds_come_back_from_one_read(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """One query answers both questions for every row.

    A read per kind, or worse per row, would put that cost on a screen's own poll
    interval — which is the only reason this returns a pair rather than being two
    methods.
    """
    made = a_local(connections)
    download = a_download(workspace, made)
    check = a_check(workspace, made)

    jobs = connections.connection_jobs()

    assert jobs.downloads[made.id].job_id == download.id
    assert jobs.checks[made.id].job_id == check.id


def test_neither_kind_is_read_as_the_other(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """A connection with only a check has no download, and the reverse."""
    checked, downloaded = a_local(connections, "checked"), a_local(connections, "downloaded")
    a_check(workspace, checked)
    a_download(workspace, downloaded)

    jobs = connections.connection_jobs()

    assert set(jobs.checks) == {checked.id}
    assert set(jobs.downloads) == {downloaded.id}


def test_a_connection_with_nothing_running_reports_neither(
    connections: InferenceConnectionService,
) -> None:
    made = a_local(connections)
    jobs = connections.connection_jobs()

    assert made.id not in jobs.downloads
    assert made.id not in jobs.checks


# --- the run a second request joins -------------------------------------------


def test_a_queued_run_is_the_one_a_second_request_would_join(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """The positive path: asked for a kind already waiting, it hands that row back."""
    made = a_local(connections)
    queued = a_download(workspace, made)

    found = connections.live_job(made.id, job_type=WEIGHT_DOWNLOAD_JOB_TYPE)

    assert found is not None
    assert found.id == queued.id


def test_a_running_run_is_joined_too(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """Both live states, not only the one before a worker took it.

    A `queued`-only answer would fork a second transfer for every request that
    arrived after the dispatcher woke, which is nearly all of them.
    """
    made = a_local(connections)
    started = a_download(workspace, made)
    workspace.job_queue.claim("worker-1")

    found = connections.live_job(made.id, job_type=WEIGHT_DOWNLOAD_JOB_TYPE)

    assert found is not None
    assert found.id == started.id
    assert found.state is BackgroundJobState.RUNNING


def test_a_settled_run_is_not_joined(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """The half that keeps the action usable at all.

    A finished, failed or cancelled run is not something to wait for, so it must
    not answer here — joining one would mean a connection whose first download
    failed could never be asked for a second, because every request would be
    handed the failure.
    """
    made = a_local(connections)
    job = a_download(workspace, made)
    workspace.job_queue.claim("worker-1")
    workspace.job_queue.finish(
        job.id, BackgroundJobOutcome(state=BackgroundJobState.FAILED, error="the disk filled")
    )

    assert connections.live_job(made.id, job_type=WEIGHT_DOWNLOAD_JOB_TYPE) is None


def test_the_other_kind_of_run_is_not_joined(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """A live check is not a download, so a download request starts one.

    The kernel half of the decision the routes carry: coalescing is per kind, and
    nothing here refuses work because a *different* operation is under way.
    """
    made = a_local(connections)
    a_check(workspace, made)

    assert connections.live_job(made.id, job_type=WEIGHT_DOWNLOAD_JOB_TYPE) is None
    assert connections.live_job(made.id, job_type=INTEGRITY_CHECK_JOB_TYPE) is not None


def test_another_connections_run_is_not_joined(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """Matched on the connection the payload names, never on the type alone."""
    mine, theirs = a_local(connections, "mine"), a_local(connections, "theirs")
    a_download(workspace, theirs)

    assert connections.live_job(mine.id, job_type=WEIGHT_DOWNLOAD_JOB_TYPE) is None


def test_a_job_naming_no_connection_is_not_joined(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """A malformed row is skipped rather than raised over, as the listing skips it.

    It also must not be *returned*: a request handed a job that is about nothing
    would poll a run that can only fail, in place of the one it asked for.
    """
    made = a_local(connections)
    workspace.job_queue.enqueue(
        BackgroundJobSpec(type=WEIGHT_DOWNLOAD_JOB_TYPE, payload={}, idempotent=True)
    )

    assert connections.live_job(made.id, job_type=WEIGHT_DOWNLOAD_JOB_TYPE) is None
