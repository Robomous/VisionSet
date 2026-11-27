# usage: from visionset.server.routes import tracks
"""Tracks: one object followed through the frame occurrences of a sequence source.

Three routers. Reading and creating hang off the source and the track itself;
every other write sits under ``/jobs/{job_id}``, as an annotation write does,
because the job is the actor whose write scope the kernel checks against every
observation the operation touches.

**One error translation happens here.** ``AssetNotInJob`` is a 404 when an asset
id is a path segment; on these routes no asset is named at all — the refusal
means the track's observations sit on assets another job carries — so it is
re-rendered as a 409 with its code unchanged. The remedy is to act through the
job that holds them.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import Query, Response, status

from visionset.kernel.errors import AssetNotInJob
from visionset.kernel.services import TrackService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented, error_response
from visionset.server.models import (
    ObservationCreate,
    TrackClassBody,
    TrackCreate,
    TrackMerge,
    TrackOut,
    TrackPage,
    TrackSplit,
    TrackSplitOut,
    TrackStatusOut,
)

source_router = protected_router(prefix="/sources/{source_id}/tracks", tags=["tracks"])
router = protected_router(prefix="/tracks", tags=["tracks"])
job_router = protected_router(prefix="/jobs/{job_id}/tracks", tags=["tracks"])

BatchQuery = Annotated[UUID, Query(description="The batch whose work on the track to count.")]
WithAnnotationsQuery = Annotated[
    bool,
    Query(description="Also delete every annotation the track observes."),
]


@source_router.get("", responses=documented(404))
def list_tracks(workspace: WorkspaceDep, source_id: UUID) -> TrackPage:
    """Every track of this source, in creation order.

    An unknown source is 404 `SOURCE_NOT_FOUND`.
    """
    found = TrackService(workspace).list(source_id)
    return TrackPage(items=[TrackOut.of(t) for t in found], total=len(found))


@source_router.post("", status_code=status.HTTP_201_CREATED, responses=documented(404, 409))
def create_track(workspace: WorkspaceDep, source_id: UUID, body: TrackCreate) -> TrackOut:
    """Start an empty track of one class on a video or image-sequence source.

    Not gated on a job: a track observes nothing until a job observes an
    annotation with it. The class must be declared by the project's active
    schema version. 404: `SOURCE_NOT_FOUND`, `SCHEMA_NOT_FOUND`. 409:
    `TRACK_EXTERNAL_ID_TAKEN`, for an `external_id` another track of the source
    carries. 422: `SOURCE_NOT_SEQUENCE` for a source that is neither a video nor an image sequence,
    `LABEL_CLASS_NOT_IN_SCHEMA`, `INVALID_NAME` for a blank class or external id.
    """
    return TrackOut.of(
        TrackService(workspace).create(source_id, body.label_class, external_id=body.external_id)
    )


@router.get("/{track_id}", responses=documented(404))
def get_track(workspace: WorkspaceDep, track_id: UUID) -> TrackOut:
    """The track with that id, and its observations in position order.

    An unknown track is 404 `TRACK_NOT_FOUND`.
    """
    return TrackOut.of(TrackService(workspace).get(track_id))


@router.get("/{track_id}/status", responses=documented(404))
def get_track_status(
    workspace: WorkspaceDep, track_id: UUID, batch_id: BatchQuery
) -> TrackStatusOut:
    """How far one batch's work on the track's observed assets has got.

    Derived on every read. Each observation counts once under the progress its
    asset holds in the batch, or under `outside` when the batch does not hold
    that asset. `settled` is true when the track has at least one observation,
    the batch holds every one (`outside` is 0) and each sits on a settled asset.
    An unknown track is 404 `TRACK_NOT_FOUND`, and a batch
    outside the track's project is 404 `BATCH_NOT_FOUND`.
    """
    return TrackStatusOut.of(TrackService(workspace).status(track_id, batch_id))


@job_router.post(
    "/{track_id}/observations",
    status_code=status.HTTP_201_CREATED,
    response_model=TrackOut,
    responses=documented(404, 409),
)
def observe_track(
    workspace: WorkspaceDep, job_id: UUID, track_id: UUID, body: ObservationCreate
) -> TrackOut | Response:
    """Record that the track is seen at an occurrence, as an annotation drawn there.

    The annotation must sit on the occurrence's asset, carry the track's class
    and be 2D, and that asset must not be `pre_labeled`: a model's output nobody
    has judged is not tracked. 404: `JOB_NOT_FOUND`, `TRACK_NOT_FOUND`,
    `FRAME_OCCURRENCE_NOT_FOUND`, `ANNOTATION_NOT_FOUND`. 409:
    `BATCH_NOT_IN_ANNOTATION`, `JOB_FINISHED`, `ASSET_NOT_IN_JOB` (rendered as a
    409 here: the job does not carry the occurrence's asset), `ASSET_NOT_WRITABLE`,
    `ASSET_NOT_JUDGED`, `TRACK_CLASS_MISMATCH`, `OCCURRENCE_ALREADY_OBSERVED`,
    `ANNOTATION_ALREADY_OBSERVED`. 422: `TRACK_SOURCE_MISMATCH`,
    `ANNOTATION_NOT_AT_OCCURRENCE`, `INVALID_ANNOTATION`.
    """
    try:
        detail = TrackService(workspace).observe(
            job_id, track_id, body.occurrence_id, body.annotation_id
        )
    except AssetNotInJob as exc:
        return error_response(exc, status=409)
    return TrackOut.of(detail)


@job_router.delete(
    "/{track_id}/observations/{occurrence_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=documented(404, 409),
)
def unobserve_track(
    workspace: WorkspaceDep, job_id: UUID, track_id: UUID, occurrence_id: UUID
) -> Response | None:
    """Remove the track's observation at an occurrence. The annotation stays.

    404: `JOB_NOT_FOUND`, `TRACK_NOT_FOUND`, `OBSERVATION_NOT_FOUND`. 409:
    `BATCH_NOT_IN_ANNOTATION`, `JOB_FINISHED`, `ASSET_NOT_IN_JOB` (rendered as a
    409 here: another job carries the observed asset), `ASSET_NOT_WRITABLE`.
    """
    try:
        TrackService(workspace).unobserve(job_id, track_id, occurrence_id)
    except AssetNotInJob as exc:
        return error_response(exc, status=409)
    return None


@job_router.put("/{track_id}/class", response_model=TrackOut, responses=documented(404, 409))
def set_track_class(
    workspace: WorkspaceDep, job_id: UUID, track_id: UUID, body: TrackClassBody
) -> TrackOut | Response:
    """Give the track and every annotation it observes a new class.

    The annotations are rewritten in one transaction with the track, against the
    batch's pinned version, which must declare the class, even for a track with
    no observation; the same class again changes nothing. The job must
    carry every observed asset at a writable progress. 404: `JOB_NOT_FOUND`,
    `TRACK_NOT_FOUND`. 409: `BATCH_NOT_IN_ANNOTATION`, `JOB_FINISHED`,
    `ASSET_NOT_IN_JOB` (rendered as a 409 here: act through the job holding the
    track's observations), `ASSET_NOT_WRITABLE`, `STALE_WRITE`. 422:
    `LABEL_CLASS_NOT_IN_SCHEMA`, `DISALLOWED_GEOMETRY`, `MISSING_REQUIRED_ATTRIBUTE`,
    `UNKNOWN_ATTRIBUTE`, `INVALID_ATTRIBUTE_VALUE`, `DUPLICATE_CLASSIFICATION_TAG`,
    `INVALID_ANNOTATION`, `INVALID_NAME`. 500: `WORKSPACE_CORRUPT`.
    """
    try:
        detail = TrackService(workspace).change_class(job_id, track_id, body.label_class)
    except AssetNotInJob as exc:
        return error_response(exc, status=409)
    return TrackOut.of(detail)


@job_router.post("/{track_id}/merge", response_model=TrackOut, responses=documented(404, 409))
def merge_tracks(
    workspace: WorkspaceDep, job_id: UUID, track_id: UUID, body: TrackMerge
) -> TrackOut | Response:
    """Move every observation of `body.track_id` onto this track, and delete that one.

    The tracks share a source and a class and observe disjoint occurrences. This
    track keeps its own `external_id`, and takes the absorbed one's when it has
    none. 404: `JOB_NOT_FOUND`, `TRACK_NOT_FOUND`. 409: `BATCH_NOT_IN_ANNOTATION`,
    `JOB_FINISHED`, `ASSET_NOT_IN_JOB` (rendered as a 409 here: act through the
    job holding both tracks' observations), `ASSET_NOT_WRITABLE`,
    `TRACK_CLASS_MISMATCH`, `OCCURRENCE_ALREADY_OBSERVED`. 422:
    `TRACK_MERGE_WITH_ITSELF`, `TRACK_SOURCE_MISMATCH`.
    """
    try:
        detail = TrackService(workspace).merge(job_id, track_id, body.track_id)
    except AssetNotInJob as exc:
        return error_response(exc, status=409)
    return TrackOut.of(detail)


@job_router.post("/{track_id}/split", response_model=TrackSplitOut, responses=documented(404, 409))
def split_track(
    workspace: WorkspaceDep, job_id: UUID, track_id: UUID, body: TrackSplit
) -> TrackSplitOut | Response:
    """Cut the track at an occurrence: it and every later observation move to a new track.

    The new track has the same source and class and no `external_id`. Answers
    the shortened track as `kept` and the new one as `created`. 404:
    `JOB_NOT_FOUND`, `TRACK_NOT_FOUND`, `FRAME_OCCURRENCE_NOT_FOUND`. 409:
    `BATCH_NOT_IN_ANNOTATION`, `JOB_FINISHED`, `ASSET_NOT_IN_JOB` (rendered as a
    409 here: act through the job holding the track's observations),
    `ASSET_NOT_WRITABLE`, `TRACK_SPLIT_EMPTY`. 422: `TRACK_SOURCE_MISMATCH`.
    """
    try:
        kept, created = TrackService(workspace).split(job_id, track_id, body.occurrence_id)
    except AssetNotInJob as exc:
        return error_response(exc, status=409)
    return TrackSplitOut.of(kept, created)


@job_router.delete(
    "/{track_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=documented(404, 409),
)
def delete_track(
    workspace: WorkspaceDep,
    job_id: UUID,
    track_id: UUID,
    with_annotations: WithAnnotationsQuery = False,
) -> Response | None:
    """Delete the track and its observations.

    Every annotation it observed stays unless `with_annotations` is true, which
    deletes them too, in one transaction, by the rules of an annotation delete.
    No confirmation gate: like an annotation delete, the batch gate is the guard.
    404: `JOB_NOT_FOUND`, `TRACK_NOT_FOUND`. 409: `BATCH_NOT_IN_ANNOTATION`,
    `JOB_FINISHED`, `ASSET_NOT_IN_JOB` (rendered as a 409 here: act through the
    job holding the track's observations), `ASSET_NOT_WRITABLE`, `STALE_WRITE`.
    """
    service = TrackService(workspace)
    try:
        if with_annotations:
            service.delete_with_annotations(job_id, track_id)
        else:
            service.delete(job_id, track_id)
    except AssetNotInJob as exc:
        return error_response(exc, status=409)
    return None
