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
from visionset.kernel.services import IngestService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import AssetOut

router = protected_router(prefix="/projects/{project_id}/assets", tags=["assets"])

#: Content is immutable by identity, so the strongest caching HTTP offers is not
#: a gamble. One year is the maximum ``max-age`` anything honours, and
#: ``immutable`` tells a browser not to revalidate even on a reload.
_IMMUTABLE: Final = "public, max-age=31536000, immutable"

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
_IMAGE_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    200: {
        "content": {"image/jpeg": {"schema": {}}, "image/png": {"schema": {}}},
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
