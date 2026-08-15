"""`IngestService`: content identity, recorded origin, and the per-file report.

Two things shape this file, both inherited from `test_source_service.py`.

The ffmpeg requirement arrives through `write_video`, which calls `require_ffmpeg`
itself — there is deliberately no module-level skip. Most of what is asserted here
(dedup, the report, batch targeting, the not-found ladders) is about stills and has
to run on a machine with no ffmpeg at all.

Assertions are about the contract rather than the implementation: "one blob" is
counted on disk because that is the acceptance criterion in the issue, and "the
same asset" compares ids rather than row counts.
"""

from collections.abc import Callable
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from typing import BinaryIO
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from tests.fixtures.media import (
    GeneratedVideo,
    write_corrupt_image,
    write_corrupt_video,
    write_image,
    write_image_in_unsupported_format,
    write_images,
    write_rotated_video,
    write_unsupported_file,
    write_video,
)

from visionset.kernel import (
    AssetNotFound,
    BatchNotEditable,
    BatchNotFound,
    IngestJobNotFound,
    InvalidName,
    InvalidTransition,
    MediaToolUnavailable,
    ProjectNotFound,
    SourceNotFound,
    ThumbnailNotCached,
    UnsupportedMedia,
    WorkspaceCorrupt,
)
from visionset.kernel.adapters import PillowImageProcessor
from visionset.kernel.domain import (
    INGEST_TRANSITIONS,
    Asset,
    BatchState,
    GeometryType,
    ImageFormat,
    ImageMetadata,
    IngestCompleted,
    IngestFailureKind,
    IngestJob,
    IngestState,
    LabelClass,
    Project,
    Source,
    SourceKind,
    VideoFrame,
    VideoMetadata,
    VideoProvenance,
)
from visionset.kernel.ports import (
    DEFAULT_THUMBNAIL_MAX_EDGE,
    FRAME_FORMAT,
    THUMBNAIL_FORMAT,
)
from visionset.kernel.services import (
    BatchService,
    IngestService,
    ProjectService,
    SchemaService,
    SourceService,
    WorkspaceService,
)

# Private, and imported deliberately: the sort key is module level precisely so
# each of its four terms can be shown to be load-bearing against constructed
# assets, which a real ingest cannot arrange.
from visionset.kernel.services.ingest_service import _in_stable_order


class _NoFfmpeg:
    """A `VideoProcessor` on a machine with no decoder installed.

    Injected through the composition point rather than monkeypatched, because
    that seam is exactly what `WorkspaceService` documents it is for.
    """

    def probe(self, source: Path, *, name: str | None = None) -> VideoMetadata:
        raise MediaToolUnavailable("ffmpeg is not installed; install it and try again")

    def frames(
        self, source: Path, *, fps: float = 1.0, name: str | None = None
    ) -> "list[VideoFrame]":
        raise MediaToolUnavailable("ffmpeg is not installed; install it and try again")


class _WatchingProcessor:
    """The real decoder, plus a look at the run's own row before each file.

    Injected through the composition point, like `_NoFfmpeg`. The look is taken
    through a **second** `WorkspaceService` opened on the same directory,
    because what is being tested is that the counters are committed while the
    run is still going — a read on the service doing the work would prove less.
    """

    def __init__(self, root: Path, source_id: list[UUID], seen: list[IngestJob]) -> None:
        self._root = root
        self._source_id = source_id  # filled by the test once the source exists
        self._seen = seen
        self._real = PillowImageProcessor()

    def _observe(self) -> None:
        watcher = WorkspaceService.open(self._root)
        try:
            self._seen.append(IngestService(watcher).list(self._source_id[0])[-1])
        finally:
            watcher.close()

    def probe(self, content: BinaryIO, *, name: str | None = None) -> ImageMetadata:
        self._observe()
        return self._real.probe(content, name=name)

    def thumbnail(
        self, content: BinaryIO, *, max_edge: int = 256, name: str | None = None
    ) -> bytes:
        return self._real.thumbnail(content, max_edge=max_edge, name=name)


class _FailsOnNthFile:
    """A decoder that stops being a decoder partway through, and not politely.

    `OSError` rather than a `MediaError`: the point is a cause the run cannot
    report per file and has to fail on, which is what leaves the counters
    holding the position it reached.
    """

    def __init__(self, nth: int) -> None:
        self._nth = nth
        self._calls = 0
        self._real = PillowImageProcessor()

    def probe(self, content: BinaryIO, *, name: str | None = None) -> ImageMetadata:
        self._calls += 1
        if self._calls == self._nth:
            raise OSError("the disk went away")
        return self._real.probe(content, name=name)

    def thumbnail(
        self, content: BinaryIO, *, max_edge: int = 256, name: str | None = None
    ) -> bytes:
        return self._real.thumbnail(content, max_edge=max_edge, name=name)


class _ThumbnaillessProcessor:
    """A decoder that reads every file and renders a preview for none of them.

    The refusal is a `MediaError`, which is the case that matters: a preview is
    a cache, so it must degrade to a NULL rather than travel out as an
    `IngestFailure` about a file that is perfectly good.
    """

    def __init__(self) -> None:
        self._real = PillowImageProcessor()

    def probe(self, content: BinaryIO, *, name: str | None = None) -> ImageMetadata:
        return self._real.probe(content, name=name)

    def thumbnail(
        self, content: BinaryIO, *, max_edge: int = 256, name: str | None = None
    ) -> bytes:
        raise UnsupportedMedia("no preview today")


def _planted_video_source(workspace: WorkspaceService, project: Project, tmp_path: Path) -> Source:
    """A video source written straight to the store, because registering probes.

    The subject of the tests that use this is the extraction, not the
    registration, and registration would fail first on a machine with no ffmpeg.
    """
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"not really a clip")
    with workspace.unit_of_work() as uow:
        return uow.sources.add(
            Source(
                project_id=project.id,
                kind=SourceKind.VIDEO,
                path=str(clip),
                video=VideoProvenance(
                    metadata=VideoMetadata(
                        width=64, height=48, fps=10.0, duration_seconds=2.0, codec="h264"
                    ),
                    extraction_fps=1.0,
                ),
            )
        )


class Fixture:
    """A workspace with one project, a directory to fill, and every service."""

    def __init__(self, tmp_path: Path, name: str = "ws") -> None:
        self.tmp_path = tmp_path
        self.root = tmp_path / name
        self.workspace = WorkspaceService.init(self.root)
        self.projects = ProjectService(self.workspace)
        self.sources = SourceService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.ingest = IngestService(self.workspace)
        self.project = self.projects.create(f"{name}-project")
        self.stills = tmp_path / f"{name}-stills"
        self.stills.mkdir()

    def clip(self, name: str = "clip.mp4", **kwargs: object) -> GeneratedVideo:
        return write_video(self.tmp_path / name, **kwargs)  # type: ignore[arg-type]

    def blob_hashes(self) -> set[str]:
        """Every blob on disk, named by its hash — `put` is content-addressed."""
        return {path.name for path in (self.root / "blobs").rglob("*") if path.is_file()}

    def blob_count(self) -> int:
        """Blobs on disk, **cached previews included**: distinct bytes of any kind."""
        return len(self.blob_hashes())

    def content_blob_count(self) -> int:
        """The same, with the previews subtracted — ingested content only.

        Every deduplication claim in this file is about *content*: the same
        image is stored once. A preview is stored beside each asset,
        so a bare `blob_count` would make "one image, one blob" read as two and
        say nothing about the dedup it is there to prove. Every project in the
        workspace is walked, because two of these tests ingest into two.
        """
        previews: set[str] = set()
        with self.workspace.unit_of_work() as uow:
            for project in uow.projects.list(self.workspace.workspace_id):
                previews |= {
                    asset.thumbnail_hash
                    for asset in uow.assets.list(project.id)
                    if asset.thumbnail_hash is not None
                }
        return len(self.blob_hashes() - previews)

    def assets(self) -> list[Asset]:
        with self.workspace.unit_of_work() as uow:
            return uow.assets.list(self.project.id)

    def freeze(self, batch_id: UUID) -> None:
        """Approve the batch, creating the schema version approval has to pin."""
        SchemaService(self.workspace).create_version(
            self.project.id, [LabelClass(name="thing", geometries=(GeometryType.BBOX,))]
        )
        self.batches.approve(batch_id)

    def job_in(self, state: IngestState) -> IngestJob:
        """A job in `state`, over a source of two images that is readable now.

        Three of the four are walked to through real operations — `pending` is
        what `enqueue` leaves, `completed` is a run that works, and `failed` is a
        run whose directory was taken away and put back. Only `running` is
        written directly, and it is the one state no operation leaves behind: a
        run that reaches it either finishes or fails inside the same call, and a
        row stuck there is by definition a process that died. Leaving it out
        would leave a quarter of the table unswept.
        """
        write_images(self.stills, count=2)
        source = self.sources.register_images(self.project.id, self.stills)
        if state is IngestState.PENDING:
            return self.ingest.enqueue(source.id)
        if state is IngestState.COMPLETED:
            return self.ingest.get(self.ingest.ingest(source.id).job_id)
        if state is IngestState.FAILED:
            files = sorted(self.stills.iterdir())
            for path in files:
                path.unlink()
            self.stills.rmdir()
            with pytest.raises(FileNotFoundError):
                self.ingest.ingest(source.id)
            self.stills.mkdir()
            write_images(self.stills, count=2)
            return self.ingest.list(source.id)[0]
        with self.workspace.unit_of_work() as uow:
            return uow.ingest_jobs.add(
                IngestJob(source_id=source.id, state=state, batch_name="planted")
            )

    def close(self) -> None:
        self.workspace.close()


# --- a directory of stills ------------------------------------------------


def test_a_directory_of_stills_becomes_assets_in_a_draft_batch(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=3)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert result.created == 3
    assert result.deduplicated == 0
    assert result.failed == 0
    batch = fixture.batches.get(result.batch_id)
    assert batch.state is BatchState.DRAFT
    assert batch.asset_ids == list(result.asset_ids)
    fixture.close()


def test_membership_order_is_the_order_the_directory_was_read_in(tmp_path: Path) -> None:
    """Filename order, so a re-run of an unchanged directory lines up with the first."""
    fixture = Fixture(tmp_path)
    paths = write_images(fixture.stills, count=4)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert [asset.uri for asset in result.assets] == [str(path) for path in sorted(paths)]
    fixture.close()


def test_every_asset_records_the_dimensions_and_format_the_decoder_reported(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "a.png", size=(40, 30), seed=1)
    write_image(fixture.stills / "b.jpg", size=(40, 30), seed=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    by_name = {Path(asset.uri).name: asset for asset in result.assets}
    assert by_name["a.png"].format is ImageFormat.PNG
    assert by_name["b.jpg"].format is ImageFormat.JPEG
    assert (by_name["a.png"].width, by_name["a.png"].height) == (40, 30)
    fixture.close()


def test_the_bytes_decide_the_format_and_not_the_name(tmp_path: Path) -> None:
    """A JPEG somebody renamed is still a JPEG, and the row says so."""
    fixture = Fixture(tmp_path)
    written = write_image(fixture.stills / "truth.jpg")
    written.rename(fixture.stills / "liar.png")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert result.assets[0].format is ImageFormat.JPEG
    fixture.close()


def test_an_exif_rotated_still_is_stored_at_its_displayed_size(tmp_path: Path) -> None:
    """Orientation is applied rather than reported; this is where it lands."""
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "upright.jpg", size=(32, 24), orientation=6)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert (result.assets[0].width, result.assets[0].height) == (24, 32)
    fixture.close()


def test_a_still_records_its_source_and_no_frame_position(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    asset = fixture.ingest.ingest(source.id).assets[0]

    assert asset.source_id == source.id
    assert asset.frame_index is None
    assert asset.frame_timestamp is None
    fixture.close()


def test_a_subdirectory_is_stepped_over_and_reported_nowhere(tmp_path: Path) -> None:
    """Top level only — recursion is a question about what the source *is*."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    write_images(fixture.stills / "nested", count=3)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert result.created == 2
    assert result.failed == 0
    fixture.close()


def test_an_empty_directory_produces_an_empty_draft_batch(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert result.assets == ()
    assert fixture.batches.get(result.batch_id).asset_ids == []
    assert fixture.ingest.get(result.job_id).state is IngestState.COMPLETED
    fixture.close()


# --- a clip ---------------------------------------------------------------


@pytest.mark.parametrize(("rate", "expected"), [(1.0, 2), (5.0, 10), (10.0, 20)])
def test_a_clip_becomes_one_asset_per_extracted_frame(
    tmp_path: Path, rate: float, expected: int
) -> None:
    """The fixture is 10 fps for 2 s, so these three land exactly rather than round."""
    fixture = Fixture(tmp_path)
    clip = fixture.clip()
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=rate)

    result = fixture.ingest.ingest(source.id)

    assert result.created == expected
    fixture.close()


def test_every_frame_records_where_in_the_clip_it_came_from(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    clip = fixture.clip()
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=5.0)

    result = fixture.ingest.ingest(source.id)

    assert [asset.frame_index for asset in result.assets] == list(range(10))
    assert [asset.frame_timestamp for asset in result.assets] == [
        pytest.approx(index / 5.0) for index in range(10)
    ]
    fixture.close()


def test_a_frame_uri_names_the_clip_and_the_frame(tmp_path: Path) -> None:
    """The spelling `MediaError`'s docstring already fixed for a decoded frame."""
    fixture = Fixture(tmp_path)
    clip = fixture.clip()
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=1.0)

    result = fixture.ingest.ingest(source.id)

    assert [asset.uri for asset in result.assets] == [
        f"{source.path}#frame=0",
        f"{source.path}#frame=1",
    ]
    fixture.close()


def test_a_frame_takes_its_size_from_the_probe_and_its_format_from_the_port(
    tmp_path: Path,
) -> None:
    """Frames are not re-decoded to confirm what the port already guarantees.

    `VideoProcessor` owes every frame in `FRAME_FORMAT` at the dimensions `probe`
    reported, and that promise is asserted in the port's own tests. Paying a
    Pillow decode per frame to re-check it would also route our own encoder's
    output into an operator's per-file report.
    """
    fixture = Fixture(tmp_path)
    clip = fixture.clip()
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=1.0)

    asset = fixture.ingest.ingest(source.id).assets[0]

    assert (asset.width, asset.height) == (clip.width, clip.height)
    assert asset.format is FRAME_FORMAT
    fixture.close()


def test_a_rotated_clip_yields_frames_at_their_displayed_size(tmp_path: Path) -> None:
    """The display matrix is applied; a 64x48 file held upright ingests as 48x64."""
    fixture = Fixture(tmp_path)
    clip = write_rotated_video(tmp_path / "upright.mp4")
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=1.0)

    asset = fixture.ingest.ingest(source.id).assets[0]

    assert (asset.width, asset.height) == (clip.height, clip.width)
    fixture.close()


def test_a_truncated_clip_keeps_what_decoded_and_reports_the_break(tmp_path: Path) -> None:
    """Partial success is the contract: ffmpeg yields, then says the bytes ran out."""
    fixture = Fixture(tmp_path)
    clip = write_corrupt_video(tmp_path / "broken.mp4")
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=10.0)

    result = fixture.ingest.ingest(source.id)

    assert 0 < result.created < clip.frame_count
    assert [failure.kind for failure in result.failures] == [IngestFailureKind.PARTIAL]
    # The clip's filename, not `source.path` — that one is absolute.
    assert result.failures[0].name == "broken.mp4"
    assert source.path not in result.failures[0].name
    assert fixture.ingest.get(result.job_id).state is IngestState.COMPLETED
    fixture.close()


def test_a_truncated_clip_reports_how_much_of_it_arrived(tmp_path: Path) -> None:
    """The run holds both numbers, so the report states them instead of a sentence.

    `frames_produced` is exact — it is the length of what the loop kept — and matches the
    assets that landed, which is what makes "the frames are in the batch" checkable rather
    than reassuring. `frames_expected_estimate` is `duration × extraction_fps` off the probe
    the source already carries: at 10 fps over the fixture's two seconds, twenty.
    """
    fixture = Fixture(tmp_path)
    clip = write_corrupt_video(tmp_path / "broken.mp4")
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=10.0)

    result = fixture.ingest.ingest(source.id)

    reported = result.failures[0]
    assert reported.frames_produced == result.created
    assert reported.frames_expected_estimate == clip.frame_count
    # A partial is not a file the run could not read, and the two counts say so
    # apart: something arrived, and this is how much of it did not.
    assert result.partial == 1
    assert result.failed == 0
    fixture.close()


def test_a_clip_that_reads_to_the_end_reports_nothing_at_all(tmp_path: Path) -> None:
    """Silence is the ok-state. A clean run has nothing to say about itself."""
    fixture = Fixture(tmp_path)
    clip = fixture.clip()
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=10.0)

    result = fixture.ingest.ingest(source.id)

    assert result.created == clip.frame_count
    assert result.failures == ()
    assert result.partial == 0
    assert result.failed == 0
    fixture.close()


# --- identity is the content hash -----------------------------------------


def test_the_same_image_in_two_sources_is_one_blob_and_one_asset(tmp_path: Path) -> None:
    """The issue's first acceptance criterion, asserted on the disk and on the rows."""
    fixture = Fixture(tmp_path)
    other = tmp_path / "second"
    write_image(fixture.stills / "shared.png", seed=7)
    write_image(other / "shared.png", seed=7)
    first = fixture.sources.register_images(fixture.project.id, fixture.stills)
    second = fixture.sources.register_images(fixture.project.id, other)

    original = fixture.ingest.ingest(first.id)
    again = fixture.ingest.ingest(second.id)

    assert fixture.content_blob_count() == 1
    assert len(fixture.assets()) == 1
    assert again.created == 0
    assert again.deduplicated == 1
    assert again.asset_ids == original.asset_ids
    fixture.close()


def test_the_first_origin_wins_when_the_same_bytes_arrive_again(tmp_path: Path) -> None:
    """Origin is provenance, not identity, so a second sighting does not rewrite it."""
    fixture = Fixture(tmp_path)
    other = tmp_path / "second"
    write_image(fixture.stills / "shared.png", seed=7)
    write_image(other / "shared.png", seed=7)
    first = fixture.sources.register_images(fixture.project.id, fixture.stills)
    second = fixture.sources.register_images(fixture.project.id, other)
    fixture.ingest.ingest(first.id)

    asset = fixture.ingest.ingest(second.id).assets[0]

    assert asset.source_id == first.id
    assert asset.uri == str(fixture.stills / "shared.png")
    fixture.close()


def test_a_duplicate_still_joins_the_batch_of_the_run_that_found_it(tmp_path: Path) -> None:
    """A duplicate is not new data, but it is part of what this run was asked to gather."""
    fixture = Fixture(tmp_path)
    other = tmp_path / "second"
    write_image(fixture.stills / "shared.png", seed=7)
    write_image(other / "shared.png", seed=7)
    first = fixture.sources.register_images(fixture.project.id, fixture.stills)
    second = fixture.sources.register_images(fixture.project.id, other)
    original = fixture.ingest.ingest(first.id)

    again = fixture.ingest.ingest(second.id)

    assert fixture.batches.get(again.batch_id).asset_ids == list(original.asset_ids)
    fixture.close()


def test_two_identical_files_in_one_directory_become_one_asset(tmp_path: Path) -> None:
    """Within-run dedup. Without it the pair reaches the unique index and the run dies."""
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "a.png", seed=3)
    write_image(fixture.stills / "b.png", seed=3)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert result.created == 1
    assert len(result.assets) == 1
    assert fixture.content_blob_count() == 1
    fixture.close()


def test_re_ingesting_one_source_creates_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=3)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    first = fixture.ingest.ingest(source.id)

    again = fixture.ingest.ingest(source.id)

    assert again.created == 0
    assert again.deduplicated == 3
    assert again.asset_ids == first.asset_ids
    assert fixture.content_blob_count() == 3
    fixture.close()


def test_two_projects_ingesting_one_image_are_two_assets_over_one_blob(tmp_path: Path) -> None:
    """The unique index is per project — that is what makes `project_id` the parent."""
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "shared.png", seed=7)
    other = fixture.projects.create("second-project")
    here = fixture.sources.register_images(fixture.project.id, fixture.stills)
    there = fixture.sources.register_images(other.id, fixture.stills)

    mine = fixture.ingest.ingest(here.id)
    theirs = fixture.ingest.ingest(there.id)

    assert mine.asset_ids != theirs.asset_ids
    assert mine.assets[0].content_hash == theirs.assets[0].content_hash
    assert fixture.content_blob_count() == 1
    fixture.close()


# --- the backstops under it -----------------------------------------------


def test_the_store_refuses_a_second_asset_with_the_same_content(tmp_path: Path) -> None:
    """The rule is the service's; the index is what makes it more than a wish."""
    from visionset.kernel import ConstraintViolated

    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    ingested = fixture.ingest.ingest(source.id).assets[0]

    with pytest.raises(ConstraintViolated), fixture.workspace.unit_of_work() as uow:
        uow.assets.add(ingested.model_copy(update={"id": uuid4()}))
    fixture.close()


def test_the_store_refuses_a_second_source_for_one_origin(tmp_path: Path) -> None:
    """The origin index, now that `asset.source_id` has a target."""
    from visionset.kernel import ConstraintViolated

    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    with pytest.raises(ConstraintViolated), fixture.workspace.unit_of_work() as uow:
        uow.sources.add(source.model_copy(update={"id": uuid4()}))
    fixture.close()


def test_one_clip_at_two_rates_is_still_two_sources(tmp_path: Path) -> None:
    """The fourth index term is doing work rather than decorating the other three."""
    fixture = Fixture(tmp_path)
    clip = fixture.clip()

    slow = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=1.0)
    fast = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=5.0)

    assert slow.id != fast.id
    fixture.close()


# --- the target batch -----------------------------------------------------


def test_a_created_batch_is_named_after_its_source_by_default(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert fixture.batches.get(result.batch_id).name == fixture.stills.name
    fixture.close()


def test_a_caller_may_name_the_batch_the_run_creates(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id, batch_name="monday-dashcam")

    assert fixture.batches.get(result.batch_id).name == "monday-dashcam"
    fixture.close()


def test_an_existing_draft_batch_is_added_to_rather_than_replaced(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    first = fixture.sources.register_images(fixture.project.id, fixture.stills)
    original = fixture.ingest.ingest(first.id)
    more = tmp_path / "more"
    write_images(more, count=2, first_seed=50)
    second = fixture.sources.register_images(fixture.project.id, more)

    again = fixture.ingest.ingest(second.id, batch_id=original.batch_id)

    assert again.batch_id == original.batch_id
    batch = fixture.batches.get(original.batch_id)
    assert batch.asset_ids == [*original.asset_ids, *again.asset_ids]
    fixture.close()


def test_ingesting_into_a_frozen_batch_is_refused_before_anything_is_decoded(
    tmp_path: Path,
) -> None:
    """Fail-fast asserted rather than assumed: no blobs, no assets, no job left running."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    seed = fixture.sources.register_images(fixture.project.id, fixture.stills)
    opened = fixture.ingest.ingest(seed.id)
    fixture.freeze(opened.batch_id)
    more = tmp_path / "more"
    write_images(more, count=2, first_seed=90)
    second = fixture.sources.register_images(fixture.project.id, more)
    blobs_before = fixture.blob_count()

    with pytest.raises(BatchNotEditable):
        fixture.ingest.ingest(second.id, batch_id=opened.batch_id)

    assert fixture.blob_count() == blobs_before
    assert len(fixture.assets()) == 2
    assert fixture.ingest.list(second.id) == []
    fixture.close()


def test_ingesting_into_a_batch_of_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    elsewhere = Fixture(tmp_path, name="other")
    stranger = elsewhere.batches.create(elsewhere.project.id, "theirs")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    with pytest.raises(BatchNotFound):
        fixture.ingest.ingest(source.id, batch_id=stranger.id)

    elsewhere.close()
    fixture.close()


def test_a_blank_batch_name_is_refused_before_anything_is_decoded(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    with pytest.raises(InvalidName):
        fixture.ingest.ingest(source.id, batch_name="   ")

    assert fixture.blob_count() == 0
    fixture.close()


# --- the per-file report --------------------------------------------------


def test_a_file_that_is_not_an_image_is_reported_and_the_run_carries_on(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    notes = write_unsupported_file(fixture.stills / "notes.txt")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert result.created == 2
    assert [failure.name for failure in result.failures] == [notes.name]
    fixture.close()


def test_a_refused_file_leaves_no_blob_behind(tmp_path: Path) -> None:
    """Probe before put, which is the whole reason for that ordering."""
    fixture = Fixture(tmp_path)
    write_unsupported_file(fixture.stills / "notes.txt")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    fixture.ingest.ingest(source.id)

    assert fixture.blob_count() == 0
    fixture.close()


def test_a_report_line_keeps_the_name_and_the_reason_apart(tmp_path: Path) -> None:
    """So a report renders as a table rather than as a list of sentences."""
    fixture = Fixture(tmp_path)
    notes = write_unsupported_file(fixture.stills / "notes.txt")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    failure = fixture.ingest.ingest(source.id).failures[0]

    assert failure.name == notes.name
    assert str(notes) not in failure.reason
    assert notes.name not in failure.reason
    fixture.close()


def test_a_report_line_names_the_file_without_naming_the_server(tmp_path: Path) -> None:
    """This report travels to REST, the CLI and MCP, and must not carry
    the absolute path the run's own loop happened to be holding — the one place a
    server path reached a client, while `Source.path` and `Asset.uri` are kept
    off the wire on purpose.
    """
    fixture = Fixture(tmp_path)
    write_unsupported_file(fixture.stills / "notes.txt")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    failure = fixture.ingest.ingest(source.id).failures[0]

    assert failure.name == "notes.txt"
    # Both halves matter: not the directory that was read, and not the workspace
    # it sits under. A basename that happened to contain neither would pass the
    # first and tell us nothing.
    assert str(fixture.stills) not in failure.name
    assert str(tmp_path) not in failure.name
    assert source.path not in failure.name
    fixture.close()


def test_the_report_separates_data_loss_from_operator_noise(tmp_path: Path) -> None:
    """Why `IngestFailureKind` exists: a reason sentence cannot be grouped on."""
    fixture = Fixture(tmp_path)
    write_unsupported_file(fixture.stills / "notes.txt")
    write_image_in_unsupported_format(fixture.stills / "old.bmp")
    write_corrupt_image(fixture.stills / "half.png")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    by_name = {failure.name: failure.kind for failure in result.failures}
    assert by_name == {
        "notes.txt": IngestFailureKind.UNSUPPORTED,
        "old.bmp": IngestFailureKind.UNSUPPORTED,
        "half.png": IngestFailureKind.CORRUPT,
    }
    fixture.close()


def test_per_file_failures_do_not_fail_the_job(tmp_path: Path) -> None:
    """The remedy split, asserted at the level where it decides something."""
    fixture = Fixture(tmp_path)
    write_unsupported_file(fixture.stills / "notes.txt")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert fixture.ingest.get(result.job_id).state is IngestState.COMPLETED
    fixture.close()


# --- the job record -------------------------------------------------------


def test_a_completed_run_leaves_a_job_pointing_at_its_source_and_its_batch(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    job = fixture.ingest.get(result.job_id)
    assert job.state is IngestState.COMPLETED
    assert job.source_id == source.id
    assert job.batch_id == result.batch_id
    assert job.error is None
    fixture.close()


def test_a_missing_decoder_fails_the_job_and_is_re_raised(tmp_path: Path) -> None:
    """One broken machine is not five thousand broken files — hence no report line."""
    workspace = WorkspaceService.init(tmp_path / "ws", video_processor_factory=_NoFfmpeg)
    projects = ProjectService(workspace)
    ingest = IngestService(workspace)
    source = _planted_video_source(workspace, projects.create("p"), tmp_path)

    with pytest.raises(MediaToolUnavailable):
        ingest.ingest(source.id)

    job = ingest.list(source.id)[0]
    assert job.state is IngestState.FAILED
    assert "ffmpeg" in (job.error or "")
    assert job.batch_id is None
    workspace.close()


def test_a_source_that_has_been_deleted_fails_the_job_and_is_re_raised(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.stills.rmdir()

    with pytest.raises(FileNotFoundError):
        fixture.ingest.ingest(source.id)

    assert fixture.ingest.list(source.id)[0].state is IngestState.FAILED
    fixture.close()


def test_every_run_of_one_source_is_listed_in_order(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    first = fixture.ingest.ingest(source.id)
    second = fixture.ingest.ingest(source.id)

    assert [job.id for job in fixture.ingest.list(source.id)] == [first.job_id, second.job_id]
    fixture.close()


def test_require_job_resolves_inside_a_callers_transaction(tmp_path: Path) -> None:
    """The gate the service runs in its own unit of work before every write."""
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    result = fixture.ingest.ingest(source.id)

    with fixture.workspace.unit_of_work() as uow:
        assert fixture.ingest.require_job(uow, result.job_id).id == result.job_id
    fixture.close()


# --- the transition table, swept in full ----------------------------------


@pytest.mark.parametrize("origin", list(IngestState), ids=lambda s: f"from-{s.value}")
def test_the_transition_table_is_the_whole_of_what_can_be_resumed(
    tmp_path: Path, origin: IngestState
) -> None:
    """Every state, checked against the table itself rather than against a list.

    `resume` is the one operation that names a target — `running` — so the
    column of the square it can reach is the whole of what there is to sweep.
    """
    fixture = Fixture(tmp_path)
    job = fixture.job_in(origin)

    if IngestState.RUNNING in INGEST_TRANSITIONS[origin]:
        assert fixture.ingest.resume(job.id).job_id == job.id
        assert fixture.ingest.get(job.id).state is IngestState.COMPLETED
    else:
        with pytest.raises(InvalidTransition, match="cannot become"):
            fixture.ingest.resume(job.id)
        assert fixture.ingest.get(job.id).state is origin
    fixture.close()


def test_a_completed_run_can_go_nowhere() -> None:
    assert INGEST_TRANSITIONS[IngestState.COMPLETED] == frozenset()


def test_a_run_stuck_at_running_cannot_be_resumed() -> None:
    """A crashed process is not a reported failure, and must not be overwritten.

    Ingesting the source again is the remedy — content addressing makes that
    create nothing — and it leaves the stuck row as the record of the crash.
    """
    assert IngestState.RUNNING not in INGEST_TRANSITIONS[IngestState.RUNNING]


def test_the_refusal_says_where_the_run_can_actually_go(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(IngestState.COMPLETED)

    with pytest.raises(InvalidTransition, match="can only become nothing"):
        fixture.ingest.resume(job.id)
    fixture.close()


# --- progress, while the run is still going -------------------------------


def test_progress_is_visible_to_somebody_who_is_not_running_the_ingest(
    tmp_path: Path,
) -> None:
    """The polling contract, read the way the API and the UI will read it.

    The observer is a *second* `WorkspaceService` opened on the same directory,
    not another call on the one doing the work: what is being claimed is that
    the counters are committed as the run goes, and only a separate connection
    can show that.
    """
    root = tmp_path / "ws"
    source_id: list[UUID] = []
    seen: list[IngestJob] = []
    workspace = WorkspaceService.init(
        root, image_processor_factory=lambda: _WatchingProcessor(root, source_id, seen)
    )
    projects = ProjectService(workspace)
    sources = SourceService(workspace)
    ingest = IngestService(workspace)
    project = projects.create("p")
    stills = tmp_path / "stills"
    stills.mkdir()
    write_images(stills, count=3)
    source = sources.register_images(project.id, stills)
    source_id.append(source.id)

    result = ingest.ingest(source.id)

    # One observation per file, each taken before that file was counted.
    assert [job.processed for job in seen] == [0, 1, 2]
    assert {job.total for job in seen} == {3}
    assert {job.state for job in seen} == {IngestState.RUNNING}
    assert ingest.get(result.job_id).processed == 3
    workspace.close()


def test_a_completed_run_records_how_many_items_it_processed(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=4)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    job = fixture.ingest.get(result.job_id)
    assert (job.processed, job.total) == (4, 4)
    fixture.close()


def test_an_unreadable_file_still_counts_as_processed(tmp_path: Path) -> None:
    """`processed` is items dealt with, not items that became assets."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    write_unsupported_file(fixture.stills / "notes.txt")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    job = fixture.ingest.get(result.job_id)
    assert (job.processed, job.total) == (3, 3)
    fixture.close()


def test_an_empty_directory_records_a_total_of_zero(tmp_path: Path) -> None:
    """Written before the loop, which is the only reason an empty run says anything."""
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    job = fixture.ingest.get(result.job_id)
    assert (job.processed, job.total) == (0, 0)
    fixture.close()


def test_a_clip_records_no_total_because_extraction_decides_it(tmp_path: Path) -> None:
    """`VideoMetadata` carries no frame count, so a total here would be a guess."""
    fixture = Fixture(tmp_path)
    clip = fixture.clip()
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=1.0)

    result = fixture.ingest.ingest(source.id)

    job = fixture.ingest.get(result.job_id)
    assert job.total is None
    assert job.processed == len(result.assets)
    fixture.close()


# --- the report, on the row -----------------------------------------------


def test_a_run_records_which_files_failed_and_why(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    write_corrupt_image(fixture.stills / "broken.png")
    write_unsupported_file(fixture.stills / "notes.txt")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    job = fixture.ingest.get(result.job_id)
    assert job.state is IngestState.COMPLETED  # per-file failures do not fail a run
    assert job.failures == result.failures
    assert {failure.kind for failure in job.failures} == {
        IngestFailureKind.CORRUPT,
        IngestFailureKind.UNSUPPORTED,
    }
    for failure in job.failures:
        assert failure.name not in failure.reason
    fixture.close()


def test_a_fatal_cause_is_recorded_apart_from_the_per_file_report(tmp_path: Path) -> None:
    """One broken machine is not five thousand broken files, on the row too."""
    workspace = WorkspaceService.init(tmp_path / "ws", video_processor_factory=_NoFfmpeg)
    ingest = IngestService(workspace)
    source = _planted_video_source(workspace, ProjectService(workspace).create("p"), tmp_path)

    with pytest.raises(MediaToolUnavailable):
        ingest.ingest(source.id)

    job = ingest.list(source.id)[0]
    assert job.state is IngestState.FAILED
    assert "ffmpeg" in (job.error or "")
    assert job.failures == ()
    workspace.close()


def test_a_failed_run_keeps_the_progress_it_had_made(tmp_path: Path) -> None:
    """How far it got is the first thing anyone reading a failure wants.

    The decoder gives up on the third of four files with something that is not a
    `MediaError` at all — a disk that went away, say — so the run stops rather
    than reporting it, and the two files it had already counted stay counted.
    """
    root = tmp_path / "ws"
    workspace = WorkspaceService.init(root, image_processor_factory=lambda: _FailsOnNthFile(3))
    sources = SourceService(workspace)
    ingest = IngestService(workspace)
    project = ProjectService(workspace).create("p")
    stills = tmp_path / "stills"
    stills.mkdir()
    write_images(stills, count=4)
    source = sources.register_images(project.id, stills)

    with pytest.raises(OSError, match="the disk went away"):
        ingest.ingest(source.id)

    job = ingest.list(source.id)[0]
    assert job.state is IngestState.FAILED
    assert (job.processed, job.total) == (2, 4)
    workspace.close()


# --- asking for a run without doing it -------------------------------------


def test_enqueue_leaves_a_pending_job_and_reads_nothing(tmp_path: Path) -> None:
    """The half a caller needs when the work happens somewhere else."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    job = fixture.ingest.enqueue(source.id)

    assert job.state is IngestState.PENDING
    assert (job.processed, job.total, job.failures) == (0, None, ())
    assert fixture.assets() == []
    assert fixture.batches.list(fixture.project.id) == []
    fixture.close()


def test_resume_is_how_an_enqueued_run_is_started(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    job = fixture.ingest.enqueue(source.id, batch_name="monday")

    result = fixture.ingest.resume(job.id)

    assert result.job_id == job.id
    assert fixture.ingest.get(job.id).state is IngestState.COMPLETED
    assert fixture.batches.get(result.batch_id).name == "monday"
    assert len(result.created_asset_ids) == 2
    fixture.close()


def test_enqueue_refuses_before_it_writes_a_row(tmp_path: Path) -> None:
    """The point of the split: a refused launch leaves nothing to poll."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    with pytest.raises(SourceNotFound):
        fixture.ingest.enqueue(uuid4())
    with pytest.raises(InvalidName, match="batch name"):
        fixture.ingest.enqueue(source.id, batch_name="   ")

    assert fixture.ingest.list(source.id) == []
    fixture.close()


def test_enqueue_records_the_batch_the_run_is_headed_for(tmp_path: Path) -> None:
    """`resume` reads it back, so it has to be on the row rather than in a caller."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    target = fixture.batches.create(fixture.project.id, "waiting")

    job = fixture.ingest.enqueue(source.id, batch_id=target.id)
    assert job.batch_id == target.id

    result = fixture.ingest.resume(job.id)
    assert result.batch_id == target.id
    assert len(fixture.batches.get(target.id).asset_ids) == 2
    fixture.close()


def test_enqueue_refuses_a_frozen_target_batch(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    batch = fixture.batches.create(
        fixture.project.id, "frozen", fixture.ingest.ingest(source.id).asset_ids
    )
    fixture.freeze(batch.id)

    with pytest.raises(BatchNotEditable):
        fixture.ingest.enqueue(source.id, batch_id=batch.id)
    fixture.close()


def test_resumable_reports_a_job_that_may_run_without_moving_it(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(IngestState.FAILED)

    assert fixture.ingest.resumable(job.id).id == job.id
    assert fixture.ingest.get(job.id).state is IngestState.FAILED
    fixture.close()


@pytest.mark.parametrize("state", [IngestState.COMPLETED, IngestState.RUNNING])
def test_resumable_refuses_exactly_what_resume_refuses(tmp_path: Path, state: IngestState) -> None:
    """One spelling of the pre-check, so a caller that runs the work elsewhere
    gets the same refusal on its own thread."""
    fixture = Fixture(tmp_path)
    job = fixture.job_in(state)

    with pytest.raises(InvalidTransition):
        fixture.ingest.resumable(job.id)
    with pytest.raises(InvalidTransition):
        fixture.ingest.resume(job.id)
    fixture.close()


# --- resuming a failed run ------------------------------------------------


def test_resuming_a_failed_run_completes_it_on_the_same_row(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(IngestState.FAILED)

    result = fixture.ingest.resume(job.id)

    assert result.job_id == job.id
    assert fixture.ingest.get(job.id).state is IngestState.COMPLETED
    assert fixture.batches.get(result.batch_id).asset_ids == list(result.asset_ids)
    fixture.close()


def test_resuming_creates_no_second_job(tmp_path: Path) -> None:
    """A run is one unit of work; a row per attempt would fork its batch."""
    fixture = Fixture(tmp_path)
    job = fixture.job_in(IngestState.FAILED)

    fixture.ingest.resume(job.id)

    assert [stored.id for stored in fixture.ingest.list(job.source_id)] == [job.id]
    fixture.close()


def test_resuming_clears_the_previous_attempts_report(tmp_path: Path) -> None:
    """The counters and the report describe *this* attempt, not the last one."""
    fixture = Fixture(tmp_path)
    job = fixture.job_in(IngestState.FAILED)
    assert fixture.ingest.get(job.id).error is not None

    fixture.ingest.resume(job.id)

    resumed = fixture.ingest.get(job.id)
    assert resumed.error is None
    assert resumed.failures == ()
    assert (resumed.processed, resumed.total) == (2, 2)
    fixture.close()


def test_resuming_keeps_the_batch_name_the_first_attempt_was_given(tmp_path: Path) -> None:
    """Which is what `batch_name` is a column for: a failed run reached no batch."""
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.stills.rmdir()
    with pytest.raises(FileNotFoundError):
        fixture.ingest.ingest(source.id, batch_name="monday")
    fixture.stills.mkdir()
    write_images(fixture.stills, count=1)

    job = fixture.ingest.list(source.id)[0]
    result = fixture.ingest.resume(job.id)

    assert fixture.batches.get(result.batch_id).name == "monday"
    fixture.close()


def test_resuming_creates_no_new_blobs_for_what_was_already_stored(tmp_path: Path) -> None:
    """Resume is a redo, and a redo of content-addressed work costs no storage."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=3)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    result = fixture.ingest.ingest(source.id)
    before = fixture.blob_count()
    # Put the completed run back into a state resume accepts, which nothing
    # public does: the point here is the second read of the same bytes.
    with fixture.workspace.unit_of_work() as uow:
        stored = uow.ingest_jobs.get(result.job_id)
        assert stored is not None
        uow.ingest_jobs.update(stored.model_copy(update={"state": IngestState.FAILED}))

    again = fixture.ingest.resume(result.job_id)

    assert again.created == 0
    assert again.asset_ids == result.asset_ids
    assert fixture.blob_count() == before
    fixture.close()


def test_a_resumed_run_announces_itself(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(IngestState.FAILED)
    announced: list[IngestCompleted] = []
    fixture.workspace.event_bus.subscribe(IngestCompleted, announced.append)

    fixture.ingest.resume(job.id)

    assert [event.ingest_job_id for event in announced] == [job.id]
    fixture.close()


def test_resuming_into_a_batch_that_was_frozen_meanwhile_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    batch = fixture.batches.create(fixture.project.id, "target", [])
    result = fixture.ingest.ingest(source.id, batch_id=batch.id)
    with fixture.workspace.unit_of_work() as uow:
        stored = uow.ingest_jobs.get(result.job_id)
        assert stored is not None
        uow.ingest_jobs.update(stored.model_copy(update={"state": IngestState.FAILED}))
    fixture.freeze(batch.id)

    with pytest.raises(BatchNotEditable):
        fixture.ingest.resume(result.job_id)
    fixture.close()


# --- a preview per asset --------------------------------------------------


def _preview(fixture: Fixture, asset: Asset) -> ImageMetadata:
    """Decode what was cached for `asset`, so the assertions can be about it."""
    assert asset.thumbnail_hash is not None
    with fixture.workspace.blob_store.get(asset.thumbnail_hash) as cached:
        return PillowImageProcessor().probe(cached)


def _blob_path(fixture: Fixture, content_hash: str) -> Path:
    """Where `FilesystemBlobStore` keeps that hash, so a test can damage it."""
    return fixture.root / "blobs" / content_hash[:2] / content_hash[2:4] / content_hash


def _reread(fixture: Fixture, asset_id: UUID) -> Asset:
    return next(asset for asset in fixture.assets() if asset.id == asset_id)


def test_every_ingested_still_gets_a_preview_in_the_blob_store(tmp_path: Path) -> None:
    """The issue's first acceptance criterion: retrievable by hash."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=3)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert all(asset.thumbnail_hash is not None for asset in result.assets)
    assert all(fixture.workspace.blob_store.exists(a.thumbnail_hash or "") for a in result.assets)
    # Three images and the three previews beside them, none of them shared.
    assert fixture.blob_count() == 6
    assert fixture.content_blob_count() == 3
    fixture.close()


def test_a_preview_is_a_jpeg_whatever_the_source_was(tmp_path: Path) -> None:
    """The port pins the encoding, so the cache holds one format and not four."""
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "a.png", seed=1)
    write_image(fixture.stills / "b.jpg", seed=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert {asset.format for asset in result.assets} == {ImageFormat.PNG, ImageFormat.JPEG}
    assert {_preview(fixture, asset).format for asset in result.assets} == {THUMBNAIL_FORMAT}
    fixture.close()


def test_a_preview_is_bounded_by_the_port_s_pinned_edge(tmp_path: Path) -> None:
    """Asserted against the constant, never a number copied out of it."""
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "big.png", size=(1024, 512))
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    asset = fixture.ingest.ingest(source.id).assets[0]

    preview = _preview(fixture, asset)
    assert max(preview.width, preview.height) == DEFAULT_THUMBNAIL_MAX_EDGE
    assert (asset.width, asset.height) == (1024, 512)
    fixture.close()


def test_a_small_image_is_not_enlarged_into_its_preview(tmp_path: Path) -> None:
    """`thumbnail` never upscales, so the cache is not bigger than the asset."""
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "small.png")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    asset = fixture.ingest.ingest(source.id).assets[0]

    preview = _preview(fixture, asset)
    assert (preview.width, preview.height) == (asset.width, asset.height)
    fixture.close()


def test_the_same_image_renders_the_same_preview_blob(tmp_path: Path) -> None:
    """Repeatability, asserted as an equality — never against a hardcoded hash.

    Determinism is promised within one Pillow build and not across them, which
    is the whole reason a thumbnail hash is a cache key rather than an identity.
    Two projects are used because within one, dedup would make this trivially
    true by never rendering the second.
    """
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "shared.png", seed=7)
    other = fixture.projects.create("second-project")
    here = fixture.sources.register_images(fixture.project.id, fixture.stills)
    there = fixture.sources.register_images(other.id, fixture.stills)

    mine = fixture.ingest.ingest(here.id)
    theirs = fixture.ingest.ingest(there.id)

    assert mine.assets[0].thumbnail_hash == theirs.assets[0].thumbnail_hash
    # One image, one preview: two assets over two blobs, not four.
    assert fixture.blob_count() == 2
    fixture.close()


def test_two_identical_files_share_one_preview_blob(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "a.png", seed=3)
    write_image(fixture.stills / "b.png", seed=3)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    fixture.ingest.ingest(source.id)

    assert fixture.blob_count() == 2
    fixture.close()


def test_a_frame_gets_a_preview_too(tmp_path: Path) -> None:
    """The no-re-probe rule is about reported metadata, not about the cache."""
    fixture = Fixture(tmp_path)
    clip = fixture.clip(fps=10, duration_seconds=1.0)
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=1.0)

    result = fixture.ingest.ingest(source.id)

    assert result.assets
    assert all(asset.thumbnail_hash is not None for asset in result.assets)
    assert {_preview(fixture, asset).format for asset in result.assets} == {THUMBNAIL_FORMAT}
    fixture.close()


def test_a_preview_that_will_not_render_leaves_a_null_and_no_failure(tmp_path: Path) -> None:
    """A cache miss is not data loss, so it must not reach the per-file report."""
    root = tmp_path / "ws"
    workspace = WorkspaceService.init(root, image_processor_factory=_ThumbnaillessProcessor)
    ingest = IngestService(workspace)
    project = ProjectService(workspace).create("p")
    stills = tmp_path / "stills"
    stills.mkdir()
    write_images(stills, count=2)
    source = SourceService(workspace).register_images(project.id, stills)

    result = ingest.ingest(source.id)

    assert len(result.assets) == 2
    assert result.failures == ()
    assert all(asset.thumbnail_hash is None for asset in result.assets)
    # The two images, and nothing beside them.
    assert len([p for p in (root / "blobs").rglob("*") if p.is_file()]) == 2
    workspace.close()


def test_a_refused_file_still_leaves_no_blob_of_either_kind(tmp_path: Path) -> None:
    """Probing first is what keeps this true once a second `put` joined the loop."""
    fixture = Fixture(tmp_path)
    write_unsupported_file(fixture.stills / "notes.txt")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert result.failed == 1
    assert fixture.blob_count() == 0
    fixture.close()


def test_re_ingesting_fills_a_preview_an_earlier_asset_never_had(tmp_path: Path) -> None:
    """A cache is filled by whoever first holds the bytes; provenance is not.

    The planted asset stands in for one written before this column existed.
    """
    fixture = Fixture(tmp_path)
    path = write_image(fixture.stills / "one.png", seed=5)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    with fixture.workspace.unit_of_work() as uow:
        planted = uow.assets.add(
            Asset(
                project_id=fixture.project.id,
                content_hash=fixture.workspace.blob_store.put(path.open("rb")),
                uri="somewhere/else.png",
            )
        )

    result = fixture.ingest.ingest(source.id)

    assert result.created == 0
    assert result.assets[0].id == planted.id
    assert result.assets[0].thumbnail_hash is not None
    # Origin still records the first sighting; only the cache was filled.
    assert result.assets[0].uri == "somewhere/else.png"
    assert result.assets[0].source_id is None
    fixture.close()


def test_re_ingesting_does_not_replace_a_preview_that_is_already_there(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "one.png", seed=5)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    first = fixture.ingest.ingest(source.id).assets[0]

    again = fixture.ingest.ingest(source.id).assets[0]

    assert again.thumbnail_hash == first.thumbnail_hash
    fixture.close()


# --- the backfill ---------------------------------------------------------


def _plant_unrendered(fixture: Fixture, count: int) -> list[Asset]:
    """`count` assets holding real bytes and no preview, as an unbackfilled row does."""
    planted: list[Asset] = []
    for path in write_images(fixture.stills, count=count, first_seed=11):
        with fixture.workspace.unit_of_work() as uow, path.open("rb") as handle:
            planted.append(
                uow.assets.add(
                    Asset(
                        project_id=fixture.project.id,
                        content_hash=fixture.workspace.blob_store.put(handle),
                        uri=str(path),
                        format=ImageFormat.PNG,
                    )
                )
            )
    return planted


def test_the_backfill_renders_a_preview_for_every_asset_missing_one(tmp_path: Path) -> None:
    """The issue's second acceptance criterion."""
    fixture = Fixture(tmp_path)
    planted = _plant_unrendered(fixture, count=3)

    report = fixture.ingest.backfill_thumbnails(fixture.project.id)

    assert report.project_id == fixture.project.id
    assert set(report.filled) == {asset.id for asset in planted}
    assert report.examined == 3
    assert report.missing == () and report.unreadable == ()
    assert all(asset.thumbnail_hash is not None for asset in fixture.assets())
    fixture.close()


def test_a_second_backfill_pass_finds_nothing_left_to_do(tmp_path: Path) -> None:
    """Idempotent, and cheap to re-run: there is no state to reset between passes."""
    fixture = Fixture(tmp_path)
    _plant_unrendered(fixture, count=2)
    fixture.ingest.backfill_thumbnails(fixture.project.id)
    before = fixture.blob_count()

    report = fixture.ingest.backfill_thumbnails(fixture.project.id)

    assert report.examined == 0
    assert fixture.blob_count() == before
    fixture.close()


def test_the_backfill_leaves_an_asset_that_already_has_a_preview_alone(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    ingested = fixture.ingest.ingest(source.id)

    report = fixture.ingest.backfill_thumbnails(fixture.project.id)

    assert report.examined == 0
    assert {a.thumbnail_hash for a in fixture.assets()} == {
        a.thumbnail_hash for a in ingested.assets
    }
    fixture.close()


def test_the_backfill_reads_the_blob_rather_than_the_file_it_came_from(tmp_path: Path) -> None:
    """`uri` may name a path that is long gone; the workspace holds the bytes."""
    fixture = Fixture(tmp_path)
    planted = _plant_unrendered(fixture, count=1)
    for path in fixture.stills.iterdir():
        path.unlink()

    report = fixture.ingest.backfill_thumbnails(fixture.project.id)

    assert report.filled == (planted[0].id,)
    fixture.close()


def test_an_asset_whose_blob_is_gone_is_reported_rather_than_raised(tmp_path: Path) -> None:
    """Workspace damage a preview pass cannot repair, and must not hide.

    Not a `WorkspaceCorrupt`: raising would abandon the repair of every healthy
    asset over one bad row, which is the argument `ReleaseVerification` already
    makes for reporting.
    """
    fixture = Fixture(tmp_path)
    planted = _plant_unrendered(fixture, count=2)
    _blob_path(fixture, planted[0].content_hash).unlink()

    report = fixture.ingest.backfill_thumbnails(fixture.project.id)

    assert report.missing == (planted[0].id,)
    assert report.filled == (planted[1].id,)
    assert report.examined == 2
    assert _reread(fixture, planted[0].id).thumbnail_hash is None
    fixture.close()


def test_stored_bytes_that_will_not_render_are_reported_by_remedy(tmp_path: Path) -> None:
    """`IngestFailure` earns its reuse here: the split says the right thing."""
    fixture = Fixture(tmp_path)
    planted = _plant_unrendered(fixture, count=2)
    _blob_path(fixture, planted[0].content_hash).write_bytes(b"not an image at all")

    report = fixture.ingest.backfill_thumbnails(fixture.project.id)

    assert report.filled == (planted[1].id,)
    assert [failure.kind for failure in report.unreadable] == [IngestFailureKind.UNSUPPORTED]
    # The basename of the uri, never the uri: `Asset.uri` is unpublished and
    # this report travels to the CLI and to MCP.
    assert report.unreadable[0].name == Path(planted[0].uri).name
    assert planted[0].uri not in report.unreadable[0].reason
    fixture.close()


def test_backfilling_a_project_in_another_workspace_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    elsewhere = Fixture(tmp_path, name="other")

    with pytest.raises(ProjectNotFound):
        fixture.ingest.backfill_thumbnails(elsewhere.project.id)

    elsewhere.close()
    fixture.close()


# --- scope ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("call", "expected"),
    [
        pytest.param(
            lambda fx: fx.ingest.ingest(uuid4()),
            SourceNotFound,
            id="ingesting-an-unknown-source",
        ),
        pytest.param(
            lambda fx: fx.ingest.get(uuid4()),
            IngestJobNotFound,
            id="getting-an-unknown-job",
        ),
        pytest.param(
            lambda fx: fx.ingest.resume(uuid4()),
            IngestJobNotFound,
            id="resuming-an-unknown-job",
        ),
        pytest.param(
            lambda fx: fx.ingest.resumable(uuid4()),
            IngestJobNotFound,
            id="asking-whether-an-unknown-job-is-resumable",
        ),
        # Refused rather than answered with an empty report, which would read as
        # "nothing to do" rather than "no such thing".
        pytest.param(
            lambda fx: fx.ingest.backfill_thumbnails(uuid4()),
            ProjectNotFound,
            id="backfilling-an-unknown-project",
        ),
        pytest.param(
            lambda fx: fx.ingest.assets(uuid4()),
            ProjectNotFound,
            id="listing-an-unknown-projects-assets",
        ),
        pytest.param(
            lambda fx: fx.ingest.asset(fx.project.id, uuid4()),
            AssetNotFound,
            id="reading-an-unknown-asset",
        ),
        # The project is resolved before the asset, so a caller who mistypes the
        # project hears about the project rather than about the asset.
        pytest.param(
            lambda fx: fx.ingest.asset(uuid4(), uuid4()),
            ProjectNotFound,
            id="reading-an-asset-of-an-unknown-project",
        ),
    ],
)
def test_naming_something_that_does_not_exist_is_refused(
    tmp_path: Path,
    call: Callable[[Fixture], object],
    expected: type[Exception],
) -> None:
    """Every entry point's not-found answer, in one table.

    The rows are the point: which calls are covered is visible at a glance, and so
    is which are not. The last two are a pair rather than a repetition — reading an
    asset resolves its project first, so the two ways of naming something absent
    answer with two different refusals.
    """
    fixture = Fixture(tmp_path)
    with pytest.raises(expected):
        call(fixture)
    fixture.close()


def test_an_ingest_job_in_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    elsewhere = Fixture(tmp_path, name="other")
    source = elsewhere.sources.register_images(elsewhere.project.id, elsewhere.stills)
    theirs = elsewhere.ingest.ingest(source.id)

    with pytest.raises(IngestJobNotFound):
        fixture.ingest.get(theirs.job_id)

    elsewhere.close()
    fixture.close()


# --- announcements --------------------------------------------------------


def test_a_completed_ingest_announces_itself(tmp_path: Path) -> None:
    """The tripwire M1 left on purpose, flipped: something emits this now."""
    fixture = Fixture(tmp_path)
    seen: list[IngestCompleted] = []
    fixture.workspace.event_bus.subscribe(IngestCompleted, seen.append)
    write_images(fixture.stills, count=3)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert len(seen) == 1
    assert seen[0].ingest_job_id == result.job_id
    assert seen[0].project_id == fixture.project.id
    assert seen[0].source_id == source.id
    assert seen[0].asset_count == 3
    fixture.close()


def test_a_run_that_failed_announces_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    seen: list[IngestCompleted] = []
    fixture.workspace.event_bus.subscribe(IngestCompleted, seen.append)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.stills.rmdir()

    with pytest.raises(FileNotFoundError):
        fixture.ingest.ingest(source.id)

    assert seen == []
    fixture.close()


def test_the_announcement_follows_the_commit(tmp_path: Path) -> None:
    """A subscriber reading the workspace back must find the work already there."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    found: list[int] = []

    def count_members(event: IngestCompleted) -> None:
        with fixture.workspace.unit_of_work() as uow:
            found.append(len(uow.assets.list(event.project_id)))

    fixture.workspace.event_bus.subscribe(IngestCompleted, count_members)
    fixture.ingest.ingest(source.id)

    assert found == [2]
    fixture.close()


# --- the domain invariant -------------------------------------------------


def _asset(**overrides: object) -> Asset:
    fields: dict[str, object] = {
        "project_id": uuid4(),
        "content_hash": "a" * 64,
        "uri": "file:///x.png",
    }
    fields.update(overrides)
    return Asset(**fields)  # type: ignore[arg-type]


def test_a_frame_index_without_a_timestamp_is_refused() -> None:
    with pytest.raises(ValidationError, match="together or not at all"):
        _asset(source_id=uuid4(), frame_index=0)


def test_a_frame_timestamp_without_an_index_is_refused() -> None:
    with pytest.raises(ValidationError, match="together or not at all"):
        _asset(source_id=uuid4(), frame_timestamp=0.0)


def test_a_frame_position_without_a_source_is_refused() -> None:
    with pytest.raises(ValidationError, match="needs the source"):
        _asset(frame_index=0, frame_timestamp=0.0)


def test_an_asset_may_carry_a_source_and_no_frame_position() -> None:
    source_id: UUID = uuid4()

    assert _asset(source_id=source_id).source_id == source_id


def test_a_thumbnail_hash_is_held_to_the_same_rule_as_a_content_hash() -> None:
    """One validator covers both, because both name a blob."""
    with pytest.raises(ValidationError, match="thumbnail_hash must be 64"):
        _asset(thumbnail_hash="nope")


def test_an_asset_may_carry_no_thumbnail_hash_at_all() -> None:
    """NULL is the ordinary state of a cache, not a violation to tolerate."""
    assert _asset().thumbnail_hash is None


# --- reading one asset, and reaching its bytes ----------------------------


def test_an_asset_is_read_back_by_id_within_its_project(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)
    stored = fixture.assets()[0]

    assert fixture.ingest.asset(fixture.project.id, stored.id) == stored
    fixture.close()


def test_an_asset_of_another_project_reads_as_missing_rather_than_forbidden(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)
    stored = fixture.assets()[0]
    elsewhere = fixture.projects.create("elsewhere")

    with pytest.raises(AssetNotFound):
        fixture.ingest.asset(elsewhere.id, stored.id)
    fixture.close()


def test_an_assets_content_is_the_bytes_that_were_ingested(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    written = write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)
    stored = fixture.assets()[0]

    with fixture.ingest.open_content(stored) as stream:
        served = stream.read()

    assert served == written[0].read_bytes()
    fixture.close()


def test_a_missing_content_blob_is_damage_rather_than_a_missing_entity(tmp_path: Path) -> None:
    """A hash on a row with no blob behind it is a guarantee failing, not a 404."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)
    stored = fixture.assets()[0]
    digest = stored.content_hash
    (fixture.root / "blobs" / digest[:2] / digest[2:4] / digest).unlink()

    with pytest.raises(WorkspaceCorrupt):
        fixture.ingest.open_content(stored)
    fixture.close()


def test_an_assets_thumbnail_is_the_cached_preview(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)
    stored = fixture.assets()[0]

    assert stored.thumbnail_hash is not None
    with fixture.ingest.open_thumbnail(stored) as stream:
        preview = stream.read()

    assert PillowImageProcessor().probe(BytesIO(preview)).format is THUMBNAIL_FORMAT
    fixture.close()


def test_an_asset_with_no_cached_preview_is_refused_by_name(tmp_path: Path) -> None:
    """NULL is an ordinary state with a real remedy, so it is its own refusal."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)
    stored = fixture.assets()[0]

    with pytest.raises(ThumbnailNotCached, match="backfill"):
        fixture.ingest.open_thumbnail(stored.model_copy(update={"thumbnail_hash": None}))
    fixture.close()


def test_reading_a_preview_never_renders_one(tmp_path: Path) -> None:
    """A read must not put an encode on whichever path happens to ask first."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)
    stored = fixture.assets()[0]
    before = fixture.blob_count()

    with fixture.ingest.open_thumbnail(stored) as stream:
        stream.read()

    assert fixture.blob_count() == before
    fixture.close()


# --- listing a project's assets -----------------------------------------------


def test_a_project_with_no_assets_lists_nothing_rather_than_refusing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    assert fixture.ingest.assets(fixture.project.id) == []
    fixture.close()


def test_stills_come_back_in_filename_order(tmp_path: Path) -> None:
    """A directory is walked sorted, so this is the order somebody's own file
    browser shows — the closest thing to "in order" the stored columns support."""
    fixture = Fixture(tmp_path)
    paths = write_images(fixture.stills, count=5)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)

    listed = fixture.ingest.assets(fixture.project.id)

    assert [asset.uri for asset in listed] == [str(path) for path in sorted(paths)]
    fixture.close()


def test_a_clips_frames_come_back_in_frame_order_not_lexicographic_uri_order(
    tmp_path: Path,
) -> None:
    """The reason the sort key is not simply the uri.

    A frame's uri is `{path}#frame={n}`, so sorting those as strings puts
    `#frame=10` between `#frame=1` and `#frame=2`. With ten or more frames that
    is visible; with nine it is not, which is why the clip below is long enough
    to have a two-digit index.
    """
    fixture = Fixture(tmp_path)
    clip = fixture.clip()
    source = fixture.sources.register_video(fixture.project.id, clip.path, extraction_fps=10.0)
    fixture.ingest.ingest(source.id)

    listed = fixture.ingest.assets(fixture.project.id)
    indexes = [asset.frame_index for asset in listed]

    assert len(indexes) > 10, "the clip must be long enough to reach a two-digit index"
    assert indexes == sorted(index for index in indexes if index is not None)
    fixture.close()


def test_two_sources_do_not_interleave(tmp_path: Path) -> None:
    """Grouped by source, so a clip's frames stay together rather than being
    shuffled through a directory's stills."""
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=3)
    stills = fixture.sources.register_images(fixture.project.id, fixture.stills)
    other = fixture.tmp_path / "more-stills"
    other.mkdir()
    write_images(other, count=3, first_seed=100)
    second = fixture.sources.register_images(fixture.project.id, other)
    fixture.ingest.ingest(stills.id)
    fixture.ingest.ingest(second.id)

    listed = fixture.ingest.assets(fixture.project.id)
    sources = [asset.source_id for asset in listed]

    # Every asset of one source is contiguous: the list of sources, deduplicated
    # in order, has one entry per source rather than alternating.
    collapsed = [
        key for index, key in enumerate(sources) if index == 0 or sources[index - 1] != key
    ]
    assert len(collapsed) == len(set(sources)) == 2
    fixture.close()


def test_the_order_is_the_same_on_every_call(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=5)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)

    first = [asset.id for asset in fixture.ingest.assets(fixture.project.id)]
    again = [asset.id for asset in fixture.ingest.assets(fixture.project.id)]

    assert first == again
    fixture.close()


def test_listing_one_project_never_reaches_into_another(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=3)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)
    neighbour = fixture.projects.create("neighbour")

    assert len(fixture.ingest.assets(fixture.project.id)) == 3
    assert fixture.ingest.assets(neighbour.id) == []
    fixture.close()


def test_the_listing_sorts_rather_than_returning_the_store_s_own_order(tmp_path: Path) -> None:
    """Written straight through the unit of work, deliberately out of order.

    Every test above reaches this state through `ingest`, which inserts in the
    order it read — and SQLite hands rows back in insertion order, so those tests
    pass whether or not anything sorts. Mutation testing caught exactly that:
    deleting the `sorted(...)` left them all green. This one scrambles the
    insertion order so the sort is the only thing that could produce the answer.
    """
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    with fixture.workspace.unit_of_work() as uow:
        for index, name in enumerate(["c.png", "a.png", "b.png"]):
            uow.assets.add(
                Asset(
                    project_id=fixture.project.id,
                    content_hash=f"{index:064x}",
                    uri=f"/tmp/in/{name}",
                    source_id=source.id,
                )
            )

    listed = fixture.ingest.assets(fixture.project.id)

    assert [Path(asset.uri).name for asset in listed] == ["a.png", "b.png", "c.png"]
    fixture.close()


# --- when an asset arrived ----------------------------------------------------


def test_an_ingested_asset_records_when_it_arrived(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=2)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    before = datetime.now(UTC)

    result = fixture.ingest.ingest(source.id)

    after = datetime.now(UTC)
    for asset in result.assets:
        assert asset.ingested_at is not None
        assert before <= asset.ingested_at <= after
    fixture.close()


def test_the_arrival_survives_the_round_trip_through_the_store(tmp_path: Path) -> None:
    """The mapper hand-written for this column, exercised as a read rather than a write.

    `Asset` stopped being a flat mapping when it gained a timestamp: a `String`
    column has to be handed ISO text, and `_flat_mapping` would hand it a
    `datetime` through a deprecated sqlite3 adapter. Comparing the value that
    comes back out of a *fresh* read is what proves both directions agree.
    """
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=1)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    written = fixture.ingest.ingest(source.id).assets[0]
    read_back = fixture.ingest.asset(fixture.project.id, written.id)

    assert read_back.ingested_at == written.ingested_at
    assert read_back.ingested_at is not None
    assert read_back.ingested_at.tzinfo is not None
    fixture.close()


def test_one_run_stamps_every_asset_with_one_moment(tmp_path: Path) -> None:
    """A single ingest is a single arrival, so the run shares one timestamp.

    What it buys is the tiebreak: with one moment across the run, the order
    inside it falls through to `_in_stable_order`, which means something, rather
    than to whichever file the loop reached first.
    """
    fixture = Fixture(tmp_path)
    write_images(fixture.stills, count=5)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    assert len({asset.ingested_at for asset in result.assets}) == 1
    fixture.close()


def test_a_deduplicated_re_sighting_does_not_move_the_arrival(tmp_path: Path) -> None:
    """Identity is content, so the second sighting created nothing to date.

    The sibling of `test_the_first_origin_wins_when_the_same_bytes_arrive_again`:
    an arrival is provenance too, and "recent" therefore answers *new to this
    project* rather than *touched most recently*.
    """
    fixture = Fixture(tmp_path)
    other = tmp_path / "second"
    write_image(fixture.stills / "shared.png", seed=7)
    write_image(other / "shared.png", seed=7)
    first = fixture.sources.register_images(fixture.project.id, fixture.stills)
    second = fixture.sources.register_images(fixture.project.id, other)
    original = fixture.ingest.ingest(first.id).assets[0]

    again = fixture.ingest.ingest(second.id).assets[0]

    assert again.id == original.id
    assert again.ingested_at == original.ingested_at
    fixture.close()


def test_a_dedup_that_fills_a_missing_thumbnail_leaves_the_arrival_alone(
    tmp_path: Path,
) -> None:
    """`_store`'s one branch that *writes* to a deduplicated asset.

    `Repository.update` is a whole-row replace, so this is the single place a
    second sighting can put its own date on a row it did not create. Reaching it
    needs all three conditions at once — the content is already stored, its
    preview is missing, and the arriving candidate has one — which is why the
    two dedup tests above do not: their stored asset already has a thumbnail, so
    the branch is never entered.

    Mutation-tested: stamping `ingested_at` in that `model_copy` leaves every
    other test in this file green and turns this one red.
    """
    fixture = Fixture(tmp_path)
    other = tmp_path / "second"
    write_image(fixture.stills / "shared.png", seed=11)
    write_image(other / "shared.png", seed=11)
    first = fixture.sources.register_images(fixture.project.id, fixture.stills)
    second = fixture.sources.register_images(fixture.project.id, other)
    original = fixture.ingest.ingest(first.id).assets[0]
    # Exactly the state an unbackfilled asset is in: content stored, no preview.
    with fixture.workspace.unit_of_work() as uow:
        uow.assets.update(original.model_copy(update={"thumbnail_hash": None}))

    again = fixture.ingest.ingest(second.id).assets[0]

    assert again.id == original.id
    assert again.thumbnail_hash is not None, "the fill branch was not reached"
    assert again.ingested_at == original.ingested_at
    fixture.close()


def test_backfilling_a_thumbnail_leaves_the_arrival_alone(tmp_path: Path) -> None:
    """The other writer of a stored asset, and the same rule applies to it."""
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "shared.png", seed=11)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    original = fixture.ingest.ingest(source.id).assets[0]
    with fixture.workspace.unit_of_work() as uow:
        uow.assets.update(original.model_copy(update={"thumbnail_hash": None}))

    refilled = fixture.ingest.backfill_thumbnails(fixture.project.id)
    asset = fixture.ingest.asset(fixture.project.id, original.id)

    assert refilled.filled == (original.id,)
    assert asset.thumbnail_hash is not None
    assert asset.ingested_at == original.ingested_at
    fixture.close()


# --- the listing is ordered by arrival ------------------------------------------


def test_the_newest_ingest_comes_first(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    older = tmp_path / "older"
    write_image(older / "old.png", seed=1)
    write_image(fixture.stills / "new.png", seed=2)
    first = fixture.sources.register_images(fixture.project.id, older)
    second = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(first.id)
    fixture.ingest.ingest(second.id)

    listed = fixture.ingest.assets(fixture.project.id)

    assert [Path(asset.uri).name for asset in listed] == ["new.png", "old.png"]
    fixture.close()


def test_assets_of_one_run_keep_the_stable_order_inside_it(tmp_path: Path) -> None:
    """Recency orders the runs; `_in_stable_order` orders what is inside one.

    The seeds are enumerated rather than derived from the name. ``hash()`` on a
    ``str`` is randomized per process, so ``hash(name) % 1000`` drew three seeds
    out of a thousand afresh on every run — and roughly three runs in a thousand
    drew the same one twice, at which point two files hold identical bytes,
    content addressing correctly collapses them into one asset, and this test
    fails for a reason that has nothing to do with ordering. Caught in the wild.
    """
    fixture = Fixture(tmp_path)
    for seed, name in enumerate(["c.png", "a.png", "b.png"], start=1):
        write_image(fixture.stills / name, seed=seed)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)

    listed = fixture.ingest.assets(fixture.project.id)

    assert [Path(asset.uri).name for asset in listed] == ["a.png", "b.png", "c.png"]
    fixture.close()


def test_an_asset_with_no_recorded_arrival_sorts_last(tmp_path: Path) -> None:
    """A pre-migration row degrades quietly: it goes to the back, never the front.

    Both other readings are wrong. Treating NULL as the epoch invents a date;
    treating it as *now* would pin the oldest rows in the product to the top of a
    "recent" list forever.
    """
    fixture = Fixture(tmp_path)
    write_image(fixture.stills / "ingested.png", seed=4)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    fixture.ingest.ingest(source.id)
    # Written straight through the unit of work: a row with no arrival is
    # exactly what migration 13 leaves behind and no operation can produce.
    with fixture.workspace.unit_of_work() as uow:
        uow.assets.add(
            Asset(
                project_id=fixture.project.id,
                content_hash=f"{99:064x}",
                uri="/tmp/in/aaa-sorts-first-by-name.png",
                source_id=source.id,
            )
        )

    listed = fixture.ingest.assets(fixture.project.id)

    assert [Path(asset.uri).name for asset in listed] == [
        "ingested.png",
        "aaa-sorts-first-by-name.png",
    ]
    fixture.close()


# --- the sort key itself -------------------------------------------------------
#
# Module level so it can be exercised against constructed assets, which is the
# only way to control the arrangement precisely enough to prove each term of the
# key is load-bearing. The service tests above go through a real ingest, and a
# real ingest cannot produce two sources whose assets interleave by path.


def _sortable(
    project_id: UUID, *, uri: str, source: UUID | None = None, frame: int | None = None
) -> Asset:
    """One asset built to be sorted. Not `_asset` above — that name is taken, and
    shadowing it silently broke six of its tests until pytest said so.

    `frame_timestamp` travels with `frame_index` because the domain refuses one
    without the other; the value is arbitrary and never read by the sort.
    """
    return Asset(
        project_id=project_id,
        content_hash=f"{abs(hash(uri)):064x}"[:64],
        uri=uri,
        source_id=source,
        frame_index=frame,
        frame_timestamp=None if frame is None else float(frame),
    )


def test_the_key_groups_by_source_even_when_the_paths_interleave() -> None:
    project = uuid4()
    first, second = sorted([uuid4(), uuid4()], key=str)
    scrambled = [
        _sortable(project, uri="a.png", source=first),
        _sortable(project, uri="b.png", source=second),
        _sortable(project, uri="c.png", source=first),
        _sortable(project, uri="d.png", source=second),
    ]

    ordered = sorted(scrambled, key=_in_stable_order)

    # Sorted by path alone this would be a, b, c, d — one asset from each source
    # in turn. Grouping is what the source term buys.
    assert [asset.source_id for asset in ordered] == [first, first, second, second]
    assert [asset.uri for asset in ordered] == ["a.png", "c.png", "b.png", "d.png"]


def test_the_key_orders_frames_numerically_not_as_text() -> None:
    project, source = uuid4(), uuid4()
    scrambled = [
        _sortable(project, uri="clip.mp4#frame=10", source=source, frame=10),
        _sortable(project, uri="clip.mp4#frame=2", source=source, frame=2),
        _sortable(project, uri="clip.mp4#frame=1", source=source, frame=1),
    ]

    ordered = sorted(scrambled, key=_in_stable_order)

    # By uri as text this is #frame=1, #frame=10, #frame=2.
    assert [asset.frame_index for asset in ordered] == [1, 2, 10]


def test_the_key_is_a_total_order_so_two_identical_rows_still_have_one() -> None:
    """The id term. Without it two assets alike in every other column would
    compare equal, and `sorted` would leave them in whatever order it found."""
    project, source = uuid4(), uuid4()
    twins = [_sortable(project, uri="same.png", source=source) for _ in range(2)]

    forward = sorted(twins, key=_in_stable_order)
    backward = sorted(list(reversed(twins)), key=_in_stable_order)

    assert [asset.id for asset in forward] == [asset.id for asset in backward]
