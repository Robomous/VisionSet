"""Raster masks: the COCO RLE codec, its limits, the mask geometry and its helpers."""

from __future__ import annotations

import random
import time
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from visionset.kernel.domain import (
    MAX_MASK_COUNTS_LENGTH,
    MAX_MASK_PIXELS,
    MAX_MASK_SIDE,
    Annotation,
    Geometry,
    MaskEncodingError,
    MaskGeometry,
    PolygonGeometry,
    canonical_runs,
    compose_class_map,
    decode_counts,
    encode_counts,
    mask_area,
    mask_bitmap,
    mask_enclosing_box,
    mask_fits_asset,
    mask_from_bitmap,
    mask_from_rows,
    mask_mirrored,
    mask_resampled,
    mask_rotated_once,
    mask_rows,
    mask_runs,
    mask_union,
    rasterize_polygon,
    rasterize_rings,
    split_class_map,
    trace_mask,
)
from visionset.kernel.domain import geometry as geometry_module
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.domain.rle import bitmap_from_runs, runs_from_bitmap

geometry_adapter: TypeAdapter[Geometry] = TypeAdapter(Geometry)


def _grid(*rows: str) -> MaskGeometry:
    return mask_from_rows([[character == "#" for character in row] for row in rows])


def _drawn(mask: MaskGeometry) -> list[str]:
    return ["".join("#" if value else "." for value in row) for row in mask_rows(mask)]


# --- the codec against COCO --------------------------------------------------------------

# Worked by hand from COCO's maskApi `rleToString`: each value from the fourth run on is
# its difference from the run two before it, written in five-bit groups, least
# significant first, as chr(48 + group), with 0x20 meaning "more groups follow" and 0x10
# the sign of the last group.
#   (100,):         100 = 0b11_00100 -> 4 | 0x20 = 36 'T', then 3 '3'.
#   (3, 1, 3, 1, 1): runs 0..2 as themselves '3','1','3'; run 3 is 1 - 1 = 0 '0';
#                    run 4 is 1 - 3 = -2 -> group 30 (sign bit set), nothing left: 'N'.
#   (1, 3, 1, 1):    run 3 is 1 - 3 = -2 'N'.
#   (0, 4):          a mask starting with foreground opens with an empty background run.
COCO_STRINGS = [
    ((4,), "4"),
    ((0, 4), "04"),
    ((1, 2, 1), "121"),
    ((2, 1, 1, 2), "2111"),
    ((1, 3, 1, 1), "131N"),
    ((3, 1, 3, 1, 1), "3130N"),
    ((100,), "T3"),
    ((0, 100), "0T3"),
]


@pytest.mark.parametrize(("runs", "counts"), COCO_STRINGS)
def test_the_encoder_writes_cocos_own_strings(runs: tuple[int, ...], counts: str) -> None:
    assert encode_counts(runs) == counts
    assert decode_counts(counts, sum(runs), 1) == runs


def test_the_runs_count_down_columns_first() -> None:
    # Column-major: the 2x3 mask below reads down x=0, then x=1, then x=2.
    mask = _grid(
        "#..",
        "##.",
    )
    # x=0 is (1, 1), x=1 is (0, 1), x=2 is (0, 0): 0 dark, 2 lit, 1 dark, 1 lit, 2 dark.
    assert mask_runs(mask) == (0, 2, 1, 1, 2)
    # Runs 3 and 4 are written as 1 - 2 = -1 ('O') and 2 - 1 = 1 ('1').
    assert mask.counts == "021O1"


def test_a_large_value_round_trips_through_several_groups() -> None:
    head = (12_345, 6_789_012, 3, 1)
    runs = (*head, 90_000_000 - sum(head))
    assert decode_counts(encode_counts(runs), 10_000, 9_000) == runs


# --- canonical form ----------------------------------------------------------------------


def test_a_non_canonical_string_is_stored_canonical() -> None:
    # "Q0" spells 1 with a redundant second group; "302" has a zero-length foreground run.
    assert MaskGeometry(size=(20, 1), counts="Q0c0").counts == "1c0"
    assert decode_counts("1c0", 20, 1) == (1, 19)
    assert MaskGeometry(size=(5, 1), counts="302").counts == "5"
    assert decode_counts("302", 5, 1) == (5,)


def test_equal_masks_have_equal_counts_whatever_spelling_wrote_them() -> None:
    rng = random.Random(1162)
    for _ in range(200):
        height, width = rng.randint(1, 12), rng.randint(1, 12)
        bitmap = bytes(rng.random() < 0.4 for _ in range(height * width))
        canonical = mask_from_bitmap(bitmap, height=height, width=width)
        runs = list(mask_runs(canonical))
        # Split every run into a run, a zero-length run of the other colour and the rest.
        spelled: list[int] = []
        for run in runs:
            spelled.extend((1, 0, run - 1) if run > 1 else (run,))
        respelled = MaskGeometry(size=(height, width), counts=encode_counts(spelled))
        assert respelled == canonical
        assert respelled.counts == canonical.counts
        assert bitmap_from_runs(mask_runs(canonical)) == bytearray(bitmap)


def _counting_decodes(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []

    def counted(counts: str, height: int, width: int) -> tuple[int, ...]:
        calls.append(counts)
        return decode_counts(counts, height, width)

    monkeypatch.setattr(geometry_module, "decode_counts", counted)
    return calls


def test_wrapping_a_mask_in_an_annotation_does_not_decode_it_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decodes = _counting_decodes(monkeypatch)
    mask = MaskGeometry(size=(5, 1), counts="302")
    annotation = Annotation(
        asset_id=uuid4(), label_class="road", schema_version=1, geometry=mask, provenance="human"
    )
    Annotation.model_validate(annotation.model_dump())

    assert annotation.geometry is mask
    assert decodes == ["302", "5"]


def test_a_copied_mask_is_judged_again_once_its_size_or_counts_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decodes = _counting_decodes(monkeypatch)
    mask = MaskGeometry(size=(5, 1), counts="5")

    respelled = Annotation(
        asset_id=uuid4(),
        label_class="road",
        schema_version=1,
        geometry=mask.model_copy(update={"counts": "302"}),
        provenance="human",
    )
    with pytest.raises(ValidationError, match="cover more than the 4 pixels"):
        Annotation(
            asset_id=uuid4(),
            label_class="road",
            schema_version=1,
            geometry=mask.model_copy(update={"size": (4, 1)}),
            provenance="human",
        )

    assert respelled.geometry.counts == "5"
    assert decodes == ["5", "302", "5"]


def test_canonical_runs_accepts_an_import_adapters_uncompressed_list() -> None:
    assert canonical_runs([2, 0, 3, 1, 0], 6, 1) == (5, 1)
    assert canonical_runs([0, 6], 3, 2) == (0, 6)
    with pytest.raises(MaskEncodingError, match="cover 5 pixels"):
        canonical_runs([2, 3], 3, 2)
    with pytest.raises(MaskEncodingError, match="negative"):
        canonical_runs([5, -1, 2], 3, 2)
    with pytest.raises(MaskEncodingError, match="integer"):
        canonical_runs([True, 5], 3, 2)


def test_the_wire_takes_only_the_compressed_string() -> None:
    with pytest.raises(ValidationError):
        geometry_adapter.validate_python({"type": "mask", "size": [2, 2], "counts": [4]})


# --- the shapes masks take ---------------------------------------------------------------

SHAPES = {
    "hole": ("#####", "#...#", "#.#.#", "#...#", "#####"),
    "disconnected": ("##...", "##...", ".....", "...##", "...#."),
    "empty": ("....", "....", "...."),
    "full": ("###", "###"),
    "one pixel lit": ("#",),
    "one pixel dark": (".",),
    "wide": ("#.#.#.#",),
    "tall": ("#", ".", ".", "#", "#"),
    "odd": ("..#..", ".###.", "#####"),
}


@pytest.mark.parametrize("name", SHAPES)
def test_every_shape_round_trips_losslessly(name: str) -> None:
    rows = SHAPES[name]
    mask = _grid(*rows)
    assert mask.size == (len(rows), len(rows[0]))
    assert _drawn(mask) == list(rows)
    again = geometry_adapter.validate_json(mask.model_dump_json())
    assert again == mask
    assert _drawn(MaskGeometry(size=mask.size, counts=mask.counts)) == list(rows)


def test_an_empty_mask_has_no_area_and_no_box() -> None:
    empty = _grid(*SHAPES["empty"])
    assert empty.counts == "<"  # 12 background pixels, one run
    assert mask_area(empty) == 0
    assert mask_enclosing_box(empty) is None
    assert trace_mask(empty) == ()


def test_area_and_box_are_read_from_the_runs() -> None:
    mask = _grid(*SHAPES["disconnected"])
    assert mask_area(mask) == 7
    box = mask_enclosing_box(mask)
    assert box is not None
    assert (box.x, box.y, box.width, box.height) == (0.0, 0.0, 5.0, 5.0)
    corner = _grid("....", "..#.", "..##")
    box = mask_enclosing_box(corner)
    assert box is not None
    assert (box.x, box.y, box.width, box.height) == (2.0, 1.0, 2.0, 2.0)


def test_a_run_crossing_a_column_spans_every_row_it_touches() -> None:
    # Foreground from the bottom of x=0 into the top of x=1: rows 0..2 both.
    mask = _grid("..#", "...", "#..")
    crossing = _grid(".#.", "...", "#..")
    assert mask_runs(crossing) == (2, 2, 5)
    box = mask_enclosing_box(crossing)
    assert box is not None
    assert (box.x, box.y, box.width, box.height) == (0.0, 0.0, 2.0, 3.0)
    assert mask_area(mask) == 2


def test_a_mask_fits_only_an_asset_of_its_own_size() -> None:
    mask = _grid("##.", "...")
    assert mask_fits_asset(mask, width=3, height=2)
    assert not mask_fits_asset(mask, width=2, height=3)
    assert mask_fits_asset(mask, width=None, height=None)
    assert geometry_intersects_asset(mask, width=3, height=2)
    assert not geometry_intersects_asset(mask, width=4, height=2)
    # An empty mask still belongs to its frame.
    assert geometry_intersects_asset(_grid("..."), width=3, height=1)


# --- limits and malformed input ----------------------------------------------------------


@pytest.mark.parametrize(
    "size",
    [(0, 4), (4, 0), (-1, 4), (MAX_MASK_SIDE + 1, 1), (1, MAX_MASK_SIDE + 1)],
)
def test_a_size_out_of_bounds_is_refused(size: tuple[int, int]) -> None:
    with pytest.raises(ValidationError):
        MaskGeometry(size=size, counts="4")
    with pytest.raises(MaskEncodingError):
        decode_counts("4", *size)


@pytest.mark.parametrize("size", [[True, 2], [2.0, 2], ["2", "2"], [2], [2, 2, 2]])
def test_a_size_is_two_integers(size: list[object]) -> None:
    with pytest.raises(ValidationError):
        geometry_adapter.validate_python({"type": "mask", "size": size, "counts": "4"})


def test_the_pixel_limit_is_inclusive() -> None:
    side = 10_000
    assert side * side == MAX_MASK_PIXELS
    empty = MaskGeometry(size=(side, side), counts=encode_counts((MAX_MASK_PIXELS,)))
    full = MaskGeometry(size=(side, side), counts=encode_counts((0, MAX_MASK_PIXELS)))
    assert mask_area(empty) == 0
    assert mask_area(full) == MAX_MASK_PIXELS
    with pytest.raises(ValidationError, match="pixel limit"):
        MaskGeometry(size=(side, side + 1), counts=encode_counts((side * (side + 1),)))


@pytest.mark.parametrize(
    ("counts", "message"),
    [
        ("", "at least 1 character"),
        ("4 ", "COCO RLE characters"),
        ("4p", "COCO RLE characters"),
        ("Q", "middle of a value"),
        ("N", "negative"),
        ("5", "more than the 4 pixels"),
        ("3", "cover 3 pixels"),
        ("1111", "more than the 4 pixels"),
        ("2N", "negative"),
    ],
)
def test_a_malformed_counts_string_is_refused(counts: str, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        MaskGeometry(size=(2, 2), counts=counts)


def test_a_counts_string_over_the_length_limit_is_refused_before_decoding() -> None:
    oversized = "0" * (MAX_MASK_COUNTS_LENGTH + 1)
    with pytest.raises(MaskEncodingError, match="character limit"):
        decode_counts(oversized, 2, 2)
    with pytest.raises(ValidationError):
        MaskGeometry(size=(2, 2), counts=oversized)


def test_a_value_wider_than_the_size_can_need_is_refused_at_its_groups() -> None:
    # 'o' is group 63: five more bits and a continuation, forever.
    with pytest.raises(MaskEncodingError, match="groups"):
        decode_counts("o" * 1000, 2, 2)


def test_a_short_string_claiming_a_huge_mask_allocates_nothing() -> None:
    # A bomb: a handful of characters naming a run of 2**40 pixels against a
    # small frame, and a full-size frame read without a bitmap ever being built.
    bomb = encode_counts((1 << 40,))
    with pytest.raises(MaskEncodingError):
        decode_counts(bomb, 100, 100)
    started = time.perf_counter()
    runs = decode_counts(encode_counts((0, MAX_MASK_PIXELS)), 10_000, 10_000)
    assert time.perf_counter() - started < 1.0
    assert runs == (0, MAX_MASK_PIXELS)


def test_the_error_is_a_typed_value_error() -> None:
    assert issubclass(MaskEncodingError, ValueError)
    with pytest.raises(MaskEncodingError):
        mask_from_bitmap(b"\x00\x01", height=2, width=2)
    with pytest.raises(MaskEncodingError, match="as long as the first"):
        mask_from_rows([[1, 0], [1]])


# --- polygons and masks ------------------------------------------------------------------


def test_a_polygon_lights_the_pixels_whose_centres_it_holds() -> None:
    square = PolygonGeometry(points=[(1.0, 1.0), (3.0, 1.0), (3.0, 3.0), (1.0, 3.0)])
    assert _drawn(rasterize_polygon(square, height=4, width=5)) == [
        ".....",
        ".##..",
        ".##..",
        ".....",
    ]


def test_rasterization_loses_what_is_finer_than_a_pixel() -> None:
    # A sliver between two rows of centres lights nothing.
    sliver = PolygonGeometry(points=[(0.0, 0.6), (4.0, 0.6), (4.0, 1.4), (0.0, 1.4)])
    assert mask_area(rasterize_polygon(sliver, height=3, width=4)) == 0
    # A triangle keeps only the pixels whose centres it covers: 0.5 px is lost on the slope.
    triangle = PolygonGeometry(points=[(0.0, 0.0), (4.0, 0.0), (0.0, 4.0)])
    assert _drawn(rasterize_polygon(triangle, height=4, width=4)) == [
        "###.",
        "##..",
        "#...",
        "....",
    ]


def test_a_polygon_off_the_frame_gives_an_empty_mask() -> None:
    away = PolygonGeometry(points=[(10.0, 10.0), (20.0, 10.0), (20.0, 20.0)])
    assert mask_area(rasterize_polygon(away, height=4, width=4)) == 0


def test_a_centre_on_an_edge_is_inside_below_and_to_the_right() -> None:
    # Edges through the centres of row 1 and column 1: the top-left edges own them.
    square = PolygonGeometry(points=[(1.5, 1.5), (3.5, 1.5), (3.5, 3.5), (1.5, 3.5)])
    assert _drawn(rasterize_polygon(square, height=4, width=4)) == [
        "....",
        ".##.",
        ".##.",
        "....",
    ]


def test_a_nonfinite_vertex_is_refused() -> None:
    with pytest.raises(ValueError, match="finite"):
        rasterize_rings([[(0.0, 0.0), (float("inf"), 0.0), (0.0, 1.0)]], height=2, width=2)


def test_a_union_keeps_a_pixel_two_parts_share_where_one_ring_set_would_cut_a_hole() -> None:
    outer = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)]
    inner = [(1.0, 1.0), (3.0, 1.0), (3.0, 3.0), (1.0, 3.0)]
    parts = [rasterize_rings([ring], height=4, width=5) for ring in (outer, inner)]

    assert _drawn(mask_union(parts, height=4, width=5)) == ["####.", "####.", "####.", "####."]
    assert _drawn(rasterize_rings([outer, inner], height=4, width=5)) == [
        "####.",
        "#..#.",
        "#..#.",
        "####.",
    ]


def test_a_union_of_nothing_is_empty_and_of_the_wrong_size_is_refused() -> None:
    assert mask_area(mask_union([], height=2, width=3)) == 0
    with pytest.raises(MaskEncodingError, match="union"):
        mask_union([rasterize_rings([], height=3, width=2)], height=2, width=3)


def test_tracing_reports_the_hole_and_the_island_inside_it() -> None:
    ring, island = trace_mask(_grid(*SHAPES["hole"]))
    assert ring.outer.points == [(0.0, 0.0), (5.0, 0.0), (5.0, 5.0), (0.0, 5.0)]
    assert [hole.points for hole in ring.holes] == [
        [(1.0, 1.0), (1.0, 4.0), (4.0, 4.0), (4.0, 1.0)]
    ]
    assert island.outer.points == [(2.0, 2.0), (3.0, 2.0), (3.0, 3.0), (2.0, 3.0)]
    assert island.holes == ()


def test_tracing_separates_disconnected_and_corner_touching_regions() -> None:
    assert len(trace_mask(_grid(*SHAPES["disconnected"]))) == 2
    assert len(trace_mask(_grid("#.", ".#"))) == 2


def test_the_hole_around_an_island_is_assigned_to_the_ring_around_it() -> None:
    nested = _grid(
        "#######",
        "#.....#",
        "#.###.#",
        "#.#.#.#",
        "#.###.#",
        "#.....#",
        "#######",
    )
    regions = trace_mask(nested)
    assert [len(region.holes) for region in regions] == [1, 1]


def test_the_traced_rings_rasterize_back_to_exactly_the_mask() -> None:
    rng = random.Random(7)
    for _ in range(150):
        height, width = rng.randint(1, 14), rng.randint(1, 14)
        rows = [[rng.random() < 0.5 for _ in range(width)] for _ in range(height)]
        mask = mask_from_rows(rows)
        regions = trace_mask(mask)
        rings = [region.outer.points for region in regions] + [
            hole.points for region in regions for hole in region.holes
        ]
        assert rasterize_rings(rings, height=height, width=width) == mask


def test_dropping_the_holes_is_the_loss_a_polygon_takes() -> None:
    ring, _ = trace_mask(_grid(*SHAPES["hole"]))
    outline_only = rasterize_polygon(ring.outer, height=5, width=5)
    assert mask_area(outline_only) - mask_area(_grid(*SHAPES["hole"])) == 8


# --- class-id maps -----------------------------------------------------------------------


def test_a_class_map_splits_into_one_mask_per_present_class() -> None:
    values = [
        0, 1, 1, 255,
        0, 2, 1, 255,
        0, 2, 2, 0,
    ]  # fmt: skip
    masks = split_class_map(values, height=3, width=4, ignore={0, 255})
    assert list(masks) == [1, 2]
    assert _drawn(masks[1]) == [".##.", "..#.", "...."]
    assert _drawn(masks[2]) == ["....", ".#..", ".##."]
    recomposed = compose_class_map(list(masks.items()), height=3, width=4, fill=0)
    assert recomposed.values == [0 if value == 255 else value for value in values]
    assert recomposed.overlapping_pixels == 0


def test_an_all_ignored_map_has_no_masks() -> None:
    assert split_class_map([0, 0, 0, 0], height=2, width=2, ignore={0}) == {}


def test_a_map_of_the_wrong_length_is_refused() -> None:
    with pytest.raises(MaskEncodingError, match="class map"):
        split_class_map([1, 2, 3], height=2, width=2)


def test_composing_reports_overlap_and_keeps_the_lowest_class() -> None:
    a = _grid("##.", "...")
    b = _grid(".##", "...")
    forward = compose_class_map([(7, b), (3, a)], height=2, width=3, fill=0)
    backward = compose_class_map([(3, a), (7, b)], height=2, width=3, fill=0)
    assert forward == backward
    assert forward.values == [3, 3, 7, 0, 0, 0]
    assert forward.overlapping_pixels == 1
    assert forward.overlapping_classes == frozenset({3, 7})


def test_two_masks_of_one_class_are_a_union_not_an_overlap() -> None:
    a = _grid("##.", "...")
    b = _grid(".##", "...")
    composed = compose_class_map([(4, a), (4, b)], height=2, width=3, fill=9)
    assert composed.values == [4, 4, 4, 9, 9, 9]
    assert composed.overlapping_pixels == 0


def test_composing_a_mask_of_another_size_is_refused() -> None:
    with pytest.raises(MaskEncodingError, match="cannot compose"):
        compose_class_map([(1, _grid("#"))], height=2, width=2, fill=0)


# --- transforms --------------------------------------------------------------------------


def test_a_mirror_moves_each_pixel_across() -> None:
    assert _drawn(mask_mirrored(_grid("#..", "##."))) == ["..#", ".##"]


def test_a_quarter_turn_is_counter_clockwise_and_swaps_the_size() -> None:
    turned = mask_rotated_once(_grid("#..", "##."))
    assert turned.size == (3, 2)
    # (x, y) lands at (y, W - 1 - x).
    assert _drawn(turned) == ["..", ".#", "##"]
    again = turned
    for _ in range(3):
        again = mask_rotated_once(again)
    assert again == _grid("#..", "##.")


def test_resampling_takes_the_pixel_under_each_centre() -> None:
    mask = _grid("##..", "##..", "....", "...#")
    assert mask_resampled(mask, height=4, width=4) == mask
    assert _drawn(mask_resampled(mask, height=2, width=2)) == ["#.", ".#"]
    assert _drawn(mask_resampled(_grid("#."), height=1, width=4)) == ["##.."]


def test_bitmaps_and_rows_agree() -> None:
    mask = _grid(*SHAPES["odd"])
    bitmap = mask_bitmap(mask)
    assert runs_from_bitmap(bitmap) == mask_runs(mask)
    assert mask_from_bitmap(bytes(bitmap), height=3, width=5) == mask


def test_a_spelling_whose_canonical_form_outgrows_the_limit_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from visionset.kernel.domain import geometry

    # The limit is judged on the canonical form too: merging zero-length runs can
    # lengthen a string, and what is stored must reload. A lowered limit stands in for
    # the multi-megabyte spelling that grows past the real one.
    spelled = encode_counts([1, 0, 15, 0, 15])
    canonical = encode_counts([31])
    assert decode_counts(spelled, 31, 1) == (31,)
    monkeypatch.setattr(geometry, "MAX_MASK_COUNTS_LENGTH", len(canonical) - 1)
    with pytest.raises(ValidationError, match="canonical counts"):
        MaskGeometry(size=(31, 1), counts=spelled)


def test_an_extreme_vertex_rasterizes_without_overflowing() -> None:
    huge = PolygonGeometry(points=[(1e308, 0.0), (-1e308, 10.0), (0.0, 5.0)])
    mask = rasterize_polygon(huge, height=10, width=10)
    assert mask.size == (10, 10)
