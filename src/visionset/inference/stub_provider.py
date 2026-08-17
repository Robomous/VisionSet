# usage: from visionset.inference import STUB_MODEL_ID, StubSegmenter
"""A point segmenter that runs everywhere and predicts nothing.

**Why a shipped no-op rather than a test fixture.** The whole path between a
click in the editor and a shape in the document — the connection lifecycle, the
route, the wire shapes, the suggest panel's states — could not be exercised
against a real server on a pull request, because the models that answer a point
prompt are gigabytes and one of them is gated. A fixture cannot close that: the
browser suite drives a real ``visionset server`` in its own process, where no
test double can be injected. So the stand-in has to be something the shipped
distribution can actually resolve.

``DummyExporter`` is the same decision, taken earlier and for the same reason:
an installed format that writes nothing, so that publish-and-export is walkable
end to end without an exporter's own correctness entering the picture. The
browser suite already exports through it.

**It is reachable by naming it and it is not offered.** Nothing in the curated
catalogue lists this id, so nobody choosing a model is shown a segmenter that
cannot segment; typing it works, which is what the suite needs and what anybody
diagnosing their own setup can use to ask *is the path working, or is it the
model?*. The omission from the catalogue is deliberate rather than an oversight,
which is why it is written down here.

**It needs no weights and no runtime**, and both of those are load-bearing
rather than convenient. No weights means the connection reaches ``ready``
without a network call, so the suite stays hermetic and the "VisionSet downloads
nothing on its own" promise is untouched. No runtime means the browser job does
not install two gigabytes of CUDA wheels to click a button — this module imports
nothing from the optional extra, and :func:`visionset.inference.providers._local`
resolves it *before* the runtime check for exactly that reason.

**What it answers is derived from the prompt, not fixed.** A square centred on
the click, so a suite can assert that the shape came back *where it asked* rather
than only that something came back — a stand-in answering a constant would pass
a pipeline that ignored the prompt entirely.
"""

from __future__ import annotations

from collections.abc import Iterator
from io import BytesIO
from typing import Final

from PIL import Image

from visionset.kernel.domain import (
    AssetSegmentation,
    PointPrompt,
    PredictionRequest,
    SegmentedMask,
)
from visionset.kernel.errors import UnsupportedPrompt

STUB_MODEL_ID: Final = "visionset/stub-segmenter"
"""The reserved model id that resolves to this, rather than to the hub.

Under the ``visionset/`` namespace deliberately: it is this build's own, it
names nothing published, and a reader who meets it in a connection list can tell
at a glance that it did not come from anywhere else.
"""

STUB_FAMILY: Final = "visionset_stub"
"""The ``model_type`` this build records for such a connection.

Recorded rather than read, because there is no config to read it from. It is a
family in the sense that matters to everything downstream — it is what
``capabilities_of`` turns into ``point_suggest``, which is what makes the editor
offer the suggest tool at all.
"""

SQUARE_FRACTION: Final = 6
"""How much of the picture a suggestion covers: one sixth of its shorter edge.

Proportional rather than a pixel count, so the answer is the same shape on a
thumbnail and on a 4K frame. Large enough that a browser can see it and click
it; small enough to sit inside the picture at any sane click.
"""

SCORE: Final = 0.99
"""Confident, so that no caller's ``minimum_confidence`` filters it out.

A stand-in that were sometimes filtered would make a suite's failures depend on
a default somebody is free to change.
"""


class StubSegmenter:
    """Implements the ``PointSegmenter`` port structurally; predicts nothing."""

    def __init__(self, *, connection_name: str) -> None:
        self._connection_name = connection_name

    @property
    def model_ref(self) -> str:
        """What an answer says produced it.

        The real adapters spell this ``model_id@revision``; this keeps the shape
        so that anything rendering or recording a provenance string is exercised
        the same way, and makes plain in the same breath that no model ran.
        """
        return f"{STUB_MODEL_ID}@stub"

    def segment(self, request: PredictionRequest) -> Iterator[AssetSegmentation]:
        """One square per target, centred on the first positive point.

        Raises:
            UnsupportedPrompt: the request asks with words. Refused in the real
                adapter's own vocabulary, because a stand-in whose refusals
                differ from the thing it stands in for would let a client handle
                one and not the other.
        """
        if not isinstance(request.prompt, PointPrompt):
            raise UnsupportedPrompt(
                f"{self.model_ref} answers point prompts; it was asked with "
                f"{request.prompt.kind!r}, which it has no way to interpret"
            )
        # ``positive`` carries ``min_length=1``, so there is always somewhere to
        # centre on and no empty-prompt branch to write. Reading the first one
        # rather than a centroid keeps the answer obvious to a caller checking
        # where its click landed.
        at = request.prompt.positive[0]
        for target in request.targets:
            with Image.open(BytesIO(target.content)) as image:
                size = (image.width, image.height)
            yield AssetSegmentation(
                asset_id=target.asset_id,
                model_ref=self.model_ref,
                segments=(SegmentedMask(mask=_square(size, at=at), score=SCORE),),
            )


def _square(size: tuple[int, int], *, at: tuple[float, float]) -> list[list[bool]]:
    """A filled square around ``at``, clamped to the picture.

    Clamped rather than refused: the route above has already established that
    the point lies on the asset, so the only thing left to handle is a click near
    an edge, where the honest answer is the part of the square that exists.
    """
    width, height = size
    half = max(2, min(width, height) // (SQUARE_FRACTION * 2))
    x, y = int(at[0]), int(at[1])
    left, right = max(0, x - half), min(width, x + half)
    top, bottom = max(0, y - half), min(height, y + half)
    lit = [left <= column < right for column in range(width)]
    dark = [False] * width
    # One list per row and the two row shapes built once: a megapixel of
    # freshly allocated booleans is what the port asks for, and there is no
    # reason for every dark row to be a different object.
    return [lit if top <= row < bottom else dark for row in range(height)]
