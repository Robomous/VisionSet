# usage: from visionset.kernel.services import SchemaDraftService
"""The schema version a project is still writing: the one mutable thing here.

``SchemaService`` states as doctrine that it has no ``update`` and no ``delete``,
and that sentence is what makes an old version safe to read forever. A draft needs
both, so it gets its own service rather than falsifying that one.

The dependency runs one way only. This module imports ``SchemaService`` to publish;
``SchemaService`` knows nothing about drafts, and must not — a version is a fact
about what a project labels, and how somebody arrived at it is not part of that.

**One draft per project per kind, and no author.** The workspace has no identities
to attribute a draft to, so a draft belongs to the project and to everybody
holding a credential to it. That is also what makes the refusal below necessary:
with no owner, two writers are the ordinary case rather than the exceptional one.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import UUID

from visionset.kernel.domain import (
    DraftLabelClass,
    Project,
    SchemaDraft,
    SchemaProvenance,
)
from visionset.kernel.errors import ProjectNotFound, StaleWrite
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.workspace_service import WorkspaceService


class SchemaDraftService:
    """Read, write, discard and publish the drafts of one project."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace

    def get(self, project_id: UUID, kind: SchemaProvenance) -> SchemaDraft | None:
        """The project's draft of that kind, or ``None``.

        ``None`` is the ordinary answer and never an error: most projects have no
        draft most of the time, and a service that raised here would make the
        common case the exceptional one.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return self._stored(uow, project_id, kind)

    def save(
        self,
        project_id: UUID,
        kind: SchemaProvenance,
        *,
        classes: Sequence[DraftLabelClass],
        note: str = "",
        based_on: int | None = None,
        expected_revision: int | None = None,
    ) -> SchemaDraft:
        """Write the whole draft, and refuse a write decided against a stale read.

        There is no partial edit, for the reason there is none of a version: the
        classes are one value, and a field-at-a-time protocol over a shared draft
        would need a merge rule nobody has agreed on.

        ``expected_revision`` names the revision this write was decided against.
        ``None`` means *create*, so a caller that never read cannot silently
        replace one that did — a writer with no revision in hand has, by
        definition, not seen what it is about to overwrite.

        Unlike ``JobService.mark``, this is **not** exempted when the stored value
        already matches what is asked for. A draft write is not idempotent by
        content: the revision it returns is what a later publish names, so
        answering an expired write with success would hand back a number that
        does not describe the draft on disk.

        Raises:
            ProjectNotFound: no such project in this workspace.
            StaleWrite: a draft already exists and ``expected_revision`` is not
                its current one — including ``None``, which asks to create.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            stored = self._stored(uow, project_id, kind)
            now = datetime.now(UTC)
            if stored is None:
                if expected_revision is not None:
                    raise StaleWrite(
                        f"project {project_id} has no {kind.value} schema draft at revision "
                        f"{expected_revision}; it was discarded or published while you were "
                        f"working on it"
                    )
                return uow.schema_drafts.add(
                    SchemaDraft(
                        project_id=project_id,
                        kind=kind,
                        classes=tuple(classes),
                        note=note,
                        based_on=based_on,
                        revision=1,
                        updated_at=now,
                    )
                )
            if expected_revision != stored.revision:
                raise StaleWrite(
                    f"the {kind.value} schema draft of project {project_id} is at revision "
                    f"{stored.revision}, not {expected_revision}; read it again and resubmit"
                )
            return uow.schema_drafts.update(
                stored.model_copy(
                    update={
                        "classes": tuple(classes),
                        "note": note,
                        "based_on": based_on,
                        "revision": stored.revision + 1,
                        "updated_at": now,
                    }
                )
            )

    def discard(self, project_id: UUID, kind: SchemaProvenance) -> bool:
        """Throw the draft away. ``False`` when there was none, which is not an error.

        Unconditional, and deliberately: discarding is what somebody does when
        they have decided the work is not wanted, and refusing that over a stale
        revision would leave them re-reading a draft only to delete it.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            stored = self._stored(uow, project_id, kind)
            if stored is None:
                return False
            return uow.schema_drafts.delete(stored.id)

    # --- lookups shared by the operations above ----------------------------

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> Project:
        """The project, or refuse because this workspace does not have it.

        A project belonging to another workspace reads as missing rather than as
        forbidden — the rule every service here follows, for the same reason:
        this service speaks for one workspace.
        """
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project

    def _stored(
        self, uow: UnitOfWork, project_id: UUID, kind: SchemaProvenance
    ) -> SchemaDraft | None:
        """The one draft of that kind, filtered in Python.

        ``Repository.list`` takes a single ``parent_id`` and no query language, so
        the filter is here — and at two rows per project the walk is free. The
        unique index is what makes ``next`` correct rather than a first-of-many.
        """
        return next(
            (draft for draft in uow.schema_drafts.list(project_id) if draft.kind == kind), None
        )
