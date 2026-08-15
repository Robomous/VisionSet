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
    PolylineGeometry,
)

geometry_adapter: TypeAdapter[Geometry] = TypeAdapter(Geometry)

VARIANTS = [
    BboxGeometry(x=1.0, y=2.0, width=10.0, height=20.0),
    PolygonGeometry(points=[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]),
    PolylineGeometry(points=[(0.0, 0.0), (10.0, 5.0), (20.0, 30.0)]),
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

    polyline = geometry_adapter.validate_python(
        {"type": "polyline", "points": [[0.0, 0.0], [10.0, 0.0]]}
    )
    assert isinstance(polyline, PolylineGeometry)

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


def test_polyline_needs_at_least_two_points() -> None:
    for bad in [[], [(0.0, 0.0)]]:
        with pytest.raises(ValidationError, match="at least 2 items"):
            geometry_adapter.validate_python({"type": "polyline", "points": bad})


def test_polyline_refuses_a_path_with_no_length() -> None:
    # The analogue of the zero-area box: every point the same point describes
    # nothing. It is the ONLY degeneracy refused — see the model's docstring.
    with pytest.raises(ValidationError, match="no length"):
        geometry_adapter.validate_python({"type": "polyline", "points": [[5.0, 5.0], [5.0, 5.0]]})


def test_polyline_keeps_duplicate_points_inside_a_path_that_has_length() -> None:
    # Real digitizers and honest resampling both emit these, and they cost a
    # renderer nothing. Only the all-identical case is refused.
    doubled = [(0.0, 0.0), (5.0, 5.0), (5.0, 5.0), (10.0, 10.0)]
    assert len(PolylineGeometry(points=doubled).points) == 4


def test_a_polyline_is_not_the_polygon_with_the_same_points() -> None:
    # The ends stay apart: nothing joins the last point to the first, so the two
    # are different values even where the vertex list is identical.
    points = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]
    assert PolylineGeometry(points=points) != PolygonGeometry(points=points)
    assert PolylineGeometry(points=points).type != PolygonGeometry(points=points).type


def test_a_polyline_repeating_its_first_point_is_still_a_polyline() -> None:
    # A closed path is a legal polyline. The domain does not reinterpret it as a
    # polygon, because the caller said which one they meant.
    closed = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 0.0)]
    assert PolylineGeometry(points=closed).type is GeometryType.POLYLINE


def test_polyline_point_order_is_part_of_the_value() -> None:
    # Reversing a lane is a different annotation of the same pixels, so the two
    # must not compare equal. Nothing sorts the points on the way in.
    forward = [(0.0, 0.0), (10.0, 5.0), (20.0, 30.0)]
    assert PolylineGeometry(points=forward) != PolylineGeometry(points=list(reversed(forward)))


def test_the_domain_does_not_impose_one_format_s_ordering_rule() -> None:
    # TuSimple wants points sorted by ascending Y. That is enforced by the lanes
    # exporter, never here: a horizontal path is a perfectly good polyline, and a
    # domain that refused it would be encoding what a road is.
    horizontal = [(0.0, 50.0), (100.0, 50.0)]
    descending = [(0.0, 90.0), (10.0, 10.0)]
    assert PolylineGeometry(points=horizontal).points[0] == (0.0, 50.0)
    assert PolylineGeometry(points=descending).points[0] == (0.0, 90.0)


def test_unimplemented_and_unknown_geometry_tags_are_rejected() -> None:
    for tag in ["mask", "keypoints", "cuboid_3d", "polyline_3d", "hexagon"]:
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
    # This is the check AnnotationService performs, and it is per class: the rule
    # is membership in *this class's* `geometries`, not in
    # `SchemaService.allowed_geometries` (which is the union across a version's
    # classes, and would let a polygon through under a boxes-only class). The
    # discriminator's values are `GeometryType` members, so neither comparison
    # needs an adapter layer.
    label_class = LabelClass(name="car", geometries=(GeometryType.BBOX, GeometryType.POLYGON))
    annotation = _annotation(BboxGeometry(x=1.0, y=2.0, width=10.0, height=20.0))
    assert annotation.geometry.type in label_class.geometries

    # The second member of the set, so the test would notice a membership check
    # that had quietly collapsed back into equality against the first.
    polygon = _annotation(PolygonGeometry(points=[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]))
    assert polygon.geometry.type in label_class.geometries

    tagged = _annotation(ClassificationGeometry())
    assert tagged.geometry.type not in label_class.geometries


def test_implemented_geometries_names_exactly_the_variants_of_the_union() -> None:
    # Derived from the union rather than listed beside it, so appending a variant
    # widens it with no second edit. SchemaService refuses a class outside this set.
    from_the_union = {g.type for g in VARIANTS}
    expected = {
        GeometryType.BBOX,
        GeometryType.POLYGON,
        GeometryType.POLYLINE,
        GeometryType.CLASSIFICATION_TAG,
    }
    assert IMPLEMENTED_GEOMETRIES == from_the_union == expected
    assert set(GeometryType) > IMPLEMENTED_GEOMETRIES  # the rest is roadmap
