"""`SourceService`: registration, provenance, and the idempotency rule.

Two things shape this file.

The ffmpeg requirement arrives through `write_video`, which calls `require_ffmpeg`
itself — there is deliberately no module-level skip. The tests that need no clip
(directory registration, the not-found ladders, the domain invariant) have to run
on a machine without ffmpeg, and a module-level skip would take them with it.

The idempotency assertions compare `id`s rather than counting rows wherever they
can, because "returns the same source" is the contract; "wrote one row" is how it
happens to be implemented.
"""

from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError
from tests.fixtures.media import (
    GeneratedVideo,
    write_corrupt_video,
    write_unsupported_file,
    write_video,
)

from visionset.kernel import (
    InvalidName,
    ProjectNotFound,
    SourceNotFound,
    UnsupportedMedia,
    WorkspaceCorrupt,
)
from visionset.kernel.domain import Source, SourceKind, TimeRange, VideoMetadata, VideoProvenance
from visionset.kernel.ports import DEFAULT_EXTRACTION_FPS
from visionset.kernel.services import ProjectService, SourceService, WorkspaceService


class Fixture:
    """A workspace with one project and a directory of stills to point at."""

    def __init__(self, tmp_path: Path, name: str = "ws") -> None:
        self.tmp_path = tmp_path
        self.workspace = WorkspaceService.init(tmp_path / name)
        self.projects = ProjectService(self.workspace)
        self.sources = SourceService(self.workspace)
        self.project = self.projects.create(f"{name}-project")
        self.stills = tmp_path / f"{name}-stills"
        self.stills.mkdir()

    def clip(self, name: str = "clip.mp4", **kwargs: object) -> GeneratedVideo:
        return write_video(self.tmp_path / name, **kwargs)  # type: ignore[arg-type]

    def close(self) -> None:
        self.workspace.close()


# --- registering a directory of stills --------------------------------------


def test_an_image_directory_source_persists_and_rehydrates_completely(tmp_path: Path) -> None:
    fx = Fixture(tmp_path)
    registered = fx.sources.register_images(
        fx.project.id, fx.stills, capture_params={"site": "yard-3"}
    )
    fx.close()

    reopened = WorkspaceService.open(tmp_path / "ws")
    read_back = SourceService(reopened).get(registered.id)
    assert read_back.kind is SourceKind.IMAGE_DIRECTORY
    assert read_back.path == str(fx.stills.resolve())
    assert read_back.capture_params == {"site": "yard-3"}
    assert read_back.video is None
    assert read_back.registered_at == registered.registered_at
    assert read_back.registered_at.tzinfo is not None
    reopened.close()


def test_registering_a_directory_that_is_not_there_is_a_file_not_found_error(
    tmp_path: Path,
) -> None:
    fx = Fixture(tmp_path)
    with pytest.raises(FileNotFoundError):
        fx.sources.register_images(fx.project.id, tmp_path / "absent")
    fx.close()


def test_registering_a_file_as_an_image_directory_is_a_not_a_directory_error(
    tmp_path: Path,
) -> None:
    fx = Fixture(tmp_path)
    plain = tmp_path / "notes.txt"
    plain.write_text("hello")
    with pytest.raises(NotADirectoryError):
        fx.sources.register_images(fx.project.id, plain)
    fx.close()


def test_a_relative_path_and_its_absolute_form_are_one_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Canonicalization is the whole reason `path` is not stored as given."""
    fx = Fixture(tmp_path)
    absolute = fx.sources.register_images(fx.project.id, fx.stills)
    monkeypatch.chdir(tmp_path)
    relative = fx.sources.register_images(fx.project.id, Path(f"./{fx.stills.name}"))
    assert relative.id == absolute.id
    assert fx.sources.list(fx.project.id) == [absolute]
    fx.close()


# --- registering a clip ------------------------------------------------------


def test_a_video_source_stores_the_original_fps_from_the_probe(tmp_path: Path) -> None:
    """Registration's probe, asserted against the generator."""
    fx = Fixture(tmp_path)
    clip = fx.clip(fps=10, duration_seconds=2.0)
    registered = fx.sources.register_video(fx.project.id, clip.path, extraction_fps=5.0)

    provenance = registered.require_video()
    assert provenance.metadata.fps == pytest.approx(clip.fps)
    assert provenance.metadata.width == clip.width
    assert provenance.metadata.height == clip.height
    assert provenance.metadata.duration_seconds == pytest.approx(clip.duration_seconds, abs=0.2)
    assert provenance.metadata.codec
    assert provenance.extraction_fps == 5.0
    fx.close()


def test_a_video_source_rehydrates_its_whole_provenance(tmp_path: Path) -> None:
    fx = Fixture(tmp_path)
    clip = fx.clip()
    registered = fx.sources.register_video(fx.project.id, clip.path, extraction_fps=2.5)
    fx.close()

    reopened = WorkspaceService.open(tmp_path / "ws")
    read_back = SourceService(reopened).get(registered.id)
    assert read_back == registered
    assert read_back.require_video() == registered.require_video()
    reopened.close()


def test_registering_a_video_defaults_to_the_port_extraction_rate(tmp_path: Path) -> None:
    fx = Fixture(tmp_path)
    registered = fx.sources.register_video(fx.project.id, fx.clip().path)
    assert registered.require_video().extraction_fps == DEFAULT_EXTRACTION_FPS
    fx.close()


def test_a_non_positive_extraction_rate_is_refused_before_anything_is_probed(
    tmp_path: Path,
) -> None:
    fx = Fixture(tmp_path)
    with pytest.raises(ValueError, match="extraction_fps must be positive"):
        fx.sources.register_video(fx.project.id, tmp_path / "never-read.mp4", extraction_fps=0)
    fx.close()


def test_registering_something_that_is_not_a_video_stores_nothing(tmp_path: Path) -> None:
    fx = Fixture(tmp_path)
    not_a_clip = write_unsupported_file(tmp_path / "notes.mp4")
    with pytest.raises(UnsupportedMedia):
        fx.sources.register_video(fx.project.id, not_a_clip)
    assert fx.sources.list(fx.project.id) == []
    fx.close()


def test_a_truncated_clip_registers_because_a_probe_only_reads_the_header(
    tmp_path: Path,
) -> None:
    """Registration is not a validation pass, and ingest must not assume it is.

    `write_corrupt_video` truncates a faststart clip, so the index at the front
    still describes the whole thing and ffprobe answers happily; ffmpeg only
    fails once a decode runs off the end of the bytes. So damage surfaces at
    extraction, not here — and the duration this source records is the one the
    intact file would have had.
    """
    fx = Fixture(tmp_path)
    broken = write_corrupt_video(tmp_path / "broken.mp4")
    registered = fx.sources.register_video(fx.project.id, broken.path)
    assert registered.require_video().metadata.duration_seconds == pytest.approx(
        broken.duration_seconds, abs=0.2
    )
    fx.close()


# --- idempotency -------------------------------------------------------------


def test_registering_the_same_directory_twice_returns_the_same_source(tmp_path: Path) -> None:
    fx = Fixture(tmp_path)
    first = fx.sources.register_images(fx.project.id, fx.stills)
    second = fx.sources.register_images(fx.project.id, fx.stills)
    assert second == first
    assert fx.sources.list(fx.project.id) == [first]
    fx.close()


def test_registering_the_same_clip_at_the_same_rate_returns_the_same_source(
    tmp_path: Path,
) -> None:
    fx = Fixture(tmp_path)
    clip = fx.clip()
    first = fx.sources.register_video(fx.project.id, clip.path, extraction_fps=5.0)
    second = fx.sources.register_video(fx.project.id, clip.path, extraction_fps=5.0)
    assert second == first
    assert len(fx.sources.list(fx.project.id)) == 1
    fx.close()


def test_the_same_clip_at_a_different_rate_is_a_second_source(tmp_path: Path) -> None:
    """The decomposition rate is part of the source's identity, deliberately."""
    fx = Fixture(tmp_path)
    clip = fx.clip()
    slow = fx.sources.register_video(fx.project.id, clip.path, extraction_fps=1.0)
    fast = fx.sources.register_video(fx.project.id, clip.path, extraction_fps=5.0)
    assert fast.id != slow.id
    assert {s.id for s in fx.sources.list(fx.project.id)} == {slow.id, fast.id}
    fx.close()


def test_the_same_clip_with_the_same_ranges_is_one_source(tmp_path: Path) -> None:
    fx = Fixture(tmp_path)
    clip = fx.clip()
    selection = [TimeRange(start_seconds=0.5, end_seconds=1.5)]
    first = fx.sources.register_video(fx.project.id, clip.path, ranges=selection)
    second = fx.sources.register_video(fx.project.id, clip.path, ranges=selection)
    assert second == first
    assert len(fx.sources.list(fx.project.id)) == 1
    fx.close()


def test_the_same_clip_with_different_ranges_is_a_second_source(tmp_path: Path) -> None:
    """Ranges are the other half of the cut, so they fork identity as the rate does."""
    fx = Fixture(tmp_path)
    clip = fx.clip()
    head = fx.sources.register_video(
        fx.project.id, clip.path, ranges=[TimeRange(start_seconds=0, end_seconds=1)]
    )
    tail = fx.sources.register_video(
        fx.project.id, clip.path, ranges=[TimeRange(start_seconds=1, end_seconds=2)]
    )
    assert head.id != tail.id
    assert {s.id for s in fx.sources.list(fx.project.id)} == {head.id, tail.id}
    fx.close()


def test_range_spelling_variants_collapse_to_one_source(tmp_path: Path) -> None:
    """Identity compares the canonical form, never what a caller happened to type."""
    fx = Fixture(tmp_path)
    clip = fx.clip()
    messy = fx.sources.register_video(
        fx.project.id,
        clip.path,
        ranges=[
            TimeRange(start_seconds=1.2, end_seconds=1.8),
            TimeRange(start_seconds=0.2, end_seconds=1.5),
        ],
    )
    tidy = fx.sources.register_video(
        fx.project.id, clip.path, ranges=[TimeRange(start_seconds=0.2, end_seconds=1.8)]
    )
    assert tidy.id == messy.id
    assert messy.require_video().ranges == (TimeRange(start_seconds=0.2, end_seconds=1.8),)
    fx.close()


def test_a_selection_covering_the_whole_clip_is_the_plain_source(tmp_path: Path) -> None:
    """\"Whole clip\" has one identity spelling: the empty selection."""
    fx = Fixture(tmp_path)
    clip = fx.clip(duration_seconds=2.0)
    plain = fx.sources.register_video(fx.project.id, clip.path)
    covering = fx.sources.register_video(
        fx.project.id, clip.path, ranges=[TimeRange(start_seconds=0, end_seconds=5)]
    )
    assert covering.id == plain.id
    assert covering.require_video().ranges == ()
    fx.close()


def test_a_ranged_source_rehydrates_its_selection(tmp_path: Path) -> None:
    fx = Fixture(tmp_path)
    clip = fx.clip()
    registered = fx.sources.register_video(
        fx.project.id, clip.path, ranges=[TimeRange(start_seconds=0.5, end_seconds=1.5)]
    )
    fx.close()

    reopened = WorkspaceService.open(tmp_path / "ws")
    read_back = SourceService(reopened).get(registered.id)
    assert read_back.require_video().ranges == (TimeRange(start_seconds=0.5, end_seconds=1.5),)
    reopened.close()


def test_differing_capture_params_update_the_source_rather_than_forking_it(
    tmp_path: Path,
) -> None:
    """A typo in a lens note must not give one directory two origins."""
    fx = Fixture(tmp_path)
    first = fx.sources.register_images(fx.project.id, fx.stills, capture_params={"lens": "24mm"})
    second = fx.sources.register_images(fx.project.id, fx.stills, capture_params={"lens": "35mm"})
    assert second.id == first.id
    assert second.capture_params == {"lens": "35mm"}
    assert fx.sources.list(fx.project.id) == [second]
    fx.close()


def test_a_replaced_clip_refreshes_its_provenance_and_keeps_its_identity(tmp_path: Path) -> None:
    """The path is the source; the bytes behind it are what a re-probe is for."""
    fx = Fixture(tmp_path)
    clip = fx.clip(fps=10, duration_seconds=2.0)
    first = fx.sources.register_video(fx.project.id, clip.path, extraction_fps=1.0)

    write_video(clip.path, fps=25, duration_seconds=1.0)
    second = fx.sources.register_video(fx.project.id, clip.path, extraction_fps=1.0)

    assert second.id == first.id
    assert second.registered_at == first.registered_at
    assert second.require_video().metadata.fps == pytest.approx(25)
    assert second.require_video().metadata.fps != first.require_video().metadata.fps
    assert len(fx.sources.list(fx.project.id)) == 1
    fx.close()


# --- the display name ---------------------------------------------------------


def test_a_stated_display_name_becomes_the_source_name(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(
        fixture.project.id, fixture.stills, display_name="dashcam morning run"
    )
    assert source.display_name == "dashcam morning run"
    assert source.name == "dashcam morning run"
    fixture.close()


def test_an_unnamed_source_is_called_by_its_path_basename(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(fixture.project.id, fixture.stills)
    assert source.display_name is None
    # ``Fixture`` names the directory ``ws-stills`` — asserting via the fixture's
    # own path keeps this the derivation, not a copied string.
    assert source.name == fixture.stills.name
    fixture.close()


def test_a_display_name_is_not_part_of_the_identity_key(tmp_path: Path) -> None:
    """Renaming must not fork one origin into two.

    Same directory, different names: one source, wearing the latest name — the
    ``capture_params`` rule, for the same reason.
    """
    fixture = Fixture(tmp_path)
    first = fixture.sources.register_images(fixture.project.id, fixture.stills, display_name="one")
    second = fixture.sources.register_images(fixture.project.id, fixture.stills, display_name="two")
    assert second.id == first.id
    assert second.display_name == "two"
    fixture.close()


def test_a_nameless_reregistration_keeps_the_stated_name(tmp_path: Path) -> None:
    """``None`` means nobody said — not "erase what somebody did say".

    CLI and MCP registrations pass no name, so treating absence as a reset
    would un-name a source on the next ingest of the same directory.
    """
    fixture = Fixture(tmp_path)
    named = fixture.sources.register_images(fixture.project.id, fixture.stills, display_name="kept")
    again = fixture.sources.register_images(fixture.project.id, fixture.stills)
    assert again.id == named.id
    assert again.display_name == "kept"
    assert fixture.sources.get(named.id).display_name == "kept"
    fixture.close()


def test_a_blank_display_name_is_refused_as_an_invalid_name(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(InvalidName):
        fixture.sources.register_images(fixture.project.id, fixture.stills, display_name="   ")
    fixture.close()


def test_a_display_name_survives_the_round_trip(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    source = fixture.sources.register_images(
        fixture.project.id, fixture.stills, display_name="named"
    )
    assert fixture.sources.get(source.id).name == "named"
    fixture.close()


# --- scope and lookups -------------------------------------------------------


def test_registering_against_an_unknown_project_is_refused(tmp_path: Path) -> None:
    fx = Fixture(tmp_path)
    with pytest.raises(ProjectNotFound):
        fx.sources.register_images(uuid4(), fx.stills)
    fx.close()


@pytest.mark.parametrize(
    ("call", "expected"),
    [
        pytest.param(
            lambda fx: fx.sources.get(uuid4()), SourceNotFound, id="getting-an-unknown-source"
        ),
        pytest.param(
            lambda fx: fx.sources.list(uuid4()),
            ProjectNotFound,
            id="listing-an-unknown-projects-sources",
        ),
    ],
)
def test_naming_something_that_does_not_exist_is_refused(
    tmp_path: Path, call: Callable[[Fixture], object], expected: type[Exception]
) -> None:
    """The two refusals differ in subject: an unknown source is a missing source, and
    an unknown project is a missing project rather than a project holding no sources."""
    fx = Fixture(tmp_path)
    with pytest.raises(expected):
        call(fx)
    fx.close()


def test_sources_are_scoped_to_their_project(tmp_path: Path) -> None:
    fx = Fixture(tmp_path)
    other = fx.projects.create("other")
    mine = fx.sources.register_images(fx.project.id, fx.stills)
    assert fx.sources.list(other.id) == []
    assert fx.sources.list(fx.project.id) == [mine]
    fx.close()


def test_a_source_in_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    """Not as forbidden — this service speaks for one workspace."""
    theirs = Fixture(tmp_path, name="theirs")
    stranger = theirs.sources.register_images(theirs.project.id, theirs.stills)
    theirs.close()

    mine = Fixture(tmp_path, name="mine")
    with pytest.raises(SourceNotFound):
        mine.sources.get(stranger.id)
    mine.close()


def test_require_source_resolves_inside_a_callers_transaction(tmp_path: Path) -> None:
    """The shape ingest needs: one lookup, one transaction, no re-entry."""
    fx = Fixture(tmp_path)
    registered = fx.sources.register_images(fx.project.id, fx.stills)
    with fx.workspace.unit_of_work() as uow:
        assert fx.sources.require_source(uow, registered.id) == registered
        with pytest.raises(SourceNotFound):
            fx.sources.require_source(uow, uuid4())
    fx.close()


# --- the domain invariant ----------------------------------------------------


def _provenance() -> VideoProvenance:
    return VideoProvenance(
        metadata=VideoMetadata(width=4, height=4, fps=30.0, duration_seconds=1.0, codec="h264"),
        extraction_fps=1.0,
    )


def test_an_image_directory_source_may_not_carry_video_provenance() -> None:
    with pytest.raises(ValidationError, match="must not carry video provenance"):
        Source(
            project_id=uuid4(),
            kind=SourceKind.IMAGE_DIRECTORY,
            path="/data",
            video=_provenance(),
        )


def test_a_video_source_must_carry_video_provenance() -> None:
    with pytest.raises(ValidationError, match="must carry video provenance"):
        Source(project_id=uuid4(), kind=SourceKind.VIDEO, path="/data/clip.mp4")


def test_the_invariant_survives_assignment_not_only_construction() -> None:
    """`validate_assignment` is on for exactly this: a model validator does not
    re-run on attribute assignment, so without it the pair could drift apart
    after a valid construction."""
    source = Source(
        project_id=uuid4(),
        kind=SourceKind.VIDEO,
        path="/data/clip.mp4",
        video=_provenance(),
    )
    with pytest.raises(ValidationError, match="must not carry video provenance"):
        source.kind = SourceKind.IMAGE_DIRECTORY


def test_a_naive_registration_timestamp_is_refused() -> None:
    from datetime import datetime

    with pytest.raises(ValidationError, match="timezone-aware"):
        Source(
            project_id=uuid4(),
            kind=SourceKind.IMAGE_DIRECTORY,
            path="/data",
            registered_at=datetime(2026, 7, 27, 9, 0),
        )


def test_require_video_refuses_a_source_that_is_not_a_clip() -> None:
    source = Source(project_id=uuid4(), kind=SourceKind.IMAGE_DIRECTORY, path="/data")
    with pytest.raises(WorkspaceCorrupt, match="no video provenance"):
        source.require_video()
