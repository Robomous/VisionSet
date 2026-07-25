from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import Annotation


def _make(**overrides: object) -> Annotation:
    data: dict[str, object] = {
        "asset_id": uuid4(),
        "label_class": "car",
        "schema_version": 1,
        "geometry": {"type": "bbox", "x": 1.0, "y": 2.0, "w": 10.0, "h": 20.0},
        "provenance": "human",
    }
    data.update(overrides)
    return Annotation.model_validate(data)


def test_id_is_uuid_generated_at_creation() -> None:
    a, b = _make(), _make()
    assert isinstance(a.id, UUID)
    assert a.id != b.id  # never index-based identity


def test_model_provenance_requires_model_ref() -> None:
    with pytest.raises(ValidationError, match="model_ref"):
        _make(provenance="model")


def test_model_provenance_with_ref_is_valid() -> None:
    a = _make(provenance="model", model_ref="yolo11n@sha256:abc", confidence=0.9)
    assert a.model_ref == "yolo11n@sha256:abc"


def test_confidence_bounds() -> None:
    with pytest.raises(ValidationError):
        _make(confidence=1.5)
    with pytest.raises(ValidationError):
        _make(confidence=-0.1)


def test_schema_version_must_be_positive() -> None:
    with pytest.raises(ValidationError):
        _make(schema_version=0)


def test_unknown_provenance_rejected() -> None:
    with pytest.raises(ValidationError):
        _make(provenance="alien")
