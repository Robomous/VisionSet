# usage: from visionset.server.routes import batches
"""Batches: curating what gets annotated, and freezing it so work can start.

Two routers, for the reason ``sources.py`` has two: the collection hangs off the
project that owns it, and the batch itself is addressable on its own — so what
hangs off *it* (its assets, its jobs) does not sit four segments deep.

``promote`` also lives here, and its path is the argument for it — see the
comment on the handler.

**A batch is born from an ingest**, not from a POST. There is deliberately no
create, delete or membership route here: an ingest run puts what it gathered into
a batch, and curating one out of an arbitrary subset of assets has no caller
until M5's gallery. ``BatchService`` has the methods; the API grows a route when
somebody needs one.

The lifecycle *is* here, because without it nothing downstream is reachable: an
annotation may only be written into a batch that is ``in_annotation``, and a
completed batch is what makes its assets promotable. Approve pins the schema
version and cuts the batch into jobs; start opens it; complete is derived from
the jobs rather than declared. ``repin`` is the one route that moves a pin after
approval, and it is a request rather than a consequence — see its handler.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from uuid import UUID

from visionset.kernel.domain import AssetProgress
from visionset.kernel.services import BatchService, DatasetService, JobService, ProjectService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    AssetOut,
    AssetPage,
    BatchApprove,
    BatchAssetOut,
    BatchAssetPage,
    BatchCorrection,
    BatchCreate,
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


def _promoted(workspace: WorkspaceDep, project_id: UUID) -> frozenset[UUID]:
    """The trunk's current membership, read once for the whole response.

    Every ``BatchOut`` needs it and none of them needs a different one, so a
    listing of twenty batches costs one query rather than twenty — the batch's
    own ``asset_ids`` are already in memory and the rest is a set intersection.

    A project's dataset is 1:1 and created in the same transaction as the
    project, so this cannot fail for a project that exists; a project that does
    not is already a 404 from whatever resolved it.
    """
    dataset = ProjectService(workspace).get_dataset(project_id)
    return DatasetService(workspace).member_asset_ids(dataset.id)


@project_router.post("", status_code=201, responses=documented(404, 422))
def create_batch(workspace: WorkspaceDep, project_id: UUID, body: BatchCreate) -> BatchOut:
    """Start a draft batch over a chosen set of the project's assets.

    **A batch is still born from an ingest in the ordinary case**, and this does
    not change that: an ingest run puts what it gathered into one, which is where
    almost every batch comes from. What had no surface at all was curating one
    out of an arbitrary subset — the shape a correction batch is, and the shape
    anybody re-cutting work by hand needs (cf. #281).

    The batch is a `draft`, so its membership stays editable and approval is what
    freezes it and pins the schema. `asset_ids` may be empty: a batch nobody has
    filled yet is a legitimate intermediate state, and approving one is what
    `EmptyBatch` refuses.
    """
    batches = BatchService(workspace)
    created = batches.create(project_id, body.name, body.asset_ids)
    return BatchOut.of(
        created,
        JobService(workspace).batch_progress(created.id),
        promoted=_promoted(workspace, project_id),
    )


@project_router.get("", responses=documented(404))
def list_batches(workspace: WorkspaceDep, project_id: UUID) -> BatchPage:
    """Every batch of that project, in the order they were created."""
    jobs = JobService(workspace)
    found = BatchService(workspace).list(project_id)
    promoted = _promoted(workspace, project_id)
    return BatchPage(
        items=[
            BatchOut.of(batch, jobs.batch_progress(batch.id), promoted=promoted) for batch in found
        ],
        total=len(found),
    )


@router.get("/{batch_id}", responses=documented(404))
def get_batch(workspace: WorkspaceDep, batch_id: UUID) -> BatchOut:
    """The batch, with how far its assets have got.

    `progress` counts every asset of every job in the batch, so a draft — which
    has no jobs yet — reports zeros across the board while `asset_count` is
    already whatever the ingest gathered. `schema_version` is null until approval
    pins one, and moves after that only through `repin`.
    """
    batch = BatchService(workspace).get(batch_id)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
    )


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
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
    )


@router.post("/{batch_id}/start", responses=documented(404, 409))
def start_batch(workspace: WorkspaceDep, batch_id: UUID) -> BatchOut:
    """Open the batch for annotation. Nothing may be written into it before this."""
    batch = BatchService(workspace).start(batch_id)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
    )


@router.post("/{batch_id}/repin", responses=documented(404, 409))
def repin_batch(
    workspace: WorkspaceDep, batch_id: UUID, allow_destructive: bool = False
) -> BatchOut:
    """Move the batch's schema pin onto the project's current active version.

    Explicit, never automatic — the pin does not follow the schema, because a
    contract that moved under work in flight is what versioning exists to
    prevent. This is how a class added *after* approval becomes usable in a batch
    somebody is already annotating, without abandoning it.

    Adding a class is additive and goes through with no flag. A change that
    narrows what the pin allowed — a class removed, a geometry changed, an
    attribute made required — is 409 `DESTRUCTIVE_SCHEMA_CHANGE`; retry the
    identical request with `?allow_destructive=true`. If this batch already holds
    annotations under a class the change would break, it is 409
    `SCHEMA_CHANGE_WOULD_ORPHAN` and **no flag overrides it** — branch on the
    code, never on the status. The orphan check is scoped to this batch: a label
    written in some *other* batch does not block this one.

    Legal only while the batch is `approved` or `in_annotation`; a draft has no
    pin yet and a completed batch's pin is history, both 409
    `INVALID_TRANSITION`. Re-pinning onto the version already pinned changes
    nothing. Annotations already written keep the version they were stamped with.
    """
    batch = BatchService(workspace).repin(batch_id, allow_destructive=allow_destructive)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
    )


@router.post("/{batch_id}/complete", responses=documented(404, 409))
def complete_batch(workspace: WorkspaceDep, batch_id: UUID) -> BatchOut:
    """Close the batch, if every one of its jobs is finished.

    Derived rather than declared: this reads the jobs and answers 409
    `BATCH_NOT_COMPLETE` while any of them is outstanding. A completed batch is
    what lets its annotated assets be promoted into the project's dataset.
    """
    batch = BatchService(workspace).complete(batch_id)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
    )


@router.post("/{batch_id}/corrections", status_code=201, responses=documented(404, 409, 422))
def create_correction_batch(
    workspace: WorkspaceDep, batch_id: UUID, body: BatchCorrection
) -> BatchOut:
    """Cut a new draft batch that corrects this completed one.

    **The forward-only answer to "this needs fixing".** A `completed` batch is
    immutable as a workflow unit — it has no exit in the lifecycle and none is
    coming — so changing settled work means a new batch over the same assets,
    carrying lineage back to this one in `parent_batch_id`.

    Addressed as a sub-resource of the parent because the parent is what decides:
    `create_correction` is declared on `BatchOut` exactly while the batch is
    `completed`, and a 409 is what a client gets for asking otherwise.

    `asset_ids` defaults to **the parent's whole membership**, since "correct
    this batch" is the ordinary ask. A subset is the other one — the three frames
    somebody found wrong — and every id given must be one the parent carried: a
    correction of a batch is a correction *of what was in it*.

    The child pins the project's **active** schema at its own approval, not the
    parent's pin. That is the point of correcting under a contract that has moved
    on, and it is the ordinary approval mechanism rather than anything new.
    """
    created = BatchService(workspace).create_correction(batch_id, body.name, body.asset_ids)
    return BatchOut.of(
        created,
        JobService(workspace).batch_progress(created.id),
        promoted=_promoted(workspace, created.project_id),
    )


@router.get("/{batch_id}/jobs", responses=documented(404))
def list_batch_jobs(workspace: WorkspaceDep, batch_id: UUID) -> JobPage:
    """The jobs the batch was cut into, in segment order.

    Empty until the batch is approved — a draft has no jobs — and a 200 either
    way.
    """
    batches = BatchService(workspace)
    # The batch itself, not only the id its path already carries: both job actions
    # need the batch open, so ``allowed_actions`` cannot be answered without it.
    batch = batches.get(batch_id)
    found = batches.jobs(batch_id)
    return JobPage(items=[JobOut.of(job, batch=batch) for job in found], total=len(found))


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
    has no jobs. Bytes are not here: an asset is named by its hashes, and
    `GET /projects/{project_id}/assets/{asset_id}/content` is what serves them.
    """
    batches = BatchService(workspace)
    batch = batches.get(batch_id)
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
        items.append(
            BatchAssetOut.in_batch(asset, job_id=job_id, progress=progress, batch_state=batch.state)
        )
    return BatchAssetPage(items=items, total=len(found))


# The one dataset operation that lives here rather than in ``datasets.py``, and
# the path is the argument: ``DatasetService.promote`` takes a *batch* id and
# derives everything else from it, so a ``dataset_id`` in front would be a segment
# no service ever checks — a path parameter nobody validates is a lie a client
# will eventually rely on. The batch is also where the refusal lives, which is the
# other half of it: promoting is what a completed batch is *for*.
@router.post("/{batch_id}/promote", responses=documented(404, 409))
def promote_batch(workspace: WorkspaceDep, batch_id: UUID) -> AssetPage:
    """Move the batch's labeled assets into its project's dataset.

    The one gate into the trunk. Which assets go in is derived, not chosen: those
    an annotator left `annotated` or a reviewer left `accepted`. A `skipped`
    asset stays out by design, and the decision stays on the record rather than
    being erased from the batch.

    Idempotent, and a union rather than a replacement. Promoting the same batch
    twice returns an empty list the second time and writes no change-log entry,
    because nothing happened — and re-promoting after a curator removed an asset
    puts it back, since the trunk keeps no memory of removals.

    A batch that has not reached `completed` is 409 `BATCH_NOT_COMPLETE`.
    """
    promoted = DatasetService(workspace).promote(batch_id)
    return AssetPage(items=[AssetOut.of(asset) for asset in promoted], total=len(promoted))
