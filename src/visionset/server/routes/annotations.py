# usage: from visionset.server.routes import annotations
"""Annotations: the labels themselves, written through the job that owns them.

Its own module rather than more of ``jobs.py``, because it is its own noun —
``jobs.py`` tracks *whether* an asset was dealt with and this stores *what was
drawn on it*. Every path still sits under ``/jobs/{job_id}``, and that is not a
formality: a label is only ever judged against the schema version its batch
pinned, and the job is how the API gets from a label to that batch.

**Every write is all-or-nothing.** Each of these maps onto exactly one
``AnnotationService`` call, which validates the whole payload before storing any
of it, in one transaction. That is why bulk delete takes repeated `id` query
parameters rather than one id per request: three DELETEs are three transactions
and a partial failure is reachable, which is precisely what the kernel refuses to
let happen.

**Two error translations happen here**, and only these two. ``AssetNotInJob`` is
a 404 when the asset id is a path segment and a 422 when it arrives inside a
body — the case ``docs/content/api.md`` uses as its worked example of the escape hatch.
Everything else is raised by the kernel and rendered by the app's handlers.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import Query, Response, status

from visionset.kernel.errors import AssetNotInJob
from visionset.kernel.services import AnnotationService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented, error_response
from visionset.server.models import (
    AnnotationCreate,
    AnnotationOut,
    AnnotationPage,
    AnnotationUpdate,
)

router = protected_router(prefix="/jobs/{job_id}", tags=["annotations"])

#: Which annotations to delete, repeated once per id. A filter, not a gate — the
#: ids are what the request is *about*, and they are here rather than in a body
#: because a request body on DELETE is legal in OpenAPI 3.1 and stripped by
#: enough proxies to be a bad thing to require.
AnnotationIdsQuery = Annotated[
    list[UUID],
    Query(alias="id", description="An annotation to delete. Repeat the parameter per id."),
]


@router.get("/assets/{asset_id}/annotations", responses=documented(404))
def list_asset_annotations(workspace: WorkspaceDep, job_id: UUID, asset_id: UUID) -> AnnotationPage:
    """Every annotation on one asset of this job, in the order they were added.

    Empty for an asset nobody has labeled yet — the ordinary starting state, not
    an error. Reading is not gated on job or batch state: a label outlives the
    work that produced it.
    """
    found = AnnotationService(workspace).for_asset(job_id, asset_id)
    return AnnotationPage(items=[AnnotationOut.of(a) for a in found], total=len(found))


# ``response_model=`` is given explicitly on every route below rather than left
# to the return annotation, because these three return an ``ErrorBody`` response
# directly on one branch. FastAPI short-circuits an actual ``Response``, but it
# would try to build a response model out of the union if nobody said otherwise.
@router.post(
    "/annotations",
    status_code=status.HTTP_201_CREATED,
    response_model=AnnotationPage,
    responses=documented(404, 409),
)
def add_annotations(
    workspace: WorkspaceDep, job_id: UUID, body: list[AnnotationCreate]
) -> AnnotationPage | Response:
    """Store annotations, judged against the version this job's batch pinned.

    All-or-nothing: every annotation is validated before any of them is written,
    so a payload with one bad box stores nothing at all. A half-labeled asset is
    not a state a client can reach.

    A refusal that is about one item carries `detail.index` — the position in the
    array you sent — because nothing was written and the message alone cannot say
    which one it was. `schema_version` is not yours to set: the pinned version is
    stamped onto whatever you send, and comes back on the response.

    An unknown job is 404 `JOB_NOT_FOUND`. The batch must be `in_annotation`, or
    this is 409 `BATCH_NOT_IN_ANNOTATION`, and the job itself must still be open:
    one that was completed is 409 `JOB_FINISHED`, and a completed job has no way
    back, so the remedy is a new job over those assets rather than a retry. An
    asset the job does not carry is 422 `ASSET_NOT_IN_JOB`.

    An annotation the pinned version does not describe is 422
    `INVALID_ANNOTATION`, which is the general answer; the specific ones carry
    their own codes — `LABEL_CLASS_NOT_IN_SCHEMA`, `DISALLOWED_GEOMETRY`,
    `MISSING_REQUIRED_ATTRIBUTE` and their kin — so a client that wants to say
    what is wrong reads the code rather than the status.

    The asset must also still be open for labeling — `unannotated` or
    `annotated`. One that was skipped, submitted for review or accepted is 409
    `ASSET_NOT_WRITABLE`, and the message names the state it is in. The remedy is
    a progress move where the table allows one (`skipped` back to `unannotated`);
    `accepted` has no exit, so correcting it means a new batch. Read
    `allowed_actions` on the batch's asset listing rather than guessing: it
    declares `annotate` exactly when this will be accepted.
    """
    try:
        stored = AnnotationService(workspace).add(job_id, [a.to_domain() for a in body])
    except AssetNotInJob as exc:
        # In a *body*, an unknown asset is a malformed payload rather than a
        # missing resource. The status is overridden and the code is not: a
        # client still branches on ASSET_NOT_IN_JOB.
        return error_response(exc, status=422)
    return AnnotationPage(items=[AnnotationOut.of(a) for a in stored], total=len(stored))


@router.patch("/annotations", response_model=AnnotationPage, responses=documented(404, 409))
def update_annotations(
    workspace: WorkspaceDep, job_id: UUID, body: list[AnnotationUpdate]
) -> AnnotationPage | Response:
    """Replace stored annotations whole, judged against the same pinned version.

    Addressed by `id` and by nothing else — annotations are never reached by
    index or position. There is no `asset_id` on the body because the stored one
    wins: moving a label from one asset to another is a delete and an add, not an
    edit, and doing it silently would take an asset's last annotation away
    without anything saying so.

    All-or-nothing, and `detail.index` names the culprit, exactly as on the POST.
    An asset whose labeling is over is 409 `ASSET_NOT_WRITABLE`, as on the POST,
    and so are the two gates around it: a batch that is not open for annotation
    is 409 `BATCH_NOT_IN_ANNOTATION` and a job that was completed is 409
    `JOB_FINISHED`. An edit is a write, and every gate that stops a new label
    stops a replacement too.
    """
    try:
        stored = AnnotationService(workspace).update(job_id, [a.to_domain() for a in body])
    except AssetNotInJob as exc:
        return error_response(exc, status=422)
    return AnnotationPage(items=[AnnotationOut.of(a) for a in stored], total=len(stored))


@router.delete(
    "/annotations",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=documented(404, 409),
)
def delete_annotations(
    workspace: WorkspaceDep, job_id: UUID, annotation_ids: AnnotationIdsQuery
) -> Response | None:
    """Remove annotations. One transaction, however many ids you pass.

    Repeating an id is not two deletions. An id that is not stored refuses the
    whole call with 404 `ANNOTATION_NOT_FOUND` and removes nothing — there is no
    partial delete, for the reason there is no partial write. Removing a label is
    still a write, so an asset that was skipped, submitted or accepted is 409
    `ASSET_NOT_WRITABLE` here too, a batch that is not open for annotation is 409
    `BATCH_NOT_IN_ANNOTATION`, and a job that was completed is 409 `JOB_FINISHED`.
    An unknown job is 404 `JOB_NOT_FOUND`, and an id naming an annotation that
    sits outside this job is 422 `ASSET_NOT_IN_JOB`.

    No confirmation gate: taking a box off is the ordinary annotator edit loop,
    not the destruction of a lifecycle entity. The batch gate is the guard, so
    once the work closes nothing here can touch it at all.
    """
    try:
        AnnotationService(workspace).delete(job_id, annotation_ids)
    except AssetNotInJob as exc:
        return error_response(exc, status=422)
    return None
