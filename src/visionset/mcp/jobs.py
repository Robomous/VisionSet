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

``pre_label_job`` asks a model to do the first pass instead: ``pre_label_batch``
narrowed to one job, for the caller that already holds a job id rather than a
batch's whole list of them.
"""

from __future__ import annotations

from typing import Annotated, Any

from mcp.server.mcpserver import Context
from pydantic import ConfigDict, Field, StrictBool, with_config

from visionset import wire
from visionset.inference import (
    DEFAULT_MINIMUM_CONFIDENCE,
    geometry_selection,
    pre_label_recorded,
)
from visionset.jobs.inline import Surface, pre_label_observer
from visionset.kernel.domain import AssetProgress
from visionset.kernel.services import (
    InferenceConnectionService,
    JobService,
)
from visionset.mcp._autostart import autostarted
from visionset.mcp._progress import PreLabelProgress, reporting
from visionset.mcp._resolve import ConnectionRef, identifier
from visionset.mcp._surface import mcp_job
from visionset.mcp._workspace import opened_workspace
from visionset.mcp.batches import Geometries, JobPreLabelOutcome, _pre_label_outcome
from visionset.wire import shapes

JobRef = Annotated[str, Field(description="The annotation job, by id.")]
"""The job a tool acts on. Module-level for the ``inspect.signature`` reason."""


closed = with_config(ConfigDict(extra="forbid"))


@closed
class JobDetail(shapes.Job):
    batch_state: str
    schema_version: int | None
    progress: shapes.ProgressCounts


@closed
class JobDetailStarted(JobDetail):
    job_started: bool


@closed
class AssetProgressSet(shapes.AssetProgress):
    job_started: bool


def _job_payload(service: JobService, job_id: Any) -> JobDetail:
    """The job, the batch it belongs to, and its counts — the shape two tools return."""
    job = service.get(job_id)
    batch = service.batch(job.id)
    return {
        **mcp_job(
            wire.job(
                job,
                batch_id=batch.id,
                batch_state=batch.state,
                pre_labeled=service.latest_pre_label_run(job.id),
            )
        ),
        "batch_state": batch.state.value,
        "schema_version": batch.schema_version,
        "progress": wire.progress_counts(service.job_progress(job.id)),
    }


def get_job(job_id: JobRef) -> JobDetail:
    """Read a job: its state, its counts, and the batch and schema it answers to.

    `schema_version` is the contract annotations written here are judged against;
    it comes from the batch's pin, not from the project's current schema.
    `batch_state` matters because nothing may be written unless it is
    `in_annotation` — if it is `approved`, call `start_batch` first.

    `progress.unannotated` is how much is left; the job can be completed once
    it, `progress.pre_labeled` and `progress.review_pending` are all zero.
    `pre_label_run` is this job's own most recent `pre_label_job` run, or null
    if nothing has pre-labeled it yet.

    `job_id` comes from `approve_batch`, `get_batch` or `list_batch_assets`. It
    is not the `ingest_job_id` an `ingest` run returns — that names the run that
    read the files in, and nothing here reads it.
    """
    with opened_workspace() as workspace:
        return _job_payload(JobService(workspace), identifier(job_id, what="job_id"))


def pre_label_job(
    job_id: JobRef,
    connection: ConnectionRef,
    minimum_confidence: Annotated[
        float,
        Field(
            ge=0.0,
            le=1.0,
            description=(
                "The floor a prediction must clear to be written, in [0, 1]. Tuned for a "
                "text-prompt model's prompt-affinity score — a point-prompt model's mask "
                "quality is a different scale and does not share a threshold with this."
            ),
        ),
    ] = DEFAULT_MINIMUM_CONFIDENCE,
    replace_model_labels: Annotated[
        StrictBool,
        Field(
            description=(
                "Also rewrite the model labels on frames still `pre_labeled` — labels a "
                "model wrote and nobody has edited, confirmed or skipped — superseding them "
                "with this run's answer. Frames anyone touched in this job, and frames "
                "a completed batch confirmed or already in the dataset, are never affected "
                "(`assets_protected` counts them). This cannot be undone; read "
                "`get_job`'s `progress.pre_labeled` first."
            )
        ),
    ] = False,
    geometries: Geometries = None,
    ctx: Context[Any, Any] | None = None,
) -> JobPreLabelOutcome:
    """Ask a model to label every untouched asset in one job. This blocks until it is done.

    `pre_label_batch`'s run narrowed to one job you already hold; the batch's pinned
    schema is still the prompt. Unlike `pre_label_batch`, a job already `completed` is
    refused rather than passed over.

    One forward pass per untouched asset, so expect minutes (send a `progressToken`
    to receive progress, or set a request timeout for the whole run). Only assets
    nothing has touched are labeled, at `pre_labeled`. Interrupting is safe: calling
    again resumes. `replace_model_labels` also rewrites model labels on frames still
    `pre_labeled`, and cannot be undone. Read `plan` in the result whenever
    `assets_labeled` is lower than expected; `get_pre_label_plan` answers the same
    without running.

    Also refused: a batch that is not `in_annotation`, a connection whose model
    answers places rather than words, and a deployment without the local runtime.

    Details: visionset://pre-labeling
    """
    with opened_workspace() as workspace, reporting(ctx) as report:
        resolved_connection = InferenceConnectionService(workspace).resolve(connection)
        resolved_job = identifier(job_id, what="job_id")
        counted = PreLabelProgress(report, 1)
        outcome = pre_label_recorded(
            workspace,
            job_id=resolved_job,
            connection_id=resolved_connection.id,
            minimum_confidence=minimum_confidence,
            replace_model_labels=replace_model_labels,
            geometries=geometry_selection(geometries),
            on_plan=counted.planned,
            on_progress=counted.asset_done,
            observer=pre_label_observer(Surface.MCP),
        )
        counted.finish()
    return {"job_id": str(resolved_job), **_pre_label_outcome(outcome, counted.plans[0])}


def complete_job(job_id: JobRef) -> JobDetailStarted:
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
        service = JobService(workspace)
        # Asked before the start, so a refusal leaves the job as it was found:
        # starting a job and then refusing to complete it is a side effect the
        # caller never asked for and the refusal does not mention.
        service.require_settled(resolved)
        started = autostarted(workspace, resolved)
        completed = service.complete(resolved)
        return {**_job_payload(service, completed.id), "job_started": started}


def next_pending_assets(
    job_id: JobRef,
    count: Annotated[
        int, Field(ge=1, description="How many assets to return. Must be at least 1.")
    ] = 10,
) -> shapes.Page[shapes.Asset]:
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
) -> AssetProgressSet:
    """Record where one asset of a job has got to, without writing annotations.

    Chiefly how you say "there is nothing in this image to label": mark it
    `skipped` and it stops blocking `complete_job` and never enters the dataset.
    Writing annotations moves an asset to `annotated` on its own, so you do not
    need this for the ordinary case.

    Not every move is legal — `accepted` is terminal, and `review_pending` can
    only be reached from `annotated`, and `pre_labeled` is never reachable here:
    only an unjudged write (a pre-label run) or a batch cut over
    all-model-labeled assets lands an asset there. Marking an asset with the state it already
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
