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

from pathlib import Path
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
    BatchNotEditable,
    BatchNotFound,
    IngestJobNotFound,
    InvalidName,
    MediaToolUnavailable,
    SourceNotFound,
)
from visionset.kernel.domain import (
    Asset,
    BatchState,
    ImageFormat,
    IngestCompleted,
    IngestFailureKind,
    IngestState,
    VideoFrame,
    VideoMetadata,
)
from visionset.kernel.ports import FRAME_FORMAT
from visionset.kernel.services import (
    BatchService,
    IngestService,
    ProjectService,
    SourceService,
    WorkspaceService,
)


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

    def blob_count(self) -> int:
        """Blobs on disk. `put` is content-addressed, so this counts distinct bytes."""
        return len([path for path in (self.root / "blobs").rglob("*") if path.is_file()])

    def assets(self) -> list[Asset]:
        with self.workspace.unit_of_work() as uow:
            return uow.assets.list(self.project.id)

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
    """#16 applies orientation rather than reporting it; this is where it lands."""
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
    """#17 applies the display matrix; a 64x48 file held upright ingests as 48x64."""
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
    assert [failure.kind for failure in result.failures] == [IngestFailureKind.CORRUPT]
    assert result.failures[0].name == source.path
    assert fixture.ingest.get(result.job_id).state is IngestState.COMPLETED
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

    assert fixture.blob_count() == 1
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
    assert fixture.blob_count() == 1
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
    assert fixture.blob_count() == 3
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
    assert fixture.blob_count() == 1
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
    """The index #18 named as owed, now that `asset.source_id` has a target."""
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
    from visionset.kernel.domain import GeometryType, LabelClass
    from visionset.kernel.services import SchemaService

    SchemaService(fixture.workspace).create_version(
        fixture.project.id, [LabelClass(name="thing", geometry=GeometryType.BBOX)]
    )
    fixture.batches.approve(opened.batch_id)
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
    assert [failure.name for failure in result.failures] == [str(notes)]
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

    assert failure.name == str(notes)
    assert str(notes) not in failure.reason
    assert notes.name not in failure.reason
    fixture.close()


def test_the_report_separates_data_loss_from_operator_noise(tmp_path: Path) -> None:
    """Why `IngestFailureKind` exists: a reason sentence cannot be grouped on."""
    fixture = Fixture(tmp_path)
    write_unsupported_file(fixture.stills / "notes.txt")
    write_image_in_unsupported_format(fixture.stills / "old.bmp")
    write_corrupt_image(fixture.stills / "half.png")
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)

    result = fixture.ingest.ingest(source.id)

    by_name = {Path(failure.name).name: failure.kind for failure in result.failures}
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
    project = projects.create("p")
    # Registration probes too, so the source is planted by hand rather than
    # registered: the subject here is the extraction, not the registration.
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"not really a clip")
    from visionset.kernel.domain import Source, SourceKind, VideoProvenance

    with workspace.unit_of_work() as uow:
        source = uow.sources.add(
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
    """The shape #19 needs: a gate it can run in its own unit of work."""
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    result = fixture.ingest.ingest(source.id)

    with fixture.workspace.unit_of_work() as uow:
        assert fixture.ingest.require_job(uow, result.job_id).id == result.job_id
    fixture.close()


# --- scope ----------------------------------------------------------------


def test_ingesting_an_unknown_source_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)

    with pytest.raises(SourceNotFound):
        fixture.ingest.ingest(uuid4())
    fixture.close()


def test_getting_an_unknown_ingest_job_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)

    with pytest.raises(IngestJobNotFound):
        fixture.ingest.get(uuid4())
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
