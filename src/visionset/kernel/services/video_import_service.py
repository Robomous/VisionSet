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
upload that stalled — every one of them leaves the project exactly as it was.
``commit`` is the single moment that changes, and it is one transaction.

What *is* reused is everything below the session: content hashing and
``BlobStore``, the project-scoped dedup rule (``store_assets``, shared with
ingest), thumbnails as a best-effort cache, and ``BatchService``'s draft batch as
the destination. A frame is an ordinary image asset by the time it lands; the
only thing that makes it a video frame is the ``VIDEO`` source it points at.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from io import BytesIO
from typing import TYPE_CHECKING
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
    FrameContentConflict,
    FrameOrdinalOutOfRange,
    MediaError,
    ProjectNotFound,
    UnsupportedMedia,
    VideoImportIncomplete,
    VideoImportNotFound,
    VideoImportNotOpen,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.batch_service import BatchService
from visionset.kernel.services.ingest_service import store_assets

if TYPE_CHECKING:
    from visionset.kernel.services.workspace_service import WorkspaceService


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

        Raises:
            ProjectNotFound: no such project in this workspace.
            BatchNotFound: ``batch_id`` names no batch of this project.
            BatchNotEditable: the target batch is past ``draft``.
            InvalidName: ``display_name``, or a provided ``batch_name``, is
                blank once stripped.
            ValueError: the declared metadata or cut parameters are not usable —
                a non-positive rate, a scale outside 1-100, or a selection that
                holds no grid point at all.
        """
        provenance = VideoProvenance(
            metadata=metadata,
            extraction_fps=extraction_fps,
            ranges=canonical_ranges(ranges, duration_seconds=metadata.duration_seconds),
            scale_percent=scale_percent,
            policy_version=SAMPLING_POLICY_VERSION,
            materializer=materializer,
        )
        expected = expected_frames(
            provenance.ranges,
            duration_seconds=metadata.duration_seconds,
            fps=provenance.extraction_fps,
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

        Raises:
            VideoImportNotFound: no such session in this workspace.
            VideoImportNotOpen: the session was already committed or aborted.
            FrameOrdinalOutOfRange: an ordinal is not a grid index the session's
                selection holds.
            FrameContentConflict: an ordinal already holds different bytes.
            UnsupportedMedia: a frame is not PNG, or is not the size it declared.
            CorruptMedia: a frame is a PNG whose bytes will not decode.
        """
        with self._workspace.unit_of_work() as uow:
            session = self.require_import(uow, import_id)
            self._require_open(session)
            selection = self._require_source(uow, session).require_video()
        staged = [self._stage(session, selection, frame) for frame in frames]
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
            session.state = VideoImportState.COMMITTED
            session.batch_id = batch.id
            session.updated_at = now
            uow.video_imports.update(session)
            return batch

    def abort(self, import_id: UUID) -> VideoImport:
        """Throw the session away: no assets, no batch, nothing left in the project.

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
        """
        if not selection.selects(frame.ordinal):
            raise FrameOrdinalOutOfRange(
                f"frame {frame.ordinal} is not on the grid video import {session.id} selected"
            )
        name = f"video import {session.id}#frame={frame.ordinal}"
        content = BytesIO(frame.content)
        metadata = self._workspace.image_processor.probe(content, name=name)
        if metadata.format is not VIDEO_FRAME_FORMAT:
            raise UnsupportedMedia(
                f"a video frame must be {VIDEO_FRAME_FORMAT.value}, got {metadata.format.value}",
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

    def _preview(self, content: BytesIO, *, name: str) -> str | None:
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
