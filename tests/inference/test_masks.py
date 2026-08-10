"""Mask to geometry: the conversion D3 lives in, driven with literals.

No torch anywhere here, which is the point of ``masks`` being written over plain
sequences: the part of a segmentation adapter that can be wrong about *shape* is
provable on any machine, and the part that needs a GPU is the part that produces
the booleans rather than the part that reads them.
"""

from __future__ import annotations

import pytest

from visionset.inference.masks import (
    DEFAULT_DETAIL,
    bbox_from,
    bounds_of,
    narrowed,
    outline,
    polygon_from,
    simplified,
    spans,
)
from visionset.kernel.domain import BboxGeometry, GeometryType, PolygonGeometry


def disc(radius: int, *, width: int | None = None, height: int | None = None) -> list[list[bool]]:
    """A filled circle: the stand-in for an organic shape, and what D3's band was written for."""
    width = width or 2 * radius + 8
    height = height or 2 * radius + 8
    cx, cy = width // 2, height // 2
    return [
        [(x - cx) ** 2 + (y - cy) ** 2 <= radius * radius for x in range(width)]
        for y in range(height)
    ]


def rect(
    x0: int, y0: int, x1: int, y1: int, *, width: int = 100, height: int = 100
) -> list[list[bool]]:
    return [[x0 <= x <= x1 and y0 <= y <= y1 for x in range(width)] for y in range(height)]


def empty(size: int = 10) -> list[list[bool]]:
    return [[False] * size for _ in range(size)]


# --- the extent ---------------------------------------------------------------


def test_a_box_is_the_pixels_outer_edge() -> None:
    """Inclusive of the last lit pixel, so a 30-wide run is 30 wide and not 29."""
    assert bbox_from(rect(10, 20, 39, 49)) == BboxGeometry(x=10.0, y=20.0, width=30.0, height=30.0)


def test_one_lit_pixel_is_a_box_one_unit_across() -> None:
    """Not zero-area: the domain refuses that, and one pixel is a real thing to point at."""
    assert bbox_from(rect(5, 5, 5, 5)) == BboxGeometry(x=5.0, y=5.0, width=1.0, height=1.0)


def test_an_empty_mask_has_no_box() -> None:
    """A click on sky is an ordinary thing to do, and None is what it answers."""
    assert bbox_from(empty()) is None
    assert spans(empty()) == []


# --- the outline --------------------------------------------------------------


def test_the_outline_closes_on_itself() -> None:
    traced = outline(rect(10, 10, 20, 20))
    assert traced[0] == (10.0, 10.0)
    assert len(traced) == 40  # the perimeter of an 11x11 square, corners counted once
    assert len(set(traced)) == len(traced), "no pixel is walked twice"


def test_an_isolated_pixel_has_no_ring_to_walk() -> None:
    assert outline(rect(3, 3, 3, 3)) == [(3.0, 3.0)]


# --- which blob, when the mask holds more than one ----------------------------


def speckled() -> list[list[int]]:
    """The repro: a 1-px speck in the topmost row, a 36-px object below-left.

    The speck owns the topmost-leftmost lit pixel, which is where the tracer
    starts from when nothing points it anywhere — so a click on the object used
    to lose to a single stray pixel.
    """
    mask = [[0] * 10 for _ in range(10)]
    mask[0][9] = 1  # 1-px speck, topmost row
    for y in range(3, 9):
        for x in range(1, 7):
            mask[y][x] = 1  # the real object, 36 px
    return mask


def test_the_blob_under_the_click_wins_over_a_speck() -> None:
    """The first symptom: a shape returned from somewhere the user did not click."""
    traced = outline(speckled(), at=[(3.0, 5.0)])
    assert (9.0, 0.0) not in traced, "the speck is not the answer to a click on the object"
    assert traced[0] == (1.0, 3.0), "tracing starts at the clicked blob's own top-left"
    assert len(traced) == 20  # the perimeter of the 6x6 object, corners counted once


def test_a_real_segmentation_is_not_reported_as_nothing() -> None:
    """The second symptom, and the one that reads as "the model found nothing".

    The speck traces to a single point, three are needed for a polygon, so the
    whole suggestion was dropped while a 36-px object sat under the click.
    """
    assert polygon_from(speckled(), at=[(3.0, 5.0)]) == PolygonGeometry(
        points=[(1.0, 3.0), (6.0, 3.0), (6.0, 8.0), (1.0, 8.0)]
    )


def test_a_click_just_off_the_blob_falls_back_to_the_nearest_one() -> None:
    """A mask need not cover the exact pixel clicked, and that is not a refusal.

    The fallback is nearest-to-the-point rather than topmost-leftmost: the speck
    is nearer the top of the frame, the object is nearer the click.
    """
    traced = outline(speckled(), at=[(0.0, 5.0)])  # one pixel left of the object
    assert traced[0] == (1.0, 3.0)
    assert (9.0, 0.0) not in traced


def test_several_points_spanning_blobs_prefer_the_largest_of_them() -> None:
    """Two positives can straddle two blobs; the bigger one is the better answer."""
    traced = outline(speckled(), at=[(9.0, 0.0), (3.0, 5.0)])  # on the speck and on the object
    assert traced[0] == (1.0, 3.0), "the 36-px object beats the 1-px speck"


def test_without_a_point_the_topmost_blob_still_wins() -> None:
    """The no-point call is unchanged — nothing outside a point prompt has an opinion."""
    assert outline(speckled()) == [(9.0, 0.0)]


def test_a_genuinely_empty_mask_is_still_nothing() -> None:
    """Zero lit pixels stays exactly as it was: the contract's documented "no suggestion"."""
    assert outline(empty(), at=[(5.0, 5.0)]) == []
    assert polygon_from(empty(), at=[(5.0, 5.0)]) is None


# --- simplification -----------------------------------------------------------


def test_simplification_keeps_the_corners_and_drops_the_straight_runs() -> None:
    line = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0), (3.0, 1.0)]
    assert simplified(line, tolerance=0.5) == [(0.0, 0.0), (3.0, 0.0), (3.0, 1.0)]


def test_a_bigger_tolerance_keeps_less() -> None:
    bumpy = [(float(x), 1.0 if x % 2 else 0.0) for x in range(20)]
    assert len(simplified(bumpy, tolerance=0.1)) > len(simplified(bumpy, tolerance=2.0))


# --- D3's vertex band ---------------------------------------------------------


@pytest.mark.parametrize("radius", [8, 15, 30, 60, 120, 300])
def test_a_typical_object_lands_in_the_ten_to_forty_vertex_band(radius: int) -> None:
    """D3's range, and the property that says the tolerance is relative rather than absolute.

    The same detail setting has to work on a thing eight pixels across and a
    thing six hundred across, which an absolute pixel tolerance cannot do: three
    pixels is nothing on a car and is the whole of a bottle cap. Asserting the
    band across a 37x size range is what would fail if the tolerance stopped
    scaling with the region.
    """
    polygon = polygon_from(disc(radius))
    assert polygon is not None
    assert 10 <= len(polygon.points) <= 40


def test_a_rectangle_comes_back_as_exactly_its_corners() -> None:
    """The closing artifact, pinned.

    Douglas-Peucker pins the last point of what it is given, and what it is given
    is a ring cut open at an arbitrary pixel — so the final vertex is pinned for
    a reason that stops being true once the ring closes, landing one pixel from
    the first. This asserts the near-duplicate is gone, which an equality check
    on first-versus-last would never catch, because it is not a duplicate.
    """
    polygon = polygon_from(rect(10, 10, 60, 60))
    assert polygon is not None
    assert polygon.points == [(10.0, 10.0), (60.0, 10.0), (60.0, 60.0), (10.0, 60.0)]


def test_a_shape_too_thin_to_be_a_polygon_is_refused() -> None:
    """Two points are a line. The domain wants three, and a caller wants a shape worth accepting."""
    assert polygon_from(rect(10, 10, 11, 10)) is None
    assert polygon_from(empty()) is None


def test_more_detail_means_more_vertices() -> None:
    fine = polygon_from(disc(60), detail=DEFAULT_DETAIL / 4)
    coarse = polygon_from(disc(60), detail=DEFAULT_DETAIL * 4)
    assert fine is not None and coarse is not None
    assert len(fine.points) > len(coarse.points)


# --- narrowing to what the class admits (D3) -----------------------------------


def test_a_polygon_stands_where_polygons_are_allowed() -> None:
    polygon = PolygonGeometry(points=[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)])
    assert narrowed(polygon, allowed=[GeometryType.POLYGON, GeometryType.BBOX]) is polygon


def test_a_polygon_becomes_its_own_box_where_only_boxes_are_allowed() -> None:
    """The D3 fallback, and the assertion the mutation test in the PR body breaks."""
    polygon = PolygonGeometry(points=[(2.0, 3.0), (12.0, 3.0), (12.0, 9.0), (2.0, 9.0)])
    assert narrowed(polygon, allowed=[GeometryType.BBOX]) == BboxGeometry(
        x=2.0, y=3.0, width=10.0, height=6.0
    )


def test_a_class_admitting_neither_is_offered_nothing() -> None:
    """D3's third case: the gesture is not offered for a tag-only class at all."""
    polygon = PolygonGeometry(points=[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)])
    assert narrowed(polygon, allowed=[GeometryType.CLASSIFICATION_TAG]) is None


def test_a_box_is_never_widened_into_a_polygon() -> None:
    """Narrowing only ever loses information. A box cannot become the outline it never held."""
    box = BboxGeometry(x=0.0, y=0.0, width=4.0, height=4.0)
    assert narrowed(box, allowed=[GeometryType.POLYGON]) is None
    assert narrowed(box, allowed=[GeometryType.BBOX]) is box


def test_a_flat_outline_still_yields_a_storable_box() -> None:
    """Zero height is widened rather than refused — the domain will not store a degenerate box."""
    assert bounds_of([(0.0, 5.0), (9.0, 5.0)]) == BboxGeometry(x=0.0, y=5.0, width=9.0, height=1.0)
