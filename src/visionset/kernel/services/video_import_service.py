"""Browser-driven video import: open a session, stage frames, commit or throw away.

**A separate use case, not a branch inside ingest.** ``IngestService`` reads an
origin this process can open and turns it into assets in one call; nothing about
its shape survives here. A video never reaches the server at all — a client
decodes it locally and posts PNG frames — so the work has a *middle*: an
arbitrary number of calls between "this is what I am about to send" and "that
was all of it". Putting that middle behind a conditional in a run-shaped service
would have made every one of its invariants conditional too.

**The invariant this service exists for: nothing staged is a project asset.**
Between ``start`` and ``commit`` a session holds bytes in the blob store and rows
in ``video_import_frame``, and no read that answers "what is in this project"
can see any of it. A cancelled tab, a decoder that gave up, a refused frame, an
upload that stalled — every one of them adds no asset and no batch to the project.
``commit`` is the single moment that changes, and it is one transaction.

What *is* reused is everything below the session: content hashing and
``BlobStore``, the project-scoped dedup rule (``store_assets``, shared with
ingest), thumbnails as a best-effort cache, and ``BatchService``'s draft batch as
the destination. A frame is an ordinary image asset by the time it lands; the
only thing that makes it a video frame is the ``VIDEO`` source it points at.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from io import SEEK_END, BytesIO
from typing import TYPE_CHECKING, BinaryIO, Final
from uuid import UUID, uuid4

from visionset.kernel.domain import (
    SAMPLING_POLICY_VERSION,
    VIDEO_FRAME_FORMAT,
    Asset,
    Batch,
    IncomingFrame,
    Project,
    Source,
    SourceKind,
    StagedFrame,
    TimeRange,
    VideoImport,
    VideoImportState,
    VideoMetadata,
    VideoProvenance,
    canonical_ranges,
    expected_frames,
    normalize_name,
)
from visionset.kernel.errors import (
    BatchNotFound,
    ConstraintViolated,
    FrameContentConflict,
    FrameOrdinalOutOfRange,
    FrameTimestampOffGrid,
    MediaError,
    ProjectNotFound,
    TooManyOpenVideoImports,
    UnsupportedMedia,
    VideoImportIncomplete,
    VideoImportNotFound,
    VideoImportNotOpen,
    VideoImportTooLarge,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.batch_service import BatchService
from visionset.kernel.services.ingest_service import store_assets

if TYPE_CHECKING:
    from visionset.kernel.services.workspace_service import WorkspaceService

MAX_IMPORT_FRAMES: Final = 100_000
"""The most grid points one session may promise, and so the most it may stage.

A bound on the *work* a single declaration can commission, checked before any
row is written. Two things make it necessary rather than tidy. A declared
duration and an extraction rate are both floats a caller chooses, and their
product is what every count downstream is computed from: at ``1e18`` seconds and
``1e5`` fps every validator passes and the row store is then asked for an
integer SQLite has no column wide enough to hold. And a session that promises
more frames than anybody can send is a session that can never commit, so it
stages rows until it is swept and then stages them again.

**The bound is on the cut that was selected, never on the clip it was cut
from.** Comparing ``duration * fps`` against this number was the cheaper
spelling and the wrong one: it refuses a two-hour recording at 30 fps even when
the selection is ten seconds of it, which is three hundred grid points and a
perfectly ordinary import — and the refusal then tells the caller to narrow a
selection that changes nothing. ``expected_frames`` over the canonical ranges is
the count this bound is about, so narrowing really does lift it. The one thing
the product is still asked is whether it is *finite*, which is what keeps an
overflowed ``inf`` out of ``math.ceil``; see :meth:`VideoImportService.start`.

A hundred thousand is far past any real import and far short of anything the
store notices: at the default rate it is twenty-seven hours of footage, at 30 fps
it is fifty-five minutes, and either way it is more than three thousand requests
of thirty-two frames before the session could complete. Anything above it is a
declaration nobody meant.
"""

MAX_FRAME_PIXELS: Final = 40_000_000
"""The largest frame geometry a session may declare, in pixels after the downscale.

The bound that makes the per-part byte ceiling a number rather than a formula.
That ceiling is derived from what a frame must decode to — see
:func:`frame_byte_ceiling` — so without a bound on the geometry itself the
"largest part this route accepts" is whatever a caller declared, which is no
bound at all.

Forty million is past 8K in both spellings — UHD is 33.2 Mpx, DCI 35.4 — and
short of anything an ordinary machine decodes without swapping: at four bytes a
pixel the raster alone is 160 MB, and the decoder needs it whole whatever the
encoding. Beyond this the refusal is honest rather than arbitrary, because the
frame could not be decoded here anyway.
"""

MAX_OPEN_IMPORTS: Final = 16
"""How many sessions one project may hold ``open`` at once.

``start`` writes a source row and a session row before a single frame arrives,
and an abandoned session reports itself to nobody — so without a cap, opening
one is an unbounded write for whoever holds a token. It counts only ``open``
sessions: a committed one is a dataset's provenance and an aborted one is
already on the sweeper's list.

Sixteen because a person decodes one clip at a time in one tab, and the number
has to leave room for several tabs plus whatever a crashed one left behind
inside the sweep window, while still being a number rather than a direction.
"""

GRID_TIMESTAMP_TOLERANCE: Final = 1e-9
"""The floor of how far a frame's declared timestamp may sit from the grid point it claims.

Both halves reach that number the same way today — the server divides
``ordinal / extraction_fps`` and ``gridTimestamps`` in ``frontend/media`` yields
exactly ``index / fps``, both as IEEE-754 doubles — so they agree bit for bit and
``==`` would pass. The tolerance is not there for them. It is there so a client
that arrives at the same grid point by another arithmetic route — accumulating
an interval, or round-tripping through a container's own timebase — is not
refused over a rounding step in work that was correct.

**The tolerance follows floating-point representation error, not elapsed clip
time.** A nanosecond is orders of magnitude below any container's timebase —
1/90000 s for MPEG, microseconds for Matroska — and it stays a nanosecond a
million seconds into a clip. It must: a selected range may sit far into a long
recording, so a large timestamp is ordinary here, and a window that grew with the
timestamp would reach the neighbouring grid point long before the clip ran out.
"""

GRID_TIMESTAMP_ULPS: Final = 4
"""How many representable doubles either side of the grid point the window covers.

Past roughly 4.5e6 seconds a double's own spacing is wider than a nanosecond, and
a fixed epsilon there would be exact equality wearing a tolerance's clothes.
:func:`math.ulp` is that spacing, so the window is stated in the units the error
is actually made in. Four of them absorbs a handful of correctly-rounded
operations — a divide, a multiply, a round trip through a container's timebase —
and nothing else: the neighbouring grid point is ``1 / extraction_fps`` away, and
a grid fine enough to put it within eight ulps of this one has already collapsed
both points onto the same few doubles, where no comparison could separate them.
"""

ABANDONED_AFTER: Final = timedelta(hours=24)
"""How long a session that is not committed may sit untouched before it is swept.

``updated_at`` moves on every accepted chunk, so a live import — however long its
decode — refreshes this constantly and is never a candidate. A day of complete
silence is a tab nobody is coming back to: nothing in any surface can resume a
session whose id was only ever held in a browser's memory.

The sweep runs at ``start``, which is the one call that also makes rows. There is
no background sweeper and deliberately so: a local-first single-writer store has
no daemon to hang one on, and the cost of the pass is one already-indexed read of
the project's own sessions.
"""


_BYTES_PER_PIXEL: Final = 4
"""What one pixel of a decoded frame costs: 8-bit RGBA, which is what a canvas holds.

The multiplier in :func:`frame_byte_ceiling`, and deliberately the *decoded*
cost rather than a guess at a compressed one. A PNG larger than its own raster
is not a frame somebody encoded badly; it is not a plausible encoding of that
geometry at all.
"""

_PNG_ENVELOPE: Final = 64 * 1024
"""Slack over the raster: the signature, the chunk headers, the per-row filter
byte, and zlib's own framing on data that will not compress. Fixed rather than
proportional, because every one of those is a constant or a function of height
that a fixed sixty-four kilobytes covers for any geometry this service accepts.
"""


def _grid_timestamp_tolerance(grid_timestamp: float, extraction_fps: float) -> float:
    """The absolute window around one grid point, and never a relative one.

    Absolute so it cannot grow with the timestamp, ulp-aware so it does not
    shrink below the error a double can make at that magnitude, and capped at
    half a grid interval so the windows of two adjacent grid points cannot touch
    however fine the grid or however far into the clip it is read.
    """
    return min(
        max(GRID_TIMESTAMP_TOLERANCE, GRID_TIMESTAMP_ULPS * math.ulp(grid_timestamp)),
        0.5 / extraction_fps,
    )


def frame_byte_ceiling(selection: VideoProvenance) -> int:
    """The most one frame part of this session may weigh, from what it must decode to.

    Public because it is the number the refusal quotes and the number a test
    reasons from, and derived rather than configured because the session already
    declares the only thing it could be derived from: every frame of this import
    must decode to ``stored_width x stored_height`` — that is the check beside
    this one — so a part heavier than that geometry's own raster cannot be one.

    A ceiling rather than an estimate, and nothing here tries to guess how well a
    real frame compresses. A photograph lands ten or twenty times under this; the
    number exists to refuse the part that is a thousand times over it, before
    anything has read a byte of it.
    """
    pixels = selection.stored_width * selection.stored_height
    return pixels * _BYTES_PER_PIXEL + _PNG_ENVELOPE


class VideoImportService:
    """The lifecycle of one browser-driven import, from declaration to batch."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._batches = BatchService(workspace)

    def start(
        self,
        project_id: UUID,
        *,
        display_name: str,
        metadata: VideoMetadata,
        extraction_fps: float,
        ranges: Sequence[TimeRange] = (),
        scale_percent: int = 100,
        batch_id: UUID | None = None,
        batch_name: str | None = None,
        materializer: str | None = None,
    ) -> VideoImport:
        """Declare a clip and open a session to receive its frames.

        Everything here is a **declaration**: the server has not seen the video
        and never will. ``metadata`` is what the client's decoder read off the
        container, and it is stored as provenance on the same terms a probe's
        answer used to be — what the clip *was*, not a promise about bytes
        anybody can reproduce. ``materializer`` is the other half of that record,
        alongside the ``SAMPLING_POLICY_VERSION`` this build stamps: a source
        carrying neither predates browser import, and that is a distinction only
        an unstamped row can make.

        The one number the server does **not** take on trust is how many frames
        the selection holds. ``ranges`` is canonicalized against the declared
        duration and ``expected_frames`` counts the grid points — the same
        arithmetic the ingest screen shows and the client materializes against —
        so "complete" at commit is a fact this process computed rather than a
        claim it was handed.

        The source's locator is ``video-import:<uuid4>`` and is **opaque**.
        A fake server path would be a lie the rest of the kernel is entitled to
        believe — ``Source.locator`` promises only ``IMAGE_DIRECTORY`` is
        openable — and making it unique per import is what keeps
        ``SOURCE_ORIGIN_UNIQUE`` out of the way: two imports of one file are two
        sources, and asset content-addressing stays the only thing that
        deduplicates their frames.

        ``batch_id`` names a draft that already exists — the way a second clip
        joins the first one's batch — and ``batch_name`` names one commit will
        create. At most one of them is meaningful; ``batch_id`` wins if both
        arrive, which is ``IngestService.enqueue``'s rule and this is the second
        caller of it rather than a second policy. Neither means the batch takes
        the source's own name.

        **Every one of those is checked here, not at commit**, and that
        placement is the point. ``batch_name`` is normalized so a blank one is
        refused before a client spends minutes decoding, and the target batch is
        resolved and required to be a draft for the same reason: an approved
        batch has been cut into jobs already, and finding that out after the
        decoding is finding it out after the work.

        **The session is also what a caller could make unboundedly many of**, so
        three refusals guard the row store rather than the dataset. A *selected
        cut* holding more than ``MAX_IMPORT_FRAMES`` grid points is refused — the
        count over the canonical ranges, not the clip's own grid, so a long
        recording with a short selection is an ordinary import and narrowing a
        selection genuinely lifts the refusal. A frame geometry over
        ``MAX_FRAME_PIXELS`` is refused too, which is what gives the per-part
        weight ceiling something finite to be derived from. And a project already
        holding ``MAX_OPEN_IMPORTS`` open sessions is refused until one of them
        ends, and the same pass sweeps what is genuinely abandoned; see
        :meth:`_make_room`.

        Raises:
            ProjectNotFound: no such project in this workspace.
            BatchNotFound: ``batch_id`` names no batch of this project.
            BatchNotEditable: the target batch is past ``draft``.
            TooManyOpenVideoImports: this project already holds the most open
                sessions it may.
            VideoImportTooLarge: the selected cut would stage more frames than
                one session may hold, or frames larger than one may decode.
            InvalidName: ``display_name``, or a provided ``batch_name``, is
                blank once stripped.
            ValueError: the declared metadata or cut parameters are not usable —
                a non-positive rate, a scale outside 1-100, or a selection that
                holds no grid point at all.
        """
        # Built before the bounds are asked anything, because it is what they
        # have to be asked *about*. A ``VideoProvenance`` is a frozen value in
        # memory: constructing one opens no transaction, writes no row and
        # commits the caller to nothing, so there is nothing to undo if the next
        # line refuses. What it costs nothing to get is the cut as it will
        # actually be stored — canonical ranges, and the geometry frames land at
        # — rather than the whole clip the arguments happen to describe.
        provenance = VideoProvenance(
            metadata=metadata,
            extraction_fps=extraction_fps,
            ranges=canonical_ranges(ranges, duration_seconds=metadata.duration_seconds),
            scale_percent=scale_percent,
            policy_version=SAMPLING_POLICY_VERSION,
            materializer=materializer,
        )
        if provenance.stored_width * provenance.stored_height > MAX_FRAME_PIXELS:
            # One half of "how much work is this", and the half that bounds a
            # single request rather than the session: the per-part byte ceiling
            # is derived from this geometry, so an unbounded declaration is an
            # unbounded part. Read off ``provenance`` rather than re-spelling
            # ``scaled_dimension``, so the number refused is the number stored.
            raise VideoImportTooLarge(
                f"frames of {metadata.width}x{metadata.height} at {scale_percent}% hold more"
                f" than {MAX_FRAME_PIXELS} pixels; scale the import down"
            )
        if not math.isfinite(metadata.duration_seconds * provenance.extraction_fps):
            # The one guard that makes every ``math.ceil`` below incapable of
            # raising ``OverflowError``, and one is enough because of what the
            # two models have already proved. ``VideoMetadata`` forbids inf and
            # NaN and requires a positive duration; ``VideoProvenance`` forbids
            # them and requires a positive rate — so both operands here are
            # finite positives and only their *product* can reach ``inf``. And
            # ``canonical_ranges`` has clamped every range end to
            # ``min(end, duration_seconds)`` and dropped every range starting at
            # or past the duration, so if that product is finite then
            # ``start * fps`` and ``end * fps`` are finite for every canonical
            # range there is — which is exactly the arithmetic ``grid_bounds``
            # and ``expected_frames`` round. Nothing below can overflow once this
            # line has passed.
            raise VideoImportTooLarge(
                f"a clip of {metadata.duration_seconds}s at {extraction_fps} fps is past every"
                " number this can be counted in; lower the rate or the declared duration"
            )
        expected = expected_frames(
            provenance.ranges,
            duration_seconds=metadata.duration_seconds,
            fps=provenance.extraction_fps,
        )
        if expected > MAX_IMPORT_FRAMES:
            # The bound is on the cut that was *selected*. The clip's own grid is
            # not the number: two hours at 30 fps is a grid nobody could send
            # whole, and ten seconds of it is three hundred points and an
            # ordinary import. Counting first is what makes "narrow the
            # selection" a remedy the caller can act on rather than advice that
            # changes nothing. Nothing large is ever stored either way —
            # ``expected`` is bounded here, before it can reach a row.
            raise VideoImportTooLarge(
                f"the selected cut holds {expected} frames at {extraction_fps} fps and one"
                f" import may hold {MAX_IMPORT_FRAMES}; narrow the selection or lower the rate"
            )
        if expected <= 0:
            # A selection narrower than one grid interval. Refused here rather
            # than committed as an empty batch: the two are indistinguishable
            # afterwards, and only one of them is ever what somebody meant.
            raise ValueError(
                "the selected ranges hold no frame at "
                f"{provenance.extraction_fps} fps; widen them or raise the rate"
            )
        name = normalize_name(display_name, what="source name")
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            self._make_room(uow, project_id)
            if batch_id is not None:
                target = self._batches.require_draft(uow, batch_id)
                if target.project_id != project_id:
                    # Not a permission error dressed up: a batch of another
                    # project is not a batch of this one, and answering anything
                    # else would describe a project the caller did not ask about.
                    raise BatchNotFound(f"no batch {batch_id} in project {project_id}")
            source = uow.sources.add(
                Source(
                    project_id=project_id,
                    kind=SourceKind.VIDEO,
                    locator=f"video-import:{uuid4()}",
                    display_name=name,
                    video=provenance,
                )
            )
            return uow.video_imports.add(
                VideoImport(
                    project_id=project_id,
                    source_id=source.id,
                    expected_frame_count=expected,
                    target_batch_id=batch_id,
                    batch_name=(
                        None
                        if batch_id is not None or batch_name is None
                        else normalize_name(batch_name, what="batch")
                    ),
                )
            )

    def get(self, import_id: UUID) -> VideoImport:
        """The session as stored, progress included.

        The session *is* the progress report — ``expected_frame_count`` and
        ``received_frame_count`` live on the row — so there is no second model
        for a poller to read. That is deliberate: a derived progress object would
        be a second answer to "how far along is this", computed somewhere else
        and able to disagree.

        Raises:
            VideoImportNotFound: no such session in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_import(uow, import_id)

    def append_frames(self, import_id: UUID, frames: Sequence[IncomingFrame]) -> VideoImport:
        """Stage a chunk of materialized frames, and answer the session's progress.

        **Every frame is decoded before it is stored.** The descriptor a client
        sends is a claim about bytes this process has in hand, so checking it
        costs one decode and buys the only thing that makes the session's count
        mean anything: a frame staged at ordinal *i* really is a PNG of the
        declared size. A descriptor that disagrees with its bytes is not a frame
        with bad metadata — it is evidence the client's grid and this session's
        have drifted — so it is refused rather than corrected.

        The decode happens **before** the transaction opens, which is the same
        rule the rest of this kernel follows: a single-writer SQLite store must
        never hold a write lock across an image decoder.

        **Idempotency is by content, adjudicated on the server's own hash.** The
        same ordinal with the identical bytes is a retry — a chunked upload that
        lost its connection is the ordinary case — so it succeeds, writes
        nothing, and leaves ``received_frame_count`` where it was. The same
        ordinal with different bytes is a conflict the session cannot settle, and
        it is refused.

        **The progress count is derived, never accumulated.** It is recomputed
        from the staged rows inside the writing statement — see
        ``UnitOfWork.recount_video_import_frames`` — because reading it and
        adding to it is a lost update that two concurrent appends reach, and one
        that no retry can repair: the frames are already staged, so re-sending
        them writes nothing and the session can never reach its own count again.

        A refused frame can leave its blob behind. Orphaned content-addressed
        blobs are already this repository's accepted policy — an ingest that
        refuses a file after storing part of it does the same — and an
        unreachable blob is wasted space rather than a wrong answer.

        **A frame is a stream and is never held whole.** ``IncomingFrame.content``
        is an open handle, so a chunk of thirty-two frames costs thirty-two open
        handles rather than thirty-two frames of memory, and a part too heavy to
        be a frame of this session is refused off its size before a byte of it is
        read — see :meth:`_stage`.

        Raises:
            VideoImportNotFound: no such session in this workspace.
            VideoImportNotOpen: the session was already committed or aborted.
            FrameOrdinalOutOfRange: an ordinal is not a grid index the session's
                selection holds.
            FrameTimestampOffGrid: a descriptor's ``requested_timestamp`` is not
                its ordinal's own grid point, or its ``source_timestamp`` is
                after that point.
            FrameContentConflict: an ordinal already holds different bytes.
            UnsupportedMedia: a frame is not PNG, is not the geometry this
                session stores, or weighs more than that geometry can.
            CorruptMedia: a frame is a PNG whose bytes will not decode.
        """
        with self._workspace.unit_of_work() as uow:
            session = self.require_import(uow, import_id)
            self._require_open(session)
            selection = self._require_source(uow, session).require_video()
        staged = [self._stage(session, selection, frame) for frame in frames]
        try:
            return self._record(import_id, staged)
        except ConstraintViolated:
            # ``(import_id, ordinal)`` is unique, and the adjudication above
            # reads the staged rows *before* it inserts: two genuinely
            # concurrent appends at one never-yet-staged ordinal both find it
            # free, and the loser's insert is refused by the index rather than
            # settled by the rule. The re-read is the settlement — the winner's
            # row is now visible, so the same pass answers what it was always
            # meant to: identical bytes are a retry that writes nothing, and
            # different bytes are ``FrameContentConflict``.
            #
            # A second transaction rather than a recovery inside the first:
            # a constraint violation ends the transaction it happened in, so
            # nothing this call had already staged survives it, and re-running
            # the whole pass is what puts those frames back.
            #
            # One retry, not a loop. A second violation means a *third* writer
            # arrived inside it, which is not a shape any client of this session
            # has — the frames of one clip are sent by the page that decoded it —
            # and a store refusing a write under contention is better reported
            # than retried forever.
            return self._record(import_id, staged)

    def _record(self, import_id: UUID, staged: Sequence[StagedFrame]) -> VideoImport:
        """One pass of "stage what is not held, refuse what disagrees", in one write.

        Split out of :meth:`append_frames` so that the retry a constraint
        violation earns is the same code and not a second spelling of the rule.

        Raises:
            VideoImportNotFound: no such session in this workspace.
            VideoImportNotOpen: the session was already committed or aborted.
            FrameContentConflict: an ordinal already holds different bytes.
            ConstraintViolated: another writer staged one of these ordinals
                between the read below and the insert.
        """
        with self._workspace.unit_of_work() as uow:
            session = self.require_import(uow, import_id)
            self._require_open(session)
            held = {row.ordinal: row for row in uow.video_import_frames.list(import_id)}
            arrived = 0
            for candidate in staged:
                standing = held.get(candidate.ordinal)
                if standing is not None:
                    if standing.content_hash != candidate.content_hash:
                        raise FrameContentConflict(
                            f"frame {candidate.ordinal} of video import {import_id} already holds"
                            " different content; abort the import and start again"
                        )
                    continue
                held[candidate.ordinal] = uow.video_import_frames.add(candidate)
                arrived += 1
            if arrived:
                now = datetime.now(UTC)
                session.received_frame_count = uow.recount_video_import_frames(import_id, at=now)
                session.updated_at = now
            return session

    def commit(self, import_id: UUID) -> Batch:
        """Turn every staged frame into an asset, in one transaction, once.

        **The completeness gate is the whole point.** A materialization that died
        partway would otherwise produce a batch silently missing a stretch of its
        clip, and nothing downstream could ever detect that: the assets are
        perfectly good images and the batch looks like any other. So the session
        commits only when it holds every grid point its selection declared.

        One transaction, and this is the one place in the ingestion story that
        needs it. The assets, the batch that carries them and the session's own
        move to ``committed`` are a single fact — "this import became that
        batch" — and a crash between any two of them would leave either assets
        nothing points at or a session claiming a batch that was never written.

        **Idempotent, by the state rather than by a guess.** A repeated commit
        answers the batch the first one created and writes nothing. That matters
        for the obvious reason (a client that retried a timed-out request must
        not get a second batch) and for a subtler one: the frames are still
        staged, so re-running the body would content-dedup every asset back onto
        itself and then hang a *second* batch off them.

        **Two ordinals with identical bytes collapse into one asset, and that is
        correct.** A static shot at 1 fps genuinely yields the same image twice;
        content addressing has always said so, and a frame-level identity built
        to keep them apart would be a second identity system contradicting the
        first. The batch is then shorter than the frame count, which is the
        honest report.

        **The staged rows go**, exactly as they do on an abort and for the same
        reason: they have become assets, the session is terminal, and no read
        will ever reach them again. Deleting them here is not tidiness — a
        half-hour clip at 1 fps leaves eighteen hundred rows per import, and the
        table's ``ON DELETE CASCADE`` never fires for either ending, because
        neither one deletes the session row. ``received_frame_count`` stays
        where it is: it is the record of what this import committed, not a
        count of rows that still exist.

        **The destination was chosen at start, and is checked again here.** A
        session aimed at an existing draft can find it approved or deleted in the
        minutes it spent decoding, and the honest answer then is the same refusal
        the start would have made — not a batch of its own invented to have
        somewhere to put the frames, which is the one outcome nobody asked for.

        Raises:
            VideoImportNotFound: no such session in this workspace.
            VideoImportNotOpen: the session was aborted.
            VideoImportIncomplete: frames are still missing.
            BatchNotFound: the target batch has since been deleted.
            BatchNotEditable: the target batch is no longer a draft.
            InvalidName: the resolved batch name is blank once stripped.
        """
        with self._workspace.unit_of_work() as uow:
            session = self.require_import(uow, import_id)
            if session.state is VideoImportState.COMMITTED:
                return self._committed_batch(uow, session)
            self._require_open(session)
            if session.received_frame_count != session.expected_frame_count:
                raise VideoImportIncomplete(
                    f"video import {import_id} holds {session.received_frame_count} of"
                    f" {session.expected_frame_count} frames; finish it or abort it"
                )
            source = self._require_source(uow, session)
            frames = sorted(
                uow.video_import_frames.list(import_id), key=lambda frame: frame.ordinal
            )
            candidates = [
                Asset(
                    project_id=session.project_id,
                    content_hash=frame.content_hash,
                    uri=f"{source.locator}#frame={frame.ordinal}",
                    width=frame.width,
                    height=frame.height,
                    format=frame.image_format,
                    source_id=source.id,
                    frame_index=frame.ordinal,
                    frame_timestamp=frame.timestamp,
                    thumbnail_hash=frame.thumbnail_hash,
                )
                for frame in frames
            ]
            now = datetime.now(UTC)
            assets, _ = store_assets(uow, session.project_id, candidates, stamped_at=now)
            batch = self._destination(uow, session, source, [asset.id for asset in assets])
            for frame in frames:
                uow.video_import_frames.delete(frame.id)
            session.state = VideoImportState.COMMITTED
            session.batch_id = batch.id
            session.updated_at = now
            uow.video_imports.update(session)
            return batch

    def abort(self, import_id: UUID) -> VideoImport:
        """Throw the session away: no assets, no batch, nothing staged reaches the project.

        The frame rows go with it, deleted one by one. The table's ``ON DELETE
        CASCADE`` does not do it, and cannot: an abort **updates** the session
        row rather than deleting it — the session is the record that this import
        happened and how it ended — so nothing ever fires the cascade. The
        cascade is the backstop for a project or source being deleted out from
        under a session, which is a different event.

        The blobs are **not** swept, deliberately. They are content-addressed, so
        an orphan is unreachable rather than wrong; a sweeper would have to prove
        no asset in any project shares the hash, which is a garbage collector
        this repository has decided it does not want. The same is already true of
        every ingest that refused a file after storing it.

        The ``VIDEO`` source stays too. It is the record that somebody declared
        this clip, which an abort does not un-declare, and it owns no assets.

        Aborting a session that is already aborted is a no-op, because a client
        cancelling twice means the same thing once. Aborting a **committed** one
        is refused: its frames are assets somebody may already be annotating, and
        there is nothing here that could take them back.

        Raises:
            VideoImportNotFound: no such session in this workspace.
            VideoImportNotOpen: the session already committed.
        """
        with self._workspace.unit_of_work() as uow:
            session = self.require_import(uow, import_id)
            if session.state is VideoImportState.ABORTED:
                return session
            self._require_open(session)
            for frame in uow.video_import_frames.list(import_id):
                uow.video_import_frames.delete(frame.id)
            session.state = VideoImportState.ABORTED
            session.received_frame_count = 0
            session.updated_at = datetime.now(UTC)
            return uow.video_imports.update(session)

    def require_import(self, uow: UnitOfWork, import_id: UUID) -> VideoImport:
        """The session, checked through its project so workspaces stay separate.

        Public and taking a ``uow`` for ``SourceService.require_source``'s
        reason: ``commit`` has to resolve the session *inside* the transaction it
        writes in, and a second spelling of this ladder is a second place for it
        to be got wrong.

        Raises:
            VideoImportNotFound: no such session in this workspace.
        """
        session = uow.video_imports.get(import_id)
        if session is not None:
            project = uow.projects.get(session.project_id)
            if project is not None and project.workspace_id == self._workspace.workspace_id:
                return session
        raise VideoImportNotFound(
            f"no video import {import_id} in workspace {self._workspace.workspace.name!r}"
        )

    # --- the parts the operations above share ------------------------------

    def _make_room(self, uow: UnitOfWork, project_id: UUID) -> None:
        """Sweep what this project abandoned, then refuse it a session too many.

        **The sweep deletes the source, not the session**, and that is the whole
        reason it bounds anything. ``start`` writes a ``VIDEO`` source beside
        every session, and an expiry that reaped sessions alone would leave one
        source per attempt behind forever — the same unbounded growth one table
        over. ``video_import.source_id`` cascades, so deleting the source takes
        the session and every frame staged under it in one statement, and the
        content-addressed blobs are left exactly where :meth:`abort` leaves
        them, for the reason stated there.

        **A committed session is never swept.** Its source is the provenance of
        assets somebody is annotating, and its row is the record of where they
        came from. Everything else — a session still ``open`` that nobody has
        touched since ``ABANDONED_AFTER``, and an aborted one that has served
        its purpose as an answer — is a row nothing will ever read again.

        The cap is counted after the sweep so that a project whose sessions are
        all stale is not refused on the strength of rows this call has just
        deleted.
        """
        cutoff = datetime.now(UTC) - ABANDONED_AFTER
        still_open = 0
        for session in uow.video_imports.list(project_id):
            if session.state is VideoImportState.COMMITTED:
                continue
            if session.updated_at <= cutoff:
                uow.sources.delete(session.source_id)
            elif session.state is VideoImportState.OPEN:
                still_open += 1
        if still_open >= MAX_OPEN_IMPORTS:
            raise TooManyOpenVideoImports(
                f"project {project_id} already holds {still_open} open video imports;"
                " finish or abort one before starting another"
            )

    def _stage(
        self, session: VideoImport, selection: VideoProvenance, frame: IncomingFrame
    ) -> StagedFrame:
        """Prove one frame is what it says it is, store it, and describe the row.

        Outside any transaction, and that placement is load-bearing — see
        :meth:`append_frames`.

        **An ordinal is an extraction-grid index, and it is checked against the
        selection rather than against the count.** ``expected_frame_count`` is how
        many frames the selection holds; the indices themselves are
        ``grid_bounds`` over the ranges on the source's own provenance, which is
        why they are read from there rather than kept a second time on the
        session. The two agree only for a clip cut from zero — a session cut from
        5 s at 1 fps expects three frames and their indices are 5, 6, 7 — so
        bounding by the count refuses every frame of every other selection.

        **The timestamps are derived, never taken.** An ordinal is a grid index,
        so the moment it names is ``ordinal / extraction_fps`` — and this method
        divides that itself, out of the ``extraction_fps`` on the source's own
        provenance, rather than reading ``requested_timestamp`` off the
        descriptor. Storing what was sent let a client post ordinal 5 on a 1 fps
        session and have the asset recorded at 9000 seconds: two halves of one
        claim contradicting each other, with no way to choose between them and no
        honest way to correct one — writing the derived number over the sent one
        would record a provenance nobody produced. So it is refused. The window
        is :func:`_grid_timestamp_tolerance` wide — absolute, never relative, and
        by construction never wide enough to reach a neighbouring grid point.

        ``source_timestamp`` is the presentation time of the sample the decoder
        actually drew, and the one thing that can be said about it is that it is
        **at or before** the grid point. That is not a convention; it is what the
        sampling this import uses means. Mediabunny's
        ``CanvasSink.canvasesAtTimestamps`` — and ``getCanvas`` beside it —
        document what they return as the last video frame in presentation order
        whose start timestamp is less than or equal to the timestamp asked for,
        and ``frontend/media``'s worker asks for ``first + clipRelative`` and
        reports ``sample.timestamp - first``. So a sample after the grid point is
        not a late frame, it is a number that cannot have come from that sink,
        and the tolerance is there to absorb the float round trip through that
        ``first`` rather than to permit any real overshoot.

        **There is no separate "within the clip" check, and there needs to be
        none.** ``selection.selects`` has already passed, every grid bound ends at
        ``ceil(t * fps)`` for a ``t`` that ``canonical_ranges`` clamped to the
        declared duration, so ``ordinal / extraction_fps`` is strictly inside the
        clip — and ``source_timestamp <= grid_timestamp`` therefore lands inside
        it too. Finiteness and non-negativity are ``IncomingFrame``'s, through
        ``allow_inf_nan=False`` and ``ge=0``; re-checking them here would be a
        second, weaker copy of a bound that already holds.

        **The size is checked against the declaration, and only then against the
        descriptor.** Comparing a client's descriptor with the client's own bytes
        is circular: both halves come from the same place, so a client declaring
        a 1920x1080 clip at 50% and posting consistent 4096x4096 frames used to
        pass every check and leave a source saying one thing and its assets
        another. ``stored_width``/``stored_height`` is the third party — the
        geometry the session was opened with, and the one the source's identity
        is keyed on. Note that ``metadata`` is *display* dimensions, so a clip
        the container rotates is already described the way its decoder will
        draw it; a rotated import matches this check rather than fighting it.

        **How heavy the part is, asked before anything reads it.** The frame
        arrives as a handle rather than as bytes, so its size is a seek and a
        ``tell`` — no decode, no copy, nothing resident — and a part over
        :func:`frame_byte_ceiling` is refused there. That ordering is the point:
        every check below has to look at the bytes, and "this is not a frame" is
        a much cheaper sentence to reach before a gigabyte has been decoded than
        after. The stream is then handed on as it is: ``probe``, ``BlobStore.put``
        and ``thumbnail`` all read in chunks, so the only thing this method ever
        holds whole is one decoded raster.
        """
        if not selection.selects(frame.ordinal):
            raise FrameOrdinalOutOfRange(
                f"frame {frame.ordinal} is not on the grid video import {session.id} selected"
            )
        # Derived here, from the session's own provenance and the ordinal beside
        # it, and never read off the descriptor. The descriptor's own number is
        # only ever the thing being checked.
        grid_timestamp = frame.ordinal / selection.extraction_fps
        tolerance = _grid_timestamp_tolerance(grid_timestamp, selection.extraction_fps)
        if not math.isclose(
            frame.requested_timestamp,
            grid_timestamp,
            rel_tol=0.0,
            abs_tol=tolerance,
        ):
            raise FrameTimestampOffGrid(
                f"frame {frame.ordinal} of video import {session.id} is the grid point"
                f" {grid_timestamp}s and its descriptor says"
                f" {frame.requested_timestamp}s"
            )
        if frame.source_timestamp is not None and not (
            frame.source_timestamp <= grid_timestamp
            or math.isclose(
                frame.source_timestamp,
                grid_timestamp,
                rel_tol=0.0,
                abs_tol=tolerance,
            )
        ):
            raise FrameTimestampOffGrid(
                f"frame {frame.ordinal} of video import {session.id} was drawn at"
                f" {frame.source_timestamp}s, after the grid point {grid_timestamp}s it"
                " claims to be"
            )
        name = f"video import {session.id}#frame={frame.ordinal}"
        content = frame.content
        content.seek(0, SEEK_END)
        weight = content.tell()
        ceiling = frame_byte_ceiling(selection)
        if weight > ceiling:
            raise UnsupportedMedia(
                f"a frame of this import may weigh {ceiling} bytes and this one weighs {weight}",
                name=name,
            )
        content.seek(0)
        metadata = self._workspace.image_processor.probe(content, name=name)
        if metadata.format is not VIDEO_FRAME_FORMAT:
            raise UnsupportedMedia(
                f"a video frame must be {VIDEO_FRAME_FORMAT.value}, got {metadata.format.value}",
                name=name,
            )
        stored = (selection.stored_width, selection.stored_height)
        if (metadata.width, metadata.height) != stored:
            raise UnsupportedMedia(
                f"this import stores frames at {stored[0]}x{stored[1]} and this one decodes to"
                f" {metadata.width}x{metadata.height}",
                name=name,
            )
        if (metadata.width, metadata.height) != (frame.width, frame.height):
            raise UnsupportedMedia(
                f"the frame declares {frame.width}x{frame.height} and decodes to"
                f" {metadata.width}x{metadata.height}",
                name=name,
            )
        # The rewind is the caller's job: ``BlobStore.put`` promises nothing
        # about position and ``probe`` has just read to the end, where
        # ``ImageProcessor`` seeks to 0 itself. Without it every frame hashes as
        # the empty stream and a whole clip dedups into one asset.
        content.seek(0)
        return StagedFrame(
            import_id=session.id,
            ordinal=frame.ordinal,
            requested_timestamp=frame.requested_timestamp,
            source_timestamp=frame.source_timestamp,
            content_hash=self._workspace.blob_store.put(content),
            width=metadata.width,
            height=metadata.height,
            image_format=metadata.format,
            thumbnail_hash=self._preview(content, name=name),
        )

    def _preview(self, content: BinaryIO, *, name: str) -> str | None:
        """A thumbnail, or NULL and carry on — ``IngestService._cache_thumbnail``'s rule.

        Rendered at append rather than at commit so the commit transaction is
        metadata only: a thousand encodes inside the one write lock this store
        has is how every other writer ends up waiting out its ``busy_timeout``.
        """
        try:
            rendered = self._workspace.image_processor.thumbnail(content, name=name)
        except MediaError:
            return None
        return self._workspace.blob_store.put(BytesIO(rendered))

    def _destination(
        self, uow: UnitOfWork, session: VideoImport, source: Source, asset_ids: list[UUID]
    ) -> Batch:
        """The batch the frames land in: the draft that was chosen, or a new one.

        ``add_batch_assets`` rather than writing the membership through the
        entity, on ``BatchService.add_assets``' terms: one row per member is what
        keeps this from putting back a membership another writer has changed.
        """
        if session.target_batch_id is None:
            return uow.batches.add(
                Batch(
                    project_id=session.project_id,
                    name=normalize_name(session.batch_name or source.name, what="batch"),
                    asset_ids=asset_ids,
                )
            )
        target = self._batches.require_draft(uow, session.target_batch_id)
        uow.add_batch_assets(target.id, asset_ids)
        return self._batches.require_batch(uow, target.id)

    def _require_open(self, session: VideoImport) -> None:
        if session.state is not VideoImportState.OPEN:
            raise VideoImportNotOpen(
                f"video import {session.id} is {session.state.value}; start a new import"
            )

    def _require_source(self, uow: UnitOfWork, session: VideoImport) -> Source:
        source = uow.sources.get(session.source_id)
        if source is None:
            raise WorkspaceCorrupt(
                f"video import {session.id} names source {session.source_id}, which is not stored"
            )
        return source

    def _committed_batch(self, uow: UnitOfWork, session: VideoImport) -> Batch:
        batch = None if session.batch_id is None else uow.batches.get(session.batch_id)
        if batch is None:
            raise WorkspaceCorrupt(
                f"video import {session.id} is committed and names no batch that is stored"
            )
        return batch

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> Project:
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project
