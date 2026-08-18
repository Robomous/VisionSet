# usage: from visionset.mcp import jobs
"""Job tools: the annotation loop an agent actually drives.

A job is one segment of an approved batch. ``next_pending_assets`` → look at the
pixels → ``add_annotations`` → ``set_asset_progress`` where nothing is there to
label → ``complete_job``.

**There is no ``start_job``.** A job is taken to ``in_progress`` by the first
write that touches it, and the result says so; see ``_autostart``. The lifecycle
verb was retired rather than folded, because the only thing an agent could do
with it was remember to call it, and measured runs did not.

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
from visionset.mcp._autostart import autostarted
from visionset.mcp._resolve import identifier
from visionset.mcp._workspace import opened_workspace

JobRef = Annotated[str, Field(description="The annotation job, by id.")]
"""The job a tool acts on. Module-level for the ``inspect.signature`` reason."""


def _job_payload(
    service: JobService, job_id: Any, *, job_started: bool | None = None
) -> dict[str, Any]:
    """The job, the batch it belongs to, and its counts — the shape two tools return.

    ``job_started`` is omitted for a read and present for a write, because only a
    write can have started anything. See :func:`autostarted`.
    """
    job = service.get(job_id)
    batch = service.batch(job.id)
    payload = {
        **wire.job(job, batch_id=batch.id, batch_state=batch.state),
        "batch_state": batch.state.value,
        "schema_version": batch.schema_version,
        "progress": wire.progress_counts(service.job_progress(job.id)),
    }
    return payload if job_started is None else {**payload, "job_started": job_started}


def get_job(job_id: JobRef) -> dict[str, Any]:
    """Read a job: its state, its counts, and the batch and schema it answers to.

    `schema_version` is the contract annotations written here are judged against;
    it comes from the batch's pin, not from the project's current schema.
    `batch_state` matters because nothing may be written unless it is
    `in_annotation` — if it is `approved`, call `start_batch` first.

    `progress.unannotated` is how much is left; the job can be completed once
    it, `progress.pre_labeled` and `progress.review_pending` are all zero.

    `job_id` comes from `approve_batch`, `get_batch` or `list_batch_assets`. It
    is not the `ingest_job_id` an `ingest` run returns — that names the run that
    read the files in, and nothing here reads it.
    """
    with opened_workspace() as workspace:
        return _job_payload(JobService(workspace), identifier(job_id, what="job_id"))


def complete_job(job_id: JobRef) -> dict[str, Any]:
    """Close a job, once every one of its assets has been settled.

    Settled means `annotated`, `skipped` or `accepted`. An asset still
    `unannotated`, `pre_labeled` or `review_pending` blocks this, and the
    remedy is either to annotate it — which also takes over a `pre_labeled`
    frame — or to `set_asset_progress` it to `skipped`.

    You do not have to start the job first. A job nobody has written to yet is
    started here before it is closed, and `job_started` in the answer says
    whether that happened — which is the ordinary case for a correction batch
    whose assets all arrived already labeled and needed no edits.

    Completing a job does not complete its batch: `complete_batch` derives that
    from all the jobs, and is a separate call.
    """
    with opened_workspace() as workspace:
        resolved = identifier(job_id, what="job_id")
        started = autostarted(workspace, resolved)
        service = JobService(workspace)
        completed = service.complete(resolved)
        return _job_payload(service, completed.id, job_started=started)


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

    An empty `items` means nothing is bare-unlabeled — not that the job can be
    completed: a `pre_labeled` asset carries a model's guess rather than
    nothing, so it never appears here, but it still blocks `complete_job` until
    somebody edits or skips it. `list_batch_assets` is how to find those; `id`
    from either is what `get_asset_image` and `add_annotations` take.
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

    Marking an asset starts the job if nobody had, and `job_started` says whether
    that happened.
    """
    with opened_workspace() as workspace:
        resolved_job = identifier(job_id, what="job_id")
        resolved_asset = identifier(asset_id, what="asset_id")
        started = autostarted(workspace, resolved_job)
        JobService(workspace).mark(resolved_job, resolved_asset, progress)
    return {**wire.asset_progress(resolved_asset, progress), "job_started": started}
