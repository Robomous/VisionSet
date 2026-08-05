# usage: from visionset.server.routes import ingest
"""Ingest jobs: the polling half of the launch-and-poll contract.

A job is addressed on its own rather than under the source that produced it,
because that is how a client reaches it: the launch handed back an id and a
`Location`, and nothing else about the run is needed to ask after it. Listing a
source's runs stays with the source, in ``routes/sources.py``.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import Response, status

from visionset.jobs.ingest import JOB_TYPE as ingest_job_type
from visionset.jobs.ingest import payload_for as ingest_payload_for
from visionset.kernel.domain import BackgroundJobSpec
from visionset.kernel.services import IngestService
from visionset.server.dependencies import RunnerDep, WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import IngestJobOut

router = protected_router(prefix="/ingest-jobs", tags=["ingest"])


@router.get("/{job_id}", responses=documented(404))
def get_ingest_job(workspace: WorkspaceDep, job_id: UUID) -> IngestJobOut:
    """Where a run is now.

    `processed` and `total` are written as the run goes, so this answers "where
    is it" rather than "where did it end". `total` is null for a clip — a video's
    frame count is a guess before extraction, so it is not reported.

    Terminal states are `completed` and `failed`. A `failed` job keeps its
    counters exactly where they stopped, and `error` says why; unreadable
    individual items are in `failures` and never fail a run on their own.
    """
    return IngestJobOut.of(IngestService(workspace).get(job_id))


@router.post(
    "/{job_id}/resume",
    status_code=status.HTTP_202_ACCEPTED,
    responses=documented(404, 409),
)
def resume_ingest(
    workspace: WorkspaceDep,
    runner: RunnerDep,
    response: Response,
    job_id: UUID,
) -> IngestJobOut:
    """Run a failed job again, on the same row and into the same batch.

    A redo, not a skip: the whole source is read again. That creates nothing it
    created before — content is addressed by hash and assets are deduplicated —
    so the cost is re-reading and the gain is that resume has no second code path.

    A `completed` job cannot be resumed, and neither can one stuck at `running`:
    that is a process that died without reporting, so ingest the source again
    instead, which creates nothing and leaves the stuck row as the record it is.
    Both answer 409 `INVALID_TRANSITION`.
    """
    # ``resumable``, not ``get``: a completed job must be 409 *here*, because a
    # 202 followed by a refusal only the worker ever saw gives a client no way
    # to tell a redo from a no-op. It reads the same table the run will.
    job = IngestService(workspace).resumable(job_id)
    workspace.job_queue.enqueue(
        BackgroundJobSpec(type=ingest_job_type, payload=ingest_payload_for(job.id), idempotent=True)
    )
    runner.wake()
    response.headers["Location"] = f"/ingest-jobs/{job.id}"
    return IngestJobOut.of(job)
