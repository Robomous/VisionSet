# usage: from visionset.server.routes import batches
"""Batches: curating what gets annotated, and freezing it so work can start.

Two routers, for the reason ``sources.py`` has two: the collection hangs off the
project that owns it, and the batch itself is addressable on its own — so what
hangs off *it* (its assets, its jobs) does not sit four segments deep.

``promote`` also lives here, and its path is the argument for it — see the
comment on the handler.

**A batch is born from an ingest** in the ordinary case, and creation and
membership editing are here for the gallery. Both are ``draft``-only: approval
freezes membership, and that refusal is the batch's own
(``BATCH_NOT_EDITABLE``), never a rule this module restates. **Delete** is the
one route that ends a batch rather than moving it: ``DELETABLE_STATES`` is
everything except ``completed``, the refusal is ``BATCH_IMMUTABLE`` and no flag
lifts it, and ``BatchAction.DELETE`` is declared beside it — a capability and the
route that honours it always land together.

The lifecycle *is* here, because without it nothing downstream is reachable: an
annotation may only be written into a batch that is ``in_annotation``, and a
completed batch is what makes its assets promotable. Approve pins the schema
version and cuts the batch into jobs; start opens it; complete is derived from
the jobs rather than declared. ``repin`` is the one route that moves a pin after
approval, and it is a request rather than a consequence — see its handler.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import Query, status

from visionset.inference import (
    open_jobs_of,
    prompt_plan,
    require_detectable_schema,
    select_pre_labelable,
)
from visionset.kernel.domain import AssetSort, MembershipChange
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
)
from visionset.server.dependencies import RunnerDep, WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    AssetOut,
    AssetPage,
    BackgroundJobOut,
    BatchApprove,
    BatchAssetOut,
    BatchAssetPage,
    BatchCorrection,
    BatchCreate,
    BatchMembership,
    BatchMembershipOut,
    BatchOut,
    BatchPage,
    ConfirmQuery,
    GeometriesQuery,
    JobOut,
    JobPage,
    JobQuery,
    LimitQuery,
    OffsetQuery,
    PreLabelFanOutItemOut,
    PreLabelFanOutOut,
    PreLabelPlanOut,
    PreLabelRequest,
    ProgressQuery,
    ProjectPreLabelRequest,
    SortQuery,
)
from visionset.server.routes._prelabel import launch, selected_produces, text_detect_connection

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


@project_router.post("", status_code=201, responses=documented(404))
def create_batch(workspace: WorkspaceDep, project_id: UUID, body: BatchCreate) -> BatchOut:
    """Start a draft batch over a chosen set of the project's assets.

    **A batch is still born from an ingest in the ordinary case**, and this does
    not change that: an ingest run puts what it gathered into one, which is where
    almost every batch comes from. What had no surface at all was curating one
    out of an arbitrary subset — the shape a correction batch is, and the shape
    anybody re-cutting work by hand needs.

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
        pre_label_run=batches.latest_pre_label_job(created.id),
    )


@project_router.get("", responses=documented(404))
def list_batches(workspace: WorkspaceDep, project_id: UUID) -> BatchPage:
    """Every batch of that project, in the order they were created."""
    jobs = JobService(workspace)
    batches = BatchService(workspace)
    found = batches.list(project_id)
    promoted = _promoted(workspace, project_id)
    # One queue read for the whole page, `_promoted`'s cost model: without it a
    # page of twenty batches would ask the queue once per row.
    pre_label_runs = batches.pre_label_runs()
    return BatchPage(
        items=[
            BatchOut.of(
                batch,
                jobs.batch_progress(batch.id),
                promoted=promoted,
                pre_label_run=pre_label_runs.get(batch.id),
            )
            for batch in found
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
    batches = BatchService(workspace)
    batch = batches.get(batch_id)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
        pre_label_run=batches.latest_pre_label_job(batch_id),
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
    pin, and an unknown batch is 404 `BATCH_NOT_FOUND`.
    """
    partition = None if body is None else body.to_domain()
    batches = BatchService(workspace)
    batch = batches.approve(batch_id, partition)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
        pre_label_run=batches.latest_pre_label_job(batch_id),
    )


@router.post("/{batch_id}/start", responses=documented(404, 409))
def start_batch(workspace: WorkspaceDep, batch_id: UUID) -> BatchOut:
    """Open the batch for annotation. Nothing may be written into it before this."""
    batches = BatchService(workspace)
    batch = batches.start(batch_id)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
        pre_label_run=batches.latest_pre_label_job(batch_id),
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
    batches = BatchService(workspace)
    batch = batches.repin(batch_id, allow_destructive=allow_destructive)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
        pre_label_run=batches.latest_pre_label_job(batch_id),
    )


@router.post("/{batch_id}/complete", responses=documented(404, 409))
def complete_batch(workspace: WorkspaceDep, batch_id: UUID) -> BatchOut:
    """Close the batch, if every one of its jobs is finished.

    Derived rather than declared: this reads the jobs and answers 409
    `BATCH_NOT_COMPLETE` while any of them is outstanding. A completed batch is
    what lets its annotated assets be promoted into the project's dataset.

    A batch that is not `in_annotation` has no closing move to make and is 409
    `INVALID_TRANSITION` — the same one-way table that leaves `completed` with no
    exit at all, which is why correcting settled work is a new batch.
    """
    batches = BatchService(workspace)
    batch = batches.complete(batch_id)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
        pre_label_run=batches.latest_pre_label_job(batch_id),
    )


@router.post("/{batch_id}/corrections", status_code=201, responses=documented(404, 409))
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
    `completed`, and 409 `INVALID_TRANSITION` is what a client gets for asking
    otherwise.

    `asset_ids` defaults to **the parent's whole membership**, since "correct
    this batch" is the ordinary ask. A subset is the other one — the three frames
    somebody found wrong — and every id given must be one the parent carried: a
    correction of a batch is a correction *of what was in it*.

    The child pins the project's **active** schema at its own approval, not the
    parent's pin. That is the point of correcting under a contract that has moved
    on, and it is the ordinary approval mechanism rather than anything new.
    """
    batches = BatchService(workspace)
    created = batches.create_correction(batch_id, body.name, body.asset_ids)
    return BatchOut.of(
        created,
        JobService(workspace).batch_progress(created.id),
        promoted=_promoted(workspace, created.project_id),
        pre_label_run=batches.latest_pre_label_job(created.id),
    )


@router.get("/{batch_id}/pre-label", responses=documented(404, 409))
def pre_label_plan(
    workspace: WorkspaceDep,
    batch_id: UUID,
    connection_id: UUID,
    geometries: GeometriesQuery = None,
) -> PreLabelPlanOut:
    """The classes a run would ask this connection's model for, and the shapes it would write.

    A run's prompt is the batch's pinned schema narrowed to the classes the
    model can answer — a class is asked for when it admits a shape the run
    writes and demands no attribute a prediction cannot supply — and that
    narrowing is invisible once the run has finished. Read this before
    launching to say which classes are in the prompt and which are not, with
    the reason beside each, and which shapes a run will write: `produces` is
    the model's declared shapes, so a schema of polygon classes is askable of a
    model that answers polygons and refused for one that answers boxes.

    `connection_id` is required because the plan is a property of the schema
    **and** the model: the same schema yields a different prompt for a detector
    and for a segmenter. `geometries` is the launch's own restriction, read
    here first: pass the shapes a launch would name and `produces` is that
    selection, with every class only those shapes cannot hold moved to
    `excluded_classes`. Omitted, the plan is for every shape the model produces.

    Refused on the same terms the launch uses, in the same order, so reading
    the plan and then launching gets one set of answers: an unknown connection
    is 404 `INFERENCE_CONNECTION_NOT_FOUND`; a connection not set up yet is 409
    `INFERENCE_CONNECTION_NOT_SET_UP`; one whose model answers places rather
    than words is 422 `UNSUPPORTED_PROMPT`; a `geometries` naming a shape the
    model does not produce is 422 `GEOMETRY_NOT_PRODUCED`; an unknown batch is
    404 `BATCH_NOT_FOUND`; a batch that is not `in_annotation` is 409
    `BATCH_NOT_IN_ANNOTATION`; a pinned schema with no class the selected shapes
    can be written as is 409 `SCHEMA_HAS_NO_DETECTABLE_CLASS`. A machine
    without the optional local runtime answers 500 `LOCAL_INFERENCE_UNAVAILABLE`
    with the install command, and a batch open for annotation but pinning no
    schema version is a broken invariant and answers 500 `WORKSPACE_CORRUPT`.
    """
    connection = text_detect_connection(workspace, connection_id)
    produces = selected_produces(connection, geometries)
    batch = BatchService(workspace).require_pre_labelable(batch_id)
    schema = require_detectable_schema(workspace, batch, produces)
    return PreLabelPlanOut.of(prompt_plan(schema, produces))


@router.post(
    "/{batch_id}/pre-label",
    status_code=status.HTTP_202_ACCEPTED,
    responses=documented(404, 409),
)
def pre_label_batch(
    workspace: WorkspaceDep,
    runner: RunnerDep,
    batch_id: UUID,
    body: PreLabelRequest,
) -> PreLabelFanOutOut:
    """Ask a model to label every untouched asset in this batch, and answer at once.

    **One row per open job, and the job is the unit.** This launch fans out over
    the batch's jobs that are still open and queues for each the same
    `annotation.pre_label` row `POST /jobs/{job_id}/pre-label` queues, or joins
    the one already queued or running for that job (`joined`). A finished job is
    passed over, so a batch whose every job is complete answers an empty page.
    Each row is polled, cancelled and remembered per job:
    `GET /background-jobs/{id}` for progress counted in that job's assets,
    `JobOut.pre_label_run` afterwards. Nothing here reports one total across
    jobs, because nothing here is one run.

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
    boxes. `GET` this path with the same `connection_id` (and the same
    `geometries`) to read the narrowing before launching.

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
    /background-jobs/{id}` for each row until `state` is `succeeded`, then
    re-read the batch's assets. Progress on a row is counted in assets. There is
    no `Location` header, because there is no single row for it to name.

    **Everything a caller can be told now is told now**, and no refusal creates a
    row — so a caller holding a row's id holds one that will run. These refusals
    are about the request, and the caller can act on each. They are checked in
    this order, and it is the order `pre_label` itself checks in, so a request
    wrong about the connection and the batch both always names the connection:
    a connection not set up yet is 409 `INFERENCE_CONNECTION_NOT_SET_UP` — its
    weights not here, or its endpoint not yet asked what it answers; a
    connection whose model answers places rather than words is 422
    `UNSUPPORTED_PROMPT`; a `geometries` naming a shape the model does not
    produce is 422 `GEOMETRY_NOT_PRODUCED`; a batch that is not `in_annotation`
    is 409 `BATCH_NOT_IN_ANNOTATION`; a pinned schema with no class the
    selected shapes can be written as is 409 `SCHEMA_HAS_NO_DETECTABLE_CLASS`.

    Two failures are about this installation rather than about the request, and
    answer 500 carrying the message that says which: a machine without the
    optional local runtime is `LOCAL_INFERENCE_UNAVAILABLE` and carries the
    exact command that installs it, and a workspace whose records no longer
    hold together — a batch pinned to a schema version that is not stored — is
    `WORKSPACE_CORRUPT`. Neither is worth resending unchanged: there is no
    state here a caller can change, so the remedy is the one the message names.

    **Asking twice joins the runs already in flight rather than starting second
    ones.** A request arriving while a job here has a pre-labeling run queued or
    running is answered with that run's row and `joined` true, so a double-click
    and a second tab watch one run per job instead of paying for the same
    inference twice.
    """
    connection = text_detect_connection(workspace, body.connection_id)
    produces = selected_produces(connection, body.geometries)
    batch = BatchService(workspace).require_pre_labelable(batch_id)
    require_detectable_schema(workspace, batch, produces)

    geometries = None if body.geometries is None else frozenset(body.geometries)
    items: list[PreLabelFanOutItemOut] = []
    for job in open_jobs_of(workspace, batch_id):
        row, joined = launch(
            workspace,
            job,
            batch,
            connection_id=body.connection_id,
            minimum_confidence=body.minimum_confidence,
            replace_model_labels=body.replace_model_labels,
            geometries=geometries,
        )
        items.append(
            PreLabelFanOutItemOut(
                batch_id=batch.id,
                batch_name=batch.name,
                annotation_job_id=job.id,
                job=BackgroundJobOut.of(row),
                joined=joined,
            )
        )
    # Woken even where every row already existed: what came back may be `queued`,
    # and the dispatcher it waits for sleeps on its own interval.
    runner.wake()
    return PreLabelFanOutOut(items=items, total=len(items))


@project_router.post(
    "/pre-label",
    status_code=status.HTTP_202_ACCEPTED,
    responses=documented(404, 409),
)
def pre_label_project_batches(
    workspace: WorkspaceDep,
    runner: RunnerDep,
    project_id: UUID,
    body: ProjectPreLabelRequest,
) -> PreLabelFanOutOut:
    """Ask a model to label every untouched asset across this project's open batches.

    **One row per open job of each selected batch, and the job is the unit.**
    This launch fans out over the project's batches that are open for
    annotation — every one of them, or exactly the `batch_ids` named — and
    within each over the jobs still open, queueing for each the same
    `annotation.pre_label` row `POST /jobs/{job_id}/pre-label` queues, or
    joining the one already queued or running for that job (`joined`). A
    finished job is passed over, so a selected batch whose every job is
    complete contributes no row. Each row is polled, cancelled and remembered
    per job, exactly as a single-job launch is: `GET /background-jobs/{id}`
    for progress counted in that job's assets, `JobOut.pre_label_run`
    afterwards. Nothing here reports one total across jobs, because nothing
    here is one run.

    **Refused whole, up front, and no refusal creates a row.** The connection
    is checked first, as the single-batch launch checks it: an unknown
    connection is 404 `INFERENCE_CONNECTION_NOT_FOUND`, one not set up yet is
    409 `INFERENCE_CONNECTION_NOT_SET_UP`, a model that answers places rather
    than words is 422 `UNSUPPORTED_PROMPT`, and a `geometries` naming a shape
    the model does not produce is 422 `GEOMETRY_NOT_PRODUCED`. Then the
    selection: an unknown project is 404 `PROJECT_NOT_FOUND`; a named batch
    outside this project is 404 `BATCH_NOT_FOUND`; a named batch not
    `in_annotation`, a project with no open batch at all, or an empty
    `batch_ids`, is 409 `BATCH_NOT_IN_ANNOTATION`; any selected batch whose
    pinned schema has no class the selected shapes can be written as is 409
    `SCHEMA_HAS_NO_DETECTABLE_CLASS`, and the message names the batch so the
    caller can leave it out by name and ask again. A partly launched project
    would leave rows the caller was never told about, which is why the whole
    request is refused instead.

    What each run writes, passes over and counts is the single-batch launch's
    contract, `geometries` included; read `POST /batches/{batch_id}/pre-label`.
    """
    connection = text_detect_connection(workspace, body.connection_id)
    produces = selected_produces(connection, body.geometries)
    selected = select_pre_labelable(workspace, project_id, produces, body.batch_ids)
    geometries = None if body.geometries is None else frozenset(body.geometries)
    items: list[PreLabelFanOutItemOut] = []
    for batch in selected:
        for job in open_jobs_of(workspace, batch.id):
            row, joined = launch(
                workspace,
                job,
                batch,
                connection_id=connection.id,
                minimum_confidence=body.minimum_confidence,
                replace_model_labels=False,
                geometries=geometries,
            )
            items.append(
                PreLabelFanOutItemOut(
                    batch_id=batch.id,
                    batch_name=batch.name,
                    annotation_job_id=job.id,
                    job=BackgroundJobOut.of(row),
                    joined=joined,
                )
            )
    runner.wake()
    return PreLabelFanOutOut(items=items, total=len(items))


@router.get("/{batch_id}/jobs", responses=documented(404))
def list_batch_jobs(workspace: WorkspaceDep, batch_id: UUID) -> JobPage:
    """The jobs the batch was cut into, in segment order.

    Empty until the batch is approved — a draft has no jobs — and a 200 either
    way.
    """
    batches = BatchService(workspace)
    # The batch itself, not only the id its path already carries: every job action
    # needs the batch open, so ``allowed_actions`` cannot be answered without it.
    batch = batches.get(batch_id)
    found = batches.jobs(batch_id)
    # One queue read for the whole page, ``list_batches``'s cost model: without it
    # a batch cut into twenty jobs would ask the queue once per row.
    runs = JobService(workspace).pre_label_runs()
    return JobPage(
        items=[JobOut.of(job, batch=batch, pre_label_run=runs.get(job.id)) for job in found],
        total=len(found),
    )


@router.get("/{batch_id}/assets", responses=documented(404))
def list_batch_assets(
    workspace: WorkspaceDep,
    batch_id: UUID,
    limit: LimitQuery = None,
    offset: OffsetQuery = 0,
    progress: ProgressQuery = None,
    sort: SortQuery = AssetSort.MEMBERSHIP,
    job: JobQuery = None,
) -> BatchAssetPage:
    """The batch's assets, with where each has got to and its labels in two numbers.

    Membership order by default, so reading twice gives the same sequence and an
    ingest into an existing batch appends rather than reshuffles; `sort=confidence`
    puts the frame whose weakest model label scores lowest first, unscored frames
    last, ties in membership order. `progress` narrows to the states named, and
    `total` is the size of what matched — the whole batch when nothing narrows it.
    An offset past the end is an empty list and a 200, never a 404. The 404 belongs
    to the batch itself, which is resolved first: an unknown one is `BATCH_NOT_FOUND`.

    `job` narrows to the assets one job carries, composing with `progress`; a job
    this batch does not have is 404 `JOB_NOT_FOUND`. `job_id` and `progress` on
    each item are null while the batch is a draft, which has no jobs — so there,
    a `progress` filter or a `job` filter matches nothing rather than refusing.
    Bytes are not here: an asset is named by its hashes, and
    `GET /projects/{project_id}/assets/{asset_id}/content` is what serves them.
    """
    batches = BatchService(workspace)
    batch = batches.get(batch_id)
    placed, total = batches.asset_page(
        batch_id,
        job=job,
        progress=None if progress is None else frozenset(progress),
        sort=sort,
        limit=limit,
        offset=offset,
    )
    return BatchAssetPage(
        items=[
            BatchAssetOut.in_batch(
                one.asset,
                job_id=one.job_id,
                job_state=one.job_state,
                progress=one.progress,
                batch_state=batch.state,
                summary=one.summary,
            )
            for one in placed
        ],
        total=total,
    )


#: Which assets to take out of the batch, repeated once per id. The
#: ``delete_annotations`` shape: the ids are what the request is *about* rather
#: than a gate on it, and a request body on DELETE is legal in OpenAPI 3.1 and
#: stripped by enough proxies to be a bad thing to require.
#:
#: ``min_length=1`` mirrors ``BatchMembership``'s, so the two halves of one
#: operation refuse the same empty request — a removal naming nothing is a
#: request that means nothing, and answering it 200 would be a silent no-op the
#: caller reads as success.
BatchAssetIdsQuery = Annotated[
    list[UUID],
    Query(
        alias="id",
        min_length=1,
        description="An asset to remove from the batch. Repeat the parameter per id.",
    ),
]


def _membership(workspace: WorkspaceDep, change: MembershipChange) -> BatchMembershipOut:
    """One projection for both halves, so add and remove cannot answer differently."""
    return BatchMembershipOut.of(
        change,
        JobService(workspace).batch_progress(change.batch.id),
        promoted=_promoted(workspace, change.batch.project_id),
        pre_label_run=BatchService(workspace).latest_pre_label_job(change.batch.id),
    )


@router.post("/{batch_id}/assets", responses=documented(404, 409))
def add_batch_assets(
    workspace: WorkspaceDep, batch_id: UUID, body: BatchMembership
) -> BatchMembershipOut:
    """Put assets into a draft batch.

    **Only while the batch is a draft**, which is what `edit_membership` in its
    `allowed_actions` declares. Approval partitions the batch into jobs against a
    pinned schema version, so an asset added afterwards would belong to no job —
    hence 409 `BATCH_NOT_EDITABLE` from that point on, and there is no flag that
    lifts it.

    Idempotent, and it says so in the answer rather than leaving it to be
    inferred: `changed` lists the ids this call actually wrote, so adding three
    assets of which two were already members reports one. An asset the batch
    already holds is not an error.

    An id that is not an asset of this batch's project is 404 `ASSET_NOT_FOUND`
    and **nothing is written** — the whole call is refused, for the reason
    annotation writes are all-or-nothing. An unknown batch is 404
    `BATCH_NOT_FOUND`, resolved before any id is read.
    """
    return _membership(workspace, BatchService(workspace).add_assets(batch_id, body.asset_ids))


@router.delete("/{batch_id}/assets", responses=documented(404, 409))
def remove_batch_assets(
    workspace: WorkspaceDep, batch_id: UUID, asset_ids: BatchAssetIdsQuery
) -> BatchMembershipOut:
    """Take assets out of a draft batch. One transaction, however many ids you pass.

    **This removes membership, not assets.** The asset stays in its project, in
    the blob store, and in every other batch that carries it; only this batch
    stops listing it.

    Draft only, like adding, and for the sharper half of the same reason: after
    approval a job already describes work over that asset, and removing the
    member would leave the job describing work that no longer exists. From then
    on the way to exclude an asset is to mark it `skipped` — a decision the
    record keeps rather than erases — and this answers 409 `BATCH_NOT_EDITABLE`.

    An id the batch does not hold is ignored rather than refused, and `changed`
    reports what actually went, so "removed 3" can be told from "3 were already
    gone".
    """
    return _membership(workspace, BatchService(workspace).remove_assets(batch_id, asset_ids))


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


# Last in the module for the reason ``BatchAction.DELETE`` is last in the enum:
# every other route here moves a batch further along, and this one ends it.
@router.delete(
    "/{batch_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=documented(404, 409),
)
def delete_batch(workspace: WorkspaceDep, batch_id: UUID, confirm: ConfirmQuery = False) -> None:
    """Remove a batch, its task groups, its jobs and their progress.

    **The work survives.** Annotations hang off assets rather than off batches,
    so deleting the unit of work never deletes the labels; the assets stay in
    their project and in every other batch that carries them, and no blob is
    touched. What goes is the batch's own record of *organisation* — how the work
    was cut into jobs, and how far each asset had got.

    A `completed` batch cannot be deleted at all and answers 409
    `BATCH_IMMUTABLE`: it is the record of what was labeled, against which pinned
    schema version, and what was deliberately skipped, which is what promotion
    and every later correction are read against. **No flag lifts that**, which is
    also why it is checked before `confirm` — a refusal naming a remedy that does
    not work is worse than a blunt one.

    Without `confirm=true` this answers 409 `CONFIRMATION_REQUIRED` and destroys
    nothing.
    """
    # Both gates go straight to the service. Pre-checking either here would be a
    # second copy of a rule the kernel owns, and the kernel's refusal is what
    # carries the code.
    BatchService(workspace).delete(batch_id, confirm=confirm)
