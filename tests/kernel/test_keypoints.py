"""Keypoints: the geometry, the class's spec, and every rule that holds them together."""

from __future__ import annotations

import json
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from visionset.kernel.domain import (
    KEYPOINTS_MANIFEST_VERSION,
    SCAN_SEQUENCE_MANIFEST_VERSION,
    AnnotationSchema,
    BboxGeometry,
    ChangeKind,
    DraftKeypointSpec,
    DraftLabelClass,
    Geometry,
    GeometryType,
    KeypointsGeometry,
    KeypointSpec,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    OrphanGuard,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    VertexVisibility,
    canonical_bytes,
    diff_classes,
    fit_within,
    geometry_fits_modality,
    manifest_version_for,
    transform_manifest,
    validate_schema_annotation,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.errors import KeypointCountMismatch, PreprocessingStepUnsupportedGeometry

geometry_adapter: TypeAdapter[Geometry] = TypeAdapter(Geometry)

NAMES = ("nose", "left_eye", "right_eye")
SPEC = KeypointSpec(names=NAMES, skeleton=((0, 1), (0, 2)))
FACE = LabelClass(name="face", geometries=(GeometryType.KEYPOINTS,), keypoints=SPEC)
LOOSE = LabelClass(name="hand", geometries=(GeometryType.KEYPOINTS, GeometryType.BBOX))
THREE = KeypointsGeometry(
    points=[(4.0, 2.0), (1.0, 1.0), (7.0, 1.0)],
    visibility=(VertexVisibility.VISIBLE, VertexVisibility.OCCLUDED, VertexVisibility.UNLABELED),
)


# --- the geometry ------------------------------------------------------------------------


def test_keypoints_keep_their_order_duplicates_and_visibility() -> None:
    parsed = geometry_adapter.validate_python(
        {"type": "keypoints", "points": [[9, 9], [1, 1], [9, 9]], "visibility": [2, 0, 1]}
    )

    assert isinstance(parsed, KeypointsGeometry)
    assert parsed.points == [(9.0, 9.0), (1.0, 1.0), (9.0, 9.0)]
    assert parsed.visibility == (2, 0, 1)


def test_a_single_keypoint_is_a_geometry_and_none_is_not() -> None:
    assert KeypointsGeometry(points=[(1.0, 1.0)]).points == [(1.0, 1.0)]
    with pytest.raises(ValidationError, match="too_short"):
        KeypointsGeometry(points=[])


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_a_nonfinite_coordinate_is_refused(value: float) -> None:
    with pytest.raises(ValidationError, match="finite_number"):
        KeypointsGeometry(points=[(1.0, 1.0), (value, 2.0)])


@pytest.mark.parametrize("state", [True, "2", 2.0, 3, -1, None])
def test_visibility_is_a_strict_integer_state(state: object) -> None:
    with pytest.raises(ValidationError):
        geometry_adapter.validate_python(
            {"type": "keypoints", "points": [[1, 1]], "visibility": [state]}
        )


def test_visibility_names_one_state_per_point() -> None:
    with pytest.raises(ValidationError, match="names 1 vertices and the geometry has 2 points"):
        KeypointsGeometry(points=[(1.0, 1.0), (2.0, 2.0)], visibility=(VertexVisibility.VISIBLE,))


def test_visibility_is_omitted_when_unknown() -> None:
    assert KeypointsGeometry(points=[(1.0, 2.0)]).model_dump(mode="json") == {
        "type": "keypoints",
        "points": [[1.0, 2.0]],
    }


def test_keypoints_land_on_the_frame_when_any_point_does() -> None:
    outside = KeypointsGeometry(points=[(-5.0, -5.0), (20.0, 3.0)])
    one_inside = KeypointsGeometry(points=[(-5.0, -5.0), (10.0, 8.0)])

    assert not geometry_intersects_asset(outside, width=10, height=8)
    assert geometry_intersects_asset(one_inside, width=10, height=8)
    assert geometry_intersects_asset(outside, width=None, height=8)


def test_an_unlabeled_point_inside_the_frame_still_lands_the_label() -> None:
    unlabeled_inside = KeypointsGeometry(
        points=[(-5.0, -5.0), (10.0, 8.0)],
        visibility=(VertexVisibility.VISIBLE, VertexVisibility.UNLABELED),
    )

    assert geometry_intersects_asset(unlabeled_inside, width=10, height=8)


def test_keypoints_belong_on_an_image_only() -> None:
    assert geometry_fits_modality(THREE, modality="image")
    assert not geometry_fits_modality(THREE, modality="point_cloud")


# --- the spec ----------------------------------------------------------------------------


def test_a_spec_strips_its_names_and_keeps_its_edges_as_written() -> None:
    spec = KeypointSpec(names=(" nose ", "tail"), skeleton=((1, 0),))
    assert spec.names == ("nose", "tail")
    assert spec.skeleton == ((1, 0),)


@pytest.mark.parametrize(
    ("names", "skeleton", "reason"),
    [
        ((), (), "too_short"),
        (("nose", "  "), (), "non-blank"),
        (("nose", "Nose"), (), "share a name"),
        (NAMES, ((0, 3),), "names keypoint 3, and the spec has 3 keypoints"),
        (NAMES, ((1, 1),), "joins a keypoint to itself"),
        (NAMES, ((0, 1), (1, 0)), r"edge \(1, 0\) appears twice"),
        (NAMES, ((0, -1),), "greater_than_equal"),
        (NAMES, ((0, True),), "int_type"),
        (NAMES, ((0, 1.0),), "int_type"),
    ],
)
def test_an_invalid_spec_is_refused(
    names: tuple[str, ...], skeleton: tuple[tuple[object, object], ...], reason: str
) -> None:
    with pytest.raises(ValidationError, match=reason):
        KeypointSpec.model_validate({"names": names, "skeleton": skeleton})


def test_a_spec_needs_a_class_accepting_keypoints() -> None:
    with pytest.raises(ValidationError, match="does not accept the keypoints geometry"):
        LabelClass(name="car", geometries=(GeometryType.BBOX,), keypoints=SPEC)


def test_a_class_without_a_spec_serializes_as_it_did_before() -> None:
    legacy = {"name": "car", "geometries": ["bbox"], "color": None, "attributes": []}
    assert LabelClass.model_validate(legacy).model_dump(mode="json") == legacy
    assert LabelClass.model_validate({"name": "car", "geometry": "bbox"}).keypoints is None


def test_a_draft_holds_an_unfinished_spec_and_converts_it_at_publish() -> None:
    unfinished = DraftLabelClass(
        name="face",
        geometries=(GeometryType.KEYPOINTS,),
        keypoints=DraftKeypointSpec(names=("nose", ""), skeleton=((0, 5),)),
    )
    with pytest.raises(ValueError, match="non-blank"):
        unfinished.to_label_class()

    finished = unfinished.model_copy(
        update={"keypoints": DraftKeypointSpec(names=NAMES, skeleton=((0, 1), (0, 2)))}
    )
    assert finished.to_label_class() == FACE
    assert "keypoints" not in DraftLabelClass(name="car").model_dump(mode="json")


@pytest.mark.parametrize("edge", [(True, 1), (1.0, 2), ("1", 2)])
def test_a_draft_skeleton_index_is_an_integer_never_coerced(edge: tuple[object, object]) -> None:
    with pytest.raises(ValidationError):
        DraftKeypointSpec.model_validate({"names": ["a", "b"], "skeleton": [edge]})
    dangling = DraftKeypointSpec.model_validate({"names": ["a"], "skeleton": [(-1, 0), (3, 3)]})
    assert dangling.skeleton == ((-1, 0), (3, 3))


# --- the schema rule ---------------------------------------------------------------------


def _schema(*classes: LabelClass) -> AnnotationSchema:
    return AnnotationSchema(project_id=uuid4(), version=4, classes=classes)


def _judge(label_class: str, geometry: Geometry) -> None:
    validate_schema_annotation(
        label_class=label_class, geometry=geometry, attributes={}, schema=_schema(FACE, LOOSE)
    )


def test_a_class_with_a_spec_takes_exactly_its_count() -> None:
    _judge("face", THREE)
    for points in ([(1.0, 1.0), (2.0, 2.0)], [(1.0, 1.0)] * 4):
        with pytest.raises(KeypointCountMismatch, match="names 3 keypoints in schema version 4"):
            _judge("face", KeypointsGeometry(points=points))


def test_a_class_without_a_spec_takes_any_count() -> None:
    for count in (1, 2, 17):
        _judge("hand", KeypointsGeometry(points=[(1.0, 1.0)] * count))
    _judge("hand", BboxGeometry(x=1.0, y=1.0, width=2.0, height=2.0))


# --- schema evolution --------------------------------------------------------------------


def _verdicts(before: LabelClass, after: LabelClass) -> list[tuple[ChangeKind, str]]:
    return [(change.kind, change.detail) for change in diff_classes([before], [after]).changes]


def test_adding_a_spec_to_a_keypoints_class_is_destructive_for_its_keypoints() -> None:
    bare = FACE.model_copy(update={"keypoints": None})
    diff = diff_classes([bare], [FACE])

    assert diff.is_destructive
    assert diff.guards == frozenset(
        {OrphanGuard(label_class="face", geometry=GeometryType.KEYPOINTS)}
    )


@pytest.mark.parametrize(
    "names", [("nose", "left_eye"), ("nose", "left_eye", "right_eye", "chin"), ("a", "b", "c")]
)
def test_renaming_or_resizing_a_spec_is_destructive(names: tuple[str, ...]) -> None:
    changed = FACE.model_copy(update={"keypoints": KeypointSpec(names=names)})
    assert _verdicts(FACE, changed) == [
        (ChangeKind.DESTRUCTIVE, "keypoint spec renamed or resized on class 'face'")
    ]


def test_dropping_a_spec_or_changing_only_its_skeleton_is_additive() -> None:
    rewired = FACE.model_copy(update={"keypoints": KeypointSpec(names=NAMES, skeleton=((1, 2),))})

    assert _verdicts(FACE, rewired) == [
        (ChangeKind.ADDITIVE, "keypoint skeleton changed on class 'face'")
    ]
    assert _verdicts(FACE, FACE.model_copy(update={"keypoints": None})) == [
        (ChangeKind.ADDITIVE, "keypoint spec removed from class 'face'")
    ]
    assert _verdicts(FACE, FACE) == []


def test_a_spec_arriving_with_the_keypoints_geometry_is_additive() -> None:
    boxes = LabelClass(name="face", geometries=(GeometryType.BBOX,))
    widened = FACE.model_copy(update={"geometries": (GeometryType.BBOX, GeometryType.KEYPOINTS)})

    assert not diff_classes([boxes], [widened]).is_destructive


# --- the manifest ------------------------------------------------------------------------


def _annotation(geometry: Geometry, label_class: str = "face") -> ManifestAnnotation:
    return ManifestAnnotation(
        id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


def _asset(*geometries: Geometry, width: int = 10, height: int = 8) -> ManifestAsset:
    return ManifestAsset(
        asset_id=uuid4(),
        content_hash="ab",
        uri="/img/ab.jpg",
        width=width,
        height=height,
        annotations=tuple(_annotation(geometry) for geometry in geometries),
    )


BOX = BboxGeometry(x=1.0, y=1.0, width=2.0, height=2.0)


def test_only_a_release_using_keypoints_is_written_at_version_12() -> None:
    boxes = LabelClass(name="face", geometries=(GeometryType.BBOX,))

    assert KEYPOINTS_MANIFEST_VERSION == SCAN_SEQUENCE_MANIFEST_VERSION + 1 == 12
    assert manifest_version_for([_asset(BOX)], classes=[boxes]) == 3
    assert manifest_version_for([_asset(BOX)], classes=[LOOSE]) == 3
    assert manifest_version_for([_asset(BOX), _asset(THREE)]) == KEYPOINTS_MANIFEST_VERSION
    assert manifest_version_for([_asset(BOX)], classes=[FACE]) == KEYPOINTS_MANIFEST_VERSION


def test_an_earlier_manifest_version_cannot_carry_keypoints_or_a_spec() -> None:
    with pytest.raises(ValidationError, match="needs version 12"):
        Manifest(manifest_version=11, schema_version=1, classes=(LOOSE,), assets=(_asset(THREE),))
    with pytest.raises(ValidationError, match="needs version 12"):
        Manifest(manifest_version=11, schema_version=1, classes=(FACE,), assets=(_asset(BOX),))


def test_keypoints_and_their_spec_round_trip_through_the_canonical_manifest_bytes() -> None:
    manifest = Manifest(
        manifest_version=KEYPOINTS_MANIFEST_VERSION,
        schema_version=1,
        classes=(FACE,),
        assets=(_asset(THREE),),
    )
    written = canonical_bytes(manifest)
    again = Manifest.model_validate(json.loads(written))

    assert again == manifest
    assert canonical_bytes(again) == written
    assert again.classes[0].keypoints == SPEC
    assert again.assets[0].annotations[0].geometry == THREE


# --- pre-processing ----------------------------------------------------------------------


def _spec(step: ResizeStep) -> RecipeSpec:
    return RecipeSpec(target=None, steps=(step,), variants_per_asset=0)


@pytest.mark.parametrize("strategy", [ResizeStrategy.FILL, ResizeStrategy.CENTER_CROP])
def test_a_cropping_resize_refuses_keypoints(strategy: ResizeStrategy) -> None:
    asset = _asset(THREE)
    step = ResizeStep(strategy=strategy, width=40, height=40)
    with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
        transform_manifest(Manifest(schema_version=1, assets=(asset,)), _spec(step), None)
    assert (caught.value.step, caught.value.geometry) == ("resize", "keypoints")


@pytest.mark.parametrize(
    ("strategy", "expected"),
    [
        (ResizeStrategy.STRETCH, [(16.0, 10.0), (4.0, 5.0), (28.0, 5.0)]),
        (ResizeStrategy.LETTERBOX, [(16.0, 12.0), (4.0, 8.0), (28.0, 8.0)]),
    ],
)
def test_a_scaling_resize_moves_keypoints_in_order_with_their_visibility(
    strategy: ResizeStrategy, expected: list[tuple[float, float]]
) -> None:
    step = ResizeStep(strategy=strategy, width=40, height=40)
    view = transform_manifest(
        Manifest(schema_version=1, assets=(_asset(THREE),)), _spec(step), None
    )
    (file,) = view.files
    (annotation,) = file.annotations

    assert annotation.geometry == KeypointsGeometry(points=expected, visibility=THREE.visibility)


def test_the_preview_cap_scales_keypoints() -> None:
    view = transform_manifest(
        Manifest(schema_version=1, assets=(_asset(THREE, width=100, height=80),)),
        RecipeSpec(target=None, steps=(), variants_per_asset=0),
        None,
    )
    (annotation,) = fit_within(view.files[0], 50).annotations

    assert annotation.geometry == KeypointsGeometry(
        points=[(2.0, 1.0), (0.5, 0.5), (3.5, 0.5)], visibility=THREE.visibility
    )
