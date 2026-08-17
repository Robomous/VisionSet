# usage: from visionset.kernel.domain import AssetSegmentation, SegmentedMask
"""What a segmenter actually answers with, before anybody decides what it means.

A model asked *what is under this point* answers with a grid of booleans and a
number saying how sure it is. Everything after that — which of the grid's
separate pieces to keep, whether to close the holes inside them, how much of the
traced outline survives — is a product decision, and none of it is the model's to
make. So this is the shape the boundary carries, and the pipeline that turns it
into a polygon or a box sits on our side of it.

**Why this exists beside ``PredictedRegion`` rather than replacing it.** A
detector genuinely answers in boxes: there is no mask behind a box it drew, so
making masks the universal answer would oblige every detector to invent one.
A segmenter genuinely answers in masks, and making geometry the universal answer
obliged *it* to decide the questions above, in an adapter, where no caller could
reach them. Two answers, because there are two kinds of question.

**A dataclass, not a pydantic model, and the reason is the size.** Every other
model in this domain is a frozen ``BaseModel`` whose validation is cheap because
its fields are scalars. A full-resolution mask is a megapixel of booleans;
handing one to pydantic means walking and re-allocating every element of it on a
path that runs while somebody is waiting for a click. The frozen dataclass in
``capabilities.py`` is the precedent for the spelling, and the range on
``score`` is a documented contract rather than a validated one — it never
reaches a caller unchecked, because the pipeline turns it into a
``PredictedRegion``, whose ``confidence`` *is* validated.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

type Mask = Sequence[Sequence[int]]
"""Rows of columns, ``mask[y][x]``, where a lit pixel is truthy.

The orientation every image library agrees on, in the asset's own pixels and at
the asset's own size — never normalized and never at a preview's scale, on the
rule every geometry in this domain follows.

**A row is ``bytes`` in production and a list of booleans in a test, and the
element type says ``int`` so that both are the same type rather than one being a
cast.** ``bool`` is a subclass of ``int`` and ``Sequence`` is covariant, so a
literal grid still satisfies this; ``bytes`` is a ``Sequence[int]`` and satisfies
it too. Nothing widened to accommodate the numeric stack — ``bytes`` is a
builtin, and what crosses is a buffer of noughts and ones rather than an array
carrying a library's semantics.

The reason it is worth spelling this way: the pipeline above never reads a pixel
in Python. It scans rows with ``index``, which on ``bytes`` is ``memchr``. So the
narrowest useful contract is *something with a length and a fast scan*, and
asking for booleans in particular obliged an adapter to box a megapixel of them
to say what a buffer already said.
"""


@dataclass(frozen=True, slots=True)
class SegmentedMask:
    """One thing a segmenter claims to have found, as pixels rather than as a shape.

    ``score`` is the model's own confidence, in ``[0.0, 1.0]``. It travels
    unchanged onto the region the pipeline builds, because it is a statement
    about the mask and the pipeline does not make the mask more or less likely to
    be right.
    """

    mask: Mask
    score: float


@dataclass(frozen=True, slots=True)
class AssetSegmentation:
    """Everything a segmenter found on one image, and which model found it.

    ``model_ref`` is on the answer rather than on the response as a whole for
    ``AssetPrediction``'s reason: these arrive one at a time, and an answer that
    could not say what produced it would be a provenance with a footnote.

    An empty ``segments`` is a real answer — a click on empty sky — and not a
    failure. "Found nothing" and "was not looked at" stay different facts.
    """

    asset_id: UUID
    model_ref: str
    segments: tuple[SegmentedMask, ...] = ()
