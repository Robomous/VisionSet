from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import Annotation, AssetProgress, progress_after_annotating


def _make(**overrides: object) -> Annotation:
    data: dict[str, object] = {
        "asset_id": uuid4(),
        "label_class": "car",
        "schema_version": 1,
        "geometry": {"type": "bbox", "x": 1.0, "y": 2.0, "width": 10.0, "height": 20.0},
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


def test_unjudged_labels_land_at_review_pending_rather_than_annotated() -> None:
    """A model's labels enter where a person has not looked at them yet."""
    assert (
        progress_after_annotating(AssetProgress.UNANNOTATED, has_annotations=True, judged=False)
        is AssetProgress.REVIEW_PENDING
    )


def test_judged_is_the_default_so_a_person_writing_a_label_is_unchanged() -> None:
    assert (
        progress_after_annotating(AssetProgress.UNANNOTATED, has_annotations=True)
        is AssetProgress.ANNOTATED
    )


def test_unjudged_changes_nothing_else() -> None:
    """Only the one edge moves; every other answer is what it always was."""
    for current in AssetProgress:
        for has_annotations in (True, False):
            if current is AssetProgress.UNANNOTATED and has_annotations:
                continue
            assert progress_after_annotating(
                current, has_annotations=has_annotations, judged=False
            ) is progress_after_annotating(current, has_annotations=has_annotations)
