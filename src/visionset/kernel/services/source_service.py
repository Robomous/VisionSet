# usage: from visionset.kernel.services import SourceService
"""Sources: the one door to the record that raw data was offered to a project.

A ``Source`` is a receipt, not a payload — it says *this directory* or *this
clip* is where a project's assets came from, when it was registered, and what a
probe made of it. Materializing assets out of it is the ingest pipeline's job;
this service only ever writes one row.

**One registration method, and it registers a directory.** A ``VIDEO`` source
is not made here at all: the server never sees a clip, so there is nothing to
open and nothing to probe. ``VideoImportService.start`` is the only door to one,
and it writes its ``VideoProvenance`` from what a client's decoder declared.
This service still *reads* both kinds — ``get``, ``list`` and
:meth:`require_source` know nothing about how a row was written.

**Registration is idempotent, and the match key is ``(kind, path,
extraction_fps, ranges, scale_percent)``** — the video half of that key is dead
weight for the one writer left here and is kept because the stored rows and the
unique index still carry it. Registering the same origin twice returns the same
``Source`` rather than a second one, so that "which source did this asset come
from?" has one answer through ``asset.source_id``. The key
deliberately excludes ``capture_params``: fragmenting one directory into two
sources because an operator typed a different lens note would defeat the point.
It also excludes the stored ``VideoMetadata``. ``registered_at`` is
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

Composition follows the rule in ``docs/content/workspaces.md``: this service takes an
open ``WorkspaceService`` and nothing else, and reaches every port through it.
It never names an adapter.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from uuid import UUID

from visionset.kernel.domain import (
    Project,
    Source,
    SourceKind,
    canonical_path,
    normalize_name,
)
from visionset.kernel.errors import ProjectNotFound, SourceNotFound
from visionset.kernel.ports import UnitOfWork
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

        ``display_name`` is what to *call* the source — the answer for an
        origin whose basename is unreadable, which over HTTP is every image
        upload (the staging directory is content-addressed, so the basename is a
        digest). It is not part of the identity key: providing a new one renames
        the existing source, and ``None`` leaves whatever is stored alone —
        every nameless re-registration would otherwise erase the name somebody
        stated.

        Raises:
            ProjectNotFound: no such project in this workspace.
            InvalidName: ``display_name`` was provided and is blank.
            FileNotFoundError: there is nothing at ``directory``.
            NotADirectoryError: ``directory`` is there but is not one.
        """
        path = canonical_path(directory)
        if not Path(path).is_dir():
            raise NotADirectoryError(f"{path} is not a directory")
        name = None if display_name is None else normalize_name(display_name, what="source name")
        params = dict(capture_params or {})
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            for stored in uow.sources.list(project_id):
                if stored.kind is not SourceKind.IMAGE_DIRECTORY or stored.locator != path:
                    continue
                # ``None`` means the caller said nothing, which must keep the
                # stored name — not erase it. A provided name renames: a label
                # is curation, not provenance, so the last statement wins.
                changes: dict[str, object] = {}
                if stored.capture_params != params:
                    changes["capture_params"] = params
                if name is not None and stored.display_name != name:
                    changes["display_name"] = name
                if not changes:
                    return stored
                return uow.sources.update(stored.model_copy(update=changes))
            return uow.sources.add(
                Source(
                    project_id=project_id,
                    kind=SourceKind.IMAGE_DIRECTORY,
                    locator=path,
                    display_name=name,
                    capture_params=params,
                )
            )

    # --- lookups shared by the operations above ----------------------------

    def require_source(self, uow: UnitOfWork, source_id: UUID) -> Source:
        """The source, checked through its project so workspaces stay separate.

        Public, and taking a ``uow``, for the reason ``JobService.require_job``
        is: ingest has to resolve a source *inside its own transaction* before it
        writes assets against it, and a second spelling of this ladder is a second
        place for it to be got wrong.

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
