"""Cross-box suppression, the rule the Phase 0 measurement asked for.

Measurement found duplicate detections per instance to be the
primary failure mode of raw zero-shot output at usable thresholds — not missed
objects. So this is not a tidiness pass: without it a write gate receives three
labels for one dog and every count downstream is wrong.

Every case here is three literal boxes. That is the whole reason
`visionset/inference/nms.py` is a module of its own rather than four lines inside
a provider nobody can construct without weights.
"""

from __future__ import annotations

from visionset.inference.nms import DEFAULT_IOU_THRESHOLD, intersection_over_union, suppressed
from visionset.kernel.domain import BboxGeometry, ClassificationGeometry, PredictedRegion


def box(x: float, y: float, size: float = 10.0) -> BboxGeometry:
    return BboxGeometry(x=x, y=y, width=size, height=size)


def region(label: str, confidence: float, geometry: object = None) -> PredictedRegion:
    return PredictedRegion(
        label=label,
        confidence=confidence,
        geometry=geometry or box(0, 0),  # type: ignore[arg-type]
    )


# --- the measure --------------------------------------------------------------


def test_identical_boxes_overlap_completely() -> None:
    assert intersection_over_union(box(0, 0), box(0, 0)) == 1.0


def test_disjoint_boxes_do_not_overlap() -> None:
    assert intersection_over_union(box(0, 0), box(100, 100)) == 0.0


def test_touching_edges_are_not_an_overlap() -> None:
    """A box ending where another begins shares a line and no area."""
    assert intersection_over_union(box(0, 0), box(10, 0)) == 0.0


def test_a_half_overlap_is_a_third() -> None:
    """Two 10x10 boxes offset by 5 share 50 and cover 150 between them."""
    assert intersection_over_union(box(0, 0), box(5, 0)) == 50 / 150


# --- the rule -----------------------------------------------------------------


def test_the_most_confident_of_a_cluster_survives() -> None:
    kept = suppressed(
        [region("dog", 0.4), region("dog", 0.9), region("dog", 0.6)],
        iou_threshold=DEFAULT_IOU_THRESHOLD,
    )
    assert [one.confidence for one in kept] == [0.9]


def test_boxes_that_do_not_overlap_all_survive() -> None:
    kept = suppressed(
        [region("dog", 0.9, box(0, 0)), region("dog", 0.8, box(100, 100))],
        iou_threshold=DEFAULT_IOU_THRESHOLD,
    )
    assert len(kept) == 2


def test_suppression_is_cross_label_not_per_label() -> None:
    """The case a per-label pass would get wrong, and the reason it is cross-box.

    A prompt of several phrases finds one animal and calls it two things. Keeping
    both because the labels differ would be suppressing nothing in exactly the
    situation a caller most wanted it.
    """
    kept = suppressed(
        [region("dog", 0.9, box(0, 0)), region("animal", 0.7, box(0, 0))],
        iou_threshold=DEFAULT_IOU_THRESHOLD,
    )
    assert [one.label for one in kept] == ["dog"]


def test_the_result_is_ranked_rather_than_left_in_detection_order() -> None:
    """A caller taking the first N wants the N best ones."""
    kept = suppressed(
        [
            region("a", 0.2, box(0, 0)),
            region("b", 0.9, box(100, 0)),
            region("c", 0.5, box(200, 0)),
        ],
        iou_threshold=DEFAULT_IOU_THRESHOLD,
    )
    assert [one.label for one in kept] == ["b", "c", "a"]


def test_a_threshold_of_one_suppresses_only_exact_duplicates() -> None:
    partly = [region("dog", 0.9, box(0, 0)), region("dog", 0.8, box(5, 0))]
    assert len(suppressed(partly, iou_threshold=1.0)) == 2
    assert len(suppressed(partly, iou_threshold=0.3)) == 1


def test_a_threshold_of_zero_keeps_one_per_touching_cluster() -> None:
    kept = suppressed(
        [region("dog", 0.9, box(0, 0)), region("dog", 0.8, box(9, 0))],
        iou_threshold=0.0,
    )
    assert len(kept) == 1


def test_a_geometry_with_no_cheap_overlap_passes_through() -> None:
    """Not comparable is not the same as duplicate.

    A whole-asset tag has no area, so nothing can be said about whether it
    overlaps anything. Dropping it would make "I cannot compare these" read as
    "these were duplicates", which is the one way a suppression pass can lose
    data rather than tidy it.
    """
    kept = suppressed(
        [
            region("dog", 0.9, box(0, 0)),
            region("indoors", 0.8, ClassificationGeometry()),
            region("outdoors", 0.7, ClassificationGeometry()),
        ],
        iou_threshold=DEFAULT_IOU_THRESHOLD,
    )
    assert [one.label for one in kept] == ["dog", "indoors", "outdoors"]


def test_nothing_in_gives_nothing_out() -> None:
    assert suppressed([], iou_threshold=DEFAULT_IOU_THRESHOLD) == ()


def test_suppression_is_on_by_default() -> None:
    """The threshold is a keyword with a value, so a caller gets it for free.

    An adapter that had to remember to pass one would eventually not, and the
    duplicates would come back on the day nobody was looking at this file.
    """
    assert suppressed([region("dog", 0.9), region("dog", 0.4)]) == suppressed(
        [region("dog", 0.9), region("dog", 0.4)], iou_threshold=DEFAULT_IOU_THRESHOLD
    )
    assert len(suppressed([region("dog", 0.9), region("dog", 0.4)])) == 1
