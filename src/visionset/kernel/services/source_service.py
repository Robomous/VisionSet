# usage: from visionset.kernel.services import SourceService
"""Sources: the one door to the record that raw data was offered to a project.

A ``Source`` is a receipt, not a payload — it says *this directory* or *this
clip* is where a project's assets came from, when it was registered, and what a
probe made of it. Materializing assets out of it is the ingest pipeline's job
(#20); this service only ever writes one row.

**Two registration methods, not one ``register(kind=...)``.** The arguments
genuinely differ: a clip needs a decomposition rate and gets probed, a directory
needs neither and is not walked. That is the same argument that made
``ImageProcessor`` and ``VideoProcessor`` two protocols instead of one — a single
entry point would have to accept parameters that are meaningless for half its
callers.

**Registration is idempotent, and the match key is ``(kind, path,
extraction_fps)``.** Registering the same origin twice returns the same
``Source`` rather than a second one, so that once #20 gives ``asset.source_id`` a
target, "which source did this asset come from?" has one answer. The key
deliberately excludes ``capture_params``: fragmenting one directory into two
sources because an operator typed a different lens note would defeat the point.
It also excludes the probed ``VideoMetadata`` — a clip replaced at a known path
is still that path's source, so its recorded provenance is **refreshed in
place** rather than left describing a file that is gone. ``registered_at`` is
never rewritten; it is the first registration.

**That idempotency now has a constraint underneath it.** It shipped without one,
as a named gap: no row referenced a source, so a duplicate born of two concurrent
registrations was inert. Ingest ended that — ``asset.source_id`` has a target, so
the winner of such a race would decide an asset's recorded origin — and
``uq_source_project_kind_path_fps`` went in with it. The two layers do what they
do everywhere else in this store: the pre-check below is what produces a friendly
answer, and the index is the guarantee. A caller that loses the race sees a raw
``ConstraintViolated``, and the remedy is to call the same method again, which
finds the winner's row and returns it. A caller that instead waits out the
store's ``busy_timeout`` sees ``WorkspaceBusy``, and the remedy is the same.

Composition follows the rule in ``docs/workspaces.md``: this service takes an
open ``WorkspaceService`` and nothing else, and reaches ``video_processor``
through it. It never names an adapter.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from uuid import UUID

from visionset.kernel.domain import (
    Project,
    Source,
    SourceKind,
    VideoProvenance,
    canonical_path,
    normalize_name,
)
from visionset.kernel.errors import ProjectNotFound, SourceNotFound
from visionset.kernel.ports import DEFAULT_EXTRACTION_FPS, UnitOfWork
from visionset.kernel.services.workspace_service import WorkspaceService


class SourceService:
    """Register, read and list the origins of one project's raw data."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace

    # --- reading -----------------------------------------------------------

    def get(self, source_id: UUID) -> Source:
        """The source with that id.

        Raises:
            SourceNotFound: no such source in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_source(uow, source_id)

    # --- writing -----------------------------------------------------------

    def register_images(
        self,
        project_id: UUID,
        directory: Path,
        *,
        capture_params: Mapping[str, str] | None = None,
        display_name: str | None = None,
    ) -> Source:
        """Record a directory of stills as an origin for this project.

        The directory is checked to exist and to be a directory, and that is all:
        what is *in* it is read at ingest, because a count taken now would be
        stale by the time anything used it.

        Registering a directory already registered for this project returns the
        existing source. Differing ``capture_params`` are written onto it rather
        than making a second one — see the module docstring.

        ``display_name`` is what to *call* the source (#245) — the answer for an
        origin whose basename is unreadable, which over HTTP is every image
        upload (the staging directory is content-addressed, so the basename is a
        digest). It is not part of the identity key: providing a new one renames
        the existing source, and ``None`` leaves whatever is stored alone —
        every nameless re-registration would otherwise erase the name somebody
        stated. Only this method takes it, deliberately: a clip's basename *is*
        its filename, so ``register_video`` has no caller with this problem yet.

        Raises:
            ProjectNotFound: no such project in this workspace.
            InvalidName: ``display_name`` was provided and is blank.
            FileNotFoundError: there is nothing at ``directory``.
            NotADirectoryError: ``directory`` is there but is not one.
        """
        path = canonical_path(directory)
        if not Path(path).is_dir():
            raise NotADirectoryError(f"{path} is not a directory")
        return self._register(
            project_id,
            SourceKind.IMAGE_DIRECTORY,
            path,
            video=None,
            capture_params=capture_params,
            display_name=(
                None if display_name is None else normalize_name(display_name, what="source name")
            ),
        )

    def register_video(
        self,
        project_id: UUID,
        clip: Path,
        *,
        extraction_fps: float = DEFAULT_EXTRACTION_FPS,
        capture_params: Mapping[str, str] | None = None,
    ) -> Source:
        """Record a video file as an origin, with what a probe makes of it.

        The probe runs **before** the transaction opens. It is an out-of-process
        decoder, and holding a write transaction open across a subprocess is how
        a single-writer SQLite store ends up making every other writer wait out
        its ``busy_timeout`` and fail with ``WorkspaceBusy`` — the same reason
        ``examples/sdk_end_to_end.py`` puts its blob writes outside the
        ``unit_of_work``.

        The consequence is worth knowing: re-registering an already-known clip
        still needs ffmpeg, because the freshly probed metadata is what keeps the
        stored provenance honest when the file behind the path has changed.

        ``extraction_fps`` is part of the source's identity, not a per-run
        option: the same clip at 1 fps and at 5 fps is two sources. See
        ``domain/source.py`` for why the parameters live here and not on the job.

        Raises:
            ProjectNotFound: no such project in this workspace.
            FileNotFoundError: there is nothing at ``clip``.
            ValueError: ``extraction_fps`` is not positive.
            MediaToolUnavailable: ffmpeg is not installed on this machine.
            UnsupportedMedia: the file is intact and is not a video we read.
            CorruptMedia: the file is a video we read, and it is damaged.
        """
        if extraction_fps <= 0:
            raise ValueError(f"extraction_fps must be positive, got {extraction_fps}")
        path = canonical_path(clip)
        metadata = self._workspace.video_processor.probe(Path(path))
        return self._register(
            project_id,
            SourceKind.VIDEO,
            path,
            video=VideoProvenance(metadata=metadata, extraction_fps=extraction_fps),
            capture_params=capture_params,
        )

    # --- lookups shared by the operations above ----------------------------

    def require_source(self, uow: UnitOfWork, source_id: UUID) -> Source:
        """The source, checked through its project so workspaces stay separate.

        Public, and taking a ``uow``, for the reason ``JobService.require_job``
        is: #20's ingest has to resolve a source *inside its own transaction*
        before it writes assets against it, and a second spelling of this ladder
        is a second place for it to be got wrong.

        Raises:
            SourceNotFound: no such source in this workspace.
        """
        source = uow.sources.get(source_id)
        if source is not None:
            project = uow.projects.get(source.project_id)
            if project is not None and project.workspace_id == self._workspace.workspace_id:
                return source
        raise SourceNotFound(
            f"no source {source_id} in workspace {self._workspace.workspace.name!r}"
        )

    def _register(
        self,
        project_id: UUID,
        kind: SourceKind,
        path: str,
        *,
        video: VideoProvenance | None,
        capture_params: Mapping[str, str] | None,
        display_name: str | None = None,
    ) -> Source:
        """Add the source, or return the one that already stands for this origin."""
        params = dict(capture_params or {})
        extraction_fps = None if video is None else video.extraction_fps
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            for stored in uow.sources.list(project_id):
                if stored.kind is not kind or stored.path != path:
                    continue
                if (
                    None if stored.video is None else stored.video.extraction_fps
                ) != extraction_fps:
                    continue
                # ``None`` means the caller said nothing, which must keep the
                # stored name — not erase it. A provided name renames: a label
                # is curation, not provenance, so the last statement wins.
                changes: dict[str, object] = {}
                if stored.video != video or stored.capture_params != params:
                    # The path and parameters match, so this is the same source;
                    # the file behind it moved on. Refresh what was read off it
                    # rather than leaving a record that describes bytes nobody
                    # can produce any more.
                    changes["video"] = video
                    changes["capture_params"] = params
                if display_name is not None and stored.display_name != display_name:
                    changes["display_name"] = display_name
                if not changes:
                    return stored
                return uow.sources.update(stored.model_copy(update=changes))
            return uow.sources.add(
                Source(
                    project_id=project_id,
                    kind=kind,
                    path=path,
                    display_name=display_name,
                    capture_params=params,
                    video=video,
                )
            )

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> Project:
        """The project, or refuse because this workspace does not have it."""
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project

    # ``list`` shadows the builtin for every annotation below it in a class body,
    # so it is declared last. See ``BatchService`` for the precedent.

    def list(self, project_id: UUID) -> list[Source]:
        """Every source registered for that project, in registration order.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return uow.sources.list(project_id)
