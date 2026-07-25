from uuid import uuid4

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    AnnotationJobState,
    Asset,
    AssetProgress,
    BatchState,
    GeometryType,
)


def test_asset_content_hash_must_be_sha256_hex() -> None:
    good = "a" * 64
    asset = Asset(project_id=uuid4(), content_hash=good, uri="file:///img.png")
    assert asset.content_hash == good
    assert asset.modality == "image"

    for bad in ["", "a" * 63, "A" * 64, "z" * 64]:
        with pytest.raises(ValidationError):
            Asset(project_id=uuid4(), content_hash=bad, uri="file:///img.png")


def test_geometry_enum_includes_3d_values_today() -> None:
    values = {g.value for g in GeometryType}
    assert values == {
        "bbox",
        "polygon",
        "mask",
        "polyline",
        "keypoints",
        "cuboid_3d",
        "polyline_3d",
        "classification_tag",
    }


def test_batch_states() -> None:
    assert [s.value for s in BatchState] == ["draft", "approved", "in_annotation", "completed"]


def test_job_and_progress_states() -> None:
    assert [s.value for s in AnnotationJobState] == ["pending", "in_progress", "completed"]
    assert [s.value for s in AssetProgress] == [
        "unannotated",
        "annotated",
        "skipped",
        "review_pending",
        "accepted",
    ]
