# usage: from visionset.kernel.services import IngestService
"""Ingest: the one door that turns a registered source into assets.

#18 recorded *where* data comes from. This is what reads it — hashing every
item, storing the bytes once, writing the row that names them, and putting the
result in a draft batch somebody can approve. It is the last write in the kernel
that had no service behind it: until now the only way to make an ``Asset`` was
``examples/sdk_end_to_end.py`` reaching below a service, which this task deletes.

**One ``ingest``, where ``SourceService`` has two ``register_*``.** That split
was made because the arguments genuinely differed — a clip needs a rate and a
probe, a directory needs neither. Here they do not differ at all: the source
already carries its kind, its path and its decomposition rate, so the branch is
on ``SourceKind`` and the caller passes one id. A second entry point would ask
callers to re-state something the source already knows.

**Identity is content; origin is provenance.** Two registered directories
holding the same photograph produce one blob and one asset, and that asset keeps
the origin of the first sighting — the rule ``Source.registered_at`` already
follows. Re-running an ingest therefore creates nothing and is not an error; it
is how a source that grew by three files is caught up.

**The long middle of the run is in no transaction.** Decoding is a Pillow pass
over thousands of files or an out-of-process ffmpeg, and holding a write
transaction open across either is how a single-writer SQLite store starts
reporting "database is locked" (#80). So the run resolves what it needs, closes
the transaction, does the work, and opens another to record it. Blob writes
happen out there too, before any row exists: ``BlobStore.put`` is not
transactional and a rollback cannot unwrite it — but a blob nothing points at is
harmless (content-addressed, shared, never deleted), while a row naming bytes
that were never stored is not.

The progress writes that go on *between* items are not a contradiction: each is
one ``UPDATE`` that opens and commits while nothing is being decoded. What the
warning is about is a transaction held **across** the decode, not the existence
of writes during the phase.

**The job is a state machine, and it is a table.** ``INGEST_TRANSITIONS`` in
``domain/ingest.py`` is the whole of what is legal; this service consults it
through ``require_move`` and never restates it. It has the kernel's only
backward edge, ``failed -> running``, which is :meth:`IngestService.resume`.

**Nothing carries a job across the decode.** ``Repository.update`` replaces the
whole row, so a model read before the work and written after it would silently
undo every counter the run recorded in between. Only ``job_id`` travels; every
write re-reads the row inside its own transaction. That is what
:meth:`require_job` is public for.

**Failure splits by remedy, exactly as the media errors do.** A file that is not
an image, or one whose bytes will not decode, is *reported* — one entry in the
job's ``failures``, and the run carries on, because an operator with five
thousand files needs the other four thousand nine hundred. A missing ffmpeg is
not a file's fault at all; it fails the job outright and is re-raised, which is
precisely why ``MediaToolUnavailable`` sits outside the ``MediaError`` family.

**A preview is a cache, so it fails softly.** Every item also gets a thumbnail,
stored content-addressed beside its content and named by ``Asset.thumbnail_hash``
— the M5 gallery's reason for this task. One that will not render is *not* an
``IngestFailure``: the asset exists and nothing was lost, so the hash stays NULL
and :meth:`backfill_thumbnails` is the remedy. That method is the same
four-transaction discipline applied to a different job — read the ids, render
outside any transaction, write once at the end.

**What is still deliberately not here.** No background execution: a run is
synchronous and in-process, and the API is shaped
so that putting it behind a queue changes the caller's waiting rather than its
vocabulary — which is why a job is created ``pending`` and moved to ``running``
by whoever picks it up, even though today that is the same call.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

from visionset.kernel.domain import (
    INGEST_TRANSITIONS,
    Asset,
    Batch,
    IngestCompleted,
    IngestFailure,
    IngestFailureKind,
    IngestJob,
    IngestResult,
    IngestState,
    Project,
    Source,
    SourceKind,
    ThumbnailBackfill,
    normalize_name,
    require_move,
)
from visionset.kernel.errors import (
    CorruptMedia,
    IngestJobNotFound,
    MediaError,
    ProjectNotFound,
)
from visionset.kernel.ports import FRAME_FORMAT, UnitOfWork
from visionset.kernel.services.batch_service import BatchService
from visionset.kernel.services.source_service import SourceService
from visionset.kernel.services.workspace_service import WorkspaceService


class IngestService:
    """Materialize the sources of one project into assets, and into batches."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._sources = SourceService(workspace)
        self._batches = BatchService(workspace)

    # --- reading -----------------------------------------------------------

    def get(self, job_id: UUID) -> IngestJob:
        """The ingest job with that id, including how far it has got.

        This is the polling contract. ``processed`` / ``total`` and the per-file
        ``failures`` are written while the run is in flight, so calling this
        from another thread, another process or the future HTTP surface reports
        the run's real position rather than its last finished state.

        Raises:
            IngestJobNotFound: no such ingest job in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_job(uow, job_id)

    # --- ingesting ---------------------------------------------------------

    def ingest(
        self,
        source_id: UUID,
        *,
        batch_id: UUID | None = None,
        batch_name: str | None = None,
    ) -> IngestResult:
        """Read the source, store what it holds, and put it all in one batch.

        A directory source is read at its top level, in filename order; anything
        below a subdirectory is not looked at. A video source is decomposed at
        the rate the source itself records, and each frame becomes an asset
        carrying the position it came from.

        The batch is either an existing draft named by ``batch_id`` — checked to
        be editable *before* anything is decoded, because finding out afterwards
        would mean finding out after the work — or one this call creates, named
        ``batch_name`` or, failing that, after the source's own file or folder.
        Its membership is everything this run ingested, the assets that were
        already in the project included: a duplicate is not new data, but it is
        part of what this run was asked to gather.

        ``UnsupportedMedia`` and ``CorruptMedia`` are collected rather than
        raised — see ``IngestResult.failures``, where each keeps the item's name
        and the remedy apart. The same report is written to the job's row as the
        run goes, next to ``processed`` and ``total``, so a caller who did not
        wait for this to return can still read both. See :meth:`get`.

        Raises:
            SourceNotFound: no such source in this workspace.
            BatchNotFound: ``batch_id`` names no batch in this workspace.
            BatchNotEditable: the target batch is past ``draft``.
            InvalidName: ``batch_name`` is blank once stripped.
            FileNotFoundError: the source's path is no longer on disk.
            NotADirectoryError: a directory source's path is now a file.
            WorkspaceCorrupt: a video source carries no provenance.
            MediaToolUnavailable: ffmpeg is not installed on this machine. The
                job records it and is marked failed before it is re-raised — one
                broken machine is not five thousand broken files.
        """
        with self._workspace.unit_of_work() as uow:
            source = self._sources.require_source(uow, source_id)
            self._require_project(uow, source.project_id)
            name = self._target_name(uow, source, batch_id, batch_name)
            # ``pending``, not ``running``: the row exists before anybody picks
            # the work up, which is the vocabulary a queue will need and costs
            # nothing today. Every refusal above happens before the insert, so a
            # run that fails fast leaves no job row at all.
            job = uow.ingest_jobs.add(IngestJob(source_id=source.id, batch_name=name))

        return self._run(job.id, source, name, batch_id)

    def resume(self, job_id: UUID) -> IngestResult:
        """Run a failed job again, on the same row and into the same batch.

        A **redo, not a skip**. There is no per-file record of what the previous
        attempt managed, and there does not need to be: blobs are
        content-addressed and assets are deduplicated by content, so re-reading
        the whole source creates nothing it created before. The cost is
        re-hashing what is already stored; what it buys is that resume has no
        second code path to get it wrong.

        The counters and the per-file report are reset — they describe *this*
        attempt, and a completed run still carrying the last attempt's report
        would be a lie. The fatal ``error`` is cleared for the same reason.

        What may be resumed is whatever ``INGEST_TRANSITIONS`` says can reach
        ``running``: a ``failed`` job, and a ``pending`` one, which a synchronous
        run never leaves behind but a queued one would. A ``completed`` job
        cannot, and neither can one stuck at ``running`` — that is a process that
        died without reporting anything, so ingest the source again instead,
        which creates nothing and leaves the crashed row as the record it is.

        Raises:
            IngestJobNotFound: no such ingest job in this workspace.
            InvalidTransition: the job is ``completed``, or stuck at
                ``running`` — see ``INGEST_TRANSITIONS``.
            SourceNotFound: the source has since been deleted.
            BatchNotEditable: the batch the first attempt reached is past
                ``draft``.
            plus everything :meth:`ingest` raises.
        """
        with self._workspace.unit_of_work() as uow:
            job = self.require_job(uow, job_id)
            source = self._sources.require_source(uow, job.source_id)
            self._require_project(uow, source.project_id)
            # The friendly pre-check, so a completed job is refused before the
            # target batch is resolved. The real one is inside ``_run``, in the
            # transaction that actually moves the row.
            require_move(INGEST_TRANSITIONS, job.state, IngestState.RUNNING, _subject(job.id))
            name = self._target_name(uow, source, job.batch_id, job.batch_name)

        return self._run(job.id, source, name, job.batch_id)

    # --- the thumbnail cache -----------------------------------------------

    def backfill_thumbnails(self, project_id: UUID) -> ThumbnailBackfill:
        """Render a preview for every asset in the project that has none.

        The remedy for the three things a NULL ``thumbnail_hash`` can mean: an
        asset written before the cache existed, one whose preview a run could
        not render, and one an import put there by another route. Idempotent
        and re-runnable — a second pass over a healthy project examines nothing,
        because there is nothing left without a preview.

        **It reads the blob, never ``asset.uri``.** That path is where the bytes
        came from and may be gone, renamed, or on a machine this is not running
        on; ``blob_store.get(asset.content_hash)`` is what the workspace
        actually holds.

        **Three phases, and the rendering is in no transaction** — the module
        docstring's rule, applied to a different job. Only ids and hashes cross
        out of the first transaction, because ``Repository.update`` replaces the
        whole row and a model captured before a slow phase would undo anything
        written during it. The last phase re-reads each asset before writing, so
        an ingest that filled a preview meanwhile is not clobbered by this pass.

        Unlike an ingest there is no progress to poll: a backfill has no
        ``IngestJob`` row and nothing that could carry counters. If that is ever
        wanted it is a task of its own, not a flag on this one.

        Args:
            project_id: the project whose assets to repair.

        Returns:
            What was filled, what has no bytes left to render, and what will not
            render — three lists, because they have three different remedies.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            pending = [
                (asset.id, asset.content_hash, asset.uri)
                for asset in uow.assets.list(project_id)
                if asset.thumbnail_hash is None
            ]

        rendered: dict[UUID, str] = {}
        missing: list[UUID] = []
        unreadable: list[IngestFailure] = []
        for asset_id, content_hash, uri in pending:
            try:
                with self._workspace.blob_store.get(content_hash) as content:
                    thumbnail_hash = self._workspace.blob_store.put(
                        BytesIO(self._workspace.image_processor.thumbnail(content, name=uri))
                    )
            except FileNotFoundError:
                missing.append(asset_id)
            except MediaError as exc:
                unreadable.append(_failure(uri, exc))
            else:
                rendered[asset_id] = thumbnail_hash

        filled: list[UUID] = []
        with self._workspace.unit_of_work() as uow:
            for asset_id, thumbnail_hash in rendered.items():
                asset = uow.assets.get(asset_id)
                if asset is None:
                    continue
                if asset.thumbnail_hash is None:
                    uow.assets.update(asset.model_copy(update={"thumbnail_hash": thumbnail_hash}))
                # Counted as filled either way, because ``filled`` states an
                # outcome rather than a write: an ingest that rendered this one
                # while the pass was decoding leaves it with a preview it did
                # not have when the pass began, which is what the caller asked
                # about. Dropping it would leave the asset in no list at all.
                filled.append(asset_id)

        return ThumbnailBackfill(
            project_id=project_id,
            filled=tuple(filled),
            missing=tuple(missing),
            unreadable=tuple(unreadable),
        )

    # --- the run, phase by phase -------------------------------------------

    def _run(self, job_id: UUID, source: Source, name: str, batch_id: UUID | None) -> IngestResult:
        """The work itself, shared by a first attempt and by a resumed one.

        Takes ``job_id`` rather than an ``IngestJob`` on purpose: the row is
        rewritten many times between here and the end, and a model captured now
        would overwrite all of it — see the module docstring.
        """
        self._begin(job_id)
        try:
            candidates, failures = self._read(source, job_id)
            assets, created = self._store(source.project_id, candidates)
            batch = self._materialize(source.project_id, name, batch_id, assets)
            with self._workspace.unit_of_work() as uow:
                job = self.require_job(uow, job_id)
                require_move(INGEST_TRANSITIONS, job.state, IngestState.COMPLETED, _subject(job_id))
                uow.ingest_jobs.update(
                    job.model_copy(
                        update={"state": IngestState.COMPLETED, "batch_id": batch.id},
                    )
                )
        except Exception as exc:
            self._fail(job_id, str(exc) or exc.__class__.__name__)
            raise

        # After the block, never inside it: a subscriber must not be able to put
        # its own exception on a transaction's way out.
        self._workspace.event_bus.publish(
            IngestCompleted(
                ingest_job_id=job_id,
                project_id=source.project_id,
                source_id=source.id,
                asset_count=len(assets),
            )
        )
        return IngestResult(
            job_id=job_id,
            project_id=source.project_id,
            source_id=source.id,
            batch_id=batch.id,
            assets=tuple(assets),
            created_asset_ids=tuple(created),
            failures=tuple(failures),
        )

    def _begin(self, job_id: UUID) -> None:
        """Take the job from ``pending`` or ``failed`` to ``running``, empty-handed.

        The reset is what makes a resumed run's counters and report describe the
        attempt a caller is watching rather than the one that failed.
        """
        with self._workspace.unit_of_work() as uow:
            job = self.require_job(uow, job_id)
            require_move(INGEST_TRANSITIONS, job.state, IngestState.RUNNING, _subject(job_id))
            uow.ingest_jobs.update(
                job.model_copy(
                    update={
                        "state": IngestState.RUNNING,
                        "error": None,
                        "processed": 0,
                        "total": None,
                        "failures": (),
                    }
                )
            )

    def _read(self, source: Source, job_id: UUID) -> tuple[list[Asset], list[IngestFailure]]:
        """Decode and store every item, outside any transaction.

        Returns candidate assets in the order the source offered them, plus one
        entry per item that could not be read at all.
        """
        if source.kind is SourceKind.VIDEO:
            return self._read_video(source, job_id)
        return self._read_directory(source, job_id)

    def _read_directory(
        self, source: Source, job_id: UUID
    ) -> tuple[list[Asset], list[IngestFailure]]:
        """Every file at the top of the directory, in filename order.

        Top level only. Recursion is not a per-run option but a question about
        what *the source is* — "the same source yields the same assets" — so it
        belongs to a future ``register_images(..., recursive=True)`` rather than
        here, where it would silently change what an already-registered source
        means. Subdirectories are stepped over and recorded nowhere.

        No suffix filter either: a ``notes.txt`` is reported as unsupported
        rather than skipped, because guessing which files an operator meant to
        offer is a policy the kernel would be inventing.

        This is the one path that can state a ``total`` up front, because
        listing a directory is cheap and exact. The write before the loop is
        what publishes it — and what makes an empty directory record ``0 of 0``
        rather than nothing at all.
        """
        candidates: list[Asset] = []
        failures: list[IngestFailure] = []
        directory = Path(source.path)
        paths = sorted(item for item in directory.iterdir() if item.is_file())
        total = len(paths)
        self._record_progress(job_id, processed=0, total=total, failures=failures)
        for path in paths:
            try:
                with path.open("rb") as handle:
                    # Probe first: a file that is going to be refused should
                    # never leave a blob behind. The ``seek(0)`` between is not
                    # decoration — ``ImageProcessor`` promises to seek to 0 and
                    # not to close, and ``BlobStore.put`` promises neither, so
                    # rewinding for it is the caller's job.
                    metadata = self._workspace.image_processor.probe(handle, name=str(path))
                    handle.seek(0)
                    content_hash = self._workspace.blob_store.put(handle)
                    # No rewind before this one, and the asymmetry is the port
                    # contract rather than an oversight: ``ImageProcessor``
                    # promises to seek to 0 itself, which is exactly what lets
                    # one open handle serve a probe, a hash and a thumbnail in
                    # any order. ``BlobStore.put`` promises nothing, which is
                    # why the rewind above is still the caller's job.
                    thumbnail_hash = self._cache_thumbnail(handle, name=str(path))
            except MediaError as exc:
                failures.append(_failure(str(path), exc))
            else:
                candidates.append(
                    Asset(
                        project_id=source.project_id,
                        content_hash=content_hash,
                        uri=str(path),
                        width=metadata.width,
                        height=metadata.height,
                        format=metadata.format,
                        source_id=source.id,
                        thumbnail_hash=thumbnail_hash,
                    )
                )
            # After every item, read or refused alike: ``processed`` counts what
            # the run has dealt with, and a report that only appeared at the end
            # would be invisible for exactly as long as it is interesting.
            self._record_progress(
                job_id,
                processed=len(candidates) + len(failures),
                total=total,
                failures=failures,
            )
        return candidates, failures

    def _read_video(self, source: Source, job_id: UUID) -> tuple[list[Asset], list[IngestFailure]]:
        """One asset per extracted frame, at the rate the source records.

        The frames are **not** re-probed. ``VideoProcessor`` guarantees each one
        is a complete image in ``FRAME_FORMAT`` at the dimensions ``probe``
        reported, and that guarantee is asserted where it belongs, in the port's
        own tests. Decoding every frame a second time to re-confirm it would
        also mean putting our own encoder's output into an operator's per-file
        report — a failure nobody could act on.

        They *are* thumbnailed, and that is not a contradiction of the paragraph
        above. What must not be re-derived is anything an operator reads back as
        a fact about their clip; a preview is a cache artifact reported to
        nobody, and a gallery showing tiles for stills and blanks for frames
        would be the worse outcome for the sake of a rule about metadata. It is
        this path's only use of ``ImageProcessor``.

        Damage arrives once and terminally: ffmpeg yields the frames it managed
        and *then* says the bytes ran out, so the refusal is caught around the
        loop and what was extracted is kept. The loop is left by falling out of
        it, which is one of the two ways the port allows an iterator to be
        released.

        ``total`` stays NULL for the whole run, and honestly so. ``VideoMetadata``
        carries no frame count by design — it would be a guess for a
        variable-rate clip and the number an ingest wants is what extraction
        actually produced — so a total here would be arithmetic presented as
        fact. ``processed`` still climbs, which is what a poller needs.
        """
        provenance = source.require_video()
        candidates: list[Asset] = []
        failures: list[IngestFailure] = []
        clip = Path(source.path)
        frames = self._workspace.video_processor.frames(
            clip, fps=provenance.extraction_fps, name=clip.name
        )
        self._record_progress(job_id, processed=0, total=None, failures=failures)
        try:
            for frame in frames:
                uri = f"{source.path}#frame={frame.index}"
                # One buffer serves both. ``put`` leaves it at the end and
                # ``thumbnail`` seeks back to 0 itself, which is the same port
                # contract the directory path leans on.
                content = BytesIO(frame.content)
                content_hash = self._workspace.blob_store.put(content)
                candidates.append(
                    Asset(
                        project_id=source.project_id,
                        content_hash=content_hash,
                        uri=uri,
                        width=provenance.metadata.width,
                        height=provenance.metadata.height,
                        format=FRAME_FORMAT,
                        source_id=source.id,
                        frame_index=frame.index,
                        frame_timestamp=frame.timestamp,
                        thumbnail_hash=self._cache_thumbnail(content, name=uri),
                    )
                )
                self._record_progress(
                    job_id, processed=len(candidates), total=None, failures=failures
                )
        except MediaError as exc:
            failures.append(_failure(source.path, exc))
            self._record_progress(job_id, processed=len(candidates), total=None, failures=failures)
        return candidates, failures

    def _cache_thumbnail(self, content: BinaryIO, *, name: str) -> str | None:
        """Render a preview and store it, or hand back NULL and carry on.

        Best effort by design, and the ``try`` is *inside* the caller's rather
        than around it. A preview that will not render is not an
        ``IngestFailure``: that error means "this file did not become an asset,
        so go and fix the file", and here the asset exists, its bytes are
        stored and nothing was lost. Letting the refusal reach
        ``_read_directory``'s ``except MediaError`` would report a perfectly
        good file as unreadable *and* leave behind the orphan blob that probing
        first exists to prevent — a bug that would look like the feature
        working.

        The NULL is the record, which is why nothing is logged here. It is
        exactly the state :meth:`backfill_thumbnails` queries for, so a failure
        describes its own remedy and a later pass repairs it.

        ``max_edge`` is not a parameter, here or anywhere. The port pins one
        size; a per-call edge would fork the cache into variants that nothing
        can tell apart from a hash, and the column holds one pointer.
        """
        try:
            rendered = self._workspace.image_processor.thumbnail(content, name=name)
        except MediaError:
            return None
        return self._workspace.blob_store.put(BytesIO(rendered))

    def _store(self, project_id: UUID, candidates: list[Asset]) -> tuple[list[Asset], list[UUID]]:
        """Write the rows, reusing whatever content the project already holds.

        The project's assets are read once, into a map keyed by content hash,
        rather than queried per item — ``Repository`` has one query shape, and a
        service never builds SQL. The whole-project read is affordable at this
        scale and the fix when it stops being is a port method, not an import.

        The map is updated as the run proceeds, so two identical files inside one
        directory become one asset rather than a pair the new unique index would
        refuse at commit.

        A deduplicated candidate is otherwise discarded whole — its origin is
        the *second* sighting and is never written — with one exception, and the
        exception is precise. ``thumbnail_hash`` is not provenance but a cache,
        so filling a NULL from a candidate that has one is not a rewrite; it is
        the cache being populated by whoever first held the bytes. That is what
        makes re-ingesting a source enough to give assets written before the
        cache existed their previews. A value already there is **never**
        replaced: a second encode yields the same blob on this machine and a
        different one on another, so the swap would cost a write and buy
        nothing.
        """
        assets: list[Asset] = []
        created: list[UUID] = []
        seen: set[UUID] = set()
        with self._workspace.unit_of_work() as uow:
            known = {asset.content_hash: asset for asset in uow.assets.list(project_id)}
            for candidate in candidates:
                stored = known.get(candidate.content_hash)
                if stored is None:
                    stored = uow.assets.add(candidate)
                    known[stored.content_hash] = stored
                    created.append(stored.id)
                elif stored.thumbnail_hash is None and candidate.thumbnail_hash is not None:
                    stored = uow.assets.update(
                        stored.model_copy(update={"thumbnail_hash": candidate.thumbnail_hash})
                    )
                    known[stored.content_hash] = stored
                if stored.id not in seen:
                    seen.add(stored.id)
                    assets.append(stored)
        return assets, created

    def _materialize(
        self, project_id: UUID, name: str, batch_id: UUID | None, assets: list[Asset]
    ) -> Batch:
        """Put the run's assets in their batch, through the service that owns it.

        After the rows and not before, so a run that dies during the decode
        leaves no empty draft batch behind and its job's ``batch_id`` stays NULL
        — which is what that column being nullable actually means.
        """
        asset_ids = [asset.id for asset in assets]
        if batch_id is None:
            return self._batches.create(project_id, name, asset_ids)
        return self._batches.add_assets(batch_id, asset_ids)

    def _record_progress(
        self, job_id: UUID, *, processed: int, total: int | None, failures: list[IngestFailure]
    ) -> None:
        """Publish how far the run has got, in one ``UPDATE`` of its own.

        Called after **every** item rather than on a cadence. The number a
        caller polls is then never stale by an amount nobody can predict, and
        there is no interval constant to pick — one that fits a directory of
        five files and one that fits a directory of fifty thousand are not the
        same number, and this service cannot know which it is looking at. The
        cost is one small commit beside a decode-and-hash that costs an order of
        magnitude more.

        Re-reads the row rather than updating a copy held by the caller:
        ``Repository.update`` replaces the whole row, so a stale model would
        undo everything written since it was read.

        A run whose job row has been deleted underneath it keeps going and
        reports to nobody, the way ``_fail`` already tolerates the same thing —
        losing the work over a missing receipt would be the worse answer.
        """
        with self._workspace.unit_of_work() as uow:
            job = uow.ingest_jobs.get(job_id)
            if job is None:
                return
            uow.ingest_jobs.update(
                job.model_copy(
                    update={
                        "processed": processed,
                        "total": total,
                        "failures": tuple(failures),
                    }
                )
            )

    def _fail(self, job_id: UUID, cause: str) -> None:
        """Record why a run stopped, on its own row and in its own transaction.

        The counters and the report the run got as far as writing are left
        exactly where they are: they say how far it had come when it stopped,
        which is the first thing anyone looking at a failure wants.
        """
        with self._workspace.unit_of_work() as uow:
            job = uow.ingest_jobs.get(job_id)
            if job is None:
                return
            require_move(INGEST_TRANSITIONS, job.state, IngestState.FAILED, _subject(job_id))
            uow.ingest_jobs.update(
                job.model_copy(update={"state": IngestState.FAILED, "error": cause})
            )

    # --- lookups shared by the operations above ----------------------------

    def require_job(self, uow: UnitOfWork, job_id: UUID) -> IngestJob:
        """The job, checked through its source so workspaces stay separate.

        Public, and taking a ``uow``, for the reason
        ``SourceService.require_source`` is: #19 has to resolve a job inside its
        own transaction before it writes progress against it, and a second
        spelling of this ladder is a second place for it to be got wrong.

        Raises:
            IngestJobNotFound: no such ingest job in this workspace.
        """
        job = uow.ingest_jobs.get(job_id)
        if job is not None:
            source = uow.sources.get(job.source_id)
            if source is not None:
                project = uow.projects.get(source.project_id)
                if project is not None and project.workspace_id == self._workspace.workspace_id:
                    return job
        raise IngestJobNotFound(
            f"no ingest job {job_id} in workspace {self._workspace.workspace.name!r}"
        )

    def _target_name(
        self, uow: UnitOfWork, source: Source, batch_id: UUID | None, batch_name: str | None
    ) -> str:
        """The name a created batch would take, and the gate on an existing one.

        Both refusals belong here, before the decode: a blank name and a frozen
        batch are things a caller can fix, and finding either out after five
        thousand files have been hashed helps nobody.
        """
        if batch_id is not None:
            batch = self._batches.require_draft(uow, batch_id)
            self._require_project(uow, batch.project_id)
            return batch.name
        return normalize_name(batch_name or Path(source.path).name, what="batch")

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> Project:
        """The project, or refuse because this workspace does not have it."""
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project

    # ``list`` shadows the builtin for every annotation after it in a class
    # body, so it is declared last. See ``BatchService`` for the precedent.

    def list(self, source_id: UUID) -> list[IngestJob]:
        """Every run of that source, in the order they started.

        Parented on the source rather than on the project, because that is the
        one query shape ``Repository`` has and ``ingest_job.source_id`` is what
        the row hangs from. A project's runs are reached through its sources.

        Raises:
            SourceNotFound: no such source in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            source = self._sources.require_source(uow, source_id)
            return uow.ingest_jobs.list(source.id)


def _subject(job_id: UUID) -> str:
    """How a refused move names the run. One spelling, so refusals read alike."""
    return f"ingest job {job_id}"


def _failure(name: str, exc: MediaError) -> IngestFailure:
    """One report line, with the item's name kept apart from the remedy.

    The name comes from the loop's own item and never from ``exc.name``:
    ``MediaError`` documents its own as reporting rather than identity, and the
    caller here already knows exactly what it was reading.

    The two branches are the whole family — ``UnsupportedMedia`` is "intact and
    not for us", ``CorruptMedia`` is "for us and broken" — and a third member
    would have to say which of those a report should file it under.
    """
    kind = (
        IngestFailureKind.CORRUPT
        if isinstance(exc, CorruptMedia)
        else IngestFailureKind.UNSUPPORTED
    )
    return IngestFailure(name=name, kind=kind, reason=exc.reason)
