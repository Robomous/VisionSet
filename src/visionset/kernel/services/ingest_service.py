# usage: from visionset.kernel.services import IngestService
"""Ingest: the one door that turns a registered source into assets.

``SourceService`` records *where* data comes from. This is what reads it —
hashing every item, storing the bytes once, writing the row that names them, and
putting the result in a draft batch somebody can approve. Nothing else in the
kernel may create an ``Asset``.

**This service does not know what a video is.** It reads an origin *this
process can open*, which is a directory of stills and nothing else. A clip never
reaches the server at all — a client decodes it locally and posts frames — so
that work is ``VideoImportService``, a use case of its own shape rather than a
branch in here. A ``VIDEO`` source is a receipt for frames somebody else
materialized; pointed at one, this service has nothing to read.

**Identity is content; origin is provenance.** Two registered directories
holding the same photograph produce one blob and one asset, and that asset keeps
the origin of the first sighting — the rule ``Source.registered_at`` already
follows. Re-running an ingest therefore creates nothing and is not an error; it
is how a source that grew by three files is caught up.

**The long middle of the run is in no transaction.** Decoding is a Pillow pass
over thousands of files, and holding a write transaction open across it is how a
single-writer SQLite store starts making every other writer wait out its
``busy_timeout`` and fail with ``WorkspaceBusy``.
So the run resolves what it needs, closes
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
thousand files needs the other four thousand nine hundred. Anything that is
wrong with the *machine* rather than with a file fails the job outright and is
re-raised: one broken machine is not five thousand broken files, and that is the
line ``MediaError`` draws.

**A preview is a cache, so it fails softly.** Every item also gets a thumbnail,
stored content-addressed beside its content and named by ``Asset.thumbnail_hash``
— the M5 gallery's reason for this task. One that will not render is *not* an
``IngestFailure``: the asset exists and nothing was lost, so the hash stays NULL
and :meth:`backfill_thumbnails` is the remedy. That method is the same
four-transaction discipline applied to a different job — read the ids, render
outside any transaction, write once at the end.

**Asking for a run and doing it are two calls.** ``enqueue`` refuses everything
refusable and returns a ``pending`` job; ``resume`` picks that job up and does
the work; ``ingest`` is the two composed, for a caller that can wait. The split
is what the ``pending`` state was reserved for from the start, and it is what
lets the HTTP surface hand back a job id before the first byte is read. **What
is still not here is a scheduler**: nothing in this module decides *when* the
second half runs, and a caller that wants it off the calling thread supplies
that itself.
"""

from __future__ import annotations

from datetime import UTC, datetime
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
    report_name,
    require_move,
)
from visionset.kernel.errors import (
    AssetNotFound,
    CorruptMedia,
    IngestJobNotFound,
    MediaError,
    ProjectNotFound,
    ThumbnailNotCached,
    UnsupportedMedia,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import BlobStore, UnitOfWork
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

    def asset(self, project_id: UUID, asset_id: UUID) -> Asset:
        """One asset of that project.

        The read side of "one door to an ``Asset``": the service that writes them
        is where a caller holding an id comes to look one up, rather than each
        surface opening a unit of work of its own.

        An asset belonging to a different project reads as missing, not as
        forbidden — the rule every cross-scope reference in the kernel follows.
        The project is resolved first so an unknown project is ``ProjectNotFound``
        rather than a puzzling ``AssetNotFound``.

        Raises:
            ProjectNotFound: no such project in this workspace.
            AssetNotFound: no such asset in that project.
        """
        with self._workspace.unit_of_work() as uow:
            project = self._require_project(uow, project_id)
            asset = uow.assets.get(asset_id)
            if asset is None or asset.project_id != project.id:
                raise AssetNotFound(f"no asset {asset_id} in project {project.name!r}")
            return asset

    def assets(self, project_id: UUID) -> list[Asset]:
        """Every asset of that project, most recently ingested first.

        The collection side of "one door to an ``Asset``". The other asset
        listings on the wire are per *batch* and per *dataset* — one window onto a
        work unit, one onto the curated trunk — and neither answers "show me this
        project", which is what a project page asks.

        **Recency first, and it is stable within a run.** The sort reads
        ``Asset.ingested_at``; a whole ingest shares one timestamp, so within a
        run it falls through to ``_in_stable_order``, which is the order that
        actually means something:

        1. ``source_id``, so one clip's frames stay together rather than
           interleaving with a directory's stills;
        2. the **base uri** — the path with any ``#frame=`` fragment cut off —
           which for a directory ingest is the filename, and a directory is
           walked sorted, so files come back in the order somebody sees them in
           their own file browser, each with its own frames beside it;
        3. ``frame_index``, so frames come out **in order** within their file —
           the one place a sequence genuinely exists. Lexicographic ``uri``
           would not do it: a frame's uri is ``{path}#frame={n}``, and that
           sorts ``#frame=10`` before ``#frame=2``;
        4. ``id``, so the order is total and two calls can never disagree.

        **An asset with no arrival sorts last, never first.** ``_store`` stamps
        every asset it writes, so NULL is unreachable through the one door — but
        the field permits it, and the alternative readings would both be wrong
        if it ever appeared: treating it as the epoch is a fabricated date,
        and treating it as *now* would pin the oldest rows in the product to the
        top of a "recent" list forever. Last is the one answer that degrades
        quietly — a project that never ingested since the upgrade looks exactly
        as it did before, in ``_in_stable_order``.

        Sorted in two passes rather than by one composite key, because
        "descending by a value that may be missing" has no honest spelling as a
        tuple: negating a datetime is not defined, and every sentinel that makes
        it sortable is a date nobody chose. Both passes are stable, so the
        tiebreak survives.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            project = self._require_project(uow, project_id)
            stored = sorted(uow.assets.list(project.id), key=_in_stable_order)
        # Pair each asset with its arrival so the sort key is a plain datetime
        # and mypy never has to be told the ``None`` was filtered out.
        arrived = [(asset.ingested_at, asset) for asset in stored if asset.ingested_at is not None]
        arrived.sort(key=lambda pair: pair[0], reverse=True)
        unknown = [asset for asset in stored if asset.ingested_at is None]
        return [asset for _, asset in arrived] + unknown

    def open_content(self, asset: Asset) -> BinaryIO:
        """The asset's own bytes, as a handle the caller reads and closes.

        A handle rather than the bytes, so a fifty-megapixel frame does not have
        to sit in memory to be served. ``BlobStore.get`` streams; anything here
        that called ``read()`` would undo that in one line.

        A recorded ``content_hash`` with no blob behind it is ``WorkspaceCorrupt``
        and not a missing entity: content is written before the row that names it
        and blobs are never deleted, so this is a guarantee failing. Translating
        it is the point of the method — a bare ``FileNotFoundError`` is outside
        the ``VisionSetError`` tree and would surface as an unexplained 500.

        Raises:
            WorkspaceCorrupt: the blob this asset names is gone.
        """
        return _open_blob(self._workspace.blob_store, asset.content_hash, f"asset {asset.id}")

    def open_thumbnail(self, asset: Asset) -> BinaryIO:
        """The asset's cached preview, in ``THUMBNAIL_FORMAT``.

        Refuses rather than rendering one on demand. A thumbnail is a cache and
        this is a read; making a reader pay for an encode would put a decode on
        whatever path happens to ask first, and ``backfill_thumbnails`` already
        exists to fill the gap deliberately.

        Raises:
            ThumbnailNotCached: no preview has been rendered for this asset.
            WorkspaceCorrupt: the blob the preview names is gone.
        """
        if asset.thumbnail_hash is None:
            raise ThumbnailNotCached(
                f"asset {asset.id} has no cached preview; run backfill_thumbnails on its project"
            )
        return _open_blob(
            self._workspace.blob_store, asset.thumbnail_hash, f"thumbnail of asset {asset.id}"
        )

    # --- ingesting ---------------------------------------------------------

    def enqueue(
        self,
        source_id: UUID,
        *,
        batch_id: UUID | None = None,
        batch_name: str | None = None,
    ) -> IngestJob:
        """Record that a run was asked for, and refuse it now if it cannot happen.

        Everything :meth:`ingest` can refuse before reading a byte is refused
        here — an unknown source, a project this workspace does not have, a
        frozen target batch, a blank name — so a run that fails fast leaves **no
        job row at all** and a caller that got a row got one it can poll.

        What comes back is ``pending``. Whoever picks the work up moves it to
        ``running``, which today is :meth:`resume`; that vocabulary was written
        into ``INGEST_TRANSITIONS`` from the start for a queue that did not exist
        yet, and this is the half of it that was missing. A caller wanting the
        whole run in one call still uses :meth:`ingest`.

        ``batch_id`` is stored on the row rather than held by the caller,
        because between here and the run there is no caller to hold it: the row
        is the only thing that crosses. :meth:`resume` already reads it as "the
        batch this attempt was headed for".

        **Only a directory of images is run here.** A run opens the source's
        locator, and ``Source.locator`` promises openability for
        ``IMAGE_DIRECTORY`` alone — a clip's is the opaque ``video-import:<uuid>``
        this process has nothing to do with, because its frames are materialized
        by a client and posted to ``VideoImportService``. Accepting one produced a
        ``202`` and then a run that died on a ``FileNotFoundError`` nobody asked
        for, so the family is refused here, before a row exists.

        Raises:
            SourceNotFound: no such source in this workspace.
            UnsupportedMedia: the source is not a directory of images, so this
                process cannot read it at all.
            BatchNotFound: ``batch_id`` names no batch in this workspace.
            BatchNotEditable: the target batch is past ``draft``.
            InvalidName: ``batch_name`` is blank once stripped.
        """
        with self._workspace.unit_of_work() as uow:
            source = self._sources.require_source(uow, source_id)
            if source.kind is not SourceKind.IMAGE_DIRECTORY:
                raise UnsupportedMedia(
                    f"a {source.kind.value} source is not read by this server; a clip's"
                    " frames are decoded by a client and posted to a video import",
                    name=source.name,
                )
            self._require_project(uow, source.project_id)
            name = self._target_name(uow, source, batch_id, batch_name)
            return uow.ingest_jobs.add(
                IngestJob(source_id=source.id, batch_id=batch_id, batch_name=name)
            )

    def ingest(
        self,
        source_id: UUID,
        *,
        batch_id: UUID | None = None,
        batch_name: str | None = None,
    ) -> IngestResult:
        """Read the source, store what it holds, and put it all in one batch.

        A directory source is read at its top level, in filename order; anything
        below a subdirectory is not looked at.

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
        """
        # Enqueue then pick it straight back up. The two halves are spelled
        # separately because a caller that cannot wait — the HTTP surface, a
        # queue — needs the row before the work, and one composed call is how
        # this one keeps having no second code path to get wrong.
        job = self.enqueue(source_id, batch_id=batch_id, batch_name=batch_name)
        return self.resume(job.id)

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
        ``running``: a ``failed`` job, and a ``pending`` one — which is what
        :meth:`enqueue` leaves, so this is also how a run is *started* by
        whoever picked it up. A ``completed`` job
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
            job, source = self._resolve_for_run(uow, job_id)
            name = self._target_name(uow, source, job.batch_id, job.batch_name)

        return self._run(job.id, source, name, job.batch_id)

    def resumable(self, job_id: UUID) -> IngestJob:
        """The job, if :meth:`resume` would take it — otherwise refuse now.

        The same refusals :meth:`resume` makes before it reads anything, without
        the reading. A caller that runs the work somewhere else needs them
        *here*, on the calling thread: a launch that answered "accepted" and then
        discovered in a worker that the job was already ``completed`` would give
        a client no way to tell a redo from a no-op.

        It does not move the row. What it reports is that the move is legal at
        this moment; ``_begin`` inside the run is still the one that makes it.

        Raises:
            IngestJobNotFound: no such ingest job in this workspace.
            InvalidTransition: the job is ``completed``, or stuck at ``running``.
            SourceNotFound: the source has since been deleted.
        """
        with self._workspace.unit_of_work() as uow:
            job, _ = self._resolve_for_run(uow, job_id)
            return job

    def _resolve_for_run(self, uow: UnitOfWork, job_id: UUID) -> tuple[IngestJob, Source]:
        """The job and its source, once this workspace agrees it may run again.

        One spelling of the friendly pre-check, shared by the method that does
        the work and the one that only asks. The *real* check is inside ``_run``,
        in the transaction that actually moves the row — this one exists so a
        refusal arrives before a target batch is resolved or a file is opened.
        """
        job = self.require_job(uow, job_id)
        source = self._sources.require_source(uow, job.source_id)
        self._require_project(uow, source.project_id)
        require_move(INGEST_TRANSITIONS, job.state, IngestState.RUNNING, _subject(job.id))
        return job, source

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
                # ``Asset.uri`` is unpublished for the same reason ``Source.locator``
                # is, and this report travels: no root is in hand here, so the
                # basename is the answer — which keeps a frame's ``#frame=n``,
                # the only part of that string a reader can act on.
                unreadable.append(_failure(report_name(uri), exc))
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
        """Every file at the top of the source's directory, in filename order.

        Returns candidate assets in the order the source offered them, plus one
        entry per item that could not be read at all. Outside any transaction.

        Top level only. Recursion is not a per-run option but a question about
        what *the source is* — "the same source yields the same assets" — so it
        belongs to a future ``register_images(..., recursive=True)`` rather than
        here, where it would silently change what an already-registered source
        means. Subdirectories are stepped over and recorded nowhere.

        No suffix filter either: a ``notes.txt`` is reported as unsupported
        rather than skipped, because guessing which files an operator meant to
        offer is a policy the kernel would be inventing.

        A ``total`` is stated up front, because listing a directory is cheap and
        exact. The write before the loop is what publishes it — and what makes an
        empty directory record ``0 of 0`` rather than nothing at all.
        """
        candidates: list[Asset] = []
        failures: list[IngestFailure] = []
        directory = Path(source.locator)
        paths = sorted(item for item in directory.iterdir() if item.is_file())
        total = len(paths)
        self._record_progress(job_id, processed=0, total=total, failures=failures)
        for files_dealt_with, path in enumerate(paths, start=1):
            try:
                with path.open("rb") as handle:
                    # A file that is going to be refused never leaves a blob
                    # behind: ``stills`` has decoded the whole file — every
                    # frame of an animation included — before it yields its
                    # first item, so a refusal arrives before anything below
                    # stores a byte.
                    for still in self._workspace.image_processor.stills(handle, name=str(path)):
                        uri = (
                            str(path)
                            if still.frame_index is None
                            else f"{path}#frame={still.frame_index}"
                        )
                        if still.payload is None:
                            # The rewind is the caller's job: ``BlobStore.put``
                            # promises nothing about position, where
                            # ``ImageProcessor`` seeks to 0 itself — which is
                            # what lets one handle serve both calls.
                            handle.seek(0)
                            content_hash = self._workspace.blob_store.put(handle)
                            thumbnail_hash = self._cache_thumbnail(handle, name=uri)
                        else:
                            content = BytesIO(still.payload)
                            content_hash = self._workspace.blob_store.put(content)
                            thumbnail_hash = self._cache_thumbnail(content, name=uri)
                        candidates.append(
                            Asset(
                                project_id=source.project_id,
                                content_hash=content_hash,
                                uri=uri,
                                width=still.metadata.width,
                                height=still.metadata.height,
                                format=still.metadata.format,
                                source_id=source.id,
                                frame_index=still.frame_index,
                                frame_timestamp=still.frame_timestamp,
                                thumbnail_hash=thumbnail_hash,
                            )
                        )
            except MediaError as exc:
                # Relative to the directory being read, never the absolute path
                # the loop is holding — see ``report_name``. The walk is top
                # level today, so the two differ only for a root a future
                # ``recursive=True`` would introduce; the rule is applied here
                # rather than left for that task to remember.
                failures.append(_failure(report_name(path, root=directory), exc))
            # After every file, read or refused alike: ``processed`` counts the
            # files the run has dealt with — not the assets they became, which
            # a decomposed animation would inflate past ``total`` — and a
            # report that only appeared at the end would be invisible for
            # exactly as long as it is interesting.
            self._record_progress(
                job_id,
                processed=files_dealt_with,
                total=total,
                failures=failures,
            )
        return candidates, failures

    def _cache_thumbnail(self, content: BinaryIO, *, name: str) -> str | None:
        """Render a preview and store it, or hand back NULL and carry on.

        Best effort by design, and the ``try`` is *inside* the caller's rather
        than around it. A preview that will not render is not an
        ``IngestFailure``: that error means "this file did not become an asset,
        so go and fix the file", and here the asset exists, its bytes are
        stored and nothing was lost. Letting the refusal reach
        ``_read``'s ``except MediaError`` would report a perfectly
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
        """A transaction of this run's own, around the shared dedup rule.

        The rule itself is ``store_assets`` below, which the video-import commit
        shares. What is this method's own is the scope: an ingest run has already
        decoded and hashed everything by the time it gets here, so opening the
        transaction at the last possible moment is what keeps a single-writer
        store from waiting out a decode.
        """
        with self._workspace.unit_of_work() as uow:
            return store_assets(uow, project_id, candidates, stamped_at=datetime.now(UTC))

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
        # The batch, not the change: an ingest reports the assets *it* gathered
        # through `IngestResult`, and a second, narrower count of what membership
        # happened to gain would be a different number for the same run.
        return self._batches.add_assets(batch_id, asset_ids).batch

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
        ``SourceService.require_source`` is: a run has to resolve a job inside its
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

        ``Source.name`` rather than a third derivation off the locator. The domain
        already resolves "what to call this source" once — the stated display name
        else the locator's last segment — and both wire projections publish that
        one answer. Re-deriving it here published the locator's tail under another
        name, which for an upload is a 64-character digest and for a clip is the
        opaque ``video-import:<uuid>`` no caller was ever meant to see.
        """
        if batch_id is not None:
            batch = self._batches.require_draft(uow, batch_id)
            self._require_project(uow, batch.project_id)
            return batch.name
        return normalize_name(batch_name or source.name, what="batch")

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


def _in_stable_order(asset: Asset) -> tuple[str, str, int, str]:
    """The sort key :meth:`IngestService.assets` documents.

    Module level rather than a lambda so the reasoning has somewhere to live and
    a test can exercise it against assets alone.

    The base uri — the path with any ``#frame=`` fragment cut off — groups a
    file with its own frames, because a directory source can hold stills *and*
    a decomposed animation at once. Within the group, ``frame_index`` orders
    numerically (``#frame=10`` sorts after ``#frame=2``, which text would not),
    with ``-1`` standing in for a still's NULL because ``None`` cannot be
    compared with an ``int``. A path and its fragments never collide: the
    fragment exists precisely because the file itself did not become an asset.
    """
    return (
        str(asset.source_id or ""),
        asset.uri.partition("#frame=")[0],
        -1 if asset.frame_index is None else asset.frame_index,
        str(asset.id),
    )


def store_assets(
    uow: UnitOfWork,
    project_id: UUID,
    candidates: list[Asset],
    *,
    stamped_at: datetime,
) -> tuple[list[Asset], list[UUID]]:
    """Write the rows, reusing whatever content the project already holds.

    Module level and taking a ``uow``, because there are two callers and they
    need different transaction scopes: an ingest run gives this a transaction of
    its own, while a video import commits assets, a batch and the session's own
    state together and cannot afford a second one. Both need the *same* dedup
    rule, and two spellings of it is two places for it to be got wrong.

    The project's assets are read once, into a map keyed by content hash,
    rather than queried per item — ``Repository`` has one query shape, and a
    service never builds SQL. The whole-project read is affordable at this
    scale and the fix when it stops being is a port method, not an import.

    The map is updated as the run proceeds, so two identical files inside one
    directory — or two grid positions of one clip that drew the same frame —
    become one asset rather than a pair the unique index would refuse at commit.

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

    ``stamped_at`` is written into ``ingested_at``, and this is the only place in
    the product that writes it. Here rather than where the candidates are built,
    because the column means "when the row was first written" and this is
    that moment — which is also what makes the dedup branch correct without
    saying anything: a deduplicated candidate never reaches ``add``, so the
    stored arrival goes on naming the run that created it.

    One timestamp for the whole run, passed in rather than read here, so a
    thousand stills differing by microseconds cannot present false precision —
    and it leaves the ordering *within* a run to ``_in_stable_order``, which has
    actual meaning, rather than to whichever file the loop reached first.
    """
    assets: list[Asset] = []
    created: list[UUID] = []
    seen: set[UUID] = set()
    known = {asset.content_hash: asset for asset in uow.assets.list(project_id)}
    for candidate in candidates:
        stored = known.get(candidate.content_hash)
        if stored is None:
            stored = uow.assets.add(candidate.model_copy(update={"ingested_at": stamped_at}))
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


def _open_blob(blobs: BlobStore, content_hash: str, subject: str) -> BinaryIO:
    """A readable handle on one blob, or say the workspace is damaged.

    The streaming sibling of ``ReleaseService._read_blob``, which loads a
    manifest whole because it is about to parse it. Nothing here reads a byte:
    a caller that wanted the content in memory would still have to ask for it,
    and one serving a download must not be made to.
    """
    try:
        return blobs.get(content_hash)
    except FileNotFoundError as exc:
        raise WorkspaceCorrupt(
            f"{subject} names blob {content_hash}, which is not in the blob store"
        ) from exc


def _failure(name: str, exc: MediaError) -> IngestFailure:
    """One report line, with the item's name kept apart from the remedy.

    The name comes from the loop's own item and never from ``exc.name``:
    ``MediaError`` documents its own as reporting rather than identity, and the
    caller here already knows exactly what it was reading. Every caller passes
    it through ``report_name`` first, which is what keeps the server's own
    directory layout out of a report that travels to a client.

    The two branches are the whole of what an item can be — ``UnsupportedMedia``
    is "intact and not for us", ``CorruptMedia`` is "for us and broken" — and
    nothing read one file at a time can be read in part, which is why the report
    has no third kind.
    """
    kind = (
        IngestFailureKind.CORRUPT
        if isinstance(exc, CorruptMedia)
        else IngestFailureKind.UNSUPPORTED
    )
    return IngestFailure(name=name, kind=kind, reason=exc.reason)
