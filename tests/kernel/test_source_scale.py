"""Scale arithmetic and the canonical spellings it adds to the source domain."""

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import VideoMetadata, VideoProvenance, scaled_dimension


def _metadata(width: int = 1920, height: int = 1080) -> VideoMetadata:
    return VideoMetadata(width=width, height=height, fps=30.0, duration_seconds=1.0, codec="h264")


def _provenance(*, width: int, height: int, scale_percent: int) -> VideoProvenance:
    return VideoProvenance(
        metadata=_metadata(width, height), extraction_fps=1.0, scale_percent=scale_percent
    )


def test_scaled_dimension_rounds_half_up_in_integer_arithmetic() -> None:
    assert scaled_dimension(25, 50) == 13
    assert scaled_dimension(1920, 50) == 960
    assert scaled_dimension(1, 10) == 1
    assert scaled_dimension(640, 100) == 640


def test_scale_percent_is_bounded() -> None:
    with pytest.raises(ValidationError):
        _provenance(width=4, height=4, scale_percent=0)
    with pytest.raises(ValidationError):
        _provenance(width=4, height=4, scale_percent=101)


def test_stored_size_is_the_scaled_probe() -> None:
    provenance = _provenance(width=1920, height=1080, scale_percent=50)
    assert (provenance.stored_width, provenance.stored_height) == (960, 540)
