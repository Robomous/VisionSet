# usage: from visionset.mcp import jobs
"""Job tools: the annotation loop an agent actually drives.

A job is one segment of an approved batch. ``start_job`` →
``next_pending_assets`` → look at the pixels → ``add_annotations`` →
``set_asset_progress`` where nothing is there to label → ``complete_job``.

``get_job_progress`` folds into ``get_job``: the counts *are* what a caller wants
a job for, and a second tool to fetch them is a round trip for a field.

``next_pending_assets`` is the iteration primitive and the reason this loop
terminates. It returns only ``unannotated`` assets in stored order, so calling it
after each write walks the job exactly once with no bookkeeping on the agent's
side.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from visionset import wire
from visionset.kernel.domain import AssetProgress
from visionset.kernel.services import JobService
from visionset.mcp._resolve import identifier
from visionset.mcp._workspace import opened_workspace

JobRef = Annotated[str, Field(description="The annotation job, by id.")]
"""The job a tool acts on. Module-level for the ``inspect.signature`` reason."""


def _job_payload(service: JobService, job_id: Any) -> dict[str, Any]:
    """The job, the batch it belongs to, and its counts — the shape three tools return."""
    job = service.get(job_id)
    batch = service.batch(job.id)
    return {
        **wire.job(job, batch_id=batch.id),
        "batch_state": batch.state.value,
        "schema_version": batch.schema_version,
        "progress": wire.progress_counts(service.job_progress(job.id)),
    }


def get_job(job_id: JobRef) -> dict[str, Any]:
    """Read a job: its state, its counts, and the batch and schema it answers to.

    `schema_version` is the contract annotations written here are judged against;
    it comes from the batch's pin, not from the project's current schema.
    `batch_state` matters because nothing may be written unless it is
    `in_annotation` — if it is `approved`, call `start_batch` first.

    `progress.unannotated` is how much is left; when it and `review_pending` are
    both zero the job can be completed.
    """
    with opened_workspace() as workspace:
        return _job_payload(JobService(workspace), identifier(job_id, what="job_id"))


def start_job(job_id: JobRef) -> dict[str, Any]:
    """Mark a job as being worked on.

    Refuses unless the job's batch is already `in_annotation`. Starting a job
    does not start its batch — that is `start_batch`, and it comes first.
    """
    with opened_workspace() as workspace:
        service = JobService(workspace)
        started = service.start(identifier(job_id, what="job_id"))
        return _job_payload(service, started.id)


def complete_job(job_id: JobRef) -> dict[str, Any]:
    """Close a job, once every one of its assets has been settled.

    Settled means `annotated`, `skipped` or `accepted`. An asset still
    `unannotated` or `review_pending` blocks this, and the remedy is either to
    annotate it or to `set_asset_progress` it to `skipped`.

    Completing a job does not complete its batch: `complete_batch` derives that
    from all the jobs, and is a separate call.
    """
    with opened_workspace() as workspace:
        service = JobService(workspace)
        completed = service.complete(identifier(job_id, what="job_id"))
        return _job_payload(service, completed.id)


def next_pending_assets(
    job_id: JobRef,
    count: Annotated[
        int, Field(ge=1, description="How many assets to return. Must be at least 1.")
    ] = 10,
) -> dict[str, Any]:
    """Get the next assets in a job that nobody has annotated yet.

    The loop primitive: call it, annotate what comes back, call it again. It
    returns only `unannotated` assets, in the job's own stored order, so an asset
    stops appearing once it has been annotated or skipped and the walk terminates
    without you tracking position.

    An empty `items` means every asset in the job has been settled and the job
    can be completed. Each `id` is what `get_asset_image` and `add_annotations`
    take.
    """
    with opened_workspace() as workspace:
        assets = JobService(workspace).next_pending(identifier(job_id, what="job_id"), count)
    return wire.page([wire.asset(a) for a in assets])


def set_asset_progress(
    job_id: JobRef,
    asset_id: Annotated[str, Field(description="The asset within that job, by id.")],
    progress: Annotated[
        AssetProgress,
        Field(
            description=(
                "The state to move the asset to. Use 'skipped' for an asset with nothing to label."
            )
        ),
    ],
) -> dict[str, Any]:
    """Record where one asset of a job has got to, without writing annotations.

    Chiefly how you say "there is nothing in this image to label": mark it
    `skipped` and it stops blocking `complete_job` and never enters the dataset.
    Writing annotations moves an asset to `annotated` on its own, so you do not
    need this for the ordinary case.

    Not every move is legal — `accepted` is terminal, and `review_pending` can
    only be reached from `annotated`. Marking an asset with the state it already
    holds does nothing and is not an error. Refuses if the job's batch is not
    `in_annotation`.
    """
    with opened_workspace() as workspace:
        resolved_asset = identifier(asset_id, what="asset_id")
        JobService(workspace).mark(identifier(job_id, what="job_id"), resolved_asset, progress)
    return wire.asset_progress(resolved_asset, progress)
