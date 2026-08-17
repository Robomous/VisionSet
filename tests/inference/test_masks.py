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

from visionset.inference import masks
from visionset.inference.masks import (
    MAXIMUM_CLOSING_RADIUS,
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
    pieces = components(speckled(), at=[(3.0, 5.0)])
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


def test_without_a_point_the_noise_filter_still_answers_with_the_object() -> None:
    """Nothing outside a point prompt has an opinion — but the speck is gone first.

    The topmost-leftmost rule only ever ran over pieces that survived, and a 1-px
    speck against a 36-px object does not. What used to need a click to beat the
    speck no longer needs one (#557).
    """
    pieces = components(speckled())
    assert len(pieces) == 1
    assert (pieces[0].x, pieces[0].y) == (1, 3)


def test_every_surviving_piece_comes_back_biggest_first_behind_the_pointed_at_one() -> None:
    pieces = components(islands())
    assert [lit(list(piece.mask)) for piece in pieces] == [25, 16], "biggest first"
    assert [(piece.x, piece.y) for piece in pieces] == [(1, 2), (14, 3)]


def test_the_piece_under_the_click_leads_even_when_it_is_not_the_biggest() -> None:
    """The ordering the two geometries both read: head for a polygon, all of it for a box."""
    pieces = components(islands(), at=[(15.0, 4.0)])
    assert [lit(list(piece.mask)) for piece in pieces] == [16, 25]


def test_a_speck_is_dropped_before_anything_else_looks_at_the_mask() -> None:
    """One click must not become a cleanup job.

    The speck is 1 px against a 36-px object — far under the share — so it never
    reaches a shape, whichever geometry asked.
    """
    pieces = components(speckled())
    assert len(pieces) == 1
    assert lit(list(pieces[0].mask)) == 36


def test_a_piece_is_kept_when_it_clears_the_share() -> None:
    """The other side of the same rule, so the threshold is not merely "drop small things"."""
    assert 25 * MINIMUM_FRAGMENT_SHARE <= 16
    assert len(components(islands())) == 2


def test_an_empty_mask_has_no_pieces() -> None:
    assert components(empty(), at=[(5.0, 5.0)]) == []
    assert components(empty()) == []


# --- step 2: closing the gaps --------------------------------------------------


def notched(depth: int, size: int = 64) -> list[list[bool]]:
    """A solid square with a one-row bite ``depth`` pixels deep, cut in from the right.

    64 on a side by default, because the reach is a share of the piece's own area
    and a 13-px square is under the floor where it works out at nothing.
    """
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
    after = filled(mask)
    assert lit([list(row) for row in after]) > lit(mask)
    assert len(contour(after)) < len(contour(mask))


def test_a_bay_wider_than_the_reach_is_kept() -> None:
    """Concavity at that scale is shape rather than noise, and it survives untouched."""
    mask = [[True] * 64 for _ in range(64)]
    for y in range(28, 36):
        for x in range(56, 64):
            mask[y][x] = False
    assert filled(mask) is mask


def test_closing_never_moves_the_extent() -> None:
    """Why the close is declared for a polygon and does nothing to a box.

    A close only ever adds pixels whose whole neighbourhood was already reachable,
    so it cannot push an edge outward. The applicability table says the same
    thing; this is the behaviour under it.
    """
    mask = notched(2)
    assert bbox_from(filled(mask)) == bbox_from(mask)


def test_the_reach_scales_with_the_piece_rather_than_the_frame() -> None:
    """One default, every size — the property an absolute pixel count cannot have."""
    small = closing_radius(rect(0, 0, 63, 63, width=64, height=64))
    large = closing_radius(rect(0, 0, 199, 199, width=200, height=200))
    assert small < large


def test_the_reach_stops_at_the_cap_however_large_the_piece() -> None:
    """A gap wider than a few pixels is shape, and the pass costs a step per unit.

    Uncapped this worked out at 22 on a 4K frame — 44 bitset passes on the path
    somebody is waiting on after a click, to bridge gaps that were never there.
    """
    huge = closing_radius(rect(0, 0, 799, 799, width=800, height=800))
    assert huge == MAXIMUM_CLOSING_RADIUS


def test_a_piece_too_small_to_have_artefacts_is_closed_not_at_all() -> None:
    """Rounded down, so the smallest shapes keep every feature they have."""
    tiny = rect(0, 0, 11, 11, width=12, height=12)
    assert closing_radius(tiny) == 0
    assert filled(tiny) is tiny


def test_an_enclosed_hole_is_closed_in_the_mask_and_invisible_in_the_shape() -> None:
    """Both halves of the finding, written down where somebody will meet it again.

    A close does fill a small enclosed hole. What it cannot do is change the
    answer, because boundary tracing walks the *outer* ring and a polygon is one
    ring with no interior. This is why the step is a close rather than the flood
    fill of enclosed regions it was first written as: that version moved 336 lit
    pixels to 400 and left the traced outline byte-identical.
    """
    piece = components(holed(2))[0]
    after = filled(piece.mask)
    assert lit(list(piece.mask)) == 64 * 64 - 4
    assert lit([list(row) for row in after]) == 64 * 64
    assert outline(piece.mask) == outline(after), "the hole was never on the outer ring"


def holed(hole: int) -> list[list[bool]]:
    """A 64x64 square with a centred square hole ``hole`` pixels on a side.

    64 rather than 20 for :func:`notched`'s reason: the reach is a share of the
    piece's area, so a small square is under the floor where it reaches nothing.
    """
    low = 32 - hole // 2
    return [
        [
            5 <= x <= 68
            and 5 <= y <= 68
            and not (low <= x - 5 < low + hole and low <= y - 5 < low + hole)
            for x in range(80)
        ]
        for y in range(80)
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


def test_a_polygon_is_the_piece_that_was_clicked_and_only_that_piece() -> None:
    """A click asks about one object, so a polygon class gets one outline."""
    shaped = shapes_from(islands(), allowed=POLYGON_ONLY, at=[(3.0, 4.0)])
    assert len(shaped) == 1
    assert shaped[0].geometry.type is GeometryType.POLYGON


def test_a_box_is_one_union_over_every_surviving_piece() -> None:
    """Decision 4: an occluded object is one thing, however many pieces it arrives in.

    `islands()` is 25 px at (1,2) and 16 px at (14,3) — a railing's worth apart.
    Largest-only would cut the object off at the occlusion; a box per piece would
    annotate it twice. One box covers both.
    """
    shaped = shapes_from(islands(), allowed=BOX_ONLY, at=[(3.0, 4.0)])
    assert len(shaped) == 1
    assert shaped[0].geometry == BboxGeometry(x=1.0, y=2.0, width=17.0, height=5.0)


def test_the_union_leaves_out_the_specks_the_noise_filter_dropped() -> None:
    """The other half of the same rule: a union of everything would follow speckle.

    `speckled()` is a 36-px object at (1,3) and a 1-px speck at (9,0). The speck
    is under the share, so the box stops at the object rather than stretching to
    the corner of the frame.
    """
    shaped = shapes_from(speckled(), allowed=BOX_ONLY, at=[(3.0, 5.0)])
    assert shaped[0].geometry == BboxGeometry(x=1.0, y=3.0, width=6.0, height=6.0)


def test_a_box_never_pays_for_the_close_at_all(monkeypatch: pytest.MonkeyPatch) -> None:
    """A performance rule with no behavioural signature, so it is asserted structurally.

    A close only ever adds pixels whose neighbourhood was already reachable, so
    it cannot move an extent — which is exactly why skipping it for a box is safe
    and exactly why no assertion about the *box* could ever notice the skip. So
    the assertion is that the step is not reached: at 4K it was twelve bitset
    passes per click, thrown away (#557).
    """
    monkeypatch.setattr(masks, "filled", lambda mask: pytest.fail("a box class ran the close"))
    shaped = shapes_from(islands(), allowed=BOX_ONLY, at=[(3.0, 4.0)])

    assert shaped[0].geometry == BboxGeometry(x=1.0, y=2.0, width=17.0, height=5.0)


def test_closing_a_notch_reaches_the_polygon_and_leaves_the_box_alone() -> None:
    """Both halves at once, because each is how the other's mistake stays hidden.

    The reach is fixed now, so the comparison is against a piece small enough to
    fall under it rather than against a setting of zero.
    """
    ragged = shapes_from(notched(2, size=40), allowed=POLYGON_ONLY)
    smoothed = shapes_from(notched(2, size=64), allowed=POLYGON_ONLY)
    assert closing_radius(notched(2, size=40)) == 0, "under the reach: nothing bridged"
    assert closing_radius(notched(2, size=64)) >= 1, "over it: the notch is bridged"
    assert len(ragged[0].contour) > len(smoothed[0].contour)
    assert shapes_from(notched(2, size=64), allowed=BOX_ONLY)[0].geometry == shapes_from(
        notched(2, size=40), allowed=BOX_ONLY
    )[0].geometry.model_copy(update={"width": 64.0, "height": 64.0})


def test_a_mask_with_nothing_in_it_proposes_nothing() -> None:
    assert shapes_from(empty(), allowed=BOTH, at=[(5.0, 5.0)]) == []


# --- the two spellings of a row ------------------------------------------------
#
# The adapter hands rows over as `bytes`, because converting a 4K mask into boxed
# booleans cost more than the pipeline it fed. These tests are what make that
# safe: the rule is that a row is a sequence of integers where a lit pixel is
# truthy, and `bytes` and a list of booleans are two spellings of it rather than
# two types. Everything above reads a mask through `len` and `index` alone, and
# both answer those identically — so if any of it ever reaches for `is True`, or
# for a method only a list has, these go red.


def in_bytes(mask: list[list[bool]] | list[list[int]]) -> list[bytes]:
    """The same mask, spelled the way the adapter spells it.

    The assertion is not decoration. Every test below compares this against the
    grid it came from, so a helper that quietly returned its argument would make
    all of them compare a call to itself and pass without a buffer ever reaching
    the pipeline — which is what a mutation run found them doing.
    """
    rows = [bytes(row) for row in mask]
    assert all(isinstance(row, bytes) for row in rows), "the point is the buffer"
    return rows


@pytest.mark.parametrize("allowed", [BOTH, BOX_ONLY, POLYGON_ONLY], ids=["both", "box", "polygon"])
def test_bytes_rows_and_boolean_rows_propose_the_same_shapes(
    allowed: list[GeometryType],
) -> None:
    """The whole pipeline, over a mask holding several pieces and a prompt."""
    at = [(3.0, 5.0)]
    assert shapes_from(in_bytes(speckled()), allowed=allowed, at=at) == shapes_from(
        speckled(), allowed=allowed, at=at
    )


def test_bytes_rows_survive_the_close_that_rebuilds_the_mask() -> None:
    """The one step that hands a *different* spelling to the step after it.

    ``filled`` returns lists of booleans whatever it was given, so a bytes-row
    mask changes representation halfway down the pipeline. That is fine and it is
    load-bearing that it is fine, because it is the only place the two spellings
    meet inside one call — which is exactly the seam a mask carried as an array
    would not have survived.
    """
    notch = notched(2, size=64)
    assert closing_radius(in_bytes(notch)) >= 1, "the fixture must reach the close"
    assert shapes_from(in_bytes(notch), allowed=POLYGON_ONLY) == shapes_from(
        notch, allowed=POLYGON_ONLY
    )


def test_the_row_scans_agree_before_anything_is_shaped() -> None:
    """``spans`` and ``runs`` directly, so a failure names the scan and not the shape."""
    grid = speckled()
    assert masks.runs(in_bytes(grid)) == masks.runs(grid)
    assert spans(in_bytes(grid)) == spans(grid)
    assert bbox_from(in_bytes(grid)) == bbox_from(grid)


def test_an_empty_bytes_row_mask_proposes_nothing() -> None:
    """``index`` raising is how an unlit row is detected, and ``bytes`` raises the same."""
    assert shapes_from(in_bytes(empty()), allowed=BOTH, at=[(5.0, 5.0)]) == []
