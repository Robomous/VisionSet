import pytest
from pydantic import ValidationError

from visionset.kernel.domain import GeometryType, ModelCapability, ServedFamily


def test_a_served_family_declares_at_least_one_shape() -> None:
    with pytest.raises(ValidationError):
        ServedFamily(capability=ModelCapability.TEXT_DETECT, produces=frozenset())


def test_a_served_family_is_frozen_and_hashable() -> None:
    one = ServedFamily(
        capability=ModelCapability.TEXT_DETECT, produces=frozenset({GeometryType.BBOX})
    )
    assert one == ServedFamily(
        capability=ModelCapability.TEXT_DETECT, produces=frozenset({GeometryType.BBOX})
    )
    assert {one}
