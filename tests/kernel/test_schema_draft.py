"""The draft models: permissive where a version is strict, and strict at conversion."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest

from visionset.kernel.domain import (
    DraftAttribute,
    DraftLabelClass,
    GeometryType,
    SchemaDraft,
    SchemaProvenance,
)


def test_a_class_with_no_name_and_no_geometry_is_a_legal_draft() -> None:
    """The whole point: a version refuses this, and a draft is not a version."""
    declared = DraftLabelClass()
    assert declared.name == ""
    assert declared.geometries == ()


def test_a_complete_draft_class_converts_to_a_label_class() -> None:
    declared = DraftLabelClass(name="car", geometries=(GeometryType.BBOX,), color="#f00")
    published = declared.to_label_class()
    assert published.name == "car"
    assert published.geometries == (GeometryType.BBOX,)
    assert published.color == "#f00"


def test_a_nameless_draft_class_refuses_to_convert() -> None:
    with pytest.raises(ValueError):
        DraftLabelClass(geometries=(GeometryType.BBOX,)).to_label_class()


def test_a_shapeless_draft_class_refuses_to_convert() -> None:
    with pytest.raises(ValueError):
        DraftLabelClass(name="car").to_label_class()


def test_an_attribute_with_no_kind_yet_is_legal_but_will_not_convert() -> None:
    attribute = DraftAttribute(name="occlusion")
    assert attribute.kind is None
    with pytest.raises(ValueError):
        attribute.to_attribute()


def test_a_select_with_no_options_survives_the_draft_and_refuses_at_conversion() -> None:
    """`Attribute` enforces this; the draft deliberately does not."""
    attribute = DraftAttribute(name="weather", kind="select")
    assert attribute.options is None
    with pytest.raises(ValueError):
        attribute.to_attribute()


def test_a_draft_refuses_a_naive_timestamp() -> None:
    with pytest.raises(ValueError):
        SchemaDraft(
            project_id=uuid4(),
            kind=SchemaProvenance.CURATED,
            updated_at=datetime(2026, 1, 1),  # noqa: DTZ001 — the point of the test
        )


def test_a_draft_is_frozen() -> None:
    draft = SchemaDraft(
        project_id=uuid4(), kind=SchemaProvenance.CURATED, updated_at=datetime.now(UTC)
    )
    with pytest.raises(ValueError):
        draft.revision = 2  # type: ignore[misc]
