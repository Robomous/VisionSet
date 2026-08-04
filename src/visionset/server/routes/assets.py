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

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from typing import Any, Final
from uuid import UUID

from fastapi.responses import StreamingResponse

from visionset.kernel.domain import Asset, ImageFormat
from visionset.kernel.ports import THUMBNAIL_FORMAT
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    IngestService,
    JobService,
    ProjectService,
)
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    AssetOut,
    AssetPage,
    BatchOut,
    BatchPage,
    LimitQuery,
    OffsetQuery,
    window,
)

router = protected_router(prefix="/projects/{project_id}/assets", tags=["assets"])

#: Content is immutable by identity, so the strongest caching HTTP offers is not
#: a gamble. One year is the maximum ``max-age`` anything honours, and
#: ``immutable`` tells a browser not to revalidate even on a reload.
_IMMUTABLE: Final = "public, max-age=31536000, immutable"


def _promoted(workspace: WorkspaceDep, project_id: UUID) -> frozenset[UUID]:
    """The trunk's current membership, read once for the whole response.

    The same helper `routes/batches.py` has, and deliberately a second spelling
    rather than an import: a route module reaches for `dependencies`, `errors`
    and `models`, never for another route module, and three lines is a smaller
    price than the first edge between two of them. `DatasetService` is the one
    place the rule actually lives.
    """
    dataset = ProjectService(workspace).get_dataset(project_id)
    return DatasetService(workspace).member_asset_ids(dataset.id)


#: What each ``ImageFormat`` is called on the wire. A mapping rather than
#: ``f"image/{format}"`` because the two coincide today and would stop coinciding
#: the moment a format whose media type is not its own name arrives — WEBP is
#: already named as the next member — and a wrong ``Content-Type`` is the kind of
#: bug that shows up in one browser and nowhere else.
#:
#: Indexed directly rather than with a fallback, the ``ProgressCounts`` bargain:
#: exhaustiveness is asserted by a test against the enum itself, so adding a
#: member without a media type fails the suite instead of quietly degrading every
#: download of it to ``octet-stream``.
_MEDIA_TYPES: Final[dict[ImageFormat, str]] = {
    ImageFormat.JPEG: "image/jpeg",
    ImageFormat.PNG: "image/png",
}

#: For an asset written before the ingest pipeline probed formats. The store
#: cannot invent what nobody measured, and admitting that beats guessing.
_OCTET_STREAM: Final = "application/octet-stream"

# FastAPI documents a 200 as ``application/json`` unless told otherwise — the
# app-level ``UNIVERSAL_ERROR_RESPONSES`` only covers 422/500/503 — so the binary
# content type is declared per route. ``{}`` as the schema is OpenAPI's way of
# saying "bytes, and there is nothing more to say about their shape".
#
# Every type ``_media_type`` can return is listed, ``_OCTET_STREAM`` included. A
# response the route really sends and the contract does not declare is a lie a
# generated client inherits — and the pre-pipeline rows that produce it are
# exactly the ones a caller is least prepared for.
_IMAGE_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    200: {
        "content": {
            "image/jpeg": {"schema": {}},
            "image/png": {"schema": {}},
            _OCTET_STREAM: {"schema": {}},
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


def _media_type(asset: Asset) -> str:
    return _OCTET_STREAM if asset.format is None else _MEDIA_TYPES[asset.format]


@router.get("", responses=documented(404))
def list_project_assets(
    workspace: WorkspaceDep,
    project_id: UUID,
    limit: LimitQuery = None,
    offset: OffsetQuery = 0,
) -> AssetPage:
    """Every asset ingested into the project, in a stable order.

    The third asset listing, and the one that had been missing: the other two
    window a *batch* and the curated *trunk*, and neither answers "show me this
    project". A project page asking for six sample tiles passes `limit=6` and
    reads `total` for the rest.

    **The order is deterministic and it is not chronological.** Nothing records
    when an asset arrived, so assets are grouped by source, then by frame index
    for a clip, then by path for a directory, then by id. The practical effect is
    that a clip's frames come back in order and a directory's stills in filename
    order; the practical limit is that "the six most recent" cannot be asked for
    yet.

    `total` is every asset in the project, never the size of this page, so a
    client showing six tiles computes its own overflow from `total - 6`.
    """
    found = IngestService(workspace).assets(project_id)
    return AssetPage(
        items=[AssetOut.of(asset) for asset in window(found, limit=limit, offset=offset)],
        total=len(found),
    )


@router.get("/{asset_id}", responses=documented(404))
def get_asset(workspace: WorkspaceDep, project_id: UUID, asset_id: UUID) -> AssetOut:
    """One ingested item, by id.

    An asset belonging to a different project reads as 404 rather than 403, like
    every cross-scope reference here.

    `content_hash` identifies the bytes and `thumbnail_hash` the cached preview,
    but neither is a URL — the two routes below are, and they take this asset's
    id.
    """
    return AssetOut.of(IngestService(workspace).asset(project_id, asset_id))


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
    asset or the project, which is resolved first.
    """
    # Resolved before the membership read so an unknown asset is a 404 rather
    # than an empty page, which would be a different and wronger answer.
    asset = IngestService(workspace).asset(project_id, asset_id)
    batches = BatchService(workspace)
    jobs = JobService(workspace)
    promoted = _promoted(workspace, project_id)
    found = batches.holding(asset.id)
    return BatchPage(
        items=[
            BatchOut.of(batch, jobs.batch_progress(batch.id), promoted=promoted) for batch in found
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
    the PNG extraction wrote, which is the picture an annotator drew on and the
    picture an exporter ships.

    `Content-Type` comes from what the ingest actually probed. An asset written
    before the pipeline recorded a format is served as
    `application/octet-stream`, because inventing one would be worse than
    admitting it.

    Cached forever and never revalidated: identity is content, so these bytes
    cannot change. The `ETag` is the content hash.

    404 `WORKSPACE_CORRUPT` is not among the answers — a recorded hash with no
    blob behind it is a guarantee failing, and is 500.
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
    has reached it yet. A backfill fills what it can.

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
        media_type=_MEDIA_TYPES[THUMBNAIL_FORMAT],
        headers={"ETag": f'"{asset.thumbnail_hash}"', "Cache-Control": _IMMUTABLE},
    )
