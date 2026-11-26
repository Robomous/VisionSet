"""The cropping resizes, ``fill`` and ``center_crop``: where labels land, and which survive.

Coordinates are worked by hand. The asset is 100×200 throughout, so a 100×100
``fill`` keeps the scale at 1 and cuts 50 pixels off the top and the bottom,
and a ``center_crop`` to the same size cuts exactly the same window — every
expected value below is the source coordinate minus 50 on y.
"""

from __future__ import annotations

import math
import random
from uuid import UUID, uuid4

import pytest

from visionset.kernel.domain import (
    PIXEL_GEOMETRIES,
    RESIZE_GEOMETRIES,
    AugmentOp,
    AugmentStep,
    BboxGeometry,
    ClassificationGeometry,
    Geometry,
    GeometryType,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    PolylineGeometry,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    SplitAssignment,
    TransformedFile,
    canvas_fit,
    transform_manifest,
)
from visionset.kernel.domain.preprocessing_transform import _clip_ring, _cropped, _ring_area
from visionset.kernel.errors import PreprocessingStepUnsupportedGeometry

CROPPING = (ResizeStrategy.FILL, ResizeStrategy.CENTER_CROP)


def _asset(*geometries: Geometry, width: int = 100, height: int = 200) -> ManifestAsset:
    return ManifestAsset(
        asset_id=uuid4(),
        content_hash="aa",
        uri="/img/aa.jpg",
        width=width,
        height=height,
        annotations=tuple(
            ManifestAnnotation(
                id=uuid4(),
                label_class="thing",
                schema_version=1,
                geometry=geometry,
                provenance="human",
            )
            for geometry in geometries
        ),
    )


def _base(
    strategy: ResizeStrategy, *geometries: Geometry, width: int = 100, height: int = 100
) -> tuple[ManifestAsset, TransformedFile]:
    asset = _asset(*geometries)
    spec = RecipeSpec(
        target=None, steps=(ResizeStep(strategy=strategy, width=width, height=height),)
    )
    (file,) = transform_manifest(Manifest(schema_version=1, assets=(asset,)), spec, None).files
    return asset, file


def _id_of(asset: ManifestAsset, geometry: Geometry) -> UUID:
    """A manifest asset holds its annotations in canonical order, not the order given."""
    (match,) = [one.id for one in asset.annotations if one.geometry == geometry]
    return match


def _box(y: float, height: float = 40.0) -> BboxGeometry:
    return BboxGeometry(x=10.0, y=y, width=30.0, height=height)


# --- the shared arithmetic ----------------------------------------------------


@pytest.mark.parametrize(
    ("strategy", "source", "target", "expected"),
    [
        # Fill covers the canvas: the taller axis overflows and is cut centred.
        (ResizeStrategy.FILL, (100, 200), (100, 100), (1.0, 100, 200, 0, -50)),
        # Upscale by the wider ratio; the 160-pixel overflow splits 80/80.
        (ResizeStrategy.FILL, (16, 40), (64, 64), (4.0, 64, 160, 0, -48)),
        # An odd overflow floors, the letterbox rule: one more pixel off the left.
        (ResizeStrategy.FILL, (101, 50), (64, 64), (1.28, 129, 64, -33, 0)),
        # No scaling, the window centred on the source.
        (ResizeStrategy.CENTER_CROP, (100, 200), (100, 100), (1.0, 100, 200, 0, -50)),
        (ResizeStrategy.CENTER_CROP, (41, 41), (32, 32), (1.0, 41, 41, -5, -5)),
        # A source narrower than the canvas is padded on that axis, never scaled.
        (ResizeStrategy.CENTER_CROP, (40, 200), (64, 100), (1.0, 40, 200, 12, -50)),
    ],
)
def test_canvas_fit_matches_the_hand_computed_reference(
    strategy: ResizeStrategy,
    source: tuple[int, int],
    target: tuple[int, int],
    expected: tuple[float, int, int, int, int],
) -> None:
    fit = canvas_fit(*source, strategy=strategy, target_width=target[0], target_height=target[1])
    assert (
        fit.scale,
        fit.content_width,
        fit.content_height,
        fit.offset_x,
        fit.offset_y,
    ) == pytest.approx(expected)


def test_stretch_has_no_canvas_fit() -> None:
    with pytest.raises(ValueError, match="stretch"):
        canvas_fit(10, 10, strategy=ResizeStrategy.STRETCH, target_width=32, target_height=32)


# --- boxes --------------------------------------------------------------------


@pytest.mark.parametrize("strategy", CROPPING)
def test_a_box_wholly_on_the_canvas_moves_and_is_not_clipped(strategy: ResizeStrategy) -> None:
    asset, file = _base(strategy, _box(60.0))

    assert (file.width, file.height) == (100, 100)
    assert file.annotations[0].geometry == BboxGeometry(x=10.0, y=10.0, width=30.0, height=40.0)
    assert (file.dropped, file.clipped) == ((), ())


@pytest.mark.parametrize("strategy", CROPPING)
def test_a_box_across_the_edge_is_clipped_to_the_canvas(strategy: ResizeStrategy) -> None:
    asset, file = _base(strategy, _box(40.0))

    assert file.annotations[0].geometry == BboxGeometry(x=10.0, y=0.0, width=30.0, height=30.0)
    assert file.clipped == (asset.annotations[0].id,)
    assert file.dropped == ()


@pytest.mark.parametrize(
    ("y", "kept"),
    [
        # Source y 30..70 lands at -20..20: exactly half survives, and is kept.
        (30.0, True),
        (30.5, True),
        (29.5, False),
    ],
)
def test_a_box_is_kept_from_exactly_half_its_area_on_the_canvas(y: float, kept: bool) -> None:
    asset, file = _base(ResizeStrategy.FILL, _box(y))
    identifier = asset.annotations[0].id

    if kept:
        assert file.annotations[0].geometry == BboxGeometry(
            x=10.0, y=0.0, width=30.0, height=y - 10.0
        )
        assert file.clipped == (identifier,)
    else:
        assert file.annotations == ()
        assert file.dropped == (identifier,)


def test_a_box_wholly_off_the_canvas_is_dropped() -> None:
    asset, file = _base(ResizeStrategy.CENTER_CROP, _box(160.0), _box(60.0))

    assert [one.id for one in file.annotations] == [str(_id_of(asset, _box(60.0)))]
    assert file.dropped == (_id_of(asset, _box(160.0)),)


def test_a_box_touching_the_edge_from_inside_is_not_clipped() -> None:
    asset, file = _base(ResizeStrategy.FILL, _box(50.0, height=100.0))

    assert file.annotations[0].geometry == BboxGeometry(x=10.0, y=0.0, width=30.0, height=100.0)
    assert file.clipped == ()


def test_center_crop_pads_a_narrow_source_and_cuts_nothing_on_that_axis() -> None:
    box = BboxGeometry(x=0.0, y=60.0, width=40.0, height=40.0)
    asset = _asset(box, width=40, height=200)
    step = ResizeStep(strategy=ResizeStrategy.CENTER_CROP, width=64, height=100)
    (file,) = transform_manifest(
        Manifest(schema_version=1, assets=(asset,)), RecipeSpec(target=None, steps=(step,)), None
    ).files

    assert file.annotations[0].geometry == BboxGeometry(x=12.0, y=10.0, width=40.0, height=40.0)
    assert file.clipped == ()


def test_fill_scales_before_it_crops() -> None:
    """A 100×200 source onto 200×100 scales by 2 and cuts 150 off the top and bottom."""
    asset, file = _base(
        ResizeStrategy.FILL, BboxGeometry(x=10.0, y=80.0, width=20.0, height=30.0), width=200
    )

    assert file.annotations[0].geometry == BboxGeometry(x=20.0, y=10.0, width=40.0, height=60.0)


# --- polygons -----------------------------------------------------------------


def test_a_polygon_across_the_edge_is_clipped_to_the_canvas() -> None:
    # A right triangle whose top-left corner pokes 20 pixels above the canvas.
    triangle = PolygonGeometry(points=[(10.0, 30.0), (90.0, 130.0), (10.0, 130.0)])
    asset, file = _base(ResizeStrategy.FILL, triangle)

    (kept,) = file.annotations
    assert isinstance(kept.geometry, PolygonGeometry)
    assert sorted(kept.geometry.points) == sorted(
        [(10.0, 0.0), (26.0, 0.0), (90.0, 80.0), (10.0, 80.0)]
    )
    assert file.clipped == (asset.annotations[0].id,)


def _comb(right_prong_top: float, base: float = -4.0, *, start: int = 0) -> PolygonGeometry:
    """Two prongs standing on a base just above the canvas, placed in source coordinates.

    ``start`` rotates which vertex the ring begins at, which changes the order
    the clip meets the pieces in, so that order cannot decide which is kept.
    """
    points = [(10.0, base), (90.0, base), (90.0, right_prong_top), (60.0, right_prong_top)]
    points += [(60.0, -1.0), (30.0, -1.0), (30.0, 60.0), (10.0, 60.0)]
    points = points[start:] + points[:start]
    return PolygonGeometry(points=[(x, y + 50.0) for x, y in points])


@pytest.mark.parametrize("start", [0, 2])
def test_a_polygon_cut_into_pieces_keeps_only_the_largest(start: int) -> None:
    asset, file = _base(ResizeStrategy.CENTER_CROP, _comb(80.0, start=start))

    (kept,) = file.annotations
    assert isinstance(kept.geometry, PolygonGeometry)
    assert sorted(kept.geometry.points) == [(60.0, 0.0), (60.0, 80.0), (90.0, 0.0), (90.0, 80.0)]
    assert file.clipped == (asset.annotations[0].id,)


def test_a_split_polygon_whose_largest_piece_is_under_half_is_dropped() -> None:
    # Pieces of 1200 and 1500 kept of a 5070 whole: the larger is under half of it.
    asset, file = _base(ResizeStrategy.CENTER_CROP, _comb(50.0, base=-30.0))

    assert file.annotations == ()
    assert file.dropped == (asset.annotations[0].id,)


def test_a_polygon_wholly_off_the_canvas_is_dropped() -> None:
    off = PolygonGeometry(points=[(10.0, 160.0), (40.0, 160.0), (40.0, 190.0)])
    asset, file = _base(ResizeStrategy.FILL, off)

    assert file.annotations == ()
    assert file.dropped == (asset.annotations[0].id,)


def test_a_polygon_on_the_canvas_keeps_its_vertices_as_they_were() -> None:
    inside = PolygonGeometry(points=[(10.0, 60.0), (40.0, 60.0), (40.0, 90.0)])
    asset, file = _base(ResizeStrategy.FILL, inside)

    assert file.annotations[0].geometry == PolygonGeometry(
        points=[(10.0, 10.0), (40.0, 10.0), (40.0, 40.0)]
    )
    assert file.clipped == ()


def _sutherland_hodgman_area(ring: list[tuple[float, float]], size: float) -> float:
    """The clipped area by the one-ring algorithm: its bridges enclose nothing."""
    out = ring
    for axis, bound, above in ((0, 0.0, True), (0, size, False), (1, 0.0, True), (1, size, False)):
        points, out = out, []
        for index, p in enumerate(points):
            q = points[(index + 1) % len(points)]
            fp = p[axis] - bound if above else bound - p[axis]
            fq = q[axis] - bound if above else bound - q[axis]
            if fp >= 0:
                out.append(p)
            if (fp >= 0) != (fq >= 0):
                t = fp / (fp - fq)
                out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
        if not out:
            return 0.0
    return abs(_ring_area(out))


def _star(seed: int) -> list[tuple[float, float]]:
    """A simple ring: vertices at rising angles round a centre, no gap past a half turn."""
    rng = random.Random(seed)
    count = rng.randint(5, 12)
    angles = [2 * math.pi * (index + rng.uniform(0.1, 0.9)) / count for index in range(count)]
    cx, cy = rng.uniform(0.0, 100.0), rng.uniform(0.0, 100.0)
    return [
        (cx + radius * math.cos(angle), cy + radius * math.sin(angle))
        for angle in angles
        for radius in [rng.uniform(10.0, 90.0)]
    ]


@pytest.mark.parametrize("seed", range(40))
def test_the_pieces_cover_exactly_the_clipped_area_and_stay_on_the_canvas(seed: int) -> None:
    ring = _star(seed)
    sign = math.copysign(1.0, _ring_area(ring))

    pieces = _clip_ring(ring, 100.0, 100.0)

    assert sum(abs(_ring_area(piece)) for piece in pieces) == pytest.approx(
        _sutherland_hodgman_area(ring, 100.0), abs=1e-6
    )
    assert all(_ring_area(piece) * sign > 0 for piece in pieces)
    assert all(0.0 <= x <= 100.0 and 0.0 <= y <= 100.0 for piece in pieces for x, y in piece)


def test_a_source_edge_on_the_canvas_edge_leaves_no_spike() -> None:
    """Its run along the edge would otherwise double back and stretch the box to y 10."""
    shape = PolygonGeometry(
        points=[
            (50.0, 50.0),
            (100.0, 50.0),
            (100.0, 10.0),
            (110.0, 10.0),
            (110.0, 90.0),
            (50.0, 90.0),
        ]
    )

    cut, clipped = _cropped(shape, 100.0, 100.0)

    assert clipped
    assert isinstance(cut, PolygonGeometry)
    assert sorted(cut.points) == [(50.0, 50.0), (50.0, 90.0), (100.0, 50.0), (100.0, 90.0)]


def _inside(point: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    x, y = point
    hit = False
    for (x0, y0), (x1, y1) in zip(ring, [*ring[1:], ring[0]], strict=True):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


def _skyline(seed: int) -> list[tuple[float, float]]:
    """A rectilinear ring on a 10-pixel grid whose edges run along and across the canvas edges."""
    rng = random.Random(seed)
    xs = list(range(rng.choice([-20, 0, 20]), rng.choice([80, 100, 120]) + 1, 10))
    base = float(rng.choice([-20, 0, 10]))
    tops = [float(rng.choice([30, 60, 90, 100, 120])) for _ in xs[:-1]]
    ring = [(float(xs[0]), base), (float(xs[-1]), base)]
    for index in range(len(tops) - 1, -1, -1):
        ring += [(float(xs[index + 1]), tops[index]), (float(xs[index]), tops[index])]
    if rng.random() < 0.5:
        ring = [(y, x) for x, y in ring]
    return ring


@pytest.mark.parametrize("seed", range(40))
def test_the_pieces_span_exactly_the_clipped_region(seed: int) -> None:
    """Sampled at pixel centres; a spike along a canvas edge would stretch the span past it."""
    ring = _skyline(seed)
    inside = [
        (x + 0.5, y + 0.5)
        for x in range(100)
        for y in range(100)
        if _inside((x + 0.5, y + 0.5), ring)
    ]
    pieces = _clip_ring(ring, 100.0, 100.0)
    points = [point for piece in pieces for point in piece]

    if not inside:
        assert sum(abs(_ring_area(piece)) for piece in pieces) < 1.0
        return
    sampled = (
        min(x for x, _ in inside),
        min(y for _, y in inside),
        max(x for x, _ in inside),
        max(y for _, y in inside),
    )
    spanned = (
        min(x for x, _ in points),
        min(y for _, y in points),
        max(x for x, _ in points),
        max(y for _, y in points),
    )
    assert spanned == pytest.approx(sampled, abs=0.5)
    for piece in pieces:
        for index, point in enumerate(piece):
            before, after = piece[index - 1], piece[(index + 1) % len(piece)]
            for axis, bound in ((0, 0.0), (0, 100.0), (1, 0.0), (1, 100.0)):
                on_edge = before[axis] == point[axis] == after[axis] == bound
                assert not (
                    on_edge
                    and (point[1 - axis] - before[1 - axis]) * (after[1 - axis] - point[1 - axis])
                    < 0
                )


def test_a_ring_dipping_out_and_back_in_splits_into_its_pieces() -> None:
    # A U opening downwards whose arch is above the canvas: two legs come back.
    ring = [(10.0, -30.0), (90.0, -30.0), (90.0, 50.0), (70.0, 50.0)]
    ring += [(70.0, -10.0), (30.0, -10.0), (30.0, 40.0), (10.0, 40.0)]

    pieces = _clip_ring(ring, 100.0, 100.0)

    assert sorted(sorted(piece) for piece in pieces) == [
        [(10.0, 0.0), (10.0, 40.0), (30.0, 0.0), (30.0, 40.0)],
        [(70.0, 0.0), (70.0, 50.0), (90.0, 0.0), (90.0, 50.0)],
    ]


# --- what a cropping resize carries -------------------------------------------


def test_the_cropping_strategies_declare_every_pixel_geometry_but_the_polyline() -> None:
    expected = PIXEL_GEOMETRIES - {GeometryType.POLYLINE}
    assert RESIZE_GEOMETRIES[ResizeStrategy.FILL] == expected
    assert RESIZE_GEOMETRIES[ResizeStrategy.CENTER_CROP] == expected
    assert RESIZE_GEOMETRIES[ResizeStrategy.STRETCH] == PIXEL_GEOMETRIES
    assert RESIZE_GEOMETRIES[ResizeStrategy.LETTERBOX] == PIXEL_GEOMETRIES


@pytest.mark.parametrize("strategy", list(ResizeStrategy))
def test_a_polyline_is_refused_by_a_crop_and_moved_by_every_other_resize(
    strategy: ResizeStrategy,
) -> None:
    lane = PolylineGeometry(points=[(5.0, 60.0), (60.0, 90.0)])

    if strategy in CROPPING:
        with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
            _base(strategy, lane)
        assert (caught.value.step, caught.value.geometry) == ("resize", "polyline")
        return
    _, file = _base(strategy, lane)
    assert file.annotations[0].geometry.type is GeometryType.POLYLINE


@pytest.mark.parametrize("strategy", CROPPING)
def test_a_classification_passes_a_crop_untouched(strategy: ResizeStrategy) -> None:
    asset, file = _base(strategy, ClassificationGeometry())

    assert file.annotations[0].geometry == ClassificationGeometry()
    assert (file.dropped, file.clipped) == ((), ())


def test_every_variant_loses_what_its_base_image_loses() -> None:
    asset = _asset(_box(160.0), _box(40.0), _box(60.0))
    spec = RecipeSpec(
        target=None,
        steps=(
            ResizeStep(strategy=ResizeStrategy.FILL, width=100, height=100),
            AugmentStep(op=AugmentOp.HFLIP),
        ),
        variants_per_asset=2,
    )
    view = transform_manifest(
        Manifest(schema_version=1, assets=(asset,)),
        spec,
        SplitAssignment(train=(asset.asset_id,)),
    )

    dropped, clipped, kept = (_id_of(asset, _box(y)) for y in (160.0, 40.0, 60.0))
    for file in view.files:
        assert file.dropped == (dropped,)
        assert file.clipped == (clipped,)
        assert len(file.annotations) == 2
    variant = {one.id: one.geometry for one in view.files[1].annotations}
    assert variant == {
        f"{clipped}-aug1": BboxGeometry(x=60.0, y=0.0, width=30.0, height=30.0),
        f"{kept}-aug1": BboxGeometry(x=60.0, y=10.0, width=30.0, height=40.0),
    }
    assert (view.dropped_count, view.clipped_count) == (1, 1)
