# usage: from visionset.inference.nms import suppressed, DEFAULT_IOU_THRESHOLD
"""Cross-box non-maximum suppression, over domain values and nothing else.

**This exists because the measurement said so.** At usable thresholds the primary
failure mode of a raw zero-shot detector is not missing objects but *duplicating*
them: several boxes over one instance, each confident. Handing that to a write
gate would put three labels on one dog and make every count downstream wrong, so
suppression happens before results leave the adapter — for interactive and batch
prediction alike.

**Cross-box, not per-label.** Suppression compares every pair, including two
boxes that answered under different phrases. A prompt of ``("dog", "animal")``
finds the same animal twice and calls it two things; keeping both because the
labels differ would be suppressing nothing at all in exactly the case a caller
most wanted it. The higher-confidence answer wins and the other is dropped,
label and all.

**Pure, and over ``PredictedRegion``.** No torch, no arrays, no model. That is
what lets the rule be tested with three literal boxes instead of a GPU, and it
is why this is a module of its own rather than four lines inside a provider that
cannot be constructed without weights.

Every shape participates, through its extent. A polygon or a polyline is compared
by the axis-aligned box around its points — ``extent_of`` — and a box by itself,
so a text-prompted segmenter that answers many masks from one call is suppressed
exactly as a detector is, and a box and a mask over one object are one answer.
On duplicates of one instance, which is the failure mode this was measured
against, extent IoU is the true IoU; on two thin shapes crossing it is exactly as
wrong as box NMS already is for boxes, and no worse. A shape with no extent — a
degenerate path, a classification tag — passes through untouched, because "I
cannot compare these" must never read as "these were duplicates".
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from visionset.kernel.domain import (
    BboxGeometry,
    Geometry,
    PolygonGeometry,
    PolylineGeometry,
    PredictedRegion,
)

DEFAULT_IOU_THRESHOLD: Final = 0.5
"""Two boxes overlapping by more than this are the same object.

The conventional value, and conventional is the right kind of default here: it is
what the measurements behind this module were read against, and a threshold
picked to flatter one measurement would not survive the second dataset.
Configurable at the provider, because the honest tuning input is on-domain
acceptance data.
"""


def intersection_over_union(one: BboxGeometry, other: BboxGeometry) -> float:
    """How much two boxes overlap, as a fraction of the area they cover together.

    Zero when they do not touch, one when they coincide. Both boxes have
    strictly positive width and height — ``BboxGeometry`` refuses anything else —
    so the union is never zero and there is no degenerate case to guard.
    """
    left = max(one.x, other.x)
    top = max(one.y, other.y)
    right = min(one.x + one.width, other.x + other.width)
    bottom = min(one.y + one.height, other.y + other.height)
    overlap = max(0.0, right - left) * max(0.0, bottom - top)
    if overlap == 0.0:
        return 0.0
    union = one.width * one.height + other.width * other.height - overlap
    return overlap / union


# ponytail: extent IoU; exact polygon IoU when a measurement shows the extent wrong.
def extent_of(geometry: Geometry) -> BboxGeometry | None:
    """The axis-aligned box a shape occupies, or ``None`` for a shape with no area.

    A box is its own extent; a polygon or polyline is the box around its points.
    A zero-width or zero-height path — a vertical polyline — has no box
    ``BboxGeometry`` will construct and answers ``None``, as does a
    classification tag, which occupies nothing.
    """
    if isinstance(geometry, BboxGeometry):
        return geometry
    if not isinstance(geometry, PolygonGeometry | PolylineGeometry):
        return None
    xs = [x for x, _ in geometry.points]
    ys = [y for _, y in geometry.points]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    if width <= 0.0 or height <= 0.0:
        return None
    return BboxGeometry(x=min(xs), y=min(ys), width=width, height=height)


def suppressed(
    regions: Sequence[PredictedRegion], *, iou_threshold: float = DEFAULT_IOU_THRESHOLD
) -> tuple[PredictedRegion, ...]:
    """The regions worth keeping, most confident first.

    Greedy and ordinary: take the most confident answer, drop everything that
    overlaps it beyond ``iou_threshold``, repeat. Ties in confidence are broken
    by the order they arrived, so the result is deterministic for one model's
    output rather than merely stable-looking.

    **The order of the result is the ranking, not the input order.** A caller
    that wants the first N answers wants the N best ones, and a suppression pass
    that returned them shuffled back into detection order would make that
    impossible to get without sorting again.

    ``iou_threshold`` of 1.0 suppresses only exact duplicates, and 0.0 keeps one
    region per overlapping cluster. Neither is refused: both are legitimate
    settings and the second is what a caller asking for whole-scene coverage
    wants.
    """
    ranked = sorted(regions, key=lambda region: -region.confidence)
    kept: list[tuple[PredictedRegion, BboxGeometry | None]] = []
    for region in ranked:
        mine = extent_of(region.geometry)
        if mine is None:
            kept.append((region, mine))
            continue
        if any(
            extent is not None and intersection_over_union(mine, extent) > iou_threshold
            for _, extent in kept
        ):
            continue
        kept.append((region, mine))
    return tuple(region for region, _ in kept)
