# usage: from visionset.server.routes import jobs
"""Jobs: what an annotator is handed, and how far they have got.

A job is addressed on its own — the batch listing gave a client the id, and
nothing else about the segment is needed to work it. Listing a batch's jobs stays
with the batch, in ``routes/batches.py``.

This is the half of the annotator contract that tracks *whether* an asset was
dealt with; ``routes/annotations.py`` is the half that stores *what was drawn*.
They are separate on purpose, and the kernel keeps them apart for the same
reason: an asset can be skipped with no labels, or labeled and sent back for
rework, and neither of those is expressible in a pile of annotations.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import Query

from visionset.kernel.services import JobService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    AssetOut,
    AssetPage,
    AssetProgressOut,
    AssetProgressSet,
    JobOut,
    ProgressCounts,
)

router = protected_router(prefix="/jobs", tags=["jobs"])

#: How many waiting assets to hand out at once. ``ge=1`` is load-bearing rather
#: than tidy: ``JobService.next_pending`` refuses a non-positive count with a
#: bare ``ValueError``, which is outside the ``VisionSetError`` tree and would
#: reach the catch-all handler as a 500. The bound is what makes that
#: unreachable — the same job ``gt=0`` does for ``extraction_fps`` on a source.
PendingCountQuery = Annotated[
    int,
    Query(ge=1, description="How many waiting assets to hand out. Fewer if fewer remain."),
]


@router.get("/{job_id}", responses=documented(404))
def get_job(workspace: WorkspaceDep, job_id: UUID) -> JobOut:
    """The job, and the batch it is a segment of.

    `batch_id` is the handle worth having: it leads to the schema version this
    job's work is judged against, which a job id alone does not.
    """
    jobs = JobService(workspace)
    return JobOut.of(jobs.get(job_id), batch_id=jobs.batch(job_id).id)


@router.get("/{job_id}/progress", responses=documented(404))
def get_job_progress(workspace: WorkspaceDep, job_id: UUID) -> ProgressCounts:
    """How many of this job's assets sit in each state.

    Every state is a field, including the ones nobody is in, so a client charting
    progress never has to guard a lookup.
    """
    return ProgressCounts.of(JobService(workspace).job_progress(job_id))


@router.post("/{job_id}/start", responses=documented(404, 409))
def start_job(workspace: WorkspaceDep, job_id: UUID) -> JobOut:
    """Take the job from `pending` to `in_progress`.

    The batch has to be open first: a job in a batch nobody started is 409
    `BATCH_NOT_IN_ANNOTATION`.
    """
    jobs = JobService(workspace)
    return JobOut.of(jobs.start(job_id), batch_id=jobs.batch(job_id).id)


@router.post("/{job_id}/complete", responses=documented(404, 409))
def complete_job(workspace: WorkspaceDep, job_id: UUID) -> JobOut:
    """Close the job, if every asset in it has been dealt with.

    Dealt with means `annotated`, `skipped` or `accepted`. An `unannotated` asset
    means the labeling has not happened and a `review_pending` one means the
    review has not; either answers 409 `JOB_NOT_COMPLETE` and says how many are
    outstanding.

    Completing a job does not complete its batch — `POST /batches/{id}/complete`
    derives that from all of them.
    """
    jobs = JobService(workspace)
    return JobOut.of(jobs.complete(job_id), batch_id=jobs.batch(job_id).id)


@router.get("/{job_id}/next", responses=documented(404))
def next_pending_assets(
    workspace: WorkspaceDep, job_id: UUID, n: PendingCountQuery = 1
) -> AssetPage:
    """The next assets waiting to be labeled, in the batch's own order.

    Only `unannotated` ones: this answers the annotator's question, and an asset
    in `review_pending` is waiting on a reviewer rather than on labeling. The
    order is stored, so the same call twice returns the same assets — and marking
    an unrelated one does not reshuffle what is left.

    Fewer than `n` come back when fewer remain, and nothing at all once the job
    is done. `total` is the size of this answer, not of the job; the job's own
    tally is at `GET /jobs/{job_id}/progress`.
    """
    found = JobService(workspace).next_pending(job_id, n)
    return AssetPage(items=[AssetOut.of(asset) for asset in found], total=len(found))


@router.put("/{job_id}/assets/{asset_id}/progress", responses=documented(404, 409))
def set_asset_progress(
    workspace: WorkspaceDep, job_id: UUID, asset_id: UUID, body: AssetProgressSet
) -> AssetProgressOut:
    """Record where one asset of this job has got to.

    One route rather than five verbs, because the legal moves are a table in the
    kernel and a second spelling of it would drift: `unannotated` to `annotated`
    or `skipped`, `annotated` to `review_pending` or back, `review_pending` to
    `accepted` or back to `annotated`, and `accepted` nowhere at all. Anything
    else is 409 `INVALID_TRANSITION`.

    Setting the state an asset is already in is a no-op rather than a refusal —
    but the batch gate fires first, so writing into a closed batch is refused
    whether or not the value would have changed.

    Labels move `unannotated` and `annotated` on their own as annotations are
    added and deleted. This route is for the decisions that are nobody's
    consequence: skipping, submitting for review, accepting.
    """
    JobService(workspace).mark(job_id, asset_id, body.progress)
    return AssetProgressOut(asset_id=asset_id, progress=body.progress)
