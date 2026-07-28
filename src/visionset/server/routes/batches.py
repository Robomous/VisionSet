# usage: from visionset.server.routes import batches
"""Batches: curating what gets annotated, and freezing it so work can start.

Two routers, for the reason ``sources.py`` has two: the collection hangs off the
project that owns it, and the batch itself is addressable on its own — so what
hangs off *it* (its assets, its jobs) does not sit four segments deep.

**A batch is born from an ingest**, not from a POST. There is deliberately no
create, delete or membership route here: an ingest run puts what it gathered into
a batch, and curating one out of an arbitrary subset of assets has no caller
until M5's gallery. ``BatchService`` has the methods; the API grows a route when
somebody needs one.

The lifecycle *is* here, because without it nothing downstream is reachable: an
annotation may only be written into a batch that is ``in_annotation``, and a
completed batch is what makes its assets promotable. Approve pins the schema
version and cuts the batch into jobs; start opens it; complete is derived from
the jobs rather than declared.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from uuid import UUID

from visionset.kernel.domain import AssetProgress
from visionset.kernel.services import BatchService, JobService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    BatchApprove,
    BatchAssetOut,
    BatchAssetPage,
    BatchOut,
    BatchPage,
    JobOut,
    JobPage,
    LimitQuery,
    OffsetQuery,
    window,
)

project_router = protected_router(prefix="/projects/{project_id}/batches", tags=["batches"])
router = protected_router(prefix="/batches", tags=["batches"])


@project_router.get("", responses=documented(404))
def list_batches(workspace: WorkspaceDep, project_id: UUID) -> BatchPage:
    """Every batch of that project, in the order they were created."""
    jobs = JobService(workspace)
    found = BatchService(workspace).list(project_id)
    return BatchPage(
        items=[BatchOut.of(batch, jobs.batch_progress(batch.id)) for batch in found],
        total=len(found),
    )


@router.get("/{batch_id}", responses=documented(404))
def get_batch(workspace: WorkspaceDep, batch_id: UUID) -> BatchOut:
    """The batch, with how far its assets have got.

    `progress` counts every asset of every job in the batch, so a draft — which
    has no jobs yet — reports zeros across the board while `asset_count` is
    already whatever the ingest gathered. `schema_version` is null until approval
    pins one, and never moves after.
    """
    batch = BatchService(workspace).get(batch_id)
    return BatchOut.of(batch, JobService(workspace).batch_progress(batch.id))


@router.post("/{batch_id}/approve", responses=documented(404, 409))
def approve_batch(
    workspace: WorkspaceDep, batch_id: UUID, body: BatchApprove | None = None
) -> BatchOut:
    """Freeze the batch: pin the project's active schema version and cut it into jobs.

    Everything after this is judged against the version pinned here, so a new
    schema version created while annotators are working does not change the rules
    under them. Membership stops being editable at the same moment — an asset
    that should not be labeled is marked `skipped` from here on, which keeps the
    decision on the record instead of erasing it.

    The partition defaults to one job for the whole batch. `by_size` cuts jobs of
    a fixed length with the last taking the remainder; `by_segments` says exactly
    which assets go together, and is refused unless it reproduces the batch with
    nothing missing, repeated or foreign.

    A batch that is not a draft is 409 `INVALID_TRANSITION`; an empty one is 409
    `EMPTY_BATCH`, because it would have no jobs and could never complete; a
    project with no schema is 404 `SCHEMA_NOT_FOUND`, since there is nothing to
    pin.
    """
    partition = None if body is None else body.to_domain()
    batch = BatchService(workspace).approve(batch_id, partition)
    return BatchOut.of(batch, JobService(workspace).batch_progress(batch.id))


@router.post("/{batch_id}/start", responses=documented(404, 409))
def start_batch(workspace: WorkspaceDep, batch_id: UUID) -> BatchOut:
    """Open the batch for annotation. Nothing may be written into it before this."""
    batch = BatchService(workspace).start(batch_id)
    return BatchOut.of(batch, JobService(workspace).batch_progress(batch.id))


@router.post("/{batch_id}/complete", responses=documented(404, 409))
def complete_batch(workspace: WorkspaceDep, batch_id: UUID) -> BatchOut:
    """Close the batch, if every one of its jobs is finished.

    Derived rather than declared: this reads the jobs and answers 409
    `BATCH_NOT_COMPLETE` while any of them is outstanding. A completed batch is
    what lets its annotated assets be promoted into the project's dataset.
    """
    batch = BatchService(workspace).complete(batch_id)
    return BatchOut.of(batch, JobService(workspace).batch_progress(batch.id))


@router.get("/{batch_id}/jobs", responses=documented(404))
def list_batch_jobs(workspace: WorkspaceDep, batch_id: UUID) -> JobPage:
    """The jobs the batch was cut into, in segment order.

    Empty until the batch is approved — a draft has no jobs — and a 200 either
    way.
    """
    found = BatchService(workspace).jobs(batch_id)
    return JobPage(items=[JobOut.of(job, batch_id=batch_id) for job in found], total=len(found))


@router.get("/{batch_id}/assets", responses=documented(404))
def list_batch_assets(
    workspace: WorkspaceDep,
    batch_id: UUID,
    limit: LimitQuery = None,
    offset: OffsetQuery = 0,
) -> BatchAssetPage:
    """Everything in the batch, in membership order, with where each asset has got to.

    The order is stored, so reading twice gives the same sequence and an ingest
    into an existing batch appends rather than reshuffles. `total` is the size of
    the whole batch and not of the page; an offset past the end is an empty list
    and a 200, never a 404.

    `job_id` and `progress` are null while the batch is a draft, because a draft
    has no jobs. Bytes are not here: an asset is named by its `content_hash` and
    its `thumbnail_hash`, and downloading either is a later capability.
    """
    batches = BatchService(workspace)
    found = batches.assets(batch_id)
    # Two reads and a projection, not a join. ``jobs`` already carries the
    # per-asset progress map that approval wrote, so where an asset has got to is
    # read off the job that owns it rather than asked for separately — and the
    # partition is exact, so every asset appears in this map at most once.
    placement: dict[UUID, tuple[UUID | None, AssetProgress | None]] = {
        asset_id: (job.id, progress)
        for job in batches.jobs(batch_id)
        for asset_id, progress in job.progress.items()
    }
    items = []
    for asset in window(found, limit=limit, offset=offset):
        job_id, progress = placement.get(asset.id, (None, None))
        items.append(BatchAssetOut.in_batch(asset, job_id=job_id, progress=progress))
    return BatchAssetPage(items=items, total=len(found))
