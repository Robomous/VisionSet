# usage: from visionset.mcp import batches
"""Batch tools: the one-way lifecycle, and the two listings that drive iteration.

``draft`` → ``approve`` → ``start`` → ``complete``, and there is no way back.
Approval freezes membership, pins the project's active schema version, and cuts
the batch into jobs; nothing after that can return it to a draft, because the
jobs are already partitioned against the pin.

**There is no ``create_batch`` and no membership editing.** A batch is born from
an ingest. Curating one out of an arbitrary subset of assets has no caller until
a gallery exists to pick that subset in, and after approval the way to exclude an
asset is ``set_asset_progress`` with ``skipped``, not a membership change.
``BatchService`` still has all four methods — this is a decision about the
surface, the same one the REST API and the CLI made.

``list_batch_jobs`` folds into ``get_batch``: a batch's jobs are how it is worked,
so an agent asking about a batch is about to ask about its jobs.

``jobs_of`` is the ``BySize`` partition and there is no way to spell
``BySegments``. That variant's own docstring says the caller has already decided
the split, and the only caller holding an exact partition is a program with the
SDK. It is also the one partition that can be *wrong*, with four distinct
refusals, and handing a model the chance to meet all four buys nothing.
"""

from __future__ import annotations

from typing import Annotated, Any, Final
from uuid import UUID

from pydantic import Field

from visionset import wire
from visionset.kernel.domain import BySize, Partition
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    WorkspaceService,
)
from visionset.mcp._resolve import ProjectRef, identifier, resolve_project
from visionset.mcp._workspace import opened_workspace

BatchRef = Annotated[str, Field(description="The batch, by id. Batch names are not unique.")]
"""The batch a tool acts on. Module-level for the ``inspect.signature`` reason."""

_ACTOR: Final = "mcp"
"""Who the dataset change log records for a promotion made by an agent."""


def _promoted(workspace: WorkspaceService, project_id: UUID) -> frozenset[UUID]:
    """The trunk's current membership, read once for the whole answer.

    The same cost model the REST routes use: one query per call rather than one
    per batch, because ``asset_ids`` is already in memory and the rest is a set
    intersection.
    """
    dataset = ProjectService(workspace).get_dataset(project_id)
    return DatasetService(workspace).member_asset_ids(dataset.id)


def _batch_payload(workspace: WorkspaceService, batch_id: UUID) -> dict[str, Any]:
    """The batch, its progress and its jobs — the shape three tools return."""
    batches = BatchService(workspace)
    batch = batches.get(batch_id)
    counts = JobService(workspace).batch_progress(batch.id)
    jobs = batches.jobs(batch.id)
    return {
        **wire.batch(batch, counts, promoted=_promoted(workspace, batch.project_id)),
        "jobs": [wire.job(j, batch_id=batch.id, batch_state=batch.state) for j in jobs],
    }


def list_batches(project: ProjectRef) -> dict[str, Any]:
    """List a project's batches with where each one's assets have got to.

    The overview of outstanding work: `state` says whether a batch is open, and
    `progress.unannotated` says how much is left in it. A batch in
    `in_annotation` with unannotated assets is what `next_pending_assets` is for.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        found = BatchService(workspace).list(resolved.id)
        jobs = JobService(workspace)
        counts = [jobs.batch_progress(b.id) for b in found]
        promoted = _promoted(workspace, resolved.id)
    return wire.page(
        [wire.batch(b, c, promoted=promoted) for b, c in zip(found, counts, strict=True)],
    )


def get_batch(batch_id: BatchRef) -> dict[str, Any]:
    """Read one batch: its state, its schema pin, its progress and its jobs.

    `schema_version` is the contract every annotation in this batch is judged
    against, and it is null exactly while the batch is a draft. `jobs` is empty
    until the batch is approved — approval is what creates them.
    """
    with opened_workspace() as workspace:
        return _batch_payload(workspace, identifier(batch_id, what="batch_id"))


def approve_batch(
    batch_id: BatchRef,
    jobs_of: Annotated[
        int | None,
        Field(
            ge=1,
            description=(
                "Cut the batch into jobs of this many assets. Omit for one job "
                "covering the whole batch."
            ),
        ),
    ] = None,
) -> dict[str, Any]:
    """Freeze a batch, pin the project's active schema, and cut it into jobs.

    One-way: there is no route back to `draft`. Approval reads the project's
    *current* active schema version and records it on the batch, and a later
    `create_schema_version` does not move that pin — so approve after the schema
    is the one you want annotations judged against.

    Refuses if the batch has no assets, if it is not a draft, or if the project
    has no schema at all. Then call `start_batch` to open it for work.
    """
    # `ge=1` on the parameter rather than a check in the body: `BySize.size` is
    # `gt=0`, and constructing one with zero raises a pydantic ValidationError,
    # which is not a VisionSetError and would never reach the error envelope.
    partition: Partition | None = None if jobs_of is None else BySize(size=jobs_of)
    with opened_workspace() as workspace:
        approved = BatchService(workspace).approve(identifier(batch_id, what="batch_id"), partition)
        return _batch_payload(workspace, approved.id)


def start_batch(batch_id: BatchRef) -> dict[str, Any]:
    """Open an approved batch for annotation.

    Nothing may be written into a batch until this has been called: every
    annotation tool and `set_asset_progress` refuse while the batch is not
    `in_annotation`. Refuses if the batch has not been approved.
    """
    with opened_workspace() as workspace:
        started = BatchService(workspace).start(identifier(batch_id, what="batch_id"))
        return _batch_payload(workspace, started.id)


def repin_batch(
    batch_id: BatchRef,
    allow_destructive: Annotated[
        bool,
        Field(
            description=(
                "Proceed even though the active version narrows what the pinned "
                "one allowed. Only set this after reading the refusal."
            )
        ),
    ] = False,
) -> dict[str, Any]:
    """Move a batch's schema pin onto the project's *current* active version.

    The pin does not follow the schema on its own, so a class you add with
    `create_schema_version` is invisible inside a batch that was approved before
    it — every annotation there is judged against the pinned version. This is how
    you make the new class usable without abandoning the batch, and it is the
    second half of "add a label class while annotating".

    Adding a class is additive and needs no flag. If the new version *narrows*
    what the pin allowed — a class removed, a geometry changed, an attribute made
    required — this refuses and tells you to retry with `allow_destructive`. If
    the batch already holds annotations under a class the change would break, it
    refuses with **no** `retry_with`: nothing overrides that, and the remedy is a
    wider schema version, not a louder yes.

    Legal only while the batch is `approved` or `in_annotation`. Re-pinning onto
    the version already pinned changes nothing. Annotations already written keep
    the version they were stamped with.
    """
    with opened_workspace() as workspace:
        repinned = BatchService(workspace).repin(
            identifier(batch_id, what="batch_id"), allow_destructive=allow_destructive
        )
        return _batch_payload(workspace, repinned.id)


def complete_batch(batch_id: BatchRef) -> dict[str, Any]:
    """Close a batch, once every one of its jobs is complete.

    Derived means recomputed, not automatic: this reads the jobs and refuses
    while any is outstanding, so complete the jobs first. A completed batch is
    what `promote_batch` requires.
    """
    with opened_workspace() as workspace:
        completed = BatchService(workspace).complete(identifier(batch_id, what="batch_id"))
        return _batch_payload(workspace, completed.id)


def list_batch_assets(
    batch_id: BatchRef,
    limit: Annotated[
        int | None,
        Field(ge=1, description="How many assets to return. Omit for all of them."),
    ] = None,
    offset: Annotated[int, Field(ge=0, description="How many assets to skip.")] = 0,
) -> dict[str, Any]:
    """List a batch's assets, with the job each belongs to and its progress.

    The paged view of what is in a batch — a batch of fifty thousand frames is an
    ordinary thing, so page it. `total` is the size of the whole batch and does
    not change as you page; an offset past the end is an empty page, not an error.

    `job_id` and `progress` are both null exactly while the batch is a draft,
    because a draft has no jobs. Use `get_asset_image` on any `id` here to see
    the pixels.
    """
    with opened_workspace() as workspace:
        resolved = identifier(batch_id, what="batch_id")
        service = BatchService(workspace)
        batch = service.get(resolved)
        assets = service.assets(resolved)
        # The partition is exact, so each asset appears in at most one job and
        # this projection is a lookup rather than a join. Two public reads and no
        # new kernel method, which is what the REST listing does too.
        placement = {
            asset_id: (job.id, progress)
            for job in service.jobs(resolved)
            for asset_id, progress in job.progress.items()
        }
        # `limit` bounds the *response*, not the read. The kernel has no windowed
        # read, so this slices a full list and `total` stays the size of the whole
        # batch — page until you have seen `total` items, not until it moves.
        window = assets[offset:] if limit is None else assets[offset : offset + limit]
        items = [
            wire.batch_asset(a, job_id=job_id, progress=progress, batch_state=batch.state)
            for a in window
            for job_id, progress in [placement.get(a.id, (None, None))]
        ]
    return {"items": items, "total": len(assets)}


def promote_batch(batch_id: BatchRef) -> dict[str, Any]:
    """Move a completed batch's finished assets into the project's dataset.

    The dataset is the trunk every release is cut from, so this is the step
    between annotating and publishing. Only `annotated` and `accepted` assets
    travel — a `skipped` one was a decision and it is honoured. Annotations come
    along with their assets.

    A union against what is already there: promoting the same batch twice adds
    nothing the second time and records nothing. Refuses if the batch is not
    complete.
    """
    with opened_workspace() as workspace:
        promoted = DatasetService(workspace).promote(
            identifier(batch_id, what="batch_id"), actor=_ACTOR
        )
    return wire.page([wire.asset(a) for a in promoted])
