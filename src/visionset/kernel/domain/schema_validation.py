"""Validation rules shared by schema-bound annotation writers."""

from __future__ import annotations

from collections.abc import Mapping

from visionset.kernel.domain.geometry import Geometry
from visionset.kernel.domain.schema import AnnotationSchema, AttributeValue
from visionset.kernel.errors import (
    DisallowedGeometry,
    InvalidAttributeValue,
    LabelClassNotInSchema,
    MissingRequiredAttribute,
    UnknownAttribute,
)


def validate_schema_annotation(
    *,
    label_class: str,
    geometry: Geometry,
    attributes: Mapping[str, AttributeValue],
    schema: AnnotationSchema,
) -> None:
    """Refuse primitive annotation fields the supplied schema would not recognize.

    Classes and attributes are matched by exact name. Geometry membership is
    evaluated against the named class, not the version-wide geometry union.
    """
    declared_class = next((item for item in schema.classes if item.name == label_class), None)
    if declared_class is None:
        known = ", ".join(repr(item.name) for item in schema.classes) or "no classes at all"
        raise LabelClassNotInSchema(
            f"class {label_class!r} is not in schema version {schema.version}, "
            f"which declares {known}"
        )

    if geometry.type not in declared_class.geometries:
        allowed = ", ".join(item.value for item in declared_class.geometries)
        raise DisallowedGeometry(
            f"class {declared_class.name!r} accepts {allowed} in schema version "
            f"{schema.version}, but this annotation carries a {geometry.type.value}"
        )

    declared_attributes = {attribute.name: attribute for attribute in declared_class.attributes}
    if undeclared := sorted(attributes.keys() - declared_attributes.keys()):
        known = ", ".join(repr(name) for name in declared_attributes) or "no attributes at all"
        raise UnknownAttribute(
            f"class {declared_class.name!r} does not declare "
            f"{', '.join(repr(name) for name in undeclared)}; it declares {known}"
        )

    for attribute in declared_class.attributes:
        if attribute.name not in attributes:
            if attribute.required:
                raise MissingRequiredAttribute(
                    f"class {declared_class.name!r} requires attribute {attribute.name!r}; "
                    "its default is what a surface should offer, not a value the kernel fills in"
                )
            continue
        if (reason := attribute.rejects(attributes[attribute.name])) is not None:
            raise InvalidAttributeValue(
                f"attribute {attribute.name!r} of class {declared_class.name!r} {reason}"
            )
