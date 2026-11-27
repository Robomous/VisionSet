"""The rotated box: its canonical form, its refusals, its conversions and its moves.

Expected values are worked from the definition — the width side along
``(cos angle, sin angle)``, y down — rather than through the module's own
helpers, so a sign error in the corners fails here instead of agreeing with itself.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from math import cos, isclose, pi, sin, sqrt
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from visionset.kernel.domain import (
    OBB_MANIFEST_VERSION,
    TRACKED_MANIFEST_VERSION,
    AugmentOp,
    AugmentStep,
    BboxGeometry,
    Geometry,
    GeometryType,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    ObbGeometry,
    PolygonGeometry,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    SplitAssignment,
    TransformedFile,
    TransformedView,
    canonical_bytes,
    fit_within,
    manifest_version_for,
    obb_corners,
    obb_enclosing_box,
    obb_from_corners,
    obb_polygon,
    recipe_hash,
    rot90_quarter_turns,
    transform_manifest,
    variant_seed,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.domain.preprocessing_transform import _mirrored, _rotated_once
from visionset.kernel.errors import PreprocessingStepUnsupportedGeometry
from visionset.server.models import GeometryBody, ObbBody, geometry_of
from visionset.wire import geometry as wire_geometry

geometry_adapter: TypeAdapter[Geometry] = TypeAdapter(Geometry)
body_adapter: TypeAdapter[ObbBody] = TypeAdapter(GeometryBody)  # type: ignore[arg-type]

Point = tuple[float, float]


def _box(cx: float, cy: float, width: float, height: float, angle: float) -> ObbGeometry:
    return ObbGeometry(cx=cx, cy=cy, width=width, height=height, angle=angle)


def _same_ring(first: Iterable[Point], second: Iterable[Point]) -> bool:
    """Whether two point sets are the same within float noise, in any order."""
    left = sorted((round(x, 9), round(y, 9)) for x, y in first)
    right = sorted((round(x, 9), round(y, 9)) for x, y in second)
    return len(left) == len(right) and all(
        isclose(a, c, abs_tol=1e-9) and isclose(b, d, abs_tol=1e-9)
        for (a, b), (c, d) in zip(left, right, strict=True)
    )


# --- canonical form -----------------------------------------------------------


def test_the_wire_shape_is_flat_and_typed() -> None:
    box = geometry_adapter.validate_python(
        {"type": "obb", "cx": 10, "cy": 20, "width": 8, "height": 4, "angle": 0.25}
    )
    assert isinstance(box, ObbGeometry)
    assert json.loads(box.model_dump_json()) == {
        "type": "obb",
        "cx": 10.0,
        "cy": 20.0,
        "width": 8.0,
        "height": 4.0,
        "angle": 0.25,
    }


def test_a_tall_box_becomes_a_wide_one_turned_a_quarter() -> None:
    tall = _box(5.0, 5.0, 2.0, 4.0, 0.0)
    wide = _box(5.0, 5.0, 4.0, 2.0, pi / 2)

    assert (tall.width, tall.height, tall.angle) == (4.0, 2.0, -pi / 2)
    assert tall.model_dump_json() == wide.model_dump_json()


@pytest.mark.parametrize("angle", [pi / 2, -pi / 2, 3 * pi / 2, -3 * pi / 2])
def test_the_half_turn_boundary_lands_on_its_lower_end(angle: float) -> None:
    assert _box(0.0, 0.0, 4.0, 2.0, angle).angle == -pi / 2


def test_a_negative_zero_angle_is_written_as_zero() -> None:
    box = _box(0.0, 0.0, 4.0, 2.0, -0.0)
    assert box.model_dump_json() == _box(0.0, 0.0, 4.0, 2.0, 0.0).model_dump_json()
    assert '"angle":0.0' in box.model_dump_json()


def test_a_square_reduces_its_angle_to_a_quarter_turn() -> None:
    assert _box(0.0, 0.0, 3.0, 3.0, pi / 4).angle == -pi / 4
    assert _box(0.0, 0.0, 3.0, 3.0, pi / 2).angle == 0.0
    assert isclose(_box(0.0, 0.0, 3.0, 3.0, 1.0).angle, 1.0 - pi / 2, abs_tol=1e-12)


@pytest.mark.parametrize("turns", [-3, -1, 1, 2, 5])
def test_a_whole_number_of_half_turns_is_the_same_box(turns: int) -> None:
    base = _box(1.0, 2.0, 6.0, 3.0, 0.3)
    turned = _box(1.0, 2.0, 6.0, 3.0, 0.3 + turns * pi)

    assert -pi / 2 <= turned.angle < pi / 2
    assert isclose(turned.angle, base.angle, abs_tol=1e-12)
    assert _same_ring(obb_corners(turned), obb_corners(base))


@pytest.mark.parametrize(
    ("width", "height", "angle"),
    [(4.0, 2.0, 0.3), (2.0, 4.0, 0.3), (4.0, 2.0, -1.4), (3.0, 3.0, 2.9), (5.0, 1.0, -pi / 2)],
)
def test_a_canonical_box_is_a_fixed_point(width: float, height: float, angle: float) -> None:
    once = _box(7.0, 8.0, width, height, angle)
    twice = ObbGeometry.model_validate(once.model_dump())

    assert once.width >= once.height
    assert -pi / 2 <= once.angle < pi / 2
    assert canonical_bytes(twice) == canonical_bytes(once)


# --- refusals -----------------------------------------------------------------


@pytest.mark.parametrize("field", ["width", "height"])
@pytest.mark.parametrize("value", [0.0, -1.0])
def test_a_box_without_area_is_refused(field: str, value: float) -> None:
    sent = {"cx": 1.0, "cy": 1.0, "width": 2.0, "height": 2.0, "angle": 0.0, field: value}
    with pytest.raises(ValidationError, match="greater than 0"):
        ObbGeometry.model_validate(sent)


@pytest.mark.parametrize("field", ["cx", "cy", "width", "height", "angle"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_a_nonfinite_value_is_refused(field: str, value: float) -> None:
    sent = {"cx": 1.0, "cy": 1.0, "width": 2.0, "height": 2.0, "angle": 0.0, field: value}
    with pytest.raises(ValidationError, match="finite number"):
        ObbGeometry.model_validate(sent)


def test_a_box_whose_corners_overflow_is_refused() -> None:
    with pytest.raises(ValidationError, match="corners are not finite"):
        _box(1.7e308, 0.0, 1.7e308, 1.0, 0.0)


def test_an_unknown_key_is_refused() -> None:
    with pytest.raises(ValidationError):
        geometry_adapter.validate_python(
            {"type": "obb", "x": 0, "y": 0, "width": 2, "height": 1, "angle": 0}
        )


# --- conversions --------------------------------------------------------------


def test_the_corners_follow_the_width_side_then_the_height_side() -> None:
    angle = 0.5
    box = _box(10.0, 20.0, 8.0, 4.0, angle)
    u = (cos(angle) * 4.0, sin(angle) * 4.0)
    v = (-sin(angle) * 2.0, cos(angle) * 2.0)
    expected = [
        (10.0 - u[0] - v[0], 20.0 - u[1] - v[1]),
        (10.0 + u[0] - v[0], 20.0 + u[1] - v[1]),
        (10.0 + u[0] + v[0], 20.0 + u[1] + v[1]),
        (10.0 - u[0] + v[0], 20.0 - u[1] + v[1]),
    ]
    assert _same_ring(obb_corners(box), expected)
    assert obb_corners(box)[0] == pytest.approx(expected[0])
    assert obb_corners(box)[1] == pytest.approx(expected[1])


def test_at_angle_zero_the_corners_are_a_bounding_boxs_ring() -> None:
    assert obb_corners(_box(5.0, 4.0, 6.0, 2.0, 0.0)) == (
        (2.0, 3.0),
        (8.0, 3.0),
        (8.0, 5.0),
        (2.0, 5.0),
    )


def test_the_polygon_is_the_four_corners_exactly() -> None:
    box = _box(10.0, 20.0, 8.0, 4.0, 0.5)
    polygon = obb_polygon(box)

    assert isinstance(polygon, PolygonGeometry)
    assert polygon.points == list(obb_corners(box))


def test_the_enclosing_box_holds_every_corner_and_no_more() -> None:
    box = _box(10.0, 10.0, 4.0, 2.0, pi / 4)
    enclosing = obb_enclosing_box(box)
    half = (4.0 + 2.0) / 2 / sqrt(2)

    assert isinstance(enclosing, BboxGeometry)
    assert (enclosing.x, enclosing.y) == pytest.approx((10.0 - half, 10.0 - half))
    assert (enclosing.width, enclosing.height) == pytest.approx((2 * half, 2 * half))


def test_an_axis_aligned_box_encloses_exactly_itself() -> None:
    assert obb_enclosing_box(_box(5.0, 4.0, 6.0, 2.0, 0.0)) == BboxGeometry(
        x=2.0, y=3.0, width=6.0, height=2.0
    )


@pytest.mark.parametrize("start", range(4))
@pytest.mark.parametrize("reverse", [False, True])
def test_four_corners_recover_the_box_from_any_start_either_way_round(
    start: int, reverse: bool
) -> None:
    box = _box(30.0, 40.0, 12.0, 5.0, 0.7)
    corners = list(obb_corners(box))
    if reverse:
        corners.reverse()
    corners = corners[start:] + corners[:start]

    recovered = obb_from_corners(corners)

    assert (recovered.cx, recovered.cy) == pytest.approx((box.cx, box.cy))
    assert (recovered.width, recovered.height) == pytest.approx((box.width, box.height))
    assert isclose(recovered.angle, box.angle, abs_tol=1e-9)


@pytest.mark.parametrize(
    ("corners", "message"),
    [
        ([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)], "exactly 4 corners"),
        ([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.5, 0.5)], "exactly 4 corners"),
        ([(0.0, 0.0), (1.0, 0.0), (1.0, float("nan")), (0.0, 1.0)], "finite"),
        ([(0.0, 0.0), (0.0, 0.0), (0.0, 0.0), (0.0, 0.0)], "nonzero area"),
        ([(0.0, 0.0), (4.0, 0.0), (4.0, 0.0), (0.0, 0.0)], "nonzero area"),
        ([(0.0, 0.0), (4.0, 0.0), (5.0, 2.0), (1.0, 2.0)], "not perpendicular"),
        ([(0.0, 0.0), (4.0, 0.0), (3.0, 2.0), (1.0, 2.0)], "opposite sides differ"),
        ([(0.0, 0.0), (4.0, 0.0), (0.0, 2.0), (4.0, 2.0)], "opposite sides differ"),
    ],
    ids=["three", "five", "nan", "a point", "a line", "parallelogram", "trapezoid", "bowtie"],
)
def test_corners_that_are_not_one_rectangle_are_refused(corners: list[Point], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        obb_from_corners(corners)


# --- the frame ----------------------------------------------------------------


def test_a_box_whose_enclosing_box_touches_the_frame_but_itself_does_not_is_outside() -> None:
    # A diamond off the top-left corner: its axis-aligned box reaches (1.07, 1.07),
    # the rectangle itself stops twelve L1 pixels short of the frame.
    diamond = _box(-6.0, -6.0, 10.0, 10.0, pi / 4)
    assert obb_enclosing_box(diamond).x + obb_enclosing_box(diamond).width > 0.0

    assert geometry_intersects_asset(diamond, width=100, height=100) is False


@pytest.mark.parametrize(
    "box",
    [
        _box(-2.0, 50.0, 10.0, 4.0, 0.3),
        _box(50.0, 50.0, 400.0, 400.0, 0.2),
        _box(50.0, 50.0, 10.0, 4.0, 1.0),
    ],
    ids=["across an edge", "around the frame", "inside"],
)
def test_a_box_meeting_the_frame_is_inside(box: ObbGeometry) -> None:
    assert geometry_intersects_asset(box, width=100, height=100) is True


def test_a_box_wholly_off_the_frame_is_outside() -> None:
    assert (
        geometry_intersects_asset(_box(300.0, 300.0, 10.0, 4.0, 0.5), width=100, height=100)
        is False
    )


# --- the surfaces -------------------------------------------------------------


def test_rest_and_the_wire_carry_the_canonical_values() -> None:
    body = body_adapter.validate_python(
        {"type": "obb", "cx": 1, "cy": 2, "width": 2, "height": 4, "angle": 0}
    )
    stored = body.to_domain()

    assert stored == _box(1.0, 2.0, 4.0, 2.0, -pi / 2)
    assert geometry_of(stored) == ObbBody.of(stored)
    assert wire_geometry(stored) == {
        "type": "obb",
        "cx": 1.0,
        "cy": 2.0,
        "width": 4.0,
        "height": 2.0,
        "angle": -pi / 2,
    }


def test_a_scan_refuses_a_rotated_box() -> None:
    from visionset.kernel.domain import geometry_fits_modality, geometry_needs_calibration

    box = _box(1.0, 2.0, 4.0, 2.0, 0.1)
    assert geometry_fits_modality(box, modality="image") is True
    assert geometry_fits_modality(box, modality="point_cloud") is False
    assert geometry_needs_calibration(box, modality="image") is False


# --- the manifest -------------------------------------------------------------


def _annotation(geometry: Geometry) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=uuid4(), label_class="ship", schema_version=1, geometry=geometry, provenance="human"
    )


def _asset(
    *geometries: Geometry, width: int | None = 100, height: int | None = 200
) -> ManifestAsset:
    return ManifestAsset(
        asset_id=uuid4(),
        content_hash="ab",
        uri="/img/ab.jpg",
        width=width,
        height=height,
        annotations=tuple(_annotation(geometry) for geometry in geometries),
    )


def test_a_release_holding_a_rotated_box_is_written_at_version_8() -> None:
    plain = _asset(BboxGeometry(x=1.0, y=1.0, width=2.0, height=2.0))
    rotated = _asset(_box(5.0, 5.0, 4.0, 2.0, 0.2))

    assert OBB_MANIFEST_VERSION == TRACKED_MANIFEST_VERSION + 1 == 8
    assert manifest_version_for([plain]) == 3
    assert manifest_version_for([plain, rotated]) == OBB_MANIFEST_VERSION


def test_an_earlier_manifest_version_cannot_carry_a_rotated_box() -> None:
    classes = (LabelClass(name="ship", geometries=(GeometryType.OBB,)),)
    with pytest.raises(ValidationError, match="an obb label needs version 8"):
        Manifest(
            manifest_version=7,
            schema_version=1,
            classes=classes,
            assets=(_asset(_box(5.0, 5.0, 4.0, 2.0, 0.2)),),
        )


# --- pre-processing -----------------------------------------------------------


BOX = _box(30.0, 50.0, 20.0, 8.0, 0.4)


def _spec(*steps: ResizeStep | AugmentStep, variants: int = 0) -> RecipeSpec:
    return RecipeSpec(target=None, steps=steps, variants_per_asset=variants)


def _only_box(file: TransformedFile) -> ObbGeometry:
    (geometry,) = [one.geometry for one in file.annotations]
    assert isinstance(geometry, ObbGeometry)
    return geometry


def test_letterbox_scales_the_box_about_the_origin_then_offsets_it() -> None:
    # 100×200 onto 400×400: scale 2, content 200×400, offset (100, 0).
    step = ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=400, height=400)
    (file,) = transform_manifest(
        Manifest(schema_version=1, assets=(_asset(BOX),)), _spec(step), None
    ).files

    moved = _only_box(file)
    assert moved == _box(160.0, 100.0, 40.0, 16.0, 0.4)
    assert _same_ring(obb_corners(moved), [(2 * x + 100.0, 2 * y) for x, y in obb_corners(BOX)])


@pytest.mark.parametrize(
    "strategy", [ResizeStrategy.STRETCH, ResizeStrategy.FILL, ResizeStrategy.CENTER_CROP]
)
def test_a_resize_that_cannot_keep_a_rectangle_refuses_it(strategy: ResizeStrategy) -> None:
    step = ResizeStep(strategy=strategy, width=64, height=96)
    asset = _asset(BOX)
    with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
        transform_manifest(Manifest(schema_version=1, assets=(asset,)), _spec(step), None)
    assert (caught.value.step, caught.value.geometry) == ("resize", "obb")
    assert caught.value.asset_id == str(asset.asset_id)


def test_a_mirror_reflects_the_corners_and_negates_the_angle() -> None:
    mirrored = _mirrored(BOX, 100.0)

    assert isinstance(mirrored, ObbGeometry)
    assert mirrored == _box(70.0, 50.0, 20.0, 8.0, -0.4)
    assert _same_ring(obb_corners(mirrored), [(100.0 - x, y) for x, y in obb_corners(BOX)])


@pytest.mark.parametrize("angle", [0.0, 0.4, -1.2, pi / 4, -pi / 2])
def test_a_quarter_turn_rotates_every_corner_counter_clockwise(angle: float) -> None:
    box = _box(30.0, 50.0, 20.0, 8.0, angle)
    turned = _rotated_once(box, 100.0)

    assert isinstance(turned, ObbGeometry)
    assert (turned.cx, turned.cy) == (50.0, 70.0)
    assert (turned.width, turned.height) == (20.0, 8.0)
    assert _same_ring(obb_corners(turned), [(y, 100.0 - x) for x, y in obb_corners(box)])


def test_an_axis_aligned_box_turns_exactly() -> None:
    assert _rotated_once(_box(30.0, 50.0, 20.0, 8.0, 0.0), 100.0) == _box(
        50.0, 70.0, 20.0, 8.0, -pi / 2
    )


def test_four_quarter_turns_return_the_box() -> None:
    box: Geometry = BOX
    widths = [100.0, 200.0, 100.0, 200.0]
    for width in widths:
        box = _rotated_once(box, width)

    assert isinstance(box, ObbGeometry)
    assert (box.cx, box.cy, box.width, box.height) == pytest.approx((30.0, 50.0, 20.0, 8.0))
    assert isclose(box.angle, BOX.angle, abs_tol=1e-12)


def test_rot90_and_hflip_variants_carry_the_box() -> None:
    asset = _asset(BOX)
    for op in (AugmentOp.ROT90, AugmentOp.HFLIP, AugmentOp.BRIGHTNESS_CONTRAST):
        spec = _spec(AugmentStep(op=op), variants=1)
        view = transform_manifest(
            Manifest(schema_version=1, assets=(asset,)),
            spec,
            SplitAssignment(train=(asset.asset_id,)),
        )
        (variant,) = [file for file in view.files if file.variant == 1]
        assert _only_box(variant).type is GeometryType.OBB
        if op is AugmentOp.ROT90:
            turns = rot90_quarter_turns(variant_seed(recipe_hash(spec), asset.content_hash, 1))
            expected = list(obb_corners(BOX))
            width = 100.0
            for _ in range(turns):
                expected = [(y, width - x) for x, y in expected]
                width = 200.0 if width == 100.0 else 100.0
            assert _same_ring(obb_corners(_only_box(variant)), expected)


def test_the_preview_cap_scales_a_box_uniformly() -> None:
    view: TransformedView = transform_manifest(
        Manifest(schema_version=1, assets=(_asset(BOX, width=1000, height=667),)), _spec(), None
    )
    (file,) = view.files
    capped = fit_within(file, 512)
    scale = 512 / 1000

    assert (capped.width, capped.height) == (512, 342)
    assert _only_box(capped) == _box(30.0 * scale, 50.0 * scale, 20.0 * scale, 8.0 * scale, 0.4)
