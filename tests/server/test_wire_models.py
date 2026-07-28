"""Tripwires on the seam between a wire model and the domain it mirrors.

No HTTP here. These are the assertions that catch a wire model drifting away
from the kernel it publishes — which the route tests would not, because they
only ever send shapes both sides already agree on.
"""

from typing import get_args
from uuid import uuid4

import pytest

from visionset.kernel.domain import (
    Annotation,
    AssetProgress,
    Attribute,
    BboxGeometry,
    ClassificationGeometry,
    Geometry,
    GeometryType,
    LabelClass,
    Partition,
    PolygonGeometry,
)
from visionset.server.models import (
    AnnotationCreate,
    AnnotationOut,
    AttributeBody,
    GeometryBody,
    LabelClassBody,
    PartitionBody,
    ProgressCounts,
    geometry_of,
)


def test_the_wire_attribute_kinds_are_the_domains_own_four() -> None:
    """`AttributeBody.kind` restates the domain's `Literal` and nothing ties them.

    It is spelled inline rather than shared through an alias, because a PEP 695
    `type` alias emits a *named* schema into `components` — so the price of
    keeping the contract clean is this test. A fifth kind added to the domain
    fails here until somebody publishes it deliberately.
    """
    domain = get_args(Attribute.model_fields["kind"].annotation)
    wire = get_args(AttributeBody.model_fields["kind"].annotation)

    assert wire == domain
    assert set(wire) == {"string", "number", "boolean", "select"}


def test_the_wire_geometry_is_the_domains_own_enum() -> None:
    """Reused rather than restated, so the eight members cannot drift apart."""
    assert LabelClassBody.model_fields["geometry"].annotation is GeometryType


def test_a_label_class_round_trips_through_the_domain_and_back() -> None:
    """`of` and `to_domain` are inverses, so nothing is lost on the way out."""
    original = LabelClassBody(
        name="sign",
        geometry=GeometryType.BBOX,
        color="#ff0000",
        attributes=(
            AttributeBody(
                name="weather",
                kind="select",
                required=True,
                options=("sun", "rain"),
                default="sun",
            ),
        ),
    )

    assert LabelClassBody.of(original.to_domain()) == original


def test_a_domain_label_class_survives_being_published() -> None:
    """The other direction: a stored class comes back identical."""
    label_class = LabelClass(name="lane", geometry=GeometryType.POLYGON)

    assert LabelClassBody.of(label_class).to_domain() == label_class


def test_a_wire_label_class_is_refused_by_the_domains_own_rules() -> None:
    """The refusal happens at *construction*, which is why it becomes a 422.

    If this ever stops raising, the conversion has moved out of the validator
    and a malformed payload is answering 500 again.
    """
    with pytest.raises(ValueError, match="at least one non-blank character"):
        LabelClassBody(name="  ", geometry=GeometryType.BBOX)

    with pytest.raises(ValueError, match="needs at least one option"):
        AttributeBody(name="weather", kind="select")


def test_the_progress_counts_are_the_domains_own_states() -> None:
    """Five explicit fields rather than a dict, so this is the tie that holds them.

    A sixth `AssetProgress` member fails here until somebody publishes it — which
    is the point, because a client charting progress would otherwise silently
    stop seeing a state that exists.
    """
    fields = set(ProgressCounts.model_fields) - {"total"}

    assert fields == {progress.value for progress in AssetProgress}


def test_the_wire_geometries_are_the_domains_implemented_ones() -> None:
    """Re-spelled rather than reused — the domain docstrings carry RST markup —
    so nothing structural keeps the two unions in step except this."""
    domain = {variant.model_fields["type"].default for variant in get_args(get_args(Geometry)[0])}
    wire = {
        get_args(variant.model_fields["type"].annotation)[0]
        for variant in get_args(get_args(GeometryBody)[0])
    }

    assert wire == domain


def test_the_wire_partitions_are_the_domains_own_strategies() -> None:
    domain = {variant.model_fields["kind"].default for variant in get_args(get_args(Partition)[0])}
    wire = {
        get_args(variant.model_fields["kind"].annotation)[0]
        for variant in get_args(get_args(PartitionBody)[0])
    }

    assert wire == domain


def test_the_wire_provenances_are_the_domains_own_three() -> None:
    """Spelled inline for reason 2 in `models.py`, which is why this exists."""
    domain = get_args(Annotation.model_fields["provenance"].annotation)

    for model in (AnnotationCreate, AnnotationOut):
        assert get_args(model.model_fields["provenance"].annotation) == domain


@pytest.mark.parametrize(
    "geometry",
    [
        BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
        PolygonGeometry(points=[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]),
        ClassificationGeometry(),
    ],
)
def test_a_geometry_round_trips_through_the_wire_and_back(geometry: Geometry) -> None:
    """`geometry_of` and `to_domain` are inverses for every implemented variant."""
    assert geometry_of(geometry).to_domain() == geometry


def test_an_annotation_the_domain_cannot_hold_is_refused_at_construction() -> None:
    """If this stops raising, the conversion has left the validator and a
    malformed payload is answering 500 again."""
    box = {"type": "bbox", "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}

    with pytest.raises(ValueError, match="model_ref"):
        AnnotationCreate(asset_id=uuid4(), label_class="sign", geometry=box, provenance="model")

    with pytest.raises(ValueError, match="less than or equal to 1"):
        AnnotationCreate(
            asset_id=uuid4(),
            label_class="sign",
            geometry=box,
            provenance="human",
            confidence=2.0,
        )
