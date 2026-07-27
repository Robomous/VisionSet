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

**Four transactions, not one, and the middle of the run is in none of them.**
Decoding is a Pillow pass over thousands of files or an out-of-process ffmpeg,
and holding a write transaction open across either is how a single-writer SQLite
store starts reporting "database is locked" (#80). So the run resolves what it
needs, closes the transaction, does the work, and opens another to record it.
Blob writes happen out there too, before any row exists: ``BlobStore.put`` is not
transactional and a rollback cannot unwrite it — but a blob nothing points at is
harmless (content-addressed, shared, never deleted), while a row naming bytes
that were never stored is not. The honest consequence, stated rather than
hidden: a process killed between transactions can leave assets in the project
with no batch, and a job stuck at ``running``. That is recoverable, and finding
it is what #19's job record is for.

**Failure splits by remedy, exactly as the media errors do.** A file that is not
an image, or one whose bytes will not decode, is *reported* — one entry in
``IngestResult.failures``, and the run carries on, because an operator with five
thousand files needs the other four thousand nine hundred. A missing ffmpeg is
not a file's fault at all; it fails the job outright and is re-raised, which is
precisely why ``MediaToolUnavailable`` sits outside the ``MediaError`` family.

**What #20 deliberately leaves for later.** No transition table, no persisted
progress counters and no persisted error report — #19 owns the job's lifecycle
and turns ``IngestResult`` into columns. No ``thumbnail_hash``: #21. This service
writes terminal job states directly and reports in memory.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from uuid import UUID

from visionset.kernel.domain import (
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
    normalize_name,
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
        """The ingest job with that id.

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
        and the remedy apart.

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
            job = uow.ingest_jobs.add(IngestJob(source_id=source.id, state=IngestState.RUNNING))

        try:
            candidates, failures = self._read(source)
            assets, created = self._store(source.project_id, candidates)
            batch = self._materialize(source.project_id, name, batch_id, assets)
            with self._workspace.unit_of_work() as uow:
                job = uow.ingest_jobs.update(
                    job.model_copy(
                        update={"state": IngestState.COMPLETED, "batch_id": batch.id},
                    )
                )
        except Exception as exc:
            self._fail(job.id, str(exc) or exc.__class__.__name__)
            raise

        # After the block, never inside it: a subscriber must not be able to put
        # its own exception on a transaction's way out.
        self._workspace.event_bus.publish(
            IngestCompleted(
                ingest_job_id=job.id,
                project_id=source.project_id,
                source_id=source.id,
                asset_count=len(assets),
            )
        )
        return IngestResult(
            job_id=job.id,
            project_id=source.project_id,
            source_id=source.id,
            batch_id=batch.id,
            assets=tuple(assets),
            created_asset_ids=tuple(created),
            failures=tuple(failures),
        )

    # --- the run, phase by phase -------------------------------------------

    def _read(self, source: Source) -> tuple[list[Asset], list[IngestFailure]]:
        """Decode and store every item, outside any transaction.

        Returns candidate assets in the order the source offered them, plus one
        entry per item that could not be read at all.
        """
        if source.kind is SourceKind.VIDEO:
            return self._read_video(source)
        return self._read_directory(source)

    def _read_directory(self, source: Source) -> tuple[list[Asset], list[IngestFailure]]:
        """Every file at the top of the directory, in filename order.

        Top level only. Recursion is not a per-run option but a question about
        what *the source is* — "the same source yields the same assets" — so it
        belongs to a future ``register_images(..., recursive=True)`` rather than
        here, where it would silently change what an already-registered source
        means. Subdirectories are stepped over and recorded nowhere.

        No suffix filter either: a ``notes.txt`` is reported as unsupported
        rather than skipped, because guessing which files an operator meant to
        offer is a policy the kernel would be inventing.
        """
        candidates: list[Asset] = []
        failures: list[IngestFailure] = []
        directory = Path(source.path)
        for path in sorted(item for item in directory.iterdir() if item.is_file()):
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
            except MediaError as exc:
                failures.append(_failure(str(path), exc))
                continue
            candidates.append(
                Asset(
                    project_id=source.project_id,
                    content_hash=content_hash,
                    uri=str(path),
                    width=metadata.width,
                    height=metadata.height,
                    format=metadata.format,
                    source_id=source.id,
                )
            )
        return candidates, failures

    def _read_video(self, source: Source) -> tuple[list[Asset], list[IngestFailure]]:
        """One asset per extracted frame, at the rate the source records.

        The frames are **not** re-probed. ``VideoProcessor`` guarantees each one
        is a complete image in ``FRAME_FORMAT`` at the dimensions ``probe``
        reported, and that guarantee is asserted where it belongs, in the port's
        own tests. Decoding every frame a second time to re-confirm it would
        also mean putting our own encoder's output into an operator's per-file
        report — a failure nobody could act on.

        Damage arrives once and terminally: ffmpeg yields the frames it managed
        and *then* says the bytes ran out, so the refusal is caught around the
        loop and what was extracted is kept. The loop is left by falling out of
        it, which is one of the two ways the port allows an iterator to be
        released.
        """
        provenance = source.require_video()
        candidates: list[Asset] = []
        failures: list[IngestFailure] = []
        clip = Path(source.path)
        frames = self._workspace.video_processor.frames(
            clip, fps=provenance.extraction_fps, name=clip.name
        )
        try:
            for frame in frames:
                content_hash = self._workspace.blob_store.put(BytesIO(frame.content))
                candidates.append(
                    Asset(
                        project_id=source.project_id,
                        content_hash=content_hash,
                        uri=f"{source.path}#frame={frame.index}",
                        width=provenance.metadata.width,
                        height=provenance.metadata.height,
                        format=FRAME_FORMAT,
                        source_id=source.id,
                        frame_index=frame.index,
                        frame_timestamp=frame.timestamp,
                    )
                )
        except MediaError as exc:
            failures.append(_failure(source.path, exc))
        return candidates, failures

    def _store(self, project_id: UUID, candidates: list[Asset]) -> tuple[list[Asset], list[UUID]]:
        """Write the rows, reusing whatever content the project already holds.

        The project's assets are read once, into a map keyed by content hash,
        rather than queried per item — ``Repository`` has one query shape, and a
        service never builds SQL. The whole-project read is affordable at this
        scale and the fix when it stops being is a port method, not an import.

        The map is updated as the run proceeds, so two identical files inside one
        directory become one asset rather than a pair the new unique index would
        refuse at commit.
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

    def _fail(self, job_id: UUID, cause: str) -> None:
        """Record why a run stopped, on its own row and in its own transaction."""
        with self._workspace.unit_of_work() as uow:
            job = uow.ingest_jobs.get(job_id)
            if job is not None:
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
