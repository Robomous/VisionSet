"""The video processor: what it reports, what it refuses, and what it promises.

Four properties are pinned here, and they are worth keeping apart.

The first is **the frame count**. Extraction at 1, 5 and 10 fps from a 10 fps two-second clip
must give exactly 2, 10 and 20 frames. That is the acceptance criterion, and it is also the
canary for the extraction filter: almost any change to the command moves one of those numbers.

The second is **rotation**, and it is the same policy the image processor applies to EXIF, on a
different mechanism. A clip carrying a quarter turn probes with its edges swapped, and the frames
that come out have those same dimensions — a probe and a decode that disagreed would be a dataset
whose labels are ninety degrees off.

The third is **determinism**, with the caveat `tests/fixtures/media.py` already records for
ffmpeg: two runs on one machine agree byte for byte, two ffmpeg builds need not. So every
assertion here is about repeatability and none is about a literal hash.

The fourth is **the refusals**, and their split is by remedy rather than by symptom. A file
ffmpeg never opens is `UnsupportedMedia`; a clip that decodes for a while and then runs out is
`CorruptMedia` — and it yields the frames it managed before it says so. `MediaToolUnavailable`
is in neither family and is not a `MediaError` at all, because no file is at fault.

Two practical notes for anyone adding a case. There is **no module-level skip**: the composition
tests at the bottom need no ffmpeg and must run on a laptop without one, so the requirement
arrives through the `clip` fixture instead — `write_video` calls `require_ffmpeg` itself, which
skips locally and raises under `VISIONSET_REQUIRE_FFMPEG=1` on CI. And the composition tests live
here rather than in `test_workspace_service.py`, following the event bus and the image processor:
the port's own file is where "can this be injected?" is asked.
"""

from __future__ import annotations

import hashlib
import io
import shutil
import subprocess
from collections.abc import Iterator
from itertools import islice
from pathlib import Path

import pytest
from tests.fixtures.media import (
    DEFAULT_VIDEO_SIZE,
    GeneratedVideo,
    write_corrupt_video,
    write_rotated_video,
    write_unsupported_file,
    write_video,
)

from visionset.kernel.adapters import (
    FfmpegVideoProcessor,
    PillowImageProcessor,
    ffmpeg_video_processor,
)
from visionset.kernel.adapters.ffmpeg_video_processor import (
    _EXTRACTION_ARGS,
    _oriented,
    _rational,
    _rotation,
)
from visionset.kernel.domain import ImageFormat, VideoFrame, VideoMetadata
from visionset.kernel.errors import (
    CorruptMedia,
    MediaError,
    MediaToolUnavailable,
    UnsupportedMedia,
    VisionSetError,
)
from visionset.kernel.ports import DEFAULT_EXTRACTION_FPS, FRAME_FORMAT, VideoProcessor
from visionset.kernel.services import WorkspaceService


@pytest.fixture
def clip(tmp_path: Path) -> GeneratedVideo:
    """A 64x48 clip at 10 fps for 2 s: 20 frames, so 1/5/10 fps divide it exactly.

    Also the ffmpeg gate for this module. `write_video` calls `require_ffmpeg`, so a test that
    asks for a clip skips without the binary and fails loudly with `VISIONSET_REQUIRE_FFMPEG=1`.
    """
    return write_video(tmp_path / "clip.mp4")


def _frames(video: Path, **kwargs: float) -> list[VideoFrame]:
    return list(FfmpegVideoProcessor().frames(video, **kwargs))


def _dimensions(content: bytes) -> tuple[int, int]:
    metadata = PillowImageProcessor().probe(io.BytesIO(content))
    return metadata.width, metadata.height


# --- what a clip reports ------------------------------------------------------


def test_a_clip_reports_its_dimensions_rate_duration_and_codec(clip: GeneratedVideo) -> None:
    metadata = FfmpegVideoProcessor().probe(clip.path)

    assert (metadata.width, metadata.height) == (clip.width, clip.height)
    assert metadata.fps == pytest.approx(clip.fps)
    assert metadata.duration_seconds == pytest.approx(clip.duration_seconds)
    assert metadata.codec == "h264"


def test_a_probe_reads_the_container_and_decodes_nothing(clip: GeneratedVideo) -> None:
    """The reason there are two methods: registering a source must not cost a full decode."""
    assert FfmpegVideoProcessor().probe(clip.path) == FfmpegVideoProcessor().probe(clip.path)


def test_a_clip_at_another_size_and_rate_reports_those(tmp_path: Path) -> None:
    other = write_video(tmp_path / "short.mp4", size=(32, 32), fps=5, duration_seconds=1.0)

    metadata = FfmpegVideoProcessor().probe(other.path)

    assert (metadata.width, metadata.height) == (32, 32)
    assert metadata.fps == pytest.approx(5.0)


# --- rotation -----------------------------------------------------------------


def test_a_rotated_clip_reports_swapped_edges(tmp_path: Path) -> None:
    """The video spelling of the EXIF rule: a 64x48 file turned a quarter is a 48x64 picture."""
    rotated = write_rotated_video(tmp_path / "portrait.mp4")

    metadata = FfmpegVideoProcessor().probe(rotated.path)

    assert (rotated.width, rotated.height) == DEFAULT_VIDEO_SIZE
    assert (metadata.width, metadata.height) == (rotated.height, rotated.width)


def test_the_frames_of_a_rotated_clip_match_what_was_probed(tmp_path: Path) -> None:
    """A probe and a decode that disagreed is a dataset whose labels are ninety degrees off."""
    rotated = write_rotated_video(tmp_path / "portrait.mp4")
    processor = FfmpegVideoProcessor()

    metadata = processor.probe(rotated.path)
    frames = list(processor.frames(rotated.path, fps=5))

    assert _dimensions(frames[0].content) == (metadata.width, metadata.height)


def test_a_half_turn_leaves_the_edges_alone(tmp_path: Path) -> None:
    upside_down = write_rotated_video(tmp_path / "flipped.mp4", rotation=180)

    metadata = FfmpegVideoProcessor().probe(upside_down.path)

    assert (metadata.width, metadata.height) == DEFAULT_VIDEO_SIZE


@pytest.mark.parametrize(
    ("rotation", "expected"),
    [
        (0, (64, 48)),
        (90, (48, 64)),
        (180, (64, 48)),
        (270, (48, 64)),
        (-90, (48, 64)),
        (-180, (64, 48)),
        (360, (64, 48)),
        (450, (48, 64)),
    ],
    ids=lambda value: str(value),
)
def test_only_a_quarter_turn_swaps_the_edges(rotation: int, expected: tuple[int, int]) -> None:
    """Swept directly, because this one line is where a dataset silently goes sideways.

    ffprobe reports the same turn as 90, as -90 and as 270 depending on the file and the build,
    so the rule is arithmetic on the angle and never a membership test against three literals.
    """
    assert _oriented(64, 48, rotation) == expected


def test_a_clip_with_no_rotation_at_all_is_upright(clip: GeneratedVideo) -> None:
    """The ordinary path rather than a fallback: most video carries no display matrix."""
    assert _rotation({}) == 0
    assert _rotation({"tags": {"language": "und"}}) == 0


def test_the_older_rotate_tag_is_still_read() -> None:
    """Recent ffmpeg no longer writes it; files written by older ones are still out there."""
    assert _rotation({"tags": {"rotate": "270"}}) == 270
    assert _rotation({"side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}]})


# --- frame counts -------------------------------------------------------------


@pytest.mark.parametrize(
    ("fps", "expected"), [(1, 2), (5, 10), (10, 20)], ids=lambda value: str(value)
)
def test_extraction_at_a_target_rate_gives_the_expected_frame_count(
    clip: GeneratedVideo, fps: int, expected: int
) -> None:
    """The acceptance criterion, and the canary for the whole extraction command."""
    assert len(_frames(clip.path, fps=fps)) == expected


def test_a_rate_below_one_frame_a_second_is_allowed(clip: GeneratedVideo) -> None:
    """Long clips are the case this exists for: one frame every two seconds, not every tenth."""
    assert len(_frames(clip.path, fps=0.5)) == 1


def test_the_default_rate_is_the_one_the_port_declares(clip: GeneratedVideo) -> None:
    assert DEFAULT_EXTRACTION_FPS == 1.0
    assert _frames(clip.path) == _frames(clip.path, fps=DEFAULT_EXTRACTION_FPS)


def test_asking_for_more_frames_than_the_clip_has_duplicates_them(clip: GeneratedVideo) -> None:
    """Documented rather than clamped — and content addressing collapses the duplicates."""
    frames = _frames(clip.path, fps=20)

    assert len(frames) == 40
    assert len({hashlib.sha256(frame.content).digest() for frame in frames}) == 20


# --- frame origin -------------------------------------------------------------


def test_every_frame_carries_its_position_in_the_extracted_sequence(
    clip: GeneratedVideo,
) -> None:
    """The acceptance criterion: origin metadata attached to each frame, not inferred later."""
    frames = _frames(clip.path, fps=5)

    assert [frame.index for frame in frames] == list(range(10))


def test_a_frames_timestamp_is_its_place_on_the_requested_grid(clip: GeneratedVideo) -> None:
    frames = _frames(clip.path, fps=5)

    assert [frame.timestamp for frame in frames] == pytest.approx(
        [index / 5 for index in range(10)]
    )


def test_the_same_moment_is_named_the_same_at_any_extraction_rate(clip: GeneratedVideo) -> None:
    """What makes a timestamp the locator and the index merely the ordering: `round=up`.

    Under the filter's default rounding the frame taken for a given grid point drifts with the
    rate, so one second into the clip would be a different picture at 1 fps than at 5.
    """
    slow = _frames(clip.path, fps=1)
    quick = _frames(clip.path, fps=5)

    assert slow[1].timestamp == quick[5].timestamp == 1.0
    assert slow[1].content == quick[5].content


def test_every_frame_is_an_image_the_image_processor_accepts(clip: GeneratedVideo) -> None:
    """The point of `FRAME_FORMAT` being an `ImageFormat` member, asserted end to end."""
    frame = _frames(clip.path, fps=1)[0]

    metadata = PillowImageProcessor().probe(io.BytesIO(frame.content))

    assert metadata.format is FRAME_FORMAT is ImageFormat.PNG
    assert (metadata.width, metadata.height) == (clip.width, clip.height)


def test_consecutive_frames_of_a_moving_clip_differ(clip: GeneratedVideo) -> None:
    """Guards the failure where a pinned command quietly starts emitting one frame repeatedly."""
    frames = _frames(clip.path, fps=10)

    assert len({hashlib.sha256(frame.content).digest() for frame in frames}) == len(frames)


# --- determinism --------------------------------------------------------------


def test_two_extractions_of_one_clip_are_byte_identical(clip: GeneratedVideo) -> None:
    """The acceptance criterion. Repeatability, never a hardcoded hash — see the docstring."""
    assert _frames(clip.path, fps=5) == _frames(clip.path, fps=5)


def test_two_identical_clips_extract_to_the_same_hashes(tmp_path: Path) -> None:
    """The property a re-ingest dedups on: same bytes in, same asset identities out."""
    first = write_video(tmp_path / "a.mp4")
    second = write_video(tmp_path / "b.mp4")

    def digests(video: Path) -> list[bytes]:
        return [hashlib.sha256(frame.content).digest() for frame in _frames(video, fps=5)]

    assert digests(first.path) == digests(second.path)


def test_two_processors_agree_on_one_clip(clip: GeneratedVideo) -> None:
    """No instance state, so a workspace-scoped decoder is uniformity and not isolation."""
    assert list(FfmpegVideoProcessor().frames(clip.path, fps=5)) == list(
        FfmpegVideoProcessor().frames(clip.path, fps=5)
    )


# --- streaming ----------------------------------------------------------------


def test_frames_arrive_lazily(clip: GeneratedVideo) -> None:
    """Nothing buffers a clip: a caller that wants three frames does not decode twenty."""
    stream = FfmpegVideoProcessor().frames(clip.path, fps=10)

    taken = list(islice(stream, 3))

    assert [frame.index for frame in taken] == [0, 1, 2]
    stream.close()  # type: ignore[attr-defined]


def test_an_abandoned_iterator_leaves_no_decoder_running(
    clip: GeneratedVideo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A caller that breaks out of the loop must not leak an ffmpeg reading a file nobody wants.

    Asserted on the process object rather than by counting what is running, which would be a
    guess on a machine doing anything else at the time.
    """
    started: list[subprocess.Popen[bytes]] = []
    spawn = subprocess.Popen

    def record(*args: object, **kwargs: object) -> subprocess.Popen[bytes]:
        process = spawn(*args, **kwargs)  # type: ignore[arg-type, misc]
        started.append(process)
        return process

    monkeypatch.setattr(ffmpeg_video_processor.subprocess, "Popen", record)

    stream = FfmpegVideoProcessor().frames(clip.path, fps=10)
    next(iter(stream))
    stream.close()  # type: ignore[attr-defined]

    assert len(started) == 1
    assert started[0].poll() is not None


# --- refusals -----------------------------------------------------------------


def test_a_file_that_is_not_a_video_is_refused_by_the_probe(tmp_path: Path) -> None:
    path = write_unsupported_file(tmp_path / "notes.txt")

    with pytest.raises(UnsupportedMedia, match="not a video ffmpeg can open"):
        FfmpegVideoProcessor().probe(path)


def test_a_file_that_is_not_a_video_is_refused_by_the_extraction_too(tmp_path: Path) -> None:
    """The two methods cannot disagree about what is readable."""
    path = write_unsupported_file(tmp_path / "notes.txt")

    with pytest.raises(UnsupportedMedia):
        _frames(path, fps=1)


def test_a_truncated_clip_yields_what_decoded_and_then_refuses(tmp_path: Path) -> None:
    """The remedy split, end to end: it opened, so this is damage and not an unsupported file."""
    broken = write_corrupt_video(tmp_path / "broken.mp4")
    stream = FfmpegVideoProcessor().frames(broken.path, fps=10)

    decoded = []
    with pytest.raises(CorruptMedia, match="damaged or truncated"):
        for frame in stream:
            decoded.append(frame)

    assert 0 < len(decoded) < broken.frame_count


def test_a_truncated_clip_still_probes(tmp_path: Path) -> None:
    """Deliberate: the index survived, so the container can still say what it holds."""
    broken = write_corrupt_video(tmp_path / "broken.mp4")

    assert FfmpegVideoProcessor().probe(broken.path).codec == "h264"


def test_a_refusal_names_the_file_it_was_given(tmp_path: Path) -> None:
    """A per-file error has to say which of five thousand files."""
    path = write_unsupported_file(tmp_path / "notes.txt")

    with pytest.raises(UnsupportedMedia) as caught:
        FfmpegVideoProcessor().probe(path)

    assert caught.value.name == str(path)


def test_an_explicit_name_wins_over_the_path(tmp_path: Path) -> None:
    path = write_unsupported_file(tmp_path / "blob-ab12cd")

    with pytest.raises(UnsupportedMedia) as caught:
        FfmpegVideoProcessor().probe(path, name="dashcam/2026-07-27.mp4")

    assert caught.value.name == "dashcam/2026-07-27.mp4"


def test_a_refusal_reason_does_not_repeat_the_name(tmp_path: Path) -> None:
    """ffmpeg quotes the path in nearly everything it says; a report is a table, not sentences."""
    path = write_unsupported_file(tmp_path / "notes.txt")

    with pytest.raises(UnsupportedMedia) as caught:
        FfmpegVideoProcessor().probe(path)

    assert str(path) not in caught.value.reason
    assert path.name not in caught.value.reason
    assert str(path) in str(caught.value)


def test_a_refusal_quotes_what_the_decoder_actually_said(tmp_path: Path) -> None:
    """Redacted, not discarded: without the cause an operator has nothing to act on."""
    path = write_unsupported_file(tmp_path / "notes.txt")

    with pytest.raises(UnsupportedMedia) as caught:
        FfmpegVideoProcessor().probe(path)

    assert "Invalid data" in caught.value.reason


def test_both_video_refusals_are_the_image_family(tmp_path: Path) -> None:
    """Reused rather than duplicated: the split is by remedy, and remedies have no modality."""
    assert issubclass(UnsupportedMedia, MediaError)
    assert issubclass(CorruptMedia, MediaError)


@pytest.mark.parametrize("method", ["probe", "frames"], ids=str)
def test_a_missing_file_is_not_a_media_error(tmp_path: Path, method: str) -> None:
    """Nothing is wrong with the media: there is no media."""
    processor = FfmpegVideoProcessor()

    with pytest.raises(FileNotFoundError, match="no video file at"):
        getattr(processor, method)(tmp_path / "absent.mp4")


@pytest.mark.parametrize("fps", [0, -1, -0.5], ids=lambda value: str(value))
def test_a_rate_that_is_not_positive_is_a_programming_error(
    clip: GeneratedVideo, fps: float
) -> None:
    """A `ValueError`, deliberately outside the `MediaError` family an ingest catches."""
    with pytest.raises(ValueError, match="fps must be greater than zero"):
        _frames(clip.path, fps=fps)


def test_no_decoder_exception_ever_escapes(tmp_path: Path) -> None:
    """The sibling of the image processor's: ffmpeg's failures stop at the adapter."""
    path = write_unsupported_file(tmp_path / "notes.txt")

    with pytest.raises(VisionSetError):
        FfmpegVideoProcessor().probe(path)


# --- the tool this adapter does not ship --------------------------------------


@pytest.mark.parametrize("method", ["probe", "frames"], ids=str)
def test_a_missing_binary_is_reported_with_an_install_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, method: str
) -> None:
    """Needs no ffmpeg to run, which is the point: this is the path a fresh machine takes."""
    monkeypatch.setattr(shutil, "which", lambda _program: None)

    with pytest.raises(MediaToolUnavailable, match="apt-get install ffmpeg") as caught:
        getattr(FfmpegVideoProcessor(), method)(tmp_path / "clip.mp4")

    assert "not on PATH" in str(caught.value)


def test_a_missing_binary_is_reported_before_the_file_is_looked_at(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`frames` is not a generator, so "up front" means at the call and not at the first frame."""
    monkeypatch.setattr(shutil, "which", lambda _program: None)

    with pytest.raises(MediaToolUnavailable):
        FfmpegVideoProcessor().frames(tmp_path / "does-not-exist.mp4")


def test_a_missing_binary_is_not_a_media_error() -> None:
    """No file is at fault, so an ingest must not record it against five thousand of them."""
    assert not issubclass(MediaToolUnavailable, MediaError)
    assert issubclass(MediaToolUnavailable, VisionSetError)


# --- the port -----------------------------------------------------------------


def test_the_default_video_processor_satisfies_the_port() -> None:
    assert isinstance(FfmpegVideoProcessor(), VideoProcessor)


def test_the_extraction_arguments_are_pinned() -> None:
    """A change detector on purpose: moving a value here moves every frame hash ever stored."""
    assert _EXTRACTION_ARGS == (
        "-an",
        "-f", "image2pipe",
        "-c:v", "png",
        "-pred", "none",
        "-compression_level", "6",
        "-fflags", "+bitexact",
        "-flags:v", "+bitexact",
    )  # fmt: skip


@pytest.mark.parametrize(
    ("value", "expected"),
    [("10/1", 10.0), ("30000/1001", 29.97002997002997), ("0/0", None), ("", None), (25, 25.0)],
    ids=["cfr", "ntsc", "unknown", "blank", "number"],
)
def test_ffprobes_rational_rates_are_read_as_numbers(value: object, expected: float | None) -> None:
    """`0/0` is how ffprobe says it does not know, and must not surface as a division error."""
    assert _rational(value) == expected


# --- composition --------------------------------------------------------------


class _NullVideoProcessor:
    """A stand-in that decodes nothing — enough to prove the seam, and nothing more."""

    def probe(self, source: Path, *, name: str | None = None) -> VideoMetadata:
        return VideoMetadata(width=1, height=1, fps=1.0, duration_seconds=1.0, codec="none")

    def frames(
        self,
        source: Path,
        *,
        fps: float = DEFAULT_EXTRACTION_FPS,
        name: str | None = None,
    ) -> Iterator[VideoFrame]:
        return iter(())


def test_a_workspace_exposes_a_video_processor_by_default(tmp_path: Path) -> None:
    with WorkspaceService.init(tmp_path / "ws") as workspace:
        assert isinstance(workspace.video_processor, VideoProcessor)
        assert isinstance(workspace.video_processor, FfmpegVideoProcessor)


def test_a_workspace_opens_on_a_machine_with_no_ffmpeg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reason the binary check is not in the constructor: images must still work."""
    monkeypatch.setattr(shutil, "which", lambda _program: None)

    with WorkspaceService.init(tmp_path / "ws") as workspace:
        assert isinstance(workspace.video_processor, FfmpegVideoProcessor)


def test_each_open_workspace_gets_its_own_processor(tmp_path: Path) -> None:
    with (
        WorkspaceService.init(tmp_path / "one") as one,
        WorkspaceService.init(tmp_path / "two") as two,
    ):
        assert one.video_processor is not two.video_processor


def test_a_video_processor_can_be_injected_at_init(tmp_path: Path) -> None:
    with WorkspaceService.init(
        tmp_path / "ws", video_processor_factory=_NullVideoProcessor
    ) as workspace:
        assert isinstance(workspace.video_processor, _NullVideoProcessor)


def test_a_video_processor_can_be_injected_at_open(tmp_path: Path) -> None:
    """The seam an embedder actually reaches for: a workspace it did not create."""
    WorkspaceService.init(tmp_path / "ws").close()

    with WorkspaceService.open(
        tmp_path / "ws", video_processor_factory=_NullVideoProcessor
    ) as workspace:
        assert isinstance(workspace.video_processor, _NullVideoProcessor)


def test_injecting_a_video_processor_leaves_the_other_ports_alone(tmp_path: Path) -> None:
    """The parameter is appended last, so binding it must not shift anything before it."""
    with WorkspaceService.init(
        tmp_path / "ws", video_processor_factory=_NullVideoProcessor
    ) as workspace:
        assert isinstance(workspace.image_processor, PillowImageProcessor)
        assert workspace.root == (tmp_path / "ws").resolve()
