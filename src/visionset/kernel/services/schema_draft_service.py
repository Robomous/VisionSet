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

from pydantic import ValidationError

from visionset.kernel.domain import (
    DraftLabelClass,
    LabelClass,
    Project,
    SchemaDraft,
    SchemaProvenance,
    SchemaPublication,
)
from visionset.kernel.errors import InvalidSchema, ProjectNotFound, SchemaDraftNotFound, StaleWrite
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import WorkspaceService


class _Omitted:
    """Marks ``based_on`` as not passed, distinct from passed as ``None``.

    A plain ``None`` default could not tell "the caller wants this cleared"
    from "the caller's surface has nowhere to name it at all" — and ``save``
    has to answer those two differently.
    """


_OMITTED = _Omitted()


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
        based_on: int | None | _Omitted = _OMITTED,
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

        ``based_on`` **omitted** preserves whatever the stored draft already
        names — a read-modify-write through a surface with no parameter for it
        (the CLI's ``set`` command, ``set_schema_draft``) must not silently null
        out a value it never had the means to carry. Passed explicitly, including
        as ``None``, it replaces the stored value the ordinary way. A draft being
        created for the first time has no stored value to preserve, so an
        omitted ``based_on`` there starts the draft at ``None``.

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
                        based_on=None if isinstance(based_on, _Omitted) else based_on,
                        revision=1,
                        updated_at=now,
                    )
                )
            if expected_revision is None:
                raise StaleWrite(
                    f"project {project_id} already has a {kind.value} schema draft at revision "
                    f"{stored.revision}; read it and pass that revision to write over it"
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
                        "based_on": stored.based_on if isinstance(based_on, _Omitted) else based_on,
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

    def publish(
        self,
        project_id: UUID,
        kind: SchemaProvenance,
        *,
        expected_revision: int,
        allow_destructive: bool = False,
    ) -> SchemaPublication:
        """Turn the draft into the next version, and spend it.

        The draft's ``note`` becomes the version's commit message and its ``kind``
        becomes the version's provenance — which is the whole reason the kind is
        part of the key: a dialog session and a deliberate composition publish
        under different words without either surface having to remember to say so.

        **Not one transaction, and it cannot be.** ``create_version`` opens its own
        unit of work, so a crash between the publish and the discard leaves a
        draft whose ``based_on`` is now behind the active version. That is a state
        every surface already announces — a version arrived underneath — rather
        than a new failure mode, and the alternative is a service reaching inside
        another service's transaction.

        The same gap is why the discard is **conditional on the revision this
        call read**, not unconditional the way the standalone ``discard`` is. A
        write can land in the window between ``create_version`` committing and
        this method's own discard — two people sharing one draft is the ordinary
        shape, not an edge case — and a discard with no revision check would
        destroy that write as collateral of a publish that never asked to touch
        it. When nothing landed in the gap, the discard runs exactly as before:
        ``create_version`` answers a publish of the contract already in force
        with the version already in force, and a draft that proposed exactly
        that has nothing left to say.

        Raises:
            ProjectNotFound: no such project in this workspace.
            SchemaDraftNotFound: the project has no draft of that kind.
            StaleWrite: the draft has moved since ``expected_revision`` was read.
            InvalidSchema: a class in the draft is unfinished or invalid, named by
                its position.
            UnsupportedGeometry, DestructiveSchemaChange, SchemaChangeWouldOrphan,
                SchemaVersionConflict: unchanged, from ``create_version``.
        """
        draft = self.get(project_id, kind)
        if draft is None:
            raise SchemaDraftNotFound(
                f"project {project_id} has no {kind.value} schema draft to publish"
            )
        if draft.revision != expected_revision:
            raise StaleWrite(
                f"the {kind.value} schema draft of project {project_id} is at revision "
                f"{draft.revision}, not {expected_revision}; read it again before publishing"
            )
        published = SchemaService(self._workspace).create_version(
            project_id,
            _as_label_classes(draft),
            description=draft.note or None,
            provenance=kind,
            allow_destructive=allow_destructive,
        )
        self._discard_if_unmoved(project_id, kind, expected_revision)
        return published

    def _discard_if_unmoved(
        self, project_id: UUID, kind: SchemaProvenance, expected_revision: int
    ) -> None:
        """Discard the draft ``publish`` just read, unless a later write moved it.

        A fresh unit of work, deliberately — ``create_version`` already
        committed its own by the time this runs, so what is read here is
        whatever the draft holds *now*, not what ``publish`` read before
        calling it. Only a draft still sitting at the revision that was
        actually published is spent; anything else is somebody else's write
        that landed in the gap, and it survives.
        """
        with self._workspace.unit_of_work() as uow:
            stored = self._stored(uow, project_id, kind)
            if stored is not None and stored.revision == expected_revision:
                uow.schema_drafts.delete(stored.id)

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


def _as_label_classes(draft: SchemaDraft) -> tuple[LabelClass, ...]:
    """The draft as a proposed version, or a refusal naming which class is not ready.

    The one crossing from permissive to strict, and the position matters more than
    the rule that fired: a person looking at fifteen rows needs to be told which
    one, and ``classes.7`` is the same locator the REST and CLI surfaces already
    use for a malformed class.
    """
    published: list[LabelClass] = []
    for index, declared in enumerate(draft.classes):
        try:
            published.append(declared.to_label_class())
        except ValueError as exc:
            raise InvalidSchema(f"classes.{index}: {_reason(exc)}") from exc
    return tuple(published)


def _reason(exc: ValueError) -> str:
    """The refusal in one fragment, whichever of the two kinds it is.

    pydantic reports a path and a message; a hand-raised ``ValueError`` is already
    a sentence. Both reach here because ``ValidationError`` is a ``ValueError``,
    which is what lets one ``except`` cover a rule stated in a validator and a rule
    stated in a conversion.
    """
    if isinstance(exc, ValidationError):
        first = exc.errors()[0]
        location = ".".join(str(part) for part in first["loc"])
        return f"{location}: {first['msg']}" if location else str(first["msg"])
    return str(exc)
