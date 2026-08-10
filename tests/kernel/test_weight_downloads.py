"""A connection's view of its own weight transfer.

The half of "observable from anywhere" that has no HTTP in it: the job row is
where a download's progress lives, and `WeightDownload` is that row read as the
thing it is about. `tests/server/test_inference.py` drives the same projection
through the wire; this file is the projection.

What it holds that nothing else can see is the mapping itself. A job row counts
in whatever unit its handler works in, and exactly one place says that unit is
the byte for this type — so a client reads `bytes_done` and formats bytes rather
than reading `processed` and looking up a job type to find out what it counted.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from visionset.kernel.domain import (
    WEIGHT_DOWNLOAD_JOB_TYPE,
    BackgroundJob,
    BackgroundJobOutcome,
    BackgroundJobSpec,
    BackgroundJobState,
    ConnectionType,
    InferenceConnection,
    WeightDownload,
    weight_download_payload,
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


def a_download(workspace: WorkspaceService, connection: InferenceConnection) -> BackgroundJob:
    return workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=WEIGHT_DOWNLOAD_JOB_TYPE,
            payload=weight_download_payload(connection.id),
            idempotent=True,
        )
    )


# --- the mapping --------------------------------------------------------------


def test_a_job_row_reads_as_bytes() -> None:
    """`processed` and `total` are the transfer's bytes, named once, here."""
    connection_id = uuid4()
    job = BackgroundJob(
        type=WEIGHT_DOWNLOAD_JOB_TYPE,
        payload=weight_download_payload(connection_id),
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
        payload=weight_download_payload(uuid4()),
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
        payload=weight_download_payload(uuid4()),
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
    job = BackgroundJob(type="inference.check_integrity", payload={"connection_id": str(uuid4())})

    with pytest.raises(ValueError, match="not a weight download"):
        WeightDownload.of(job)


# --- what a connection reports ------------------------------------------------


def test_a_connection_with_no_download_reports_none(
    connections: InferenceConnectionService,
) -> None:
    assert connections.downloads() == {}
    assert a_local(connections).id not in connections.downloads()


def test_a_queued_download_is_already_visible(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """Before a worker has touched it, which is the point: a client that saw
    nothing until bytes moved would show a pressed button and no explanation."""
    made = a_local(connections)
    job = a_download(workspace, made)

    download = connections.downloads()[made.id]

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

    download = connections.downloads()[made.id]

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

    download = connections.downloads()[made.id]

    assert download.state is BackgroundJobState.FAILED
    assert download.error == "the disk filled"


def test_the_newest_download_is_the_one_reported(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """A connection downloaded twice reports the second attempt, not the first."""
    made = a_local(connections)
    a_download(workspace, made)
    second = a_download(workspace, made)

    assert connections.downloads()[made.id].job_id == second.id


def test_each_connection_gets_its_own(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    one, two = a_local(connections, "one"), a_local(connections, "two")
    for connection in (one, two):
        a_download(workspace, connection)

    downloads = connections.downloads()

    assert downloads[one.id].connection_id == one.id
    assert downloads[two.id].connection_id == two.id


def test_a_download_naming_no_connection_is_skipped(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    """A listing of connections is the wrong place to discover a malformed row."""
    made = a_local(connections)
    workspace.job_queue.enqueue(BackgroundJobSpec(type=WEIGHT_DOWNLOAD_JOB_TYPE))
    a_download(workspace, made)

    assert set(connections.downloads()) == {made.id}


def test_other_job_types_are_not_read_as_downloads(
    workspace: WorkspaceService, connections: InferenceConnectionService
) -> None:
    made = a_local(connections)
    workspace.job_queue.enqueue(
        BackgroundJobSpec(type="inference.check_integrity", payload={"connection_id": str(made.id)})
    )

    assert connections.downloads() == {}
