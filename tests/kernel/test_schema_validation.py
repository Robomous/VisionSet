"""Schema-dependent annotation validation without workspace state."""

from __future__ import annotations

from collections.abc import Mapping
from uuid import uuid4

import pytest

from visionset.kernel import (
    DisallowedGeometry,
    InvalidAnnotation,
    InvalidAttributeValue,
    LabelClassNotInSchema,
    MissingRequiredAttribute,
    UnknownAttribute,
)
from visionset.kernel.domain import (
    AnnotationSchema,
    Attribute,
    AttributeValue,
    BboxGeometry,
    Geometry,
    GeometryType,
    LabelClass,
    PolygonGeometry,
    validate_schema_annotation,
)

CAR = LabelClass(
    name="car",
    geometries=(GeometryType.BBOX,),
    attributes=(Attribute(name="occluded", kind="boolean", required=True),),
)
SCHEMA = AnnotationSchema(project_id=uuid4(), version=2, classes=(CAR,))
TRIANGLE = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]


@pytest.mark.parametrize(
    ("label_class", "geometry", "attributes", "error"),
    [
        pytest.param(
            "car",
            BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
            {"occluded": False},
            None,
            id="accepts-a-matching-annotation",
        ),
        pytest.param(
            "truck",
            BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
            {"occluded": False},
            LabelClassNotInSchema,
            id="refuses-a-class-outside-the-schema",
        ),
        pytest.param(
            "car",
            PolygonGeometry(points=TRIANGLE),
            {"occluded": False},
            DisallowedGeometry,
            id="refuses-a-geometry-the-class-does-not-allow",
        ),
        pytest.param(
            "car",
            BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
            {"occluded": False, "colour": "red"},
            UnknownAttribute,
            id="refuses-an-attribute-the-class-does-not-declare",
        ),
        pytest.param(
            "car",
            BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
            {},
            MissingRequiredAttribute,
            id="refuses-a-missing-required-attribute",
        ),
        pytest.param(
            "car",
            BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
            {"occluded": "yes"},
            InvalidAttributeValue,
            id="refuses-an-attribute-value-of-the-wrong-type",
        ),
    ],
)
def test_a_schema_validator_reuses_the_annotation_write_rules(
    label_class: str,
    geometry: Geometry,
    attributes: Mapping[str, AttributeValue],
    error: type[InvalidAnnotation] | None,
) -> None:
    """A change that skips any schema rule makes its corresponding row pass unexpectedly."""
    if error is None:
        validate_schema_annotation(
            label_class=label_class,
            geometry=geometry,
            attributes=attributes,
            schema=SCHEMA,
        )
    else:
        with pytest.raises(error):
            validate_schema_annotation(
                label_class=label_class,
                geometry=geometry,
                attributes=attributes,
                schema=SCHEMA,
            )
