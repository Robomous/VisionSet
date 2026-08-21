# usage: from visionset.mcp import assets
"""``get_asset_image`` — the tool that makes an agent an annotator, not an operator.

Everything else in this package moves rows around. Without this one an agent can
drive the entire workflow and never see what it is annotating, which guts the
whole point: ``add_annotations`` with ``provenance='model'`` only means something
if the model looked.

**The coordinate-frame trap, and why the answer carries four numbers.** A preview
is capped at ``DEFAULT_THUMBNAIL_MAX_EDGE`` on its long side, while annotation
geometry is *always* in the asset's native pixels and is never normalized. An
agent that reads a 256-pixel preview and writes boxes in preview pixels produces
annotations that are silently wrong — wrong in a way nothing downstream can
detect, because the numbers are individually plausible. So the structured half
publishes the asset's own ``width``/``height`` (the frame to write in), the
``image_width``/``image_height`` actually sent, and the ``scale`` between them,
and the description says which to multiply by. Publishing only one pair would
have been smaller and would have made the mistake invisible.

**The preview's dimensions are measured, never derived.** The port pins a maximum
*edge*, not a size: a small image is never enlarged, and which edge is capped
depends on the aspect ratio. Computing them arithmetically would be a guess, and
a wrong ``scale`` is the one error this tool exists to prevent — so they come off
the encoded bytes, through ``ImageProcessor.probe``. Using the port rather than
importing Pillow here is what keeps a decoder out of a delivery module.

**It folds ``get_asset``.** The structured half already carries every field the
row publishes, so a separate metadata tool would be a second round trip for
something this one has to send anyway.

**Bare ``CallToolResult``, not ``Annotated[CallToolResult, Model]``.** The
annotated form declares an output schema and validates ``structuredContent``
against it — which would reject the error envelope on the refusal path, since a
refusal cannot also be a valid image result. Verified against mcp 1.28.1: bare
``CallToolResult`` passes ``structuredContent`` through untouched with no schema
declared, so both paths travel in one shape. Returning ``[Image(...), {...}]``
instead is the trap that looks right and silently produces **no**
``structuredContent`` at all.

Previews rather than originals by default because the bytes are base64-encoded
into a single JSON-RPC message: a 12-megapixel original costs an agent its
context window.
"""

from __future__ import annotations

import io
from typing import Annotated, Any, Final

from mcp.server.mcpserver.utilities.types import Image
from mcp.types import CallToolResult, TextContent
from pydantic import Field

from visionset.kernel.domain import Asset, ImageFormat
from visionset.kernel.ports import THUMBNAIL_FORMAT
from visionset.kernel.services import IngestService, WorkspaceService
from visionset.mcp._resolve import ProjectRef, identifier, resolve_project
from visionset.mcp._workspace import opened_workspace

SUFFIXES: Final[dict[ImageFormat, str]] = {ImageFormat.JPEG: "jpeg", ImageFormat.PNG: "png"}
"""What ``Image`` wants: the suffix it turns into ``image/<suffix>``.

Indexed directly rather than with a fallback, and a parity test asserts it covers
every ``ImageFormat`` member — the ``ProgressCounts`` bargain. A format added to
the enum without an entry fails the suite instead of being served under the wrong
media type or crashing one call in a thousand.
"""

OCTET_STREAM: Final = "application/octet-stream"
"""What a pre-pipeline asset's bytes are, when nothing recorded a format.

Inventing a media type would be worse than admitting there is none, which is the
call ``docs/content/api.md`` already made for the download route.
"""


def _payload(
    asset: Asset, *, sent: tuple[int | None, int | None], resolution: str
) -> dict[str, Any]:
    """The asset's own frame, the frame that was sent, and the factor between them."""
    image_width, image_height = sent
    scale = (
        asset.width / image_width
        if asset.width is not None and image_width not in (None, 0)
        else None
    )
    return {
        "asset_id": str(asset.id),
        "width": asset.width,
        "height": asset.height,
        "format": None if asset.format is None else asset.format.value,
        "content_hash": asset.content_hash,
        "image_width": image_width,
        "image_height": image_height,
        "resolution": resolution,
        "scale": scale,
    }


def _preview(workspace: WorkspaceService, asset: Asset) -> CallToolResult:
    with IngestService(workspace).open_thumbnail(asset) as handle:
        buffer = io.BytesIO(handle.read())
    measured = workspace.image_processor.probe(buffer)
    return CallToolResult(
        content=[
            Image(data=buffer.getvalue(), format=SUFFIXES[THUMBNAIL_FORMAT]).to_image_content()
        ],
        structured_content=_payload(
            asset, sent=(measured.width, measured.height), resolution="thumbnail"
        ),
    )


def _original(workspace: WorkspaceService, asset: Asset) -> CallToolResult:
    with IngestService(workspace).open_content(asset) as handle:
        data = handle.read()
    payload = _payload(asset, sent=(asset.width, asset.height), resolution="full")
    if asset.format is None:
        # Nothing recorded a format, so there is no honest media type and `Image`
        # cannot label it. Say so in words rather than serving pixels a client
        # would have to guess at.
        return CallToolResult(
            content=[
                TextContent(
                    type="text",
                    text=(
                        f"asset {asset.id} has no recorded image format, so its "
                        f"{len(data)} bytes are {OCTET_STREAM} and cannot be sent as "
                        f"image content"
                    ),
                )
            ],
            structured_content=payload,
        )
    return CallToolResult(
        content=[Image(data=data, format=SUFFIXES[asset.format]).to_image_content()],
        structured_content=payload,
    )


def get_asset_image(
    project: ProjectRef,
    asset_id: Annotated[str, Field(description="The asset to look at, by id.")],
    full: Annotated[
        bool,
        Field(
            description=(
                "Return the original bytes instead of the preview. Costly — an "
                "original can be many megapixels."
            )
        ),
    ] = False,
) -> CallToolResult:
    """Look at an asset's pixels, so you can annotate what is actually there.

    Returns the image itself plus its measurements. By default it serves the
    cached preview, capped at 256 pixels on its long edge, because the bytes
    travel base64-encoded in one message and an original would be enormous. Pass
    `full=true` when you genuinely need the detail.

    **Write geometry in the asset's own frame.** `width` and `height` are the
    asset's true size and are the coordinate system every annotation uses;
    `image_width` and `image_height` are what was actually sent. When they differ,
    multiply any coordinate you measured on the returned image by `scale` before
    passing it to `add_annotations`. Coordinates are never normalized, so an
    unscaled preview coordinate is silently wrong rather than obviously wrong.

    Refuses if no preview has been rendered yet, and names `backfill_thumbnails`
    as the remedy. An asset with no recorded image format has no honest media
    type, so its measurements come back with an explanation instead of pixels.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        asset = IngestService(workspace).asset(resolved.id, identifier(asset_id, what="asset_id"))
        return _original(workspace, asset) if full else _preview(workspace, asset)
