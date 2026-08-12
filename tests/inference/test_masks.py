"""Mask to geometry: the whole pipeline, driven with literals.

No torch anywhere here, which is the point of ``masks`` being written over plain
sequences: the part of a segmentation adapter that can be wrong about *shape* is
provable on any machine, and the part that needs a GPU is the part that produces
the booleans rather than the part that reads them.

The four steps are tested one at a time and then together, because each of them
can be wrong in a way the next one hides — a hole left open still yields a
plausible outline, and a piece wrongly dropped still yields a plausible polygon
of whatever survived.
"""

from __future__ import annotations

import pytest

from visionset.inference.masks import (
    MINIMUM_FRAGMENT_SHARE,
    MINIMUM_TOLERANCE,
    bbox_from,
    closing_radius,
    components,
    contour,
    filled,
    outline,
    polygon_at,
    shapes_from,
    simplified,
    spans,
)
from visionset.kernel.domain import (
    BboxGeometry,
    Detail,
    Fragments,
    GeometryType,
    PolygonGeometry,
)

POLYGON_ONLY = [GeometryType.POLYGON]
BOX_ONLY = [GeometryType.BBOX]
BOTH = [GeometryType.POLYGON, GeometryType.BBOX]


def disc(radius: int, *, width: int | None = None, height: int | None = None) -> list[list[bool]]:
    """A filled circle: the stand-in for an organic shape, and what the band was written for."""
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


def lit(mask: list[list[bool]]) -> int:
    return sum(sum(1 for cell in row if cell) for row in mask)


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


# --- step 1: which pieces ------------------------------------------------------


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


def islands() -> list[list[int]]:
    """Two solid squares of known area: 25 px on the left, 16 px on the right."""
    mask = [[0] * 24 for _ in range(12)]
    for y in range(2, 7):
        for x in range(1, 6):
            mask[y][x] = 1  # 5x5 = 25
    for y in range(3, 7):
        for x in range(14, 18):
            mask[y][x] = 1  # 4x4 = 16
    return mask


def test_one_piece_is_the_piece_under_the_click() -> None:
    """The first symptom this rule was written for: a shape from somewhere nobody clicked."""
    pieces = components(speckled(), fragments=Fragments.ONE, at=[(3.0, 5.0)])
    assert len(pieces) == 1
    assert (pieces[0].x, pieces[0].y) == (1, 3)
    assert lit(list(pieces[0].mask)) == 36, "the 36-px object, not the 1-px speck"


def test_a_click_just_off_the_piece_falls_back_to_the_nearest_one() -> None:
    """A mask need not cover the exact pixel clicked, and that is not a refusal.

    The fallback is nearest-to-the-point rather than topmost-leftmost: the speck
    is nearer the top of the frame, the object is nearer the click.
    """
    pieces = components(speckled(), at=[(0.0, 5.0)])  # one pixel left of the object
    assert (pieces[0].x, pieces[0].y) == (1, 3)


def test_several_points_spanning_pieces_prefer_the_largest_of_them() -> None:
    """Two positives can straddle two pieces; the bigger one is the better answer."""
    pieces = components(speckled(), at=[(9.0, 0.0), (3.0, 5.0)])
    assert (pieces[0].x, pieces[0].y) == (1, 3), "the 36-px object beats the 1-px speck"


def test_without_a_point_the_topmost_piece_still_wins() -> None:
    """The no-point call is unchanged — nothing outside a point prompt has an opinion."""
    pieces = components(speckled())
    assert (pieces[0].x, pieces[0].y) == (9, 0)


def test_every_piece_is_offered_when_every_piece_was_asked_for() -> None:
    pieces = components(islands(), fragments=Fragments.ALL)
    assert [lit(list(piece.mask)) for piece in pieces] == [25, 16], "biggest first"
    assert [(piece.x, piece.y) for piece in pieces] == [(1, 2), (14, 3)]


def test_a_speck_is_dropped_even_when_every_piece_was_asked_for() -> None:
    """One click must not become a cleanup job.

    The speck is 1 px against a 36-px object — far under the share — so asking
    for everything still answers with the thing that was clicked.
    """
    pieces = components(speckled(), fragments=Fragments.ALL)
    assert len(pieces) == 1
    assert lit(list(pieces[0].mask)) == 36


def test_a_piece_is_kept_when_it_clears_the_share() -> None:
    """The other side of the same rule, so the threshold is not merely "drop small things"."""
    assert 25 * MINIMUM_FRAGMENT_SHARE <= 16
    assert len(components(islands(), fragments=Fragments.ALL)) == 2


def test_an_empty_mask_has_no_pieces() -> None:
    assert components(empty(), at=[(5.0, 5.0)]) == []
    assert components(empty(), fragments=Fragments.ALL) == []


# --- step 2: closing the gaps --------------------------------------------------


def notched(depth: int, size: int = 13) -> list[list[bool]]:
    """A solid square with a one-row bite ``depth`` pixels deep, cut in from the right."""
    mask = [[True] * size for _ in range(size)]
    for x in range(size - depth, size):
        mask[size // 2][x] = False
    return mask


def test_a_narrow_notch_is_closed_and_the_outline_gets_simpler() -> None:
    """The gap that actually shows, and the reason this step is a close.

    A segmenter bites small notches out of an edge, and every one of them is a
    detour the traced boundary has to make. Closing bridges them, and the contour
    comes back the shape somebody meant.
    """
    mask = notched(2)
    after = filled(mask, fill_holes=0.05)
    assert lit([list(row) for row in after]) > lit(mask)
    assert len(contour(after)) < len(contour(mask))


def test_a_bay_wider_than_the_reach_is_kept() -> None:
    """Concavity at that scale is shape rather than noise, and it survives untouched."""
    mask = notched(2, size=13)
    for y in (5, 6, 7):
        for x in (10, 11, 12):
            mask[y][x] = False
    assert filled(mask, fill_holes=0.05) is mask


def test_closing_never_moves_the_extent() -> None:
    """Why `fill_holes` is declared for a polygon and not for a box.

    A close only ever adds pixels whose whole neighbourhood was already reachable,
    so it cannot push an edge outward. The applicability table says the same
    thing; this is the behaviour under it.
    """
    mask = notched(2)
    assert bbox_from(filled(mask, fill_holes=0.05)) == bbox_from(mask)


def test_the_reach_scales_with_the_piece_rather_than_the_frame() -> None:
    """One setting, every size — the property an absolute pixel count cannot have."""
    small = closing_radius(rect(0, 0, 39, 39, width=40, height=40), fill_holes=0.002)
    large = closing_radius(rect(0, 0, 199, 199, width=200, height=200), fill_holes=0.002)
    assert small < large


def test_closing_nothing_is_a_request_the_pipeline_honours() -> None:
    """A mask of foliage is mostly gaps and every one of them is real."""
    mask = notched(2)
    assert filled(mask, fill_holes=0.0) is mask
    assert closing_radius(mask, fill_holes=0.0) == 0


def test_an_enclosed_hole_is_closed_in_the_mask_and_invisible_in_the_shape() -> None:
    """Both halves of the finding, written down where somebody will meet it again.

    A close does fill a small enclosed hole. What it cannot do is change the
    answer, because boundary tracing walks the *outer* ring and a polygon is one
    ring with no interior. This is why the step is a close rather than the flood
    fill of enclosed regions it was first written as: that version moved 336 lit
    pixels to 400 and left the traced outline byte-identical.
    """
    piece = components(holed(2))[0]
    after = filled(piece.mask, fill_holes=0.02)
    assert lit(list(piece.mask)) == 400 - 4
    assert lit([list(row) for row in after]) == 400
    assert outline(piece.mask) == outline(after), "the hole was never on the outer ring"


def holed(hole: int) -> list[list[bool]]:
    """A 20x20 square with a centred square hole ``hole`` pixels on a side."""
    low = 10 - hole // 2
    return [
        [
            5 <= x <= 24
            and 5 <= y <= 24
            and not (low <= x - 5 < low + hole and low <= y - 5 < low + hole)
            for x in range(40)
        ]
        for y in range(40)
    ]


# --- step 3: the canonical contour ---------------------------------------------


def test_the_outline_closes_on_itself() -> None:
    traced = outline(rect(10, 10, 20, 20))
    assert traced[0] == (10.0, 10.0)
    assert len(traced) == 40  # the perimeter of an 11x11 square, corners counted once
    assert len(set(traced)) == len(traced), "no pixel is walked twice"


def test_an_isolated_pixel_has_no_ring_to_walk() -> None:
    assert outline(rect(3, 3, 3, 3)) == [(3.0, 3.0)]


def test_the_contour_is_the_trace_already_reduced_at_the_floor() -> None:
    """The definition, asserted as a definition rather than described.

    Douglas-Peucker is not nested, so the editor and this module can only be
    proved to agree when both start from the same points. That makes the
    half-pixel reduction part of what a contour *is*.
    """
    mask = rect(10, 10, 20, 20)
    assert contour(mask) == simplified(outline(mask), tolerance=MINIMUM_TOLERANCE)


def test_the_floor_costs_a_square_none_of_its_corners() -> None:
    """It throws away staircase, not shape: 40 traced pixels, 4 corners plus the seam."""
    assert len(outline(rect(10, 10, 20, 20))) == 40
    assert len(contour(rect(10, 10, 20, 20))) == 5


def test_an_empty_mask_has_no_contour() -> None:
    assert contour(empty()) == []


# --- step 4: simplification ----------------------------------------------------


def test_simplification_keeps_the_corners_and_drops_the_straight_runs() -> None:
    line = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0), (3.0, 1.0)]
    assert simplified(line, tolerance=0.5) == [(0.0, 0.0), (3.0, 0.0), (3.0, 1.0)]


def test_a_bigger_tolerance_keeps_less() -> None:
    bumpy = [(float(x), 1.0 if x % 2 else 0.0) for x in range(20)]
    assert len(simplified(bumpy, tolerance=0.1)) > len(simplified(bumpy, tolerance=2.0))


def test_a_contour_too_thin_to_be_a_polygon_is_refused() -> None:
    """Two points are a line. The domain wants three, and a caller wants a shape worth accepting."""
    assert polygon_at([(0.0, 0.0), (1.0, 0.0)]) is None
    assert polygon_at([]) is None


@pytest.mark.parametrize("radius", [8, 15, 30, 60, 120, 300])
def test_a_typical_object_lands_in_the_ten_to_forty_vertex_band(radius: int) -> None:
    """The range, and the property that says the tolerance is relative rather than absolute.

    The same detail setting has to work on a thing eight pixels across and a
    thing six hundred across, which an absolute pixel tolerance cannot do: three
    pixels is nothing on a car and is the whole of a bottle cap. Asserting the
    band across a 37x size range is what would fail if the tolerance stopped
    scaling with the region.
    """
    polygon = polygon_at(contour(disc(radius)))
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
    polygon = polygon_at(contour(rect(10, 10, 60, 60)))
    assert polygon is not None
    assert polygon.points == [(10.0, 10.0), (60.0, 10.0), (60.0, 60.0), (10.0, 60.0)]


@pytest.mark.parametrize("radius", [30, 60, 120])
def test_the_three_steps_are_ordered_and_tell_each_other_apart(radius: int) -> None:
    """Finer keeps more than balanced, which keeps more than coarse.

    Strictly, at every size in the band: three settings that collapsed onto two
    at some scale would be a control with a dead position.
    """
    traced = contour(disc(radius))
    counts = [
        len(polygon_at(traced, detail=step).points)  # type: ignore[union-attr]
        for step in (Detail.COARSE, Detail.BALANCED, Detail.FINE)
    ]
    assert counts[0] < counts[1] < counts[2], counts


# --- the whole pipeline, and the kinds a class admits --------------------------


def test_a_polygon_stands_where_polygons_are_allowed() -> None:
    shaped = shapes_from(speckled(), allowed=BOTH, at=[(3.0, 5.0)])
    assert len(shaped) == 1
    assert shaped[0].geometry == PolygonGeometry(
        points=[(1.0, 3.0), (6.0, 3.0), (6.0, 8.0), (1.0, 8.0)]
    )


def test_a_polygon_carries_the_contour_it_was_reduced_from() -> None:
    """What lets the editor re-simplify without asking again."""
    shaped = shapes_from(speckled(), allowed=POLYGON_ONLY, at=[(3.0, 5.0)])
    assert shaped[0].contour == tuple(contour_in_asset())


def contour_in_asset() -> list[tuple[float, float]]:
    piece = components(speckled(), at=[(3.0, 5.0)])[0]
    return [(x + piece.x, y + piece.y) for x, y in contour(piece.mask)]


def test_a_box_class_gets_the_extent_and_not_a_reduced_outlines_corners() -> None:
    """The branch after hole filling, which is what keeps `detail` off a box."""
    shaped = shapes_from(speckled(), allowed=BOX_ONLY, at=[(3.0, 5.0)])
    assert len(shaped) == 1
    assert shaped[0].geometry == BboxGeometry(x=1.0, y=3.0, width=6.0, height=6.0)
    assert shaped[0].contour == (), "there is nothing for a client to re-derive"


@pytest.mark.parametrize("step", list(Detail), ids=lambda d: d.value)
def test_a_box_does_not_move_when_detail_does(step: Detail) -> None:
    """ "Applies to polygon only", asserted as behaviour rather than as a table row."""
    shaped = shapes_from(disc(40), allowed=BOX_ONLY, detail=step)
    assert shaped[0].geometry == shapes_from(disc(40), allowed=BOX_ONLY)[0].geometry


def test_a_class_admitting_neither_is_offered_nothing() -> None:
    """The gesture is not offered for a tag-only class at all."""
    assert shapes_from(speckled(), allowed=[GeometryType.CLASSIFICATION_TAG]) == []


def test_a_piece_too_thin_to_be_a_polygon_is_dropped_rather_than_demoted() -> None:
    """Nothing is ever widened, and nothing is answered in a kind nobody asked for."""
    assert shapes_from(rect(10, 10, 11, 10), allowed=BOTH) == []


def test_every_island_becomes_its_own_shape() -> None:
    shaped = shapes_from(islands(), allowed=POLYGON_ONLY, fragments=Fragments.ALL)
    assert len(shaped) == 2
    assert [s.geometry.type for s in shaped] == [GeometryType.POLYGON, GeometryType.POLYGON]


def test_one_fragment_is_still_the_default() -> None:
    assert len(shapes_from(islands(), allowed=POLYGON_ONLY, at=[(3.0, 4.0)])) == 1


def test_closing_a_notch_reaches_the_polygon_and_leaves_the_box_alone() -> None:
    """Both halves at once, because each is how the other's mistake stays hidden."""
    ragged = shapes_from(notched(2, size=41), allowed=POLYGON_ONLY, fill_holes=0.0)
    smoothed = shapes_from(notched(2, size=41), allowed=POLYGON_ONLY, fill_holes=0.005)
    assert len(ragged[0].contour) > len(smoothed[0].contour)
    assert (
        shapes_from(notched(2, size=41), allowed=BOX_ONLY, fill_holes=0.005)[0].geometry
        == shapes_from(notched(2, size=41), allowed=BOX_ONLY, fill_holes=0.0)[0].geometry
    )


def test_a_mask_with_nothing_in_it_proposes_nothing() -> None:
    assert shapes_from(empty(), allowed=BOTH, at=[(5.0, 5.0)]) == []
