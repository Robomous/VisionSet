"""Browser-driven video import: the session, its refusals, and its one commit.

The test this module exists for is
`test_nothing_is_a_project_asset_before_the_commit`. Everything else protects
a piece of it: a session that cannot count its own frames, cannot tell a retry
from a conflict, or cannot be thrown away cleanly is a session that eventually
leaks half a clip into somebody's dataset.

**No decoder anywhere**, which is the point of the whole design: frames are PNG
bytes a client produced, so a test produces them with Pillow and the server does
exactly what it would do in production — decode them and refuse what does not
decode.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from PIL import Image

from visionset.kernel.domain import (
    SAMPLING_POLICY_VERSION,
    BatchState,
    GeometryType,
    ImageFormat,
    IncomingFrame,
    LabelClass,
    Project,
    SourceKind,
    TimeRange,
    VideoImportState,
    VideoMetadata,
)
from visionset.kernel.errors import (
    BatchNotEditable,
    BatchNotFound,
    CorruptMedia,
    FrameContentConflict,
    FrameOrdinalOutOfRange,
    InvalidName,
    ProjectNotFound,
    UnsupportedMedia,
    VideoImportIncomplete,
    VideoImportNotFound,
    VideoImportNotOpen,
)
from visionset.kernel.services import (
    BatchService,
    IngestService,
    ProjectService,
    SchemaService,
    VideoImportService,
    WorkspaceService,
)

FRAME_SIZE = (16, 12)


def _png(seed: int, size: tuple[int, int] = FRAME_SIZE) -> bytes:
    """A tiny PNG. Equal seeds give equal bytes, which is what makes dedup testable."""
    width, height = size
    pixels = bytes(
        channel
        for y in range(height)
        for x in range(width)
        for channel in ((x * 7 + seed * 13) % 256, (y * 5 + seed * 29) % 256, (seed * 47) % 256)
    )
    buffer = BytesIO()
    Image.frombytes("RGB", size, pixels).save(buffer, format="PNG")
    return buffer.getvalue()


def _jpeg(seed: int) -> bytes:
    buffer = BytesIO()
    width, height = FRAME_SIZE
    pixels = bytes(
        (x + y + seed) % 256 for y in range(height) for x in range(width) for _ in range(3)
    )
    Image.frombytes("RGB", FRAME_SIZE, pixels).save(buffer, format="JPEG")
    return buffer.getvalue()


def _frame(
    ordinal: int,
    *,
    seed: int | None = None,
    content: bytes | None = None,
    size: tuple[int, int] = FRAME_SIZE,
    fps: float = 1.0,
    source_timestamp: float | None = None,
) -> IncomingFrame:
    return IncomingFrame(
        ordinal=ordinal,
        requested_timestamp=ordinal / fps,
        source_timestamp=source_timestamp,
        width=size[0],
        height=size[1],
        content=_png(ordinal if seed is None else seed, size) if content is None else content,
    )


def _metadata(duration_seconds: float = 3.0) -> VideoMetadata:
    return VideoMetadata(
        width=FRAME_SIZE[0],
        height=FRAME_SIZE[1],
        fps=30.0,
        duration_seconds=duration_seconds,
        codec="vp9",
    )


class Fixture:
    """A workspace with one project and the services this module drives."""

    def __init__(self, tmp_path: Path, name: str = "ws") -> None:
        self.root = tmp_path / name
        self.workspace = WorkspaceService.init(self.root)
        self.projects = ProjectService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.ingest = IngestService(self.workspace)
        self.imports = VideoImportService(self.workspace)
        self.project = self.projects.create(f"{name}-project")

    def start(self, project: Project | None = None, **overrides: object) -> UUID:
        arguments: dict[str, object] = {
            "display_name": "clip.webm",
            "metadata": _metadata(),
            "extraction_fps": 1.0,
            "materializer": "mediabunny/1.56.1",
        }
        arguments.update(overrides)
        session = self.imports.start(
            (project or self.project).id,
            **arguments,  # type: ignore[arg-type]
        )
        return session.id

    def filled_batch(self, name: str = "Night drive") -> UUID:
        """A draft batch with three frames already in it, made the ordinary way."""
        import_id = self.start(batch_name=name)
        self.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
        return self.imports.commit(import_id).id

    def freeze(self, batch_id: UUID) -> None:
        """Approve the batch, creating the schema version approval has to pin."""
        SchemaService(self.workspace).create_version(
            self.project.id, [LabelClass(name="thing", geometries=(GeometryType.BBOX,))]
        )
        self.batches.approve(batch_id)

    def close(self) -> None:
        self.workspace.close()


@pytest.fixture
def fixture(tmp_path: Path) -> Fixture:
    made = Fixture(tmp_path)
    yield made
    made.close()


# --- starting a session -----------------------------------------------------


def test_start_counts_the_grid_itself_and_opens_the_session(fixture: Fixture) -> None:
    """Three seconds at 1 fps is three grid points, and the server does that sum."""
    session = fixture.imports.start(
        fixture.project.id,
        display_name="clip.webm",
        metadata=_metadata(3.0),
        extraction_fps=1.0,
    )
    assert session.state is VideoImportState.OPEN
    assert session.expected_frame_count == 3
    assert session.received_frame_count == 0
    assert session.batch_id is None


def test_the_source_locator_is_opaque_and_never_a_path(fixture: Fixture) -> None:
    """`Source.locator` promises openability for image directories only."""
    import_id = fixture.start()
    with fixture.workspace.unit_of_work() as uow:
        session = uow.video_imports.get(import_id)
        assert session is not None
        source = uow.sources.get(session.source_id)
    assert source is not None
    assert source.kind is SourceKind.VIDEO
    assert source.locator.startswith("video-import:")
    assert not Path(source.locator).is_absolute()


def test_two_sessions_over_one_clip_are_two_sources(fixture: Fixture) -> None:
    """The origin index can never collide on a video, because the locator is unique."""
    first = fixture.imports.start(
        fixture.project.id, display_name="clip.webm", metadata=_metadata(), extraction_fps=1.0
    )
    second = fixture.imports.start(
        fixture.project.id, display_name="clip.webm", metadata=_metadata(), extraction_fps=1.0
    )
    assert first.source_id != second.source_id


def test_ranges_are_canonicalized_and_counted_on_the_grid(fixture: Fixture) -> None:
    session = fixture.imports.start(
        fixture.project.id,
        display_name="clip.webm",
        metadata=_metadata(10.0),
        extraction_fps=1.0,
        ranges=(
            TimeRange(start_seconds=0.0, end_seconds=3.0),
            TimeRange(start_seconds=2.0, end_seconds=5.0),
        ),
    )
    with fixture.workspace.unit_of_work() as uow:
        source = uow.sources.get(session.source_id)
    assert source is not None
    assert source.require_video().ranges == (TimeRange(start_seconds=0.0, end_seconds=5.0),)
    assert session.expected_frame_count == 5


def test_a_selection_holding_no_grid_point_is_refused(fixture: Fixture) -> None:
    """An empty batch and a mistaken selection are indistinguishable afterwards."""
    with pytest.raises(ValueError, match="hold no frame"):
        fixture.imports.start(
            fixture.project.id,
            display_name="clip.webm",
            metadata=_metadata(10.0),
            extraction_fps=1.0,
            ranges=(TimeRange(start_seconds=0.1, end_seconds=0.2),),
        )


def test_a_blank_batch_name_is_refused_before_any_frame_is_decoded(fixture: Fixture) -> None:
    with pytest.raises(InvalidName):
        fixture.imports.start(
            fixture.project.id,
            display_name="clip.webm",
            metadata=_metadata(),
            extraction_fps=1.0,
            batch_name="   ",
        )


def test_an_unknown_target_batch_is_refused_before_any_frame_is_decoded(
    fixture: Fixture,
) -> None:
    with pytest.raises(BatchNotFound):
        fixture.start(batch_id=uuid4())


def test_an_approved_target_batch_is_refused_before_any_frame_is_decoded(
    fixture: Fixture,
) -> None:
    """The whole reason the target is checked at start: an approved batch is cut already."""
    batch_id = fixture.filled_batch()
    fixture.freeze(batch_id)
    with pytest.raises(BatchNotEditable):
        fixture.start(batch_id=batch_id)


def test_a_batch_in_another_project_is_not_a_target(fixture: Fixture) -> None:
    """Otherwise one project's frames would land in another project's batch."""
    other = fixture.projects.create("other-project")
    batch = fixture.batches.create(other.id, "theirs")
    with pytest.raises(BatchNotFound):
        fixture.start(batch_id=batch.id)


def test_a_project_in_another_workspace_is_not_found(tmp_path: Path) -> None:
    here = Fixture(tmp_path, "here")
    elsewhere = Fixture(tmp_path, "elsewhere")
    try:
        with pytest.raises(ProjectNotFound):
            here.imports.start(
                elsewhere.project.id,
                display_name="clip.webm",
                metadata=_metadata(),
                extraction_fps=1.0,
            )
    finally:
        here.close()
        elsewhere.close()


def test_an_unusable_declaration_is_refused_by_the_domain(fixture: Fixture) -> None:
    with pytest.raises(ValueError):
        fixture.imports.start(
            fixture.project.id,
            display_name="clip.webm",
            metadata=_metadata(),
            extraction_fps=0.0,
        )
    with pytest.raises(ValueError):
        fixture.imports.start(
            fixture.project.id,
            display_name="clip.webm",
            metadata=_metadata(),
            extraction_fps=1.0,
            scale_percent=0,
        )


# --- appending frames -------------------------------------------------------


def test_appending_frames_advances_the_session(fixture: Fixture) -> None:
    import_id = fixture.start()
    session = fixture.imports.append_frames(import_id, [_frame(0), _frame(1)])
    assert session.received_frame_count == 2
    assert fixture.imports.get(import_id).received_frame_count == 2


def test_the_same_ordinal_with_the_same_bytes_is_a_retry(fixture: Fixture) -> None:
    """A chunked upload that lost its connection is the ordinary case."""
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0)])
    session = fixture.imports.append_frames(import_id, [_frame(0)])
    assert session.received_frame_count == 1
    with fixture.workspace.unit_of_work() as uow:
        assert len(uow.video_import_frames.list(import_id)) == 1


def test_the_same_ordinal_with_different_bytes_is_a_conflict(fixture: Fixture) -> None:
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0, seed=1)])
    with pytest.raises(FrameContentConflict):
        fixture.imports.append_frames(import_id, [_frame(0, seed=2)])
    assert fixture.imports.get(import_id).received_frame_count == 1


def test_the_conflict_is_adjudicated_on_the_hash_the_server_computed(fixture: Fixture) -> None:
    """The descriptor carries no hash, so a client cannot claim two frames are one."""
    assert "content_hash" not in IncomingFrame.model_fields


def test_an_ordinal_outside_the_grid_is_refused(fixture: Fixture) -> None:
    import_id = fixture.start()
    with pytest.raises(FrameOrdinalOutOfRange):
        fixture.imports.append_frames(import_id, [_frame(3)])
    with pytest.raises(ValueError):
        _frame(-1)
    assert fixture.imports.get(import_id).received_frame_count == 0


def test_a_selection_that_does_not_start_at_zero_stages_its_own_grid_indices(
    fixture: Fixture,
) -> None:
    """The crossing test the two halves never had.

    An ordinal is an **extraction-grid index** — what the client sends, and what
    `ordinal / extraction_fps` locates in the clip — so a cut from 5 s at 1 fps
    holds 5, 6 and 7. Bounding it by `expected_frame_count`, which is the count
    three, refused every one of them.
    """
    import_id = fixture.start(
        metadata=_metadata(10.0), ranges=(TimeRange(start_seconds=5.0, end_seconds=8.0),)
    )
    assert fixture.imports.get(import_id).expected_frame_count == 3

    fixture.imports.append_frames(import_id, [_frame(5), _frame(6), _frame(7)])
    assert fixture.imports.get(import_id).received_frame_count == 3

    batch = fixture.imports.commit(import_id)
    assert len(batch.asset_ids) == 3
    assert [a.frame_index for a in fixture.ingest.assets(fixture.project.id)] == [5, 6, 7]


def test_an_index_inside_the_count_but_outside_the_selection_is_refused(
    fixture: Fixture,
) -> None:
    """`0` is a perfectly good index and is not in a selection that starts at 5 s."""
    import_id = fixture.start(
        metadata=_metadata(10.0), ranges=(TimeRange(start_seconds=5.0, end_seconds=8.0),)
    )
    with pytest.raises(FrameOrdinalOutOfRange):
        fixture.imports.append_frames(import_id, [_frame(0)])


def test_a_multi_range_selection_stages_the_indices_of_every_range(fixture: Fixture) -> None:
    """Two ranges, one grid: the gap between them holds no index the session accepts."""
    import_id = fixture.start(
        metadata=_metadata(10.0),
        ranges=(
            TimeRange(start_seconds=0.0, end_seconds=2.0),
            TimeRange(start_seconds=5.0, end_seconds=7.0),
        ),
    )
    assert fixture.imports.get(import_id).expected_frame_count == 4

    with pytest.raises(FrameOrdinalOutOfRange):
        fixture.imports.append_frames(import_id, [_frame(3)])

    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(5), _frame(6)])
    batch = fixture.imports.commit(import_id)
    assert len(batch.asset_ids) == 4
    assert [a.frame_index for a in fixture.ingest.assets(fixture.project.id)] == [0, 1, 5, 6]


def test_a_frame_that_is_not_png_is_refused(fixture: Fixture) -> None:
    import_id = fixture.start()
    with pytest.raises(UnsupportedMedia, match="png"):
        fixture.imports.append_frames(import_id, [_frame(0, content=_jpeg(3))])
    assert fixture.imports.get(import_id).received_frame_count == 0


def test_a_corrupt_frame_is_refused(fixture: Fixture) -> None:
    truncated = _png(0)[:40]
    import_id = fixture.start()
    with pytest.raises((CorruptMedia, UnsupportedMedia)):
        fixture.imports.append_frames(import_id, [_frame(0, content=truncated)])
    assert fixture.imports.get(import_id).received_frame_count == 0


def test_a_descriptor_that_lies_about_its_size_is_refused(fixture: Fixture) -> None:
    """A descriptor and its bytes disagreeing means the two grids have drifted."""
    import_id = fixture.start()
    lying = IncomingFrame(
        ordinal=0, requested_timestamp=0.0, width=999, height=999, content=_png(0)
    )
    with pytest.raises(UnsupportedMedia, match="declares"):
        fixture.imports.append_frames(import_id, [lying])
    assert fixture.imports.get(import_id).received_frame_count == 0


def test_the_requested_and_source_timestamps_are_kept_apart(fixture: Fixture) -> None:
    """They are equal only by coincidence, and nothing here infers one from the other."""
    import_id = fixture.start()
    fixture.imports.append_frames(
        import_id, [_frame(1, source_timestamp=0.9667), _frame(2, source_timestamp=None)]
    )
    with fixture.workspace.unit_of_work() as uow:
        staged = {row.ordinal: row for row in uow.video_import_frames.list(import_id)}
    assert staged[1].requested_timestamp == 1.0
    assert staged[1].source_timestamp == pytest.approx(0.9667)
    assert staged[1].timestamp == pytest.approx(0.9667)
    assert staged[2].source_timestamp is None
    assert staged[2].timestamp == 2.0


def test_one_session_cannot_be_filled_through_another(tmp_path: Path) -> None:
    """Cross-session isolation: the frames of two open sessions never mingle."""
    fixture = Fixture(tmp_path)
    try:
        first = fixture.start()
        second = fixture.start()
        fixture.imports.append_frames(first, [_frame(0), _frame(1)])
        assert fixture.imports.get(second).received_frame_count == 0
        with fixture.workspace.unit_of_work() as uow:
            assert uow.video_import_frames.list(second) == []
    finally:
        fixture.close()


def test_a_session_in_another_workspace_is_not_found(tmp_path: Path) -> None:
    here = Fixture(tmp_path, "here")
    elsewhere = Fixture(tmp_path, "elsewhere")
    try:
        theirs = elsewhere.start()
        with pytest.raises(VideoImportNotFound):
            here.imports.get(theirs)
        with pytest.raises(VideoImportNotFound):
            here.imports.append_frames(theirs, [_frame(0)])
        with pytest.raises(VideoImportNotFound):
            here.imports.commit(theirs)
    finally:
        here.close()
        elsewhere.close()


def test_an_unknown_session_is_not_found(fixture: Fixture) -> None:
    with pytest.raises(VideoImportNotFound):
        fixture.imports.get(uuid4())


# --- the invariant ----------------------------------------------------------


def test_nothing_is_a_project_asset_before_the_commit(fixture: Fixture) -> None:
    """The whole point of a staging session, asserted from the outside.

    Read through `IngestService.assets` and `BatchService.list` — the reads that
    answer "what is in this project" — rather than through the repositories, so
    the claim is about what any caller can see.
    """
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
    assert fixture.ingest.assets(fixture.project.id) == []
    assert fixture.batches.list(fixture.project.id) == []


def test_an_aborted_import_leaves_the_project_exactly_as_it_was(fixture: Fixture) -> None:
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1)])
    session = fixture.imports.abort(import_id)
    assert session.state is VideoImportState.ABORTED
    assert fixture.ingest.assets(fixture.project.id) == []
    assert fixture.batches.list(fixture.project.id) == []
    with fixture.workspace.unit_of_work() as uow:
        assert uow.video_import_frames.list(import_id) == []


def test_an_aborted_session_is_no_longer_committable(fixture: Fixture) -> None:
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
    fixture.imports.abort(import_id)
    with pytest.raises(VideoImportNotOpen):
        fixture.imports.commit(import_id)
    with pytest.raises(VideoImportNotOpen):
        fixture.imports.append_frames(import_id, [_frame(0)])


def test_aborting_twice_is_a_no_op(fixture: Fixture) -> None:
    import_id = fixture.start()
    fixture.imports.abort(import_id)
    assert fixture.imports.abort(import_id).state is VideoImportState.ABORTED


# --- committing -------------------------------------------------------------


def test_an_incomplete_session_refuses_to_commit(fixture: Fixture) -> None:
    """A batch silently missing a stretch of its clip is undetectable afterwards."""
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1)])
    with pytest.raises(VideoImportIncomplete, match="2 of 3"):
        fixture.imports.commit(import_id)
    assert fixture.ingest.assets(fixture.project.id) == []


def test_a_complete_session_commits_to_a_draft_batch(fixture: Fixture) -> None:
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
    batch = fixture.imports.commit(import_id)

    assert batch.state is BatchState.DRAFT
    assert len(batch.asset_ids) == 3
    assert [b.id for b in fixture.batches.list(fixture.project.id)] == [batch.id]

    session = fixture.imports.get(import_id)
    assert session.state is VideoImportState.COMMITTED
    assert session.batch_id == batch.id

    assets = fixture.ingest.assets(fixture.project.id)
    assert [asset.frame_index for asset in assets] == [0, 1, 2]
    assert {asset.format for asset in assets} == {ImageFormat.PNG}
    assert all(asset.uri.startswith("video-import:") for asset in assets)
    assert all(asset.ingested_at is not None for asset in assets)
    assert all(asset.source_id == session.source_id for asset in assets)


def test_the_committed_batch_takes_the_requested_name(fixture: Fixture) -> None:
    import_id = fixture.start(batch_name="  Night drive  ")
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
    assert fixture.imports.commit(import_id).name == "Night drive"


def test_an_unnamed_session_falls_back_to_the_source_name(fixture: Fixture) -> None:
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
    assert fixture.imports.commit(import_id).name == "clip.webm"


def test_a_session_aimed_at_a_draft_commits_into_it_rather_than_making_one(
    fixture: Fixture,
) -> None:
    """The capability the old server-side path had: a second clip joins the first's batch."""
    existing = fixture.filled_batch()
    import_id = fixture.start(batch_id=existing, display_name="other.webm")
    fixture.imports.append_frames(
        import_id, [_frame(0, seed=60), _frame(1, seed=61), _frame(2, seed=62)]
    )
    batch = fixture.imports.commit(import_id)

    assert batch.id == existing
    assert batch.name == "Night drive"
    assert len(batch.asset_ids) == 6
    assert [b.id for b in fixture.batches.list(fixture.project.id)] == [existing]
    assert fixture.imports.get(import_id).batch_id == existing


def test_a_target_batch_approved_while_the_clip_decoded_is_refused_at_commit(
    fixture: Fixture,
) -> None:
    """No fallback to a batch of its own: that would put the frames somewhere nobody chose."""
    existing = fixture.filled_batch()
    import_id = fixture.start(batch_id=existing, display_name="other.webm")
    fixture.imports.append_frames(
        import_id, [_frame(0, seed=50), _frame(1, seed=51), _frame(2, seed=52)]
    )
    fixture.freeze(existing)

    with pytest.raises(BatchNotEditable):
        fixture.imports.commit(import_id)
    assert fixture.imports.get(import_id).state is VideoImportState.OPEN


def test_a_target_batch_deleted_while_the_clip_decoded_is_refused_at_commit(
    fixture: Fixture,
) -> None:
    """The documented contract, and the one outcome nobody asked for if it is not kept.

    A session that recorded a target must never fall back to inventing a batch:
    "nobody named a target" and "the target is gone" are different facts, and the
    row has to keep them apart for `commit` to answer the second one.
    """
    existing = fixture.filled_batch()
    import_id = fixture.start(batch_id=existing, display_name="other.webm")
    fixture.imports.append_frames(
        import_id, [_frame(0, seed=70), _frame(1, seed=71), _frame(2, seed=72)]
    )
    fixture.batches.delete(existing, confirm=True)

    with pytest.raises(BatchNotFound):
        fixture.imports.commit(import_id)

    assert fixture.imports.get(import_id).state is VideoImportState.OPEN
    assert fixture.batches.list(fixture.project.id) == []


def test_committing_twice_answers_the_same_batch_and_writes_nothing(fixture: Fixture) -> None:
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
    first = fixture.imports.commit(import_id)
    second = fixture.imports.commit(import_id)

    assert second.id == first.id
    assert second.asset_ids == first.asset_ids
    assert len(fixture.batches.list(fixture.project.id)) == 1
    assert len(fixture.ingest.assets(fixture.project.id)) == 3


def test_identical_frames_at_two_ordinals_collapse_into_one_asset(fixture: Fixture) -> None:
    """A static shot genuinely yields the same image twice; content addressing says so."""
    import_id = fixture.start()
    fixture.imports.append_frames(
        import_id, [_frame(0, seed=9), _frame(1, seed=9), _frame(2, seed=4)]
    )
    batch = fixture.imports.commit(import_id)
    assert len(batch.asset_ids) == 2
    assert len(fixture.ingest.assets(fixture.project.id)) == 2


def test_a_thumbnail_is_cached_for_every_frame(fixture: Fixture) -> None:
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
    fixture.imports.commit(import_id)
    assets = fixture.ingest.assets(fixture.project.id)
    assert all(asset.thumbnail_hash is not None for asset in assets)


def test_a_committed_session_refuses_more_frames_and_refuses_to_abort(fixture: Fixture) -> None:
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
    fixture.imports.commit(import_id)
    with pytest.raises(VideoImportNotOpen):
        fixture.imports.append_frames(import_id, [_frame(0)])
    with pytest.raises(VideoImportNotOpen):
        fixture.imports.abort(import_id)


def test_two_projects_commit_into_their_own_batches(tmp_path: Path) -> None:
    """Cross-project isolation, including the dedup rule, which is per project."""
    fixture = Fixture(tmp_path)
    try:
        other = fixture.projects.create("other-project")
        mine = fixture.start()
        theirs = fixture.start(other)
        for import_id in (mine, theirs):
            fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
        first = fixture.imports.commit(mine)
        second = fixture.imports.commit(theirs)

        assert first.id != second.id
        assert set(first.asset_ids).isdisjoint(second.asset_ids)
        assert len(fixture.ingest.assets(fixture.project.id)) == 3
        assert len(fixture.ingest.assets(other.id)) == 3
    finally:
        fixture.close()


# --- provenance -------------------------------------------------------------


def test_the_declared_provenance_round_trips_through_the_store(fixture: Fixture) -> None:
    session = fixture.imports.start(
        fixture.project.id,
        display_name="clip.webm",
        metadata=_metadata(10.0),
        extraction_fps=2.0,
        ranges=(TimeRange(start_seconds=1.0, end_seconds=3.0),),
        scale_percent=50,
        materializer="mediabunny/1.56.1",
    )
    reopened = WorkspaceService.open(fixture.root)
    try:
        with reopened.unit_of_work() as uow:
            source = uow.sources.get(session.source_id)
        assert source is not None
        provenance = source.require_video()
        assert provenance.metadata == _metadata(10.0)
        assert provenance.extraction_fps == 2.0
        assert provenance.ranges == (TimeRange(start_seconds=1.0, end_seconds=3.0),)
        assert provenance.scale_percent == 50
        assert provenance.policy_version == SAMPLING_POLICY_VERSION
        assert provenance.materializer == "mediabunny/1.56.1"
    finally:
        reopened.close()


def test_a_variable_rate_clip_round_trips_with_no_source_rate_at_all(fixture: Fixture) -> None:
    """`None` is the honest answer, and the extraction rate must never stand in for it."""
    vfr = VideoMetadata(
        width=FRAME_SIZE[0],
        height=FRAME_SIZE[1],
        fps=None,
        duration_seconds=3.0,
        codec="vp9",
    )
    session = fixture.imports.start(
        fixture.project.id,
        display_name="screen-recording.webm",
        metadata=vfr,
        extraction_fps=2.0,
    )
    reopened = WorkspaceService.open(fixture.root)
    try:
        with reopened.unit_of_work() as uow:
            source = uow.sources.get(session.source_id)
        assert source is not None
        provenance = source.require_video()
        assert provenance.metadata == vfr
        assert provenance.metadata.fps is None
        assert provenance.extraction_fps == 2.0
    finally:
        reopened.close()


def test_a_session_with_no_materializer_stores_none_rather_than_a_guess(fixture: Fixture) -> None:
    session = fixture.imports.start(
        fixture.project.id,
        display_name="clip.webm",
        metadata=_metadata(),
        extraction_fps=1.0,
    )
    with fixture.workspace.unit_of_work() as uow:
        source = uow.sources.get(session.source_id)
    assert source is not None
    assert source.require_video().materializer is None


# --- the other ingestion path -----------------------------------------------


def test_a_video_source_cannot_be_run_as_an_ingest(fixture: Fixture) -> None:
    """No decoder here, and an opaque locator: a run over a clip could only crash.

    It used to be accepted — a `202` naming a batch after the locator, then a run
    that died on a bare `FileNotFoundError`, which is outside the `VisionSetError`
    tree and so a 500.
    """
    import_id = fixture.start()
    source_id = fixture.imports.get(import_id).source_id

    with pytest.raises(UnsupportedMedia, match="not read by this server"):
        fixture.ingest.enqueue(source_id)
    with pytest.raises(UnsupportedMedia):
        fixture.ingest.ingest(source_id)

    assert fixture.ingest.list(source_id) == []
    assert fixture.batches.list(fixture.project.id) == []


def test_a_refused_run_never_names_the_opaque_locator(fixture: Fixture) -> None:
    """`video-import:<uuid4>` is deliberately unpublished — see `visionset.wire`."""
    import_id = fixture.start()
    source_id = fixture.imports.get(import_id).source_id

    with pytest.raises(UnsupportedMedia) as refusal:
        fixture.ingest.enqueue(source_id)
    assert "video-import:" not in str(refusal.value)
    assert refusal.value.name == "clip.webm"
