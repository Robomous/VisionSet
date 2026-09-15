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

import math
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from PIL import Image
from pydantic import ValidationError

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
    VideoProvenance,
)
from visionset.kernel.errors import (
    BatchNotEditable,
    BatchNotFound,
    CorruptMedia,
    FrameContentConflict,
    FrameOrdinalOutOfRange,
    FrameTimestampOffGrid,
    InvalidName,
    ProjectNotFound,
    TooManyOpenVideoImports,
    UnsupportedMedia,
    VideoImportIncomplete,
    VideoImportNotFound,
    VideoImportNotOpen,
    VideoImportTooLarge,
)
from visionset.kernel.services import (
    BatchService,
    IngestService,
    ProjectService,
    SchemaService,
    VideoImportService,
    WorkspaceService,
)
from visionset.kernel.services.video_import_service import (
    ABANDONED_AFTER,
    MAX_IMPORT_FRAMES,
    MAX_OPEN_IMPORTS,
    frame_byte_ceiling,
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
    requested_timestamp: float | None = None,
    source_timestamp: float | None = None,
) -> IncomingFrame:
    return IncomingFrame(
        ordinal=ordinal,
        requested_timestamp=ordinal / fps if requested_timestamp is None else requested_timestamp,
        source_timestamp=source_timestamp,
        width=size[0],
        height=size[1],
        # A stream, because that is what a part is — see `IncomingFrame`. A
        # `BytesIO` stands in for the spooled handle the route hands over, and
        # every pass the service makes seeks it itself.
        content=BytesIO(
            _png(ordinal if seed is None else seed, size) if content is None else content
        ),
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


def test_a_cut_that_would_stage_an_absurd_number_of_frames_is_refused(
    fixture: Fixture,
) -> None:
    """Every field is in bounds and their product is not, which is the whole defect.

    `1e18` seconds at `1e5` fps passes every validator on the way in and then
    died in the mapper, on an integer SQLite has no column wide enough to hold.
    Whole-clip is the selection here — no ranges — so the count the bound sees
    is the clip's own grid, and it is refused.

    An infinite rate is the same arithmetic reached from the other side, and it
    never gets as far as a count: `VideoProvenance` forbids inf and NaN, which is
    one of the two facts the finiteness guard in `start` relies on.

    Nothing is written either way: the assertion at the end is that half.
    """
    with pytest.raises(VideoImportTooLarge):
        fixture.imports.start(
            fixture.project.id,
            display_name="clip.webm",
            metadata=_metadata(1e18),
            extraction_fps=1e5,
        )
    with pytest.raises(ValidationError):
        fixture.imports.start(
            fixture.project.id,
            display_name="clip.webm",
            metadata=_metadata(10.0),
            extraction_fps=float("inf"),
        )
    with fixture.workspace.unit_of_work() as uow:
        assert uow.sources.list(fixture.project.id) == []


def test_the_frame_bound_is_on_the_selected_cut_and_not_on_the_whole_clip(
    fixture: Fixture,
) -> None:
    """Two hours at 30 fps is a grid nobody could send, and ten seconds of it is not.

    The bound used to be `duration * fps`, so this session was refused — and the
    refusal told the caller to narrow a selection that had already been narrowed
    as far as it goes. The count over the canonical ranges is what the limit is
    about, so the session opens and promises exactly the selected cut.
    """
    session = fixture.imports.start(
        fixture.project.id,
        display_name="drive.mp4",
        metadata=_metadata(7200.0),
        extraction_fps=30.0,
        ranges=(TimeRange(start_seconds=100.0, end_seconds=110.0),),
    )

    assert session.expected_frame_count == 300
    assert session.state is VideoImportState.OPEN


def test_a_selected_cut_over_the_ceiling_is_still_refused(fixture: Fixture) -> None:
    """Narrowing lifts the refusal; not narrowing enough does not."""
    with pytest.raises(VideoImportTooLarge):
        fixture.imports.start(
            fixture.project.id,
            display_name="drive.mp4",
            metadata=_metadata(7200.0),
            extraction_fps=30.0,
            ranges=(TimeRange(start_seconds=0.0, end_seconds=4000.0),),
        )
    with fixture.workspace.unit_of_work() as uow:
        assert uow.sources.list(fixture.project.id) == []


def test_a_product_that_overflows_to_infinity_is_refused_rather_than_raised(
    fixture: Fixture,
) -> None:
    """Both operands finite, their product not: the one case one guard exists for.

    `1e308` seconds and `1e10` fps each satisfy every validator — finite,
    positive, no NaN — and multiply to `inf`, which `math.ceil` raises
    `OverflowError` on rather than rounding. An `OverflowError` out of here is a
    500 where a refusal belongs, so it is failed loudly rather than caught.
    """
    try:
        with pytest.raises(VideoImportTooLarge):
            fixture.imports.start(
                fixture.project.id,
                display_name="clip.webm",
                metadata=_metadata(1e308),
                extraction_fps=1e10,
            )
    except OverflowError as escaped:  # pragma: no cover - the defect this guards
        pytest.fail(f"the grid arithmetic overflowed instead of being refused: {escaped!r}")


def test_a_declaration_carrying_a_non_finite_number_is_refused_by_the_model(
    fixture: Fixture,
) -> None:
    """`json.loads("1e400")` is `inf`, and `inf` satisfies `gt=0`.

    So the bound nobody writes down has to be written down: without it an
    infinite duration is stored as a clip's provenance and raises `OverflowError`
    in the first arithmetic that reaches it, which is a 500 rather than a
    refusal.
    """
    with pytest.raises(ValidationError):
        _metadata(float("inf"))
    with pytest.raises(ValidationError):
        TimeRange(start_seconds=0.0, end_seconds=float("inf"))


def test_a_cut_just_under_the_ceiling_is_still_accepted(fixture: Fixture) -> None:
    """The bound is on the declaration, not on the clip: one below it opens."""
    session = fixture.imports.start(
        fixture.project.id,
        display_name="clip.webm",
        metadata=_metadata(float(MAX_IMPORT_FRAMES - 1)),
        extraction_fps=1.0,
    )
    assert session.expected_frame_count == MAX_IMPORT_FRAMES - 1


def test_a_geometry_no_decoder_could_open_is_refused_at_the_declaration(
    fixture: Fixture,
) -> None:
    """The other half of the size question, and the half that bounds one request.

    The per-part byte ceiling is derived from this geometry, so an unbounded
    declaration is an unbounded part — the bound has to be here, not only on the
    frame count.
    """
    huge = VideoMetadata(width=40_000, height=40_000, fps=30.0, duration_seconds=2.0, codec="vp9")
    with pytest.raises(VideoImportTooLarge):
        fixture.imports.start(
            fixture.project.id, display_name="clip.webm", metadata=huge, extraction_fps=1.0
        )
    # The downscale is part of the declaration, so it is part of the answer: the
    # same clip at a percent that brings it under the bound opens.
    assert (
        fixture.imports.start(
            fixture.project.id,
            display_name="clip.webm",
            metadata=huge,
            extraction_fps=1.0,
            scale_percent=10,
        )
        is not None
    )


def test_a_project_may_not_hold_more_open_sessions_than_the_cap(fixture: Fixture) -> None:
    """Every `start` writes a source and a session before a frame arrives."""
    for _ in range(MAX_OPEN_IMPORTS):
        fixture.start()
    with pytest.raises(TooManyOpenVideoImports):
        fixture.start()
    # Ending one makes room, which is what makes the cap a cap rather than a
    # lifetime quota.
    fixture.imports.abort(fixture.imports.get(_any_open(fixture)).id)
    assert fixture.start() is not None


def test_the_cap_counts_this_project_only(fixture: Fixture) -> None:
    other = fixture.projects.create("second")
    for _ in range(MAX_OPEN_IMPORTS):
        fixture.start()
    assert fixture.start(project=other) is not None


def test_an_abandoned_session_is_swept_with_its_source_and_its_frames(
    fixture: Fixture,
) -> None:
    """The sweep deletes the *source*, which is what bounds the rows.

    An expiry that reaped sessions alone would leave one `VIDEO` source per
    abandoned attempt behind forever — the same unbounded growth one table over.
    `video_import.source_id` cascades, so one delete takes all three.
    """
    abandoned = fixture.start()
    fixture.imports.append_frames(abandoned, [_frame(0)])
    _age(fixture, abandoned, ABANDONED_AFTER + timedelta(minutes=1))

    fixture.start()

    with pytest.raises(VideoImportNotFound):
        fixture.imports.get(abandoned)
    with fixture.workspace.unit_of_work() as uow:
        assert uow.video_import_frames.list(abandoned) == []
        assert len(uow.sources.list(fixture.project.id)) == 1


def test_a_committed_session_is_never_swept(fixture: Fixture) -> None:
    """Its source is the provenance of assets somebody is annotating."""
    batch_id = fixture.filled_batch()
    committed = fixture.start()
    fixture.imports.abort(committed)
    with fixture.workspace.unit_of_work() as uow:
        for session in uow.video_imports.list(fixture.project.id):
            session.updated_at = datetime.now(UTC) - ABANDONED_AFTER - timedelta(minutes=1)
            uow.video_imports.update(session)

    fixture.start()

    assert fixture.batches.get(batch_id).asset_ids
    assert len(fixture.ingest.assets(fixture.project.id)) == 3


def test_a_session_still_being_filled_is_not_swept(fixture: Fixture) -> None:
    """`updated_at` moves on every accepted chunk, so a live import refreshes it."""
    live = fixture.start()
    _age(fixture, live, ABANDONED_AFTER + timedelta(minutes=1))
    fixture.imports.append_frames(live, [_frame(0)])

    fixture.start()

    assert fixture.imports.get(live).received_frame_count == 1


def _any_open(fixture: Fixture) -> UUID:
    with fixture.workspace.unit_of_work() as uow:
        return next(
            session.id
            for session in uow.video_imports.list(fixture.project.id)
            if session.state is VideoImportState.OPEN
        )


def _age(fixture: Fixture, import_id: UUID, by: timedelta) -> None:
    """Backdate a session's `updated_at`, which is what the sweep reads."""
    with fixture.workspace.unit_of_work() as uow:
        session = uow.video_imports.get(import_id)
        assert session is not None
        session.updated_at = datetime.now(UTC) - by
        uow.video_imports.update(session)


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
        ordinal=0, requested_timestamp=0.0, width=999, height=999, content=BytesIO(_png(0))
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


def test_a_requested_timestamp_that_is_not_the_ordinals_grid_point_is_refused(
    fixture: Fixture,
) -> None:
    """The moment a frame records is derived from the session, never taken from the frame.

    Ordinal 1 on a 1 fps session is the grid point 1.0s. A descriptor saying 9000
    used to be stored verbatim as the asset's `frame_timestamp`, which is a
    provenance nobody produced — and the ordinal beside it says the opposite, so
    there is no half worth believing over the other.
    """
    import_id = fixture.start()
    contradictory = IncomingFrame(
        ordinal=1,
        requested_timestamp=9000.0,
        width=FRAME_SIZE[0],
        height=FRAME_SIZE[1],
        content=BytesIO(_png(1)),
    )

    with pytest.raises(FrameTimestampOffGrid):
        fixture.imports.append_frames(import_id, [contradictory])

    assert fixture.imports.get(import_id).received_frame_count == 0


def test_a_source_timestamp_after_its_grid_point_is_refused(fixture: Fixture) -> None:
    """The sample drawn for a grid point is the last one at or before it.

    That is what `CanvasSink.canvasesAtTimestamps` is documented to return, so a
    sample *after* the grid point is not a late frame — it is a number that
    cannot have come from that sampling at all.
    """
    import_id = fixture.start()

    with pytest.raises(FrameTimestampOffGrid):
        fixture.imports.append_frames(import_id, [_frame(1, source_timestamp=1.5)])

    assert fixture.imports.get(import_id).received_frame_count == 0


def test_a_source_timestamp_past_the_declared_duration_is_refused(fixture: Fixture) -> None:
    """Outside the clip is a special case of after the grid point, and one rule covers it."""
    import_id = fixture.start()

    with pytest.raises(FrameTimestampOffGrid):
        fixture.imports.append_frames(import_id, [_frame(2, source_timestamp=99.0)])

    assert fixture.imports.get(import_id).received_frame_count == 0


def test_a_grid_point_reached_by_another_arithmetic_route_is_accepted(
    fixture: Fixture,
) -> None:
    """A few ulps off `1/3` is the same grid point, and exact equality would refuse it.

    This is the test that fails the moment `math.isclose` becomes `==`: a client
    that accumulated its way to the third of a second, rather than dividing once,
    is correct and must not be told its grid has drifted.
    """
    import_id = fixture.start(metadata=_metadata(1.0), extraction_fps=3.0)
    nudged = 1 / 3
    for _ in range(4):
        nudged = math.nextafter(nudged, 1.0)
    assert nudged != 1 / 3

    fixture.imports.append_frames(
        import_id,
        [
            IncomingFrame(
                ordinal=1,
                requested_timestamp=nudged,
                width=FRAME_SIZE[0],
                height=FRAME_SIZE[1],
                content=BytesIO(_png(1)),
            )
        ],
    )

    assert fixture.imports.get(import_id).received_frame_count == 1


def test_a_neighbouring_grid_point_is_refused_however_late_in_the_clip_it_sits(
    fixture: Fixture,
) -> None:
    """The window is a width, not a proportion, so ten million seconds in it is the same width.

    A relative tolerance of 1e-9 is 10 ms wide at 1e7 seconds — ten whole grid
    intervals at 1000 fps — so under one the frame next door passed the check and
    was staged at a moment it was not cut from. Ranges make that magnitude
    ordinary: a narrow selection far into a long recording is a small import with
    large ordinals, not an exotic one.

    The nudge at the end is the other half of the same rule. A double's own
    spacing out here is wider than a nanosecond, so a flat epsilon would have
    quietly become exact equality; four ulps keeps honest roundoff accepted
    without the window ever reaching a fiftieth of the way to the next point.
    """
    start, fps = 10_000_000.0, 1000.0
    import_id = fixture.start(
        metadata=_metadata(start + 10.0),
        extraction_fps=fps,
        ranges=(TimeRange(start_seconds=start, end_seconds=start + 0.01),),
    )
    ordinal = int(start * fps)
    grid, neighbour = ordinal / fps, (ordinal + 1) / fps
    assert neighbour - grid < 1e-9 * neighbour, "the old relative window was this wide"

    with pytest.raises(FrameTimestampOffGrid):
        fixture.imports.append_frames(
            import_id, [_frame(ordinal, fps=fps, requested_timestamp=neighbour)]
        )
    with pytest.raises(FrameTimestampOffGrid):
        fixture.imports.append_frames(
            import_id, [_frame(ordinal, fps=fps, source_timestamp=neighbour)]
        )
    assert fixture.imports.get(import_id).received_frame_count == 0

    nudged = grid
    for _ in range(4):
        nudged = math.nextafter(nudged, math.inf)
    fixture.imports.append_frames(import_id, [_frame(ordinal, fps=fps, requested_timestamp=nudged)])
    assert fixture.imports.get(import_id).received_frame_count == 1


def test_a_cut_from_a_non_zero_start_carries_its_own_grid_points(fixture: Fixture) -> None:
    """A session cut from 5 s at 1 fps holds ordinals 5, 6, 7 — and 5.0s, 6.0s, 7.0s.

    The timestamp check is on the extraction grid, which is counted from the
    clip's start and not the selection's, so the numbers a selection-relative
    reading would send (0.0, 1.0, 2.0) are precisely what it refuses.
    """
    import_id = fixture.start(
        metadata=_metadata(10.0), ranges=(TimeRange(start_seconds=5.0, end_seconds=8.0),)
    )

    fixture.imports.append_frames(import_id, [_frame(5), _frame(6), _frame(7)])

    with fixture.workspace.unit_of_work() as uow:
        staged = {row.ordinal: row for row in uow.video_import_frames.list(import_id)}
    assert [staged[ordinal].requested_timestamp for ordinal in (5, 6, 7)] == [5.0, 6.0, 7.0]

    # The crossing assertion, and the reason this test is not two. A client
    # reading the grid as selection-relative sends an ordinal this session does
    # hold beside the moment that ordinal would be *within the selection* — so
    # `selects` passes and only the timestamp catches it. That is the shape the
    # ordinal convention was already got wrong in once.
    with pytest.raises(FrameTimestampOffGrid):
        fixture.imports.append_frames(
            import_id,
            [
                IncomingFrame(
                    ordinal=5,
                    requested_timestamp=0.0,
                    width=FRAME_SIZE[0],
                    height=FRAME_SIZE[1],
                    content=BytesIO(_png(5)),
                )
            ],
        )

    with pytest.raises(FrameTimestampOffGrid):
        fixture.imports.append_frames(import_id, [_frame(5, seed=5, fps=1.0, source_timestamp=6.0)])


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


def test_a_frame_that_is_not_the_size_the_session_declared_is_refused(
    fixture: Fixture,
) -> None:
    """The check a client cannot satisfy by being consistent with itself.

    A descriptor compared with the client's own bytes is circular — both halves
    come from the same place — so a caller could declare one geometry and post
    another, leaving a source saying one thing and its assets another while
    `SOURCE_ORIGIN_UNIQUE` keyed on the declaration. Here the frame and its
    descriptor agree perfectly; what they disagree with is the session.
    """
    import_id = fixture.start()
    with pytest.raises(UnsupportedMedia):
        fixture.imports.append_frames(import_id, [_frame(0, size=(FRAME_SIZE[0] * 2, 8))])
    assert fixture.imports.get(import_id).received_frame_count == 0


def test_a_part_heavier_than_a_frame_of_this_session_is_refused_before_it_is_decoded(
    fixture: Fixture,
) -> None:
    """The bound nothing in the stack had: `FRAMES_PER_REQUEST` counts parts, never bytes.

    The part here is not an image at all, and the refusal still names its
    *weight* — which is the assertion that matters. A size check made after the
    probe would answer `UNSUPPORTED_MEDIA` about the format, having already
    decoded whatever arrived; this one is made off the handle, before a byte is
    read.
    """
    import_id = fixture.start()
    ceiling = frame_byte_ceiling(_provenance_of(fixture, import_id))
    over = IncomingFrame(
        ordinal=0,
        requested_timestamp=0.0,
        width=FRAME_SIZE[0],
        height=FRAME_SIZE[1],
        content=BytesIO(b"\xff" * (ceiling + 1)),
    )

    with pytest.raises(UnsupportedMedia, match="weigh"):
        fixture.imports.append_frames(import_id, [over])
    assert fixture.imports.get(import_id).received_frame_count == 0


def test_the_weight_ceiling_is_derived_from_what_a_frame_must_decode_to(
    fixture: Fixture,
) -> None:
    """A session that stores quarter-size frames accepts quarter-size parts.

    A fixed number would have to be the largest frame anybody might send, which
    is no bound at all for the session that declared a small one. The declaration
    already says exactly what a frame of this import is.
    """
    full = frame_byte_ceiling(_provenance_of(fixture, fixture.start()))
    scaled = frame_byte_ceiling(_provenance_of(fixture, fixture.start(scale_percent=50)))
    assert scaled < full

    import_id = fixture.start(scale_percent=50)
    between = IncomingFrame(
        ordinal=0,
        requested_timestamp=0.0,
        width=FRAME_SIZE[0] // 2,
        height=FRAME_SIZE[1] // 2,
        content=BytesIO(b"\xff" * (scaled + 1)),
    )
    with pytest.raises(UnsupportedMedia, match="weigh"):
        fixture.imports.append_frames(import_id, [between])


def _provenance_of(fixture: Fixture, import_id: UUID) -> VideoProvenance:
    with fixture.workspace.unit_of_work() as uow:
        session = uow.video_imports.get(import_id)
        assert session is not None
        source = uow.sources.get(session.source_id)
    assert source is not None
    return source.require_video()


def test_a_scaled_session_takes_frames_at_the_scaled_size_and_nothing_else(
    fixture: Fixture,
) -> None:
    """`stored_width`/`stored_height` is the geometry, not `metadata.width`.

    The declared metadata is what the clip *was*; what a frame must be is that
    after the declared downscale, which is the arithmetic the materializer runs
    too. A check written against the metadata would refuse every scaled import.
    """
    import_id = fixture.start(scale_percent=50)
    scaled = (FRAME_SIZE[0] // 2, FRAME_SIZE[1] // 2)
    with pytest.raises(UnsupportedMedia):
        fixture.imports.append_frames(import_id, [_frame(0)])
    session = fixture.imports.append_frames(import_id, [_frame(0, size=scaled)])
    assert session.received_frame_count == 1


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


def test_a_committed_session_keeps_no_staged_rows(fixture: Fixture) -> None:
    """Commit disposes of its frames exactly as abort does, and for the same reason.

    The session is terminal either way, so nothing will read them again; the
    table's `ON DELETE CASCADE` never fires for either ending, because neither
    one deletes the session row. Left behind, a half-hour clip at 1 fps is
    eighteen hundred dead rows per import.
    """
    import_id = fixture.start()
    fixture.imports.append_frames(import_id, [_frame(0), _frame(1), _frame(2)])
    batch = fixture.imports.commit(import_id)

    with fixture.workspace.unit_of_work() as uow:
        assert uow.video_import_frames.list(import_id) == []
    assert len(batch.asset_ids) == 3
    # The count is the record of what this import committed, not a count of rows
    # that still exist.
    assert fixture.imports.get(import_id).received_frame_count == 3


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
