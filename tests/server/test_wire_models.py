"""Tripwires on the seam between a wire model and the domain it mirrors.

No HTTP here. These are the assertions that catch a wire model drifting away
from the kernel it publishes — which the route tests would not, because they
only ever send shapes both sides already agree on.
"""

from typing import get_args

import pytest

from visionset.kernel.domain import Attribute, GeometryType, LabelClass
from visionset.server.models import AttributeBody, LabelClassBody


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
