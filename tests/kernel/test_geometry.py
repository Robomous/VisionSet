from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from visionset.kernel.domain import (
    IMPLEMENTED_GEOMETRIES,
    Annotation,
    BboxGeometry,
    ClassificationGeometry,
    Geometry,
    GeometryType,
    LabelClass,
    PolygonGeometry,
)

geometry_adapter: TypeAdapter[Geometry] = TypeAdapter(Geometry)

VARIANTS = [
    BboxGeometry(x=1.0, y=2.0, width=10.0, height=20.0),
    PolygonGeometry(points=[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]),
    ClassificationGeometry(),
]


def _annotation(geometry: Geometry) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="car",
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


def test_each_variant_round_trips_through_json_unchanged() -> None:
    for geometry in VARIANTS:
        payload = geometry_adapter.dump_json(geometry)
        assert geometry_adapter.dump_json(geometry_adapter.validate_json(payload)) == payload


def test_each_variant_round_trips_nested_in_an_annotation() -> None:
    for geometry in VARIANTS:
        annotation = _annotation(geometry)
        payload = annotation.model_dump_json()
        rehydrated = Annotation.model_validate_json(payload)
        assert rehydrated == annotation
        assert rehydrated.model_dump_json() == payload


def test_discriminator_routes_to_the_right_variant() -> None:
    bbox = geometry_adapter.validate_python(
        {"type": "bbox", "x": 1.0, "y": 2.0, "width": 10.0, "height": 20.0}
    )
    assert isinstance(bbox, BboxGeometry)

    polygon = geometry_adapter.validate_python(
        {"type": "polygon", "points": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]}
    )
    assert isinstance(polygon, PolygonGeometry)

    assert isinstance(
        geometry_adapter.validate_python({"type": "classification_tag"}),
        ClassificationGeometry,
    )


def test_bbox_rejects_non_positive_width_and_height() -> None:
    for bad in [
        {"width": -1.0},
        {"height": -1.0},
        {"width": 0.0},
        {"height": 0.0},
    ]:
        data = {"type": "bbox", "x": 1.0, "y": 2.0, "width": 10.0, "height": 20.0, **bad}
        with pytest.raises(ValidationError, match="greater than 0"):
            geometry_adapter.validate_python(data)


def test_polygon_needs_at_least_three_points() -> None:
    for bad in [[], [(0.0, 0.0)], [(0.0, 0.0), (10.0, 0.0)]]:
        with pytest.raises(ValidationError, match="at least 3 items"):
            geometry_adapter.validate_python({"type": "polygon", "points": bad})


def test_polygon_accepts_three_points_without_checking_self_intersection() -> None:
    # M1 deliberately does not reject degenerate rings; documented in the model.
    bowtie = [(0.0, 0.0), (10.0, 10.0), (10.0, 0.0), (0.0, 10.0)]
    assert len(PolygonGeometry(points=bowtie).points) == 4


def test_unimplemented_and_unknown_geometry_tags_are_rejected() -> None:
    for tag in ["mask", "polyline", "keypoints", "cuboid_3d", "polyline_3d", "hexagon"]:
        with pytest.raises(ValidationError, match="union_tag_invalid"):
            geometry_adapter.validate_python({"type": tag})


def test_variants_reject_fields_belonging_to_another_variant() -> None:
    with pytest.raises(ValidationError, match="extra_forbidden"):
        geometry_adapter.validate_python(
            {"type": "bbox", "x": 1.0, "y": 2.0, "width": 10.0, "height": 20.0, "points": []}
        )
    with pytest.raises(ValidationError, match="extra_forbidden"):
        geometry_adapter.validate_python({"type": "classification_tag", "x": 1.0})


def test_geometry_is_immutable_once_validated() -> None:
    with pytest.raises(ValidationError):
        BboxGeometry(x=1.0, y=2.0, width=10.0, height=20.0).width = 30.0  # type: ignore[misc]


def test_discriminator_values_are_geometry_type_members() -> None:
    # The extension contract: a new variant must reuse a GeometryType member, so a
    # schema's allowed geometries and an annotation's geometry stay directly comparable.
    for geometry in VARIANTS:
        assert isinstance(geometry.type, GeometryType)
    assert {g.type for g in VARIANTS} <= set(GeometryType)


def test_geometry_type_is_comparable_to_a_label_class_without_translation() -> None:
    # This is the check AnnotationService performs, and it is per class: a LabelClass
    # declares one geometry, so the rule is equality against `LabelClass.geometry`, not
    # membership in `SchemaService.allowed_geometries` (which is the union across a
    # version's classes, and would let a polygon through under a bbox class). The union
    # is designed so either comparison needs no adapter layer.
    label_class = LabelClass(name="car", geometry=GeometryType.BBOX)
    annotation = _annotation(BboxGeometry(x=1.0, y=2.0, width=10.0, height=20.0))
    assert annotation.geometry.type == label_class.geometry

    tagged = _annotation(ClassificationGeometry())
    assert tagged.geometry.type != label_class.geometry


def test_implemented_geometries_names_exactly_the_variants_of_the_union() -> None:
    # Derived from the union rather than listed beside it, so appending a variant
    # widens it with no second edit. SchemaService refuses a class outside this set.
    from_the_union = {g.type for g in VARIANTS}
    expected = {GeometryType.BBOX, GeometryType.POLYGON, GeometryType.CLASSIFICATION_TAG}
    assert IMPLEMENTED_GEOMETRIES == from_the_union == expected
    assert set(GeometryType) > IMPLEMENTED_GEOMETRIES  # the rest is roadmap
