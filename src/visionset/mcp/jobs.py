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

from pydantic import Field

from visionset import wire
from visionset.inference import DEFAULT_MINIMUM_CONFIDENCE, PreLabelPlan, pre_label
from visionset.kernel.domain import AssetProgress
from visionset.kernel.services import JobService
from visionset.mcp._autostart import autostarted
from visionset.mcp._resolve import ConnectionRef, identifier, resolve_connection
from visionset.mcp._workspace import opened_workspace
from visionset.mcp.batches import Geometries, _pre_label_outcome, _selection

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
        **wire.job(
            job,
            batch_id=batch.id,
            batch_state=batch.state,
            pre_labeled=service.latest_pre_label_run(job.id),
        ),
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
        bool,
        Field(
            description=(
                "Also rewrite the model labels on frames still `pre_labeled` — labels a "
                "model wrote and nobody has edited, confirmed or skipped — superseding them "
                "with this run's answer. Frames anyone touched in this job are never "
                "affected. This cannot be undone; read `get_job`'s `progress.pre_labeled` "
                "first."
            )
        ),
    ] = False,
    geometries: Geometries = None,
) -> dict[str, Any]:
    """Ask a model to label every untouched asset in one job. This blocks until it is done.

    `pre_label_batch`'s run, narrowed to the one job you already hold: a
    `batch_id` starts this from `open_jobs_of`'s whole list, this starts it
    from one entry in that list. **The batch's pinned schema is still the
    prompt** — the model is asked for each class the schema declares that the
    shapes this run writes can be written as, exactly as a batch-wide run
    would ask, because the schema is pinned to the batch, not chosen per job.
    **A job already `completed` is refused, not passed over** — unlike
    `pre_label_batch`, which skips a finished job on its way to the next one,
    naming one job here is a decision to run that job, and a finished one has
    nothing left to write.

    This call runs one forward pass per untouched asset, so the wait is
    roughly that many times one image's inference time.

    **Interrupting is safe.** A plain run only ever writes to an asset nothing
    has touched, and commits one asset's labels in the same transaction as its
    move to `pre_labeled` — so a cut-off call has entered some prefix of the
    assets it was reaching and touched nothing else, and calling this again
    resumes with whatever is still untouched — plus, where
    `replace_model_labels` is set, the frames still `pre_labeled` — rather than
    starting over or double-writing what already landed.

    **Only assets nothing has touched — not merely assets reading
    `unannotated`.** An asset already `pre_labeled`, annotated, skipped,
    awaiting review or accepted is passed over, and so is an `unannotated` one
    that still carries annotations from a round that was skipped and later
    restored, since that sequence deletes no labels. A frame this tool already
    pre-labeled is therefore never re-asked about by a plain call, at any confidence.
    **`replace_model_labels` is the deliberate exception**: it also reaches every
    frame still `pre_labeled` and supersedes the model's labels there with this
    call's answer, one frame per transaction — a frame the model now finds
    nothing on returns to `unannotated`, and `annotations_replaced` in the
    result says how many labels went. A frame anyone edited, confirmed or
    skipped in this job is never touched either way. What is written lands at
    `pre_labeled`, never at `annotated` — nobody judged it, so it stays
    editable and out of the Dataset until somebody does. An asset somebody
    starts working while this call is still running is passed over the same
    way rather than failing the whole call; `assets_skipped` in the result
    says how many.

    **A region that could not be written as the class it named is discarded,
    not fatal.** A label naming no phrase asked for, or a shape the class does
    not admit or the model never declared, is passed over the same way. A
    text-prompted detector answers with text decoded from spans over the
    prompt, not a choice from the classes it was asked about, so a span
    crossing the boundary between two phrases can answer with neither of
    them; a model declaring two shapes may also answer in the one its class
    does not take. `regions_discarded` in the result says how many.

    **A mapped region with no overlap with a measured asset is discarded
    separately.** `regions_out_of_bounds` in the result says how many; an
    asset without dimensions remains eligible.

    **What the run writes is every shape the model produces unless `geometries`
    says which.** A model declaring both a box and a polygon writes both for
    every region it answers with, unpaired; `geometries` filters that to the
    shapes named, and a region in any other shape is counted in
    `regions_discarded`. Naming a shape the model does not produce is refused
    before anything runs.

    `plan` in the result names both halves: `asked_classes` is what this run
    actually asked about, and `excluded_classes` names every class of the pinned
    schema it could not, each with every reason; `produces` says what shape the
    run wrote. `schema_version` is the pin both were derived from. Read it
    whenever `assets_labeled` is lower than expected — a run that asked about
    two of a schema's five classes labels nothing under the other three, and
    the counters alone cannot say so. `get_pre_label_plan` answers the same
    thing without running anything.

    Also refused before anything runs: a job that is `completed`, a batch that
    is not `in_annotation`, a connection whose model answers places rather
    than words, and a deployment without the local runtime — with the install
    command in the message.
    """
    seen: list[PreLabelPlan] = []
    with opened_workspace() as workspace:
        resolved_connection = resolve_connection(workspace, connection)
        resolved_job = identifier(job_id, what="job_id")
        outcome = pre_label(
            workspace,
            job_id=resolved_job,
            connection_id=resolved_connection.id,
            minimum_confidence=minimum_confidence,
            replace_model_labels=replace_model_labels,
            geometries=_selection(geometries),
            on_plan=seen.append,
        )
    return {"job_id": str(resolved_job), **_pre_label_outcome(outcome, seen[0])}


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
