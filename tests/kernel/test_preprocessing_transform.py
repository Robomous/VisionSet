"""The geometry side of a recipe: every step over every geometry, and the gating.

Expected coordinates are worked by hand from the source frame rather than
through the module's own arithmetic, so a wrong sign in the rotation or a
swapped offset in the letterbox fails here instead of agreeing with itself.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from visionset.kernel.domain import (
    AUGMENT_GEOMETRIES,
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
    letterbox_fit,
    recipe_hash,
    rot90_quarter_turns,
    transform_manifest,
    variant_seed,
)
from visionset.kernel.errors import (
    AugmentationRequiresSplit,
    ExportSourceUnreadable,
    PreprocessingStepUnsupportedGeometry,
)

BBOX = BboxGeometry(x=10.0, y=20.0, width=30.0, height=40.0)
POLYGON = PolygonGeometry(points=[(0.0, 0.0), (50.0, 0.0), (50.0, 100.0)])
POLYLINE = PolylineGeometry(points=[(5.0, 10.0), (60.0, 150.0)])
TAG = ClassificationGeometry()
EVERY_GEOMETRY: tuple[Geometry, ...] = (BBOX, POLYGON, POLYLINE, TAG)


def _annotation(geometry: Geometry, identifier: UUID | None = None) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=identifier or uuid4(),
        label_class="thing",
        schema_version=1,
        geometry=geometry,
        attributes={"colour": "red"},
        provenance="model",
        model_ref="detector:1",
        confidence=0.75,
    )


def _asset(
    *geometries: Geometry,
    content_hash: str = "aa",
    width: int | None = 100,
    height: int | None = 200,
) -> ManifestAsset:
    return ManifestAsset(
        asset_id=uuid4(),
        content_hash=content_hash,
        uri=f"/img/{content_hash}.jpg",
        width=width,
        height=height,
        annotations=tuple(_annotation(geometry) for geometry in geometries),
    )


def _manifest(*assets: ManifestAsset) -> Manifest:
    return Manifest(schema_version=1, assets=assets)


def _train(*assets: ManifestAsset) -> SplitAssignment:
    return SplitAssignment(train=tuple(asset.asset_id for asset in assets))


def _spec(*steps: ResizeStep | AugmentStep, variants: int = 0) -> RecipeSpec:
    return RecipeSpec(target=None, steps=steps, variants_per_asset=variants)


def _geometry_of(file: TransformedFile, kind: type[Geometry]) -> Geometry:
    (match,) = [one.geometry for one in file.annotations if isinstance(one.geometry, kind)]
    return match


# --- letterbox arithmetic ---------------------------------------------------


@pytest.mark.parametrize(
    ("width", "height", "target", "expected"),
    [
        # A 4:3 landscape onto a square: the width already fits, the height pads.
        (640, 480, (640, 640), (1.0, 640, 480, 0, 80)),
        # Downscale, limited by the wider axis.
        (1000, 750, (640, 640), (0.64, 640, 480, 0, 80)),
        # Upscale, limited by the taller axis; the margin splits evenly.
        (50, 100, (640, 640), (6.4, 320, 640, 160, 0)),
        # Odd sizes: the content rounds and the odd margin floors.
        (100, 99, (64, 64), (0.64, 64, 63, 0, 0)),
        (99, 100, (65, 65), (0.65, 64, 65, 0, 0)),
        # A non-square canvas.
        (200, 100, (300, 300), (1.5, 300, 150, 0, 75)),
    ],
)
def test_letterbox_fit_matches_the_hand_computed_reference(
    width: int,
    height: int,
    target: tuple[int, int],
    expected: tuple[float, int, int, int, int],
) -> None:
    fit = letterbox_fit(width, height, target_width=target[0], target_height=target[1])
    assert (
        fit.scale,
        fit.content_width,
        fit.content_height,
        fit.offset_x,
        fit.offset_y,
    ) == pytest.approx(expected)


# --- resize × geometry ------------------------------------------------------


def test_stretch_scales_each_axis_on_its_own() -> None:
    step = ResizeStep(strategy=ResizeStrategy.STRETCH, width=200, height=100)
    (file,) = transform_manifest(_manifest(_asset(*EVERY_GEOMETRY)), _spec(step), None).files

    assert (file.width, file.height) == (200, 100)
    assert _geometry_of(file, BboxGeometry) == BboxGeometry(x=20.0, y=10.0, width=60.0, height=20.0)
    assert _geometry_of(file, PolygonGeometry) == PolygonGeometry(
        points=[(0.0, 0.0), (100.0, 0.0), (100.0, 50.0)]
    )
    assert _geometry_of(file, PolylineGeometry) == PolylineGeometry(
        points=[(10.0, 5.0), (120.0, 75.0)]
    )
    assert _geometry_of(file, ClassificationGeometry) == TAG


def test_letterbox_scales_then_offsets() -> None:
    # 100×200 onto 400×400: scale 2, content 200×400, offset (100, 0).
    step = ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=400, height=400)
    (file,) = transform_manifest(_manifest(_asset(*EVERY_GEOMETRY)), _spec(step), None).files

    assert (file.width, file.height) == (400, 400)
    assert _geometry_of(file, BboxGeometry) == BboxGeometry(
        x=120.0, y=40.0, width=60.0, height=80.0
    )
    assert _geometry_of(file, PolygonGeometry) == PolygonGeometry(
        points=[(100.0, 0.0), (200.0, 0.0), (200.0, 200.0)]
    )
    assert _geometry_of(file, PolylineGeometry) == PolylineGeometry(
        points=[(110.0, 20.0), (220.0, 300.0)]
    )
    assert _geometry_of(file, ClassificationGeometry) == TAG


def test_a_resize_needs_the_source_size_only_when_something_has_coordinates() -> None:
    step = ResizeStep(strategy=ResizeStrategy.STRETCH, width=64, height=64)
    (file,) = transform_manifest(
        _manifest(_asset(TAG, width=None, height=None)), _spec(step), None
    ).files
    assert (file.width, file.height) == (64, 64)

    with pytest.raises(ExportSourceUnreadable, match="records no pixel dimensions"):
        transform_manifest(_manifest(_asset(BBOX, width=None, height=None)), _spec(step), None)


def test_without_a_resize_the_base_file_keeps_the_source_size() -> None:
    (file,) = transform_manifest(_manifest(_asset(BBOX)), _spec(), None).files
    assert (file.width, file.height) == (100, 200)
    assert _geometry_of(file, BboxGeometry) == BBOX


# --- augmentation × geometry ----------------------------------------------


def _only_variant(spec: RecipeSpec, *geometries: Geometry) -> TransformedFile:
    asset = _asset(*geometries)
    view = transform_manifest(_manifest(asset), spec, _train(asset))
    (variant,) = [file for file in view.files if file.variant == 1]
    return variant


def test_hflip_mirrors_in_the_frame_width_and_keeps_polyline_order() -> None:
    spec = _spec(AugmentStep(op=AugmentOp.HFLIP), variants=1)
    variant = _only_variant(spec, *EVERY_GEOMETRY)

    assert (variant.width, variant.height) == (100, 200)
    assert _geometry_of(variant, BboxGeometry) == BboxGeometry(
        x=60.0, y=20.0, width=30.0, height=40.0
    )
    assert _geometry_of(variant, PolygonGeometry) == PolygonGeometry(
        points=[(100.0, 0.0), (50.0, 0.0), (50.0, 100.0)]
    )
    assert _geometry_of(variant, PolylineGeometry) == PolylineGeometry(
        points=[(95.0, 10.0), (40.0, 150.0)]
    )
    assert _geometry_of(variant, ClassificationGeometry) == TAG


@pytest.mark.parametrize("content_hash", [f"content-{candidate}" for candidate in range(8)])
def test_an_hflip_variant_is_never_its_source(content_hash: str) -> None:
    """Whatever the seed draws, a variant mirrors: an unmirrored one would copy the base image."""
    spec = _spec(AugmentStep(op=AugmentOp.HFLIP), variants=1)
    asset = _asset(BBOX, POLYLINE, content_hash=content_hash)
    view = transform_manifest(_manifest(asset), spec, _train(asset))
    (variant,) = [file for file in view.files if file.variant == 1]
    assert _geometry_of(variant, BboxGeometry) != BBOX
    assert _geometry_of(variant, PolylineGeometry) != POLYLINE


def test_brightness_contrast_changes_no_geometry_and_no_size() -> None:
    spec = _spec(AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.5), variants=1)
    variant = _only_variant(spec, *EVERY_GEOMETRY)
    assert (variant.width, variant.height) == (100, 200)
    assert len(variant.annotations) == 4
    for geometry in EVERY_GEOMETRY:
        assert _geometry_of(variant, type(geometry)) == geometry


def test_rot90_rotates_boxes_and_polygons_counter_clockwise() -> None:
    spec = _spec(AugmentStep(op=AugmentOp.ROT90), variants=1)
    asset = _asset(BBOX, POLYGON, TAG, content_hash="rot")
    view = transform_manifest(_manifest(asset), spec, _train(asset))
    (variant,) = [file for file in view.files if file.variant == 1]
    turns = rot90_quarter_turns(variant_seed(recipe_hash(spec), "rot", 1))

    # Hand-derived for a 100×200 frame, one counter-clockwise quarter turn at a
    # time: (x, y) → (y, W − x), and the frame becomes H×W.
    expected_bbox = {
        1: BboxGeometry(x=20.0, y=60.0, width=40.0, height=30.0),
        2: BboxGeometry(x=60.0, y=140.0, width=30.0, height=40.0),
        3: BboxGeometry(x=140.0, y=10.0, width=40.0, height=30.0),
    }
    expected_polygon = {
        1: PolygonGeometry(points=[(0.0, 100.0), (0.0, 50.0), (100.0, 50.0)]),
        2: PolygonGeometry(points=[(100.0, 200.0), (50.0, 200.0), (50.0, 100.0)]),
        3: PolygonGeometry(points=[(200.0, 0.0), (200.0, 50.0), (100.0, 50.0)]),
    }
    expected_size = {1: (200, 100), 2: (100, 200), 3: (200, 100)}

    assert (variant.width, variant.height) == expected_size[turns]
    assert _geometry_of(variant, BboxGeometry) == expected_bbox[turns]
    assert _geometry_of(variant, PolygonGeometry) == expected_polygon[turns]
    assert _geometry_of(variant, ClassificationGeometry) == TAG


def test_rot90_refuses_a_polyline_and_names_the_step_geometry_and_asset() -> None:
    spec = _spec(AugmentStep(op=AugmentOp.ROT90), variants=1)
    asset = _asset(POLYLINE)
    with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
        transform_manifest(_manifest(asset), spec, _train(asset))
    assert caught.value.step == "rot90"
    assert caught.value.geometry == "polyline"
    assert caught.value.asset_id == str(asset.asset_id)


@pytest.mark.parametrize("op", list(AugmentOp))
@pytest.mark.parametrize("geometry", EVERY_GEOMETRY, ids=lambda geometry: geometry.type.value)
def test_a_step_transforms_exactly_the_geometries_it_declares(
    op: AugmentOp, geometry: Geometry
) -> None:
    step = AugmentStep(op=op)
    spec = _spec(step, variants=1)
    asset = _asset(geometry)

    if geometry.type in step.supported_geometries:
        view = transform_manifest(_manifest(asset), spec, _train(asset))
        (variant,) = [file for file in view.files if file.variant == 1]
        assert variant.annotations[0].geometry.type is geometry.type
        return
    with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
        transform_manifest(_manifest(asset), spec, _train(asset))
    assert (caught.value.step, caught.value.geometry) == (op.value, geometry.type.value)
    assert caught.value.asset_id == str(asset.asset_id)


def test_the_refusal_reads_the_declaration_not_the_arithmetic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Narrowing hflip's declared geometries makes it refuse a box it can mirror."""
    narrowed = AUGMENT_GEOMETRIES[AugmentOp.HFLIP] - {GeometryType.BBOX}
    monkeypatch.setitem(AUGMENT_GEOMETRIES, AugmentOp.HFLIP, narrowed)
    spec = _spec(AugmentStep(op=AugmentOp.HFLIP), variants=1)
    asset = _asset(BBOX)

    with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
        transform_manifest(_manifest(asset), spec, _train(asset))
    assert (caught.value.step, caught.value.geometry) == ("hflip", "bbox")


def test_a_resize_consults_its_declaration_on_the_base_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        ResizeStep, "supported_geometries", property(lambda step: frozenset({GeometryType.BBOX}))
    )
    step = ResizeStep(strategy=ResizeStrategy.STRETCH, width=64, height=64)

    with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
        transform_manifest(_manifest(_asset(POLYGON)), _spec(step), None)
    assert (caught.value.step, caught.value.geometry) == ("resize", "polygon")


def test_rot90_leaves_a_polyline_outside_the_train_fold_alone() -> None:
    spec = _spec(AugmentStep(op=AugmentOp.ROT90), variants=1)
    asset = _asset(POLYLINE)
    view = transform_manifest(_manifest(asset), spec, SplitAssignment(val=(asset.asset_id,)))
    assert [file.variant for file in view.files] == [0]


def test_rot90_swaps_the_size_of_a_tag_only_asset_without_needing_coordinates() -> None:
    spec = _spec(AugmentStep(op=AugmentOp.ROT90), variants=1)
    asset = _asset(TAG, content_hash="tag-only", width=None, height=None)
    view = transform_manifest(_manifest(asset), spec, _train(asset))
    assert {(file.width, file.height) for file in view.files} == {(None, None)}


def test_steps_compose_in_recipe_order_resize_first() -> None:
    resize = ResizeStep(strategy=ResizeStrategy.STRETCH, width=200, height=100)
    spec = _spec(resize, AugmentStep(op=AugmentOp.HFLIP), variants=1)
    variant = _only_variant(spec, BBOX)
    # Stretched to (20, 10, 60, 20) in a 200-wide frame, then mirrored: x = 200 − 20 − 60.
    assert (variant.width, variant.height) == (200, 100)
    assert _geometry_of(variant, BboxGeometry) == BboxGeometry(
        x=120.0, y=10.0, width=60.0, height=20.0
    )


# --- gating and identity ----------------------------------------------------


def test_augmentation_without_a_split_recipe_is_refused() -> None:
    spec = _spec(AugmentStep(op=AugmentOp.HFLIP), variants=1)
    with pytest.raises(AugmentationRequiresSplit, match="no split recipe"):
        transform_manifest(_manifest(_asset(BBOX)), spec, None)


def test_variants_are_generated_for_the_train_fold_only() -> None:
    train, val, test = (
        _asset(BBOX, content_hash="t"),
        _asset(BBOX, content_hash="v"),
        _asset(BBOX, content_hash="s"),
    )
    folds = SplitAssignment(train=(train.asset_id,), val=(val.asset_id,), test=(test.asset_id,))
    spec = _spec(AugmentStep(op=AugmentOp.HFLIP), variants=2)

    view = transform_manifest(_manifest(train, val, test), spec, folds)

    by_asset = {
        asset_id: [(file.variant, file.fold) for file in view.files if file.asset_id == asset_id]
        for asset_id in (train.asset_id, val.asset_id, test.asset_id)
    }
    assert by_asset[train.asset_id] == [(0, "train"), (1, "train"), (2, "train")]
    assert by_asset[val.asset_id] == [(0, "val")]
    assert by_asset[test.asset_id] == [(0, "test")]
    assert (view.source_file_count, view.augmented_file_count) == (3, 2)


def test_a_release_without_a_split_still_exports_base_images_when_nothing_augments() -> None:
    step = ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=64, height=64)
    view = transform_manifest(
        _manifest(_asset(BBOX), _asset(TAG, content_hash="bb")), _spec(step), None
    )
    assert [(file.variant, file.fold) for file in view.files] == [(0, None), (0, None)]


def test_files_follow_the_manifest_order_base_first_then_variants() -> None:
    first, second = _asset(BBOX, content_hash="0001"), _asset(BBOX, content_hash="0002")
    spec = _spec(AugmentStep(op=AugmentOp.HFLIP), variants=2)
    view = transform_manifest(_manifest(second, first), spec, _train(first, second))
    assert [(file.content_hash, file.variant) for file in view.files] == [
        ("0001", 0),
        ("0001", 1),
        ("0001", 2),
        ("0002", 0),
        ("0002", 1),
        ("0002", 2),
    ]


def test_a_variant_annotation_is_the_source_annotation_with_a_suffixed_id() -> None:
    identifier = uuid4()
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="cc",
        uri="/img/cc.jpg",
        width=100,
        height=200,
        annotations=(_annotation(BBOX, identifier),),
    )
    spec = _spec(AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST), variants=2)
    base, first, second = transform_manifest(_manifest(asset), spec, _train(asset)).files

    assert [one.id for one in base.annotations] == [str(identifier)]
    assert [one.id for one in first.annotations] == [f"{identifier}-aug1"]
    assert [one.id for one in second.annotations] == [f"{identifier}-aug2"]
    (copied,) = second.annotations
    assert (copied.label_class, copied.schema_version, copied.provenance) == ("thing", 1, "model")
    assert (copied.attributes, copied.model_ref, copied.confidence) == (
        {"colour": "red"},
        "detector:1",
        0.75,
    )
    assert base.content_hash == first.content_hash == second.content_hash == "cc"


def test_the_view_is_deterministic_for_one_spec_and_one_manifest() -> None:
    asset = _asset(BBOX, POLYGON)
    spec = _spec(
        ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=640, height=640),
        AugmentStep(op=AugmentOp.HFLIP),
        AugmentStep(op=AugmentOp.ROT90),
        variants=3,
    )
    manifest = _manifest(asset)
    assert transform_manifest(manifest, spec, _train(asset)) == transform_manifest(
        manifest, spec, _train(asset)
    )
