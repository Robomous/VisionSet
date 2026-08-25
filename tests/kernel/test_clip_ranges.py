"""`TimeRange`, canonicalization, and the one frame-count formula.

No ffmpeg here: everything is arithmetic over domain values. The adapter's own
file proves the same formula against a real extraction, fractional boundaries
included, so these two files together are the estimate-equals-extraction claim.
"""

from itertools import permutations

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    TimeRange,
    VideoMetadata,
    VideoProvenance,
    canonical_ranges,
    expected_frames,
    grid_bounds,
)


def _r(start: float, end: float) -> TimeRange:
    return TimeRange(start_seconds=start, end_seconds=end)


def _metadata(duration: float = 2.0) -> VideoMetadata:
    return VideoMetadata(width=64, height=48, fps=10.0, duration_seconds=duration, codec="h264")


# --- the value object ---------------------------------------------------------


def test_a_range_must_end_after_it_starts() -> None:
    with pytest.raises(ValidationError):
        _r(1.0, 1.0)
    with pytest.raises(ValidationError):
        _r(2.0, 1.0)


def test_a_range_cannot_start_before_the_clip() -> None:
    with pytest.raises(ValidationError):
        _r(-0.1, 1.0)


# --- canonicalization ---------------------------------------------------------


def test_canonicalization_is_idempotent() -> None:
    once = canonical_ranges([_r(0.2, 1.0), _r(0.8, 1.4)], duration_seconds=2.0)
    assert canonical_ranges(once, duration_seconds=2.0) == once


def test_canonicalization_ignores_the_order_ranges_arrive_in() -> None:
    ranges = [_r(1.5, 1.9), _r(0.1, 0.4), _r(0.9, 1.2)]
    forms = {canonical_ranges(ordering, duration_seconds=2.0) for ordering in permutations(ranges)}
    assert len(forms) == 1


def test_overlapping_and_adjacent_ranges_merge() -> None:
    assert canonical_ranges([_r(0.0, 3.0), _r(2.0, 5.0)], duration_seconds=10.0) == (_r(0.0, 5.0),)
    assert canonical_ranges([_r(0.0, 1.0), _r(1.0, 2.0)], duration_seconds=10.0) == (_r(0.0, 2.0),)


def test_ranges_are_clamped_to_the_clip_and_emptied_ones_dropped() -> None:
    assert canonical_ranges([_r(1.0, 9.0), _r(5.0, 6.0)], duration_seconds=2.0) == (_r(1.0, 2.0),)


def test_a_selection_covering_the_whole_clip_is_the_empty_selection() -> None:
    """ "Whole clip" gets exactly one identity spelling."""
    assert canonical_ranges([_r(0.0, 2.0)], duration_seconds=2.0) == ()
    assert canonical_ranges([_r(0.0, 1.0), _r(0.5, 7.0)], duration_seconds=2.0) == ()


def test_provenance_refuses_a_selection_that_is_not_canonical() -> None:
    with pytest.raises(ValidationError):
        VideoProvenance(
            metadata=_metadata(),
            extraction_fps=1.0,
            ranges=(_r(0.8, 1.4), _r(0.2, 1.0)),
        )


def test_provenance_holds_the_canonical_form() -> None:
    provenance = VideoProvenance(
        metadata=_metadata(),
        extraction_fps=1.0,
        ranges=canonical_ranges([_r(0.8, 1.4), _r(0.2, 1.0)], duration_seconds=2.0),
    )
    assert provenance.ranges == (_r(0.2, 1.4),)


# --- the count formula --------------------------------------------------------


def test_the_whole_clip_count_includes_the_frame_at_zero() -> None:
    """`ceil`, not the old `floor`: 47.7 s at 1 fps holds grid points 0 through 47."""
    assert expected_frames((), duration_seconds=47.7, fps=1.0) == 48
    assert expected_frames((), duration_seconds=2.0, fps=10.0) == 20


def test_a_range_counts_its_half_open_grid_points() -> None:
    assert grid_bounds((_r(0.55, 1.25),), fps=10.0) == ((6, 13),)
    assert expected_frames((_r(0.55, 1.25),), duration_seconds=2.0, fps=10.0) == 7


def test_two_ranges_meeting_at_a_boundary_count_no_frame_twice() -> None:
    """Half-open on both sides: the grid point at the boundary belongs to one range."""
    split = expected_frames((_r(0.0, 1.0), _r(1.0, 2.0)), duration_seconds=2.0, fps=5.0)
    assert split == expected_frames((), duration_seconds=2.0, fps=5.0)
