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
