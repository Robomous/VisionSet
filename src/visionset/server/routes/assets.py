# usage: from visionset.server.routes import assets
"""Assets, and the first routes in this API that answer with bytes.

**Addressed by asset id, not by content hash**, and that is a decision rather
than a convenience. A hash names bytes and says nothing about what they are, so
a route keyed on one could only answer ``application/octet-stream`` — which a
gallery cannot put in an ``<img>``. Resolving a hash back to its asset would fix
that and needs a query ``Repository`` deliberately does not have: its whole
surface is one ``parent_id`` filter, on purpose, so *no query language leaks into
the port*. Widening the port for a download route would be the tail wagging the
dog.

The hash is not lost. It ships as the ``ETag``, which is what makes
``Cache-Control: immutable`` honest: identity is content, so an asset's bytes can
never change under a client that cached them. A caller comparing two assets for
sameness compares ``content_hash`` off the JSON, exactly as before.

**Nothing here buffers a file.** ``BlobStore.get`` hands back an open handle and
``StreamingResponse`` walks it, so a fifty-megapixel frame is served without
being read into memory — the discipline ``uploads.py`` follows in the other
direction. A handler that called ``.read()`` would undo it in one line.
The one exception is ``points``, which has to decode a scan to thin it: it
answers a buffer bounded by its point budget, never the file.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from typing import Annotated, Any, Final
from uuid import UUID

from fastapi import Query, Response, status
from fastapi.responses import StreamingResponse

from visionset.jobs.thumbnails import JOB_TYPE as backfill_job_type
from visionset.jobs.thumbnails import PROJECT_KEY as backfill_project_key
from visionset.jobs.thumbnails import payload_for as backfill_payload_for
from visionset.kernel.domain import (
    DEFAULT_POINT_BUDGET,
    LIVE_JOB_STATES,
    MAX_POINT_BUDGET,
    MEDIA_TYPES,
    MIN_POINT_BUDGET,
    OCTET_STREAM,
    Asset,
    BackgroundJob,
    BackgroundJobSpec,
    media_type_of,
)
from visionset.kernel.ports import THUMBNAIL_FORMAT
from visionset.kernel.services import (
    BatchService,
    CalibrationService,
    DatasetService,
    IngestService,
    JobService,
    ProjectService,
)
from visionset.server.dependencies import RunnerDep, WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    AssetCalibrationOut,
    AssetOut,
    AssetPage,
    BackgroundJobOut,
    BatchOut,
    BatchPage,
    CalibrationBody,
    LimitQuery,
    OffsetQuery,
    window,
)

router = protected_router(prefix="/projects/{project_id}/assets", tags=["assets"])
project_router = protected_router(prefix="/projects/{project_id}", tags=["assets"])

#: Content is immutable by identity, so the strongest caching HTTP offers is not
#: a gamble. One year is the maximum ``max-age`` anything honours, and
#: ``immutable`` tells a browser not to revalidate even on a reload.
_IMMUTABLE: Final = "public, max-age=31536000, immutable"


# FastAPI documents a 200 as ``application/json`` unless told otherwise — the
# app-level ``UNIVERSAL_ERROR_RESPONSES`` only covers 422/500/503 — so the binary
# content type is declared per route. ``{}`` as the schema is OpenAPI's way of
# saying "bytes, and there is nothing more to say about their shape".
#
# Every type ``media_type_of`` can return is listed, ``OCTET_STREAM`` included. A
# response the route really sends and the contract does not declare is a lie a
# generated client inherits — and the pre-pipeline rows that produce it are
# exactly the ones a caller is least prepared for.
#
# Built from ``MEDIA_TYPES`` rather than written out, so a format added to the
# domain cannot be served with a content type this contract never declared.
_IMAGE_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    200: {
        "content": {
            **{media_type: {"schema": {}} for media_type in sorted(MEDIA_TYPES.values())},
            OCTET_STREAM: {"schema": {}},
        },
        "description": "The bytes, streamed.",
    }
}

_THUMBNAIL_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    200: {
        "content": {"image/jpeg": {"schema": {}}},
        "description": "The cached preview, streamed.",
    }
}


_POINTS_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    200: {
        "content": {OCTET_STREAM: {"schema": {}}},
        "description": "The thinned scan, as the VSPC buffer.",
    }
}

MaxPointsQuery = Annotated[
    int,
    Query(
        ge=MIN_POINT_BUDGET,
        le=MAX_POINT_BUDGET,
        description="The most points to return; the scan is thinned by a whole stride to fit.",
    ),
]


def _media_type(asset: Asset) -> str:
    return media_type_of(asset.format)


@router.get("", responses=documented(404))
def list_project_assets(
    workspace: WorkspaceDep,
    project_id: UUID,
    limit: LimitQuery = None,
    offset: OffsetQuery = 0,
    source_id: Annotated[
        UUID | None,
        Query(
            description="Only the assets this source produced. A source of another project is 404."
        ),
    ] = None,
) -> AssetPage:
    """Every asset ingested into the project, most recently ingested first.

    The third asset listing: the other two window a *batch* and the curated
    *trunk*, and neither answers "show me this project". A page asking for six
    sample tiles passes `limit=6` and reads `total` for the rest.

    **Newest run first, and stable inside a run** — within one ingest the order
    is source, then file, then frame index, then id, so a clip's frames come back
    in order and a directory's stills in filename order. Two calls never
    disagree.

    `source_id` narrows the listing to one source, in the same order, and
    `total` then counts that source — so a client filtering by source pages and
    counts exactly as it would the whole project. An unknown project is 404
    `PROJECT_NOT_FOUND`, and a source that is not this project's is 404
    `SOURCE_NOT_FOUND`, never an empty page.

    `total` is every asset matched, never the size of this page.
    """
    found = IngestService(workspace).assets(project_id, source_id=source_id)
    return AssetPage(
        items=[AssetOut.of(asset) for asset in window(found, limit=limit, offset=offset)],
        total=len(found),
    )


@router.get("/{asset_id}", responses=documented(404))
def get_asset(workspace: WorkspaceDep, project_id: UUID, asset_id: UUID) -> AssetOut:
    """One ingested item, by id.

    An unknown project is 404 `PROJECT_NOT_FOUND` and an unknown asset is 404
    `ASSET_NOT_FOUND`. An asset belonging to a different project answers the
    second of those rather than 403, like every cross-scope reference here.

    `content_hash` identifies the bytes and `thumbnail_hash` the cached preview,
    but neither is a URL — the two routes below are, and they take this asset's
    id.
    """
    return AssetOut.of(IngestService(workspace).asset(project_id, asset_id))


@router.get("/{asset_id}/calibration", responses=documented(404))
def get_asset_calibration(
    workspace: WorkspaceDep, project_id: UUID, asset_id: UUID
) -> AssetCalibrationOut:
    """The asset's own calibration, and the one that applies to it.

    `override` is the asset's own, null when it inherits; `effective` is the
    override when there is one, else its source's, null when neither is stated.
    An unknown project is 404 `PROJECT_NOT_FOUND` and an unknown asset 404
    `ASSET_NOT_FOUND`.
    """
    return AssetCalibrationOut.of(
        CalibrationService(workspace).asset_calibration(project_id, asset_id)
    )


@router.put("/{asset_id}/calibration", responses=documented(404, 409))
def set_asset_calibration(
    workspace: WorkspaceDep, project_id: UUID, asset_id: UUID, body: CalibrationBody
) -> AssetCalibrationOut:
    """State this asset's own calibration, overriding its source's and replacing any override.

    The only way a calibration reaches an imported asset, which has no source.
    One other than the calibration in effect for the asset (its override, else
    its source's) is refused with 409 `CALIBRATION_IN_USE` while the asset holds
    3D labels, which were drawn against it; stating the identical one again
    changes nothing. A point
    cloud, which has no camera, is 409 `CALIBRATION_NOT_APPLICABLE`.
    One measured at a size other than the asset's is 422
    `CALIBRATION_RESOLUTION_MISMATCH`; a rotation that is not a proper rotation,
    or a non-positive focal length, is 422 `VALIDATION_ERROR`. An unknown
    project is 404 `PROJECT_NOT_FOUND` and an unknown asset 404 `ASSET_NOT_FOUND`.
    """
    return AssetCalibrationOut.of(
        CalibrationService(workspace).set_asset_calibration(project_id, asset_id, body.to_domain())
    )


@router.delete(
    "/{asset_id}/calibration",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=documented(404, 409),
)
def clear_asset_calibration(workspace: WorkspaceDep, project_id: UUID, asset_id: UUID) -> None:
    """Remove the asset's override, so it inherits its source's again. None is a 204 too.

    Refused with 409 `CALIBRATION_IN_USE` when the asset holds 3D labels and its
    source has no calibration to fall back to, or a different one, and with 422
    `CALIBRATION_RESOLUTION_MISMATCH` when the source's calibration was measured
    at a size other than the asset's. An unknown project is 404
    `PROJECT_NOT_FOUND` and an unknown asset 404 `ASSET_NOT_FOUND`.
    """
    CalibrationService(workspace).clear_asset_calibration(project_id, asset_id)


@router.get("/{asset_id}/batches", responses=documented(404))
def list_asset_batches(workspace: WorkspaceDep, project_id: UUID, asset_id: UUID) -> BatchPage:
    """Every batch that carries this asset, oldest membership first.

    **The membership edge walked backwards.** Every other read goes from a batch
    to its assets; this asks which rounds of work an asset has been through, and
    it is what a correction batch's lineage looks like from the asset's side —
    the original and its corrections, in the order they were cut.

    A dedicated route rather than a field on `AssetOut`, and the reason is cost:
    a listing of fifty thousand assets would pay one join per row for a fact
    almost no reader of that listing wants. This is asked about one asset, by
    somebody looking at that asset.

    An asset in no batch answers `{"items": [], "total": 0}` — the ordinary state
    of anything ingested without a target, and not a 404. The 404 here is for the
    asset or the project, which is resolved first: 404 `PROJECT_NOT_FOUND` or 404
    `ASSET_NOT_FOUND`. A batch deleted between that read and its progress is 404
    `BATCH_NOT_FOUND`, and asking again answers without it.
    """
    # Resolved before the membership read so an unknown asset is a 404 rather
    # than an empty page, which would be a different and wronger answer.
    asset = IngestService(workspace).asset(project_id, asset_id)
    batches = BatchService(workspace)
    jobs = JobService(workspace)
    promoted = DatasetService(workspace).promoted_asset_ids(project_id)
    found = batches.holding(asset.id)
    pre_label_runs = batches.pre_label_runs()
    modalities = batches.modalities(project_id)
    return BatchPage(
        items=[
            BatchOut.of(
                batch,
                jobs.batch_progress(batch.id),
                promoted=promoted,
                pre_label_run=pre_label_runs.get(batch.id),
                modalities=modalities.get(batch.id, ()),
            )
            for batch in found
        ],
        total=len(found),
    )


@router.get(
    "/{asset_id}/content",
    response_class=StreamingResponse,
    response_model=None,
    responses={**documented(404), **_IMAGE_RESPONSE},
)
def get_asset_content(
    workspace: WorkspaceDep, project_id: UUID, asset_id: UUID
) -> StreamingResponse:
    """The asset's own bytes, streamed.

    The original that was ingested, not a re-encode — for a video frame that is
    the JPEG the materializer wrote, which is the picture an annotator drew on and the
    picture an exporter ships.

    `Content-Type` comes from what the ingest actually probed. An asset written
    before the pipeline recorded a format is served as
    `application/octet-stream`, because inventing one would be worse than
    admitting it. A point-cloud scan is served as `application/octet-stream`
    too, the PCD or PLY file as ingested: neither has a registered media type,
    and the asset's `point_cloud.format` says which it is.

    Cached forever and never revalidated: identity is content, so these bytes
    cannot change. The `ETag` is the content hash.

    An unknown project or asset is 404 — `PROJECT_NOT_FOUND` and
    `ASSET_NOT_FOUND` — and those are the only two. 404 `WORKSPACE_CORRUPT` is
    not among the answers: a recorded hash with no blob behind it is a guarantee
    failing, and is 500.
    """
    ingest = IngestService(workspace)
    asset = ingest.asset(project_id, asset_id)
    return StreamingResponse(
        ingest.open_content(asset),
        media_type=_media_type(asset),
        headers={"ETag": f'"{asset.content_hash}"', "Cache-Control": _IMMUTABLE},
    )


@router.get(
    "/{asset_id}/thumbnail",
    response_class=StreamingResponse,
    response_model=None,
    responses={**documented(404), **_THUMBNAIL_RESPONSE},
)
def get_asset_thumbnail(
    workspace: WorkspaceDep, project_id: UUID, asset_id: UUID
) -> StreamingResponse:
    """The asset's cached preview, streamed. Always JPEG.

    A preview is a cache, so this reads one and never renders one. An asset with
    no preview is 404 `THUMBNAIL_NOT_CACHED` — which has three causes with one
    remedy: the asset predates the cache, its bytes would not render, or no run
    has reached it yet. `POST /projects/{project_id}/thumbnail-backfill-jobs`
    fills what it can. The other two 404s are the
    ordinary ones, resolved before the cache is consulted: 404 `PROJECT_NOT_FOUND`
    and 404 `ASSET_NOT_FOUND`, which say the thing itself is not here rather than
    that its preview is missing.

    Cached the same way `content` is, and for the same reason. The `ETag` is the
    thumbnail hash, which is a cache key and not an identity: two machines may
    hold different preview bytes for one image, so never compare these across
    workspaces.
    """
    ingest = IngestService(workspace)
    asset = ingest.asset(project_id, asset_id)
    stream = ingest.open_thumbnail(asset)
    return StreamingResponse(
        stream,
        media_type=MEDIA_TYPES[THUMBNAIL_FORMAT],
        headers={"ETag": f'"{asset.thumbnail_hash}"', "Cache-Control": _IMMUTABLE},
    )


@router.get(
    "/{asset_id}/points",
    response_class=Response,
    response_model=None,
    responses={**documented(404), **_POINTS_RESPONSE},
)
def get_asset_points(
    workspace: WorkspaceDep,
    project_id: UUID,
    asset_id: UUID,
    max_points: MaxPointsQuery = DEFAULT_POINT_BUDGET,
) -> Response:
    """A point-cloud scan thinned to at most `max_points`, as a compact binary buffer.

    Every `ceil(n / max_points)`-th of the scan's `n` finite points, in file
    order, so one asset and one budget always answer the same bytes. Little-endian
    throughout: a 16-byte header (the magic `VSPC`, then u32 version `1`, u32
    count and u32 flags, bit 0 intensity, bit 1 rgb, bit 2 origin), then f64
    origin `x, y, z` if flagged, then f32 `x, y, z` per point relative to that
    origin, then f32 intensity per point if flagged, then u8 `r, g, b` per point
    if flagged. A point is the origin plus its position; without bit 2 the origin
    is zero. An axis whose median point lies 8192 or more from zero is offset by
    that median rounded to a whole unit, so float32 keeps a georeferenced scan's
    precision. The scan's full count and bounds are the asset's `point_cloud`.

    `max_points` defaults to 500000; outside 1000 to 2000000 it is 422
    `VALIDATION_ERROR`, never clamped. An image asset is 404 `ASSET_NOT_FOUND`,
    as is an unknown asset; an unknown project is 404 `PROJECT_NOT_FOUND`. A
    stored scan this installation can no longer read is 422 `UNSUPPORTED_MEDIA`
    or `CORRUPT_MEDIA`.
    """
    sample = IngestService(workspace).points(project_id, asset_id, max_points=max_points)
    return Response(
        content=sample.encode(),
        media_type=OCTET_STREAM,
        headers={"Cache-Control": "private, no-cache"},
    )


def _live_backfill(workspace: WorkspaceDep, project_id: UUID) -> BackgroundJob | None:
    for row in workspace.job_queue.list(states=LIVE_JOB_STATES, types={backfill_job_type}):
        if row.payload.get(backfill_project_key) == str(project_id):
            return row
    return None


@project_router.post(
    "/thumbnail-backfill-jobs",
    status_code=status.HTTP_202_ACCEPTED,
    responses=documented(404),
)
def launch_thumbnail_backfill(
    workspace: WorkspaceDep,
    runner: RunnerDep,
    response: Response,
    project_id: UUID,
) -> BackgroundJobOut:
    """Queue a preview pass over the project, and answer at once with the job to poll.

    Renders a preview for every asset that has none: the remedy for the
    thumbnail route's `THUMBNAIL_NOT_CACHED`. An unknown project is 404
    `PROJECT_NOT_FOUND`, answered before any job is queued.
    The `Location` header names the job; poll `GET /background-jobs/{id}` until
    `state` is `succeeded`, and read what the pass found from `result`: `examined`,
    the ids `filled`, the ids `missing` (no bytes left in the workspace) and the
    `unreadable` assets that will not render, each with its reason. Those are the
    fields the CLI and MCP backfill report.

    **One live pass per project.** A launch while one is queued or running answers
    with that same job rather than starting a second, and a pass over a healthy
    project examines nothing.

    Raises:
        ProjectNotFound: no such project in this workspace, answered before any
            job is queued.
    """
    ProjectService(workspace).get(project_id)
    job = _live_backfill(workspace, project_id) or workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=backfill_job_type,
            payload=backfill_payload_for(project_id),
            idempotent=True,
        )
    )
    runner.wake()
    response.headers["Location"] = f"/background-jobs/{job.id}"
    return BackgroundJobOut.of(job)
