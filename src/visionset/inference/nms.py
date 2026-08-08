# usage: from visionset.inference.nms import suppressed, DEFAULT_IOU_THRESHOLD
"""Cross-box non-maximum suppression, over domain values and nothing else.

**This exists because the measurement said so.** The Phase 0 spike recorded on
#418 found that at usable thresholds the primary failure mode of a raw
zero-shot detector is not missing objects but *duplicating* them: several boxes
over one instance, each confident. Handing that to a write gate would put three
labels on one dog and make every count downstream wrong, so suppression happens
before results leave the adapter — which is also #425's fourth settled
responsibility, stated there for the batch mode and satisfied here for both.

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

Only :class:`~visionset.kernel.domain.BboxGeometry` participates. A polygon or a
polyline has no cheap IoU and no evidence that it needs one — the duplication
this was measured against is a detector's, and a mask-producing model is
prompted per instance. Anything that is not a box passes through untouched
rather than being silently dropped, because "I do not know how to compare these"
must never read as "these were duplicates".
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from visionset.kernel.domain import BboxGeometry, PredictedRegion

DEFAULT_IOU_THRESHOLD: Final = 0.5
"""Two boxes overlapping by more than this are the same object.

The conventional value, and conventional is the right kind of default here: it
is what the numbers the spike reported were read against, and a threshold picked
to flatter one measurement would not survive the second dataset. Configurable at
the provider, because the honest tuning input is on-domain acceptance data — the
signal the interactive mode is sequenced first to produce (`cf. #418`).
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
    kept: list[PredictedRegion] = []
    for region in ranked:
        if not isinstance(region.geometry, BboxGeometry):
            kept.append(region)
            continue
        if any(
            isinstance(other.geometry, BboxGeometry)
            and intersection_over_union(region.geometry, other.geometry) > iou_threshold
            for other in kept
        ):
            continue
        kept.append(region)
    return tuple(kept)
