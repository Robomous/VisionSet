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

from fastapi import Query, Response, status

from visionset.inference import require_detectable_schema
from visionset.kernel.services import JobService
from visionset.server.dependencies import RunnerDep, WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    AssetOut,
    AssetPage,
    AssetProgressOut,
    AssetProgressSet,
    BackgroundJobOut,
    JobAssign,
    JobOut,
    PreLabelRequest,
    ProgressCounts,
)
from visionset.server.routes._prelabel import launch, selected_produces, text_detect_connection

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
    return JobOut.of(
        jobs.get(job_id),
        batch=jobs.batch(job_id),
        pre_label_run=jobs.latest_pre_label_run(job_id),
    )


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
    `BATCH_NOT_IN_ANNOTATION`. A job that is not `pending` has no such move to
    make and is 409 `INVALID_TRANSITION` — the table runs one way, so a job that
    is already in progress or finished never starts again.
    """
    jobs = JobService(workspace)
    return JobOut.of(
        jobs.start(job_id),
        batch=jobs.batch(job_id),
        pre_label_run=jobs.latest_pre_label_run(job_id),
    )


@router.post(
    "/{job_id}/pre-label",
    status_code=status.HTTP_202_ACCEPTED,
    responses=documented(404, 409),
)
def pre_label_job(
    workspace: WorkspaceDep,
    runner: RunnerDep,
    response: Response,
    job_id: UUID,
    body: PreLabelRequest,
) -> BackgroundJobOut:
    """Ask a model to label every untouched asset in this job, and answer at once.

    The `pre_label` action. Labels land at `pre_labeled`, never at `annotated`:
    nobody judged them, so they arrive editable and correctable rather than
    claiming to be somebody's work — and, being unjudged, they never reach the
    Dataset until a person has taken them over.

    **Only assets nothing has touched — which is stronger than reading
    `unannotated`.** An asset already `pre_labeled`, annotated, skipped,
    awaiting review or accepted is passed over, and so is an `unannotated` one
    that still carries annotations from an earlier round that was skipped and
    then restored: that sequence deletes no labels, so progress alone does not
    prove an asset untouched. A run never writes over what a person did in this
    job, and never writes twice over what a model did — a plain second run
    extends an earlier one onto whatever is still untouched.
    `replace_model_labels` widens it to every frame still `pre_labeled` and
    supersedes those labels with this run's answer, one frame per transaction;
    a frame anyone edited, confirmed or skipped in this job is never touched,
    and a frame the model now finds nothing on returns to `unannotated`. A
    replacing request arriving while a run is in flight joins that run,
    whichever flag it carries.

    **The batch's pinned schema is the prompt, narrowed to what this run
    writes.** The model is asked for each class the schema declares that admits
    one of the shapes the run writes and demands no attribute a prediction
    cannot supply; an answer naming one of those classes, matched
    case-insensitively, is written under the schema's own spelling, and an
    answer naming none of them is discarded. A schema with no such class has
    nowhere for a prediction to land and is refused — so the same schema is
    askable of a model that answers polygons and refused for one that answers
    boxes. `GET /batches/{batch_id}/pre-label` with the same `connection_id`
    (and the same `geometries`) reads the narrowing before launching.

    **What the run writes is every shape the model produces, unless
    `geometries` says which.** A model declaring both a box and a polygon
    writes both for every region it answers with — the kernel writes one
    annotation per emitted region and pairs nothing — and `geometries` filters
    that to the shapes named: a region in any other shape is discarded and
    counted in `regions_discarded`. The selection is per run, not per class,
    and it is kept on the queued row, so a run claimed later executes what was
    asked.

    **202, not 200.** A job is hundreds of forward passes, so this follows the
    launch-and-poll contract the export and weight-download routes use: poll `GET
    /background-jobs/{id}` — the `Location` header names it — until `state` is
    `succeeded`, then re-read the job's assets. Progress on the row is counted
    in assets, and `JobOut.pre_label_run` remembers the same row afterwards.

    **Everything a caller can be told now is told now**, and no refusal creates a
    job — so a caller holding a job id holds one that will run. These refusals
    are about the request, and the caller can act on each. They are checked in
    this order, and it is the order `pre_label` itself checks in, so a request
    wrong about the connection and the job both always names the connection:
    an unknown connection is 404 `INFERENCE_CONNECTION_NOT_FOUND`; a
    connection not set up yet is 409 `INFERENCE_CONNECTION_NOT_SET_UP` — its
    weights not here, or its endpoint not yet asked what it answers; a
    connection whose model answers places rather than words is 422
    `UNSUPPORTED_PROMPT`; a `geometries` naming a shape the model does not
    produce is 422 `GEOMETRY_NOT_PRODUCED`. An unknown job is 404
    `JOB_NOT_FOUND`; a job whose batch is not `in_annotation` is 409
    `BATCH_NOT_IN_ANNOTATION`; a job already `completed` is 409 `JOB_FINISHED`,
    and there is no remedy on this route — settled work is corrected through a
    new batch rather than reopened. A pinned schema with no class the selected
    shapes can be written as is 409 `SCHEMA_HAS_NO_DETECTABLE_CLASS`.

    Two failures are about this installation rather than about the request, and
    answer 500 carrying the message that says which: a machine without the
    optional local runtime is `LOCAL_INFERENCE_UNAVAILABLE` and carries the
    exact command that installs it, and a workspace whose records no longer
    hold together — a batch pinned to a schema version that is not stored — is
    `WORKSPACE_CORRUPT`. Neither is worth resending unchanged: there is no
    state here a caller can change, so the remedy is the one the message names.

    **Asking twice joins the run already in flight rather than starting a second
    one.** A request arriving while this job has a pre-labeling run queued or
    running is answered with that run's id, so a double-click and a second tab
    watch one run instead of paying for the same inference twice — and so does
    `POST /batches/{batch_id}/pre-label`, whose fan-out reaches this same job.
    """
    connection = text_detect_connection(workspace, body.connection_id)
    produces = selected_produces(connection, body.geometries)
    job, batch = JobService(workspace).require_pre_labelable(job_id)
    require_detectable_schema(workspace, batch, produces)
    row, _ = launch(
        workspace,
        job,
        batch,
        connection_id=body.connection_id,
        minimum_confidence=body.minimum_confidence,
        replace_model_labels=body.replace_model_labels,
        geometries=None if body.geometries is None else frozenset(body.geometries),
    )
    # Woken even when the answer is a run that already existed: what came back
    # may be `queued`, and the dispatcher it waits for sleeps on its own interval.
    runner.wake()
    response.headers["Location"] = f"/background-jobs/{row.id}"
    return BackgroundJobOut.of(row)


@router.post("/{job_id}/complete", responses=documented(404, 409))
def complete_job(workspace: WorkspaceDep, job_id: UUID) -> JobOut:
    """Close the job, if every asset in it has been dealt with.

    Dealt with means `annotated`, `skipped` or `accepted`. An `unannotated` asset
    means the labeling has not happened, a `pre_labeled` one means a model's
    guess is still unjudged, and a `review_pending` one means the review has
    not; any of the three answers 409 `JOB_NOT_COMPLETE` and says how many are
    outstanding.

    A job that is not `in_progress` is 409 `INVALID_TRANSITION`, and a batch that
    is not open for annotation is 409 `BATCH_NOT_IN_ANNOTATION`. Neither has a
    remedy on this route: `completed` is where the table ends, so settled work is
    corrected through a new batch rather than reopened.

    Completing a job does not complete its batch — `POST /batches/{id}/complete`
    derives that from all of them.
    """
    jobs = JobService(workspace)
    return JobOut.of(
        jobs.complete(job_id),
        batch=jobs.batch(job_id),
        pre_label_run=jobs.latest_pre_label_run(job_id),
    )


@router.put("/{job_id}/assignee", responses=documented(404))
def assign_job(workspace: WorkspaceDep, job_id: UUID, body: JobAssign) -> JobOut:
    """Name who is working this job, or clear it with `null`.

    Informational only — a name, not an account. Legal in any job or batch
    state: naming who did a finished job is attribution, not a reopening.
    """
    service = JobService(workspace)
    job = service.assign(job_id, body.assignee)
    return JobOut.of(
        job, batch=service.batch(job_id), pre_label_run=service.latest_pre_label_run(job_id)
    )


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
    kernel and a second spelling of it would drift: `unannotated` to `annotated`,
    `pre_labeled` or `skipped`; `pre_labeled` to `annotated`, `unannotated` or
    `skipped`; `annotated` to `review_pending` or back; `review_pending` to
    `accepted` or back to `annotated`; and `accepted` nowhere at all. Anything
    else is 409 `INVALID_TRANSITION`.

    Setting the state an asset is already in is a no-op rather than a refusal —
    but the batch gate fires first, so writing into a closed batch is refused
    whether or not the value would have changed: 409 `BATCH_NOT_IN_ANNOTATION`.

    409 `STALE_WRITE` is the other one, and it is not the same complaint: the
    move was legal from the state the caller read, and somebody else moved the
    asset in between. Re-read the progress and decide again — resending this
    request unchanged would land a decision made about a state nobody is in any
    more.

    Labels move `unannotated`, `pre_labeled` and `annotated` on their own as
    annotations are written, edited or deleted. This route is for the decisions
    that are nobody's consequence: skipping, submitting for review, accepting.
    """
    JobService(workspace).mark(job_id, asset_id, body.progress)
    return AssetProgressOut(asset_id=asset_id, progress=body.progress)
