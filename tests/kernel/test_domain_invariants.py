from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    AnnotationJobState,
    Asset,
    AssetProgress,
    BatchState,
    GeometryType,
    IngestFailure,
    IngestFailureKind,
    report_name,
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


# --- what a failure report is allowed to say about an item --------------------


def test_a_report_name_with_no_root_is_the_basename() -> None:
    """The rule `SourceOut.name` already applies, in the one field that leaked."""
    assert report_name("/srv/visionset/incoming/notes.txt") == "notes.txt"
    assert report_name(Path("/srv/visionset/clips/broken.mp4")) == "broken.mp4"


def test_a_report_name_under_a_root_keeps_the_path_below_it() -> None:
    """A nested file stays distinguishable from its namesake one level up."""
    root = Path("/srv/visionset/incoming")

    assert report_name(root / "monday" / "photo.png", root=root) == "monday/photo.png"
    assert report_name(root / "tuesday" / "photo.png", root=root) == "tuesday/photo.png"
    # ...and the two answers differ, which is the whole point of carrying the
    # relative path rather than collapsing every item to its basename.
    assert report_name(root / "monday" / "photo.png", root=root) != report_name(
        root / "tuesday" / "photo.png", root=root
    )


def test_a_report_name_at_the_top_of_its_root_is_just_the_filename() -> None:
    """Which is what the walk produces today: it is top level only."""
    root = Path("/srv/visionset/incoming")

    assert report_name(root / "photo.png", root=root) == "photo.png"


def test_a_report_name_falls_back_to_the_basename_outside_its_root() -> None:
    """No root can explain the item, and a leaked path is the worse answer."""
    assert report_name("/var/tmp/stray.png", root=Path("/srv/visionset/incoming")) == "stray.png"
    # The degenerate case: the item *is* the root. `relative_to` answers "." for
    # that, which names nothing at all.
    root = Path("/srv/visionset/incoming")
    assert report_name(root, root=root) == "incoming"


def test_a_frame_keeps_its_fragment_because_that_is_the_actionable_part() -> None:
    """`clip.mp4#frame=42` is `IngestFailure`'s own documented spelling."""
    assert report_name("/srv/visionset/clips/dashcam.mp4#frame=42") == "dashcam.mp4#frame=42"


def test_a_report_name_never_carries_the_directory_it_was_read_from() -> None:
    """The property the field exists to hold, stated once as a property."""
    for item, root in [
        ("/srv/visionset/incoming/notes.txt", None),
        ("/srv/visionset/incoming/monday/photo.png", Path("/srv/visionset/incoming")),
        ("/srv/visionset/clips/dashcam.mp4#frame=1", None),
    ]:
        assert "/srv/visionset" not in report_name(item, root=root)


def test_a_partial_report_must_say_how_much_arrived() -> None:
    """The kind and the count are one statement, so neither may be made without the other.

    `partial` means *some of it is in the batch*, and a report that claimed it without
    saying how much would be a prose sentence where a number belongs. The estimate is
    genuinely optional beside it — a container that will not say how long it is still
    yields a countable number of frames.
    """
    partial = IngestFailure(
        name="broken.mp4",
        kind=IngestFailureKind.PARTIAL,
        reason="the video is damaged or truncated after 8 frames",
        frames_produced=8,
    )
    assert partial.frames_expected_estimate is None

    with pytest.raises(ValidationError):
        IngestFailure(name="broken.mp4", kind=IngestFailureKind.PARTIAL, reason="ran out of bytes")
    with pytest.raises(ValidationError):
        IngestFailure(
            name="broken.mp4",
            kind=IngestFailureKind.PARTIAL,
            reason="ran out of bytes",
            frames_produced=0,
        )


def test_a_report_that_recovered_nothing_may_not_carry_a_count() -> None:
    """The other half: `unsupported` and `corrupt` are the *nothing arrived* kinds.

    Letting them carry `frames_produced=0` would give the report two ways to say the same
    thing, and a reader grouping on the kind would have to check the number as well.
    """
    for kind in (IngestFailureKind.UNSUPPORTED, IngestFailureKind.CORRUPT):
        assert IngestFailure(name="notes.txt", kind=kind, reason="not an image")
        with pytest.raises(ValidationError):
            IngestFailure(name="notes.txt", kind=kind, reason="not an image", frames_produced=0)
        with pytest.raises(ValidationError):
            IngestFailure(
                name="notes.txt", kind=kind, reason="not an image", frames_expected_estimate=20
            )
