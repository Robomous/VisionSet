"""Scale arithmetic and the canonical spellings it adds to the source domain."""

from uuid import uuid4

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    Source,
    SourceKind,
    VideoMetadata,
    VideoProvenance,
    canonical_image_scales,
    scaled_dimension,
)


def _metadata(width: int = 1920, height: int = 1080) -> VideoMetadata:
    return VideoMetadata(width=width, height=height, fps=30.0, duration_seconds=1.0, codec="h264")


def _provenance(*, width: int, height: int, scale_percent: int) -> VideoProvenance:
    return VideoProvenance(
        metadata=_metadata(width, height), extraction_fps=1.0, scale_percent=scale_percent
    )


def _image_source(*, image_scales: dict[str, int]) -> Source:
    return Source(
        project_id=uuid4(),
        kind=SourceKind.IMAGE_DIRECTORY,
        path="/data",
        image_scales=image_scales,
    )


def _video_source(*, image_scales: dict[str, int]) -> Source:
    return Source(
        project_id=uuid4(),
        kind=SourceKind.VIDEO,
        path="/clip.mp4",
        video=_provenance(width=4, height=4, scale_percent=100),
        image_scales=image_scales,
    )


def test_scaled_dimension_rounds_half_up_in_integer_arithmetic() -> None:
    assert scaled_dimension(25, 50) == 13
    assert scaled_dimension(1920, 50) == 960
    assert scaled_dimension(1, 10) == 1
    assert scaled_dimension(640, 100) == 640


def test_canonical_image_scales_drops_hundreds_and_sorts_keys() -> None:
    assert canonical_image_scales({"b.png": 100, "a.png": 50}) == {"a.png": 50}
    assert list(canonical_image_scales({"z.png": 40, "a.png": 60})) == ["a.png", "z.png"]
    assert canonical_image_scales({}) == {}


def test_image_scales_refuses_non_canonical_and_out_of_range() -> None:
    with pytest.raises(ValidationError):
        _image_source(image_scales={"a.png": 100})
    with pytest.raises(ValidationError):
        _image_source(image_scales={"a.png": 0})
    with pytest.raises(ValidationError):
        _image_source(image_scales={"a.png": 101})


def test_a_video_source_carries_no_image_scales() -> None:
    with pytest.raises(ValidationError):
        _video_source(image_scales={"a.png": 50})


def test_scale_percent_is_bounded() -> None:
    with pytest.raises(ValidationError):
        _provenance(width=4, height=4, scale_percent=0)
    with pytest.raises(ValidationError):
        _provenance(width=4, height=4, scale_percent=101)


def test_stored_size_is_the_scaled_probe() -> None:
    provenance = _provenance(width=1920, height=1080, scale_percent=50)
    assert (provenance.stored_width, provenance.stored_height) == (960, 540)
