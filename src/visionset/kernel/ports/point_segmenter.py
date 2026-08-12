# usage: from visionset.kernel.ports import PointSegmenter
"""Asking a model what is under a point, and getting pixels back.

The sibling of ``ModelProvider`` and deliberately not a widening of it. That port
answers in geometry, which is right for a detector — a box it drew has no mask
behind it — and wrong for a segmenter, because it forces the adapter to decide
how a mask becomes a shape. Those decisions are a product's, they are the ones a
person adjusts, and an adapter is the one place a caller cannot reach them from.

So this port stops at the mask. Which pieces of it to keep, whether to fill the
holes inside them, how much of the outline to keep — all of that happens above
this line, once, for every segmenter that will ever exist here. **A parameter of
that pipeline never travels through this port**, which is what makes a second
segmenter a drop-in rather than a second copy of the same choices.

The same dual test applies as to ``ModelProvider``: every element of this shape
must hold for a runner in this process and for a service across a network, which
is why the request is per batch, the answer is an iterator, and the mask is
plain rows of booleans rather than anything an array library would name.
``tests/architecture/test_model_provider_port.py`` checks the mechanical half for
both ports.

A model that answers words rather than places is not asked a harder question here
— it is asked a different one — so it refuses with ``UnsupportedPrompt`` rather
than approximating.
"""

from collections.abc import Iterator
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import AssetSegmentation, PredictionRequest


@runtime_checkable
class PointSegmenter(Protocol):
    """Something that can be asked what sits under a set of points."""

    def segment(self, request: PredictionRequest) -> Iterator[AssetSegmentation]:
        """Answer for each target in the request, in whatever order they finish.

        Exactly one answer per target, and never more: a target that produced
        nothing answers with an empty ``segments`` tuple, on ``predict``'s rule
        that "found nothing" and "was not looked at" must stay distinguishable.

        Raises:
            VisionSetError: the segmenter cannot serve this request — a prompt
                kind it does not take, a model that is not present, a service
                that refused. It **must** raise from this tree rather than
                letting an implementation library's own exception out.
        """
        ...
