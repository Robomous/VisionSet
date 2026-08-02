# usage: from visionset.kernel.services import SchemaService
"""Annotation schemas: a project's ontology, versioned and never rewritten.

The schema replaced the immutable "task type" of the previous system, and it
carries the same promise in a form that can still evolve: what a project labels
is fixed *per version*, and a version is fixed forever. Every Annotation records
the ``schema_version`` it was made under, so history stays readable no matter how
far the ontology moves.

Four decisions shape this module:

- **This is the only door.** A schema version comes into existence here or not at
  all. ``ProjectService`` deliberately does not seed one, so a project starts
  without an ontology and gets version 1 the moment someone decides what it
  labels — rather than getting an empty schema nobody chose.
- **Versions are 1..N and immutable.** There is no ``update`` and no ``delete``
  on this service, and the domain models are frozen (see ``domain/schema.py``),
  so a rehydrated version cannot be edited even by accident. Deleting a schema
  happens only as part of deleting its project, through the database's cascade.
- **"Active" is derived, not stored.** The active version is the highest one.
  A stored ``active`` flag would be a second copy of a fact the version numbers
  already carry, and one more thing to keep consistent.
- **Narrowing the contract is a decision, and sometimes a refusal.** A change
  that would invalidate existing annotations needs ``allow_destructive=True``;
  and if annotations *already exist* under an affected class it is refused
  outright, flag or no flag. Migrating annotations onto a new version does not
  exist yet, and until it does the kernel will not leave labels pointing at a
  class the contract no longer describes.

Composition follows the rule in ``docs/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from visionset.kernel.domain import (
    IMPLEMENTED_GEOMETRIES,
    AnnotationSchema,
    ChangeKind,
    GeometryType,
    LabelClass,
    Project,
    SchemaDiff,
    diff_classes,
)
from visionset.kernel.errors import (
    ConstraintViolated,
    DestructiveSchemaChange,
    InvalidSchema,
    ProjectNotFound,
    SchemaChangeWouldOrphan,
    SchemaNotFound,
    SchemaVersionConflict,
    UnsupportedGeometry,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.workspace_service import WorkspaceService

#: SQLite's own wording when ``uq_schema_project_version`` refuses a write. The
#: adapter hands the message through verbatim, and it is the only way to tell a
#: version race apart from any other constraint — see ``_as_version_conflict``.
_VERSION_INDEX_MESSAGE = "annotation_schema.project_id, annotation_schema.version"


class SchemaService:
    """Create and read the schema versions of one project."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace

    # --- reading -----------------------------------------------------------

    def get(self, project_id: UUID, version: int) -> AnnotationSchema:
        """One version of a project's schema.

        Raises:
            ProjectNotFound: no such project in this workspace.
            SchemaNotFound: the project has no version with that number.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return self._require_version(self._by_version(uow, project_id), project_id, version)

    def get_active(self, project_id: UUID) -> AnnotationSchema:
        """The version in force: the highest one.

        Raises:
            ProjectNotFound: no such project in this workspace.
            SchemaNotFound: the project has no schema yet.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return self.require_active(uow, project_id)

    def list_versions(self, project_id: UUID) -> list[AnnotationSchema]:
        """Every version of the project's schema, oldest first.

        Empty for a project nobody has given an ontology to — that is the
        ordinary starting state, not an error.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return sorted(uow.schemas.list(project_id), key=lambda schema: schema.version)

    def allowed_geometries(
        self, project_id: UUID, version: int | None = None
    ) -> frozenset[GeometryType]:
        """Which geometries a version permits: the ones its classes are bound to.

        Derived rather than stored, so it cannot disagree with the classes. This
        is the set an annotation's ``geometry.type`` is membership-tested against
        — the discriminator's values *are* ``GeometryType`` members, so no
        translation sits in between.

        Raises:
            ProjectNotFound: no such project in this workspace.
            SchemaNotFound: no such version, or no schema at all.
        """
        schema = self.get_active(project_id) if version is None else self.get(project_id, version)
        return frozenset(label_class.geometry for label_class in schema.classes)

    # --- comparing ---------------------------------------------------------

    def compare(self, project_id: UUID, from_version: int, to_version: int) -> SchemaDiff:
        """What ``to_version`` did to ``from_version``.

        Raises:
            ProjectNotFound: no such project in this workspace.
            SchemaNotFound: either version is missing.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            versions = self._by_version(uow, project_id)
            return diff_classes(
                self._require_version(versions, project_id, from_version).classes,
                self._require_version(versions, project_id, to_version).classes,
            )

    def preview(self, project_id: UUID, classes: Sequence[LabelClass]) -> SchemaDiff:
        """How ``create_version`` would judge these classes, without writing.

        The same diff the gates in :meth:`create_version` are built on, so a
        surface can warn before it asks — "this removes 2 classes, continue?" —
        instead of asking and then reporting a refusal.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            active = self.active(uow, project_id)
            return diff_classes(() if active is None else active.classes, classes)

    # --- writing: the only door --------------------------------------------

    def create_version(
        self,
        project_id: UUID,
        classes: Sequence[LabelClass],
        *,
        allow_destructive: bool = False,
    ) -> AnnotationSchema:
        """Add the next version of the project's schema.

        The version number is one past the highest stored, so versions are
        1..N with no gaps and no reuse. Nothing is edited: this always inserts,
        which is what makes an old version safe to read forever.

        The gate is ``allow_destructive`` rather than ``confirm`` because the
        two guard different things. ``confirm`` stands in front of destroying
        data; this stands in front of narrowing a contract, whose remedy is
        usually "write a wider version", not "say yes harder".

        Raises:
            ProjectNotFound: no such project in this workspace.
            InvalidSchema: two classes share a name.
            UnsupportedGeometry: a class names a geometry with no implementation.
            DestructiveSchemaChange: the change narrows the contract and
                ``allow_destructive`` was not ``True``.
            SchemaChangeWouldOrphan: annotations already exist under a class the
                change would break. No flag overrides this.
            SchemaVersionConflict: another writer took this version number first.
        """
        proposed = tuple(classes)
        try:
            with self._workspace.unit_of_work() as uow:
                self._require_project(uow, project_id)
                _require_coherent(proposed)

                active = self.active(uow, project_id)
                diff = diff_classes(() if active is None else active.classes, proposed)
                if diff.is_destructive:
                    self._refuse_narrowing(uow, project_id, diff, allow_destructive)

                return uow.schemas.add(
                    AnnotationSchema(
                        project_id=project_id,
                        version=1 if active is None else active.version + 1,
                        classes=proposed,
                    )
                )
        except ConstraintViolated as exc:
            raise self._as_version_conflict(exc, project_id) from exc

    # --- the two gates -----------------------------------------------------

    def _refuse_narrowing(
        self, uow: UnitOfWork, project_id: UUID, diff: SchemaDiff, allow_destructive: bool
    ) -> None:
        """Let a narrowing change through only if it was asked for and is safe.

        Two refusals, in that order. Being told "you must pass a flag" before
        being told "the flag would not have helped" is the more useful sequence:
        the first is about intent, the second about facts on disk.
        """
        if not allow_destructive:
            raise DestructiveSchemaChange(
                f"this version narrows the schema of project {project_id} "
                f"({diff.describe(ChangeKind.DESTRUCTIVE)}); pass allow_destructive=True "
                f"to proceed"
            )
        annotated = _annotated_classes(uow, project_id)
        affected = sorted(diff.destructive_classes & annotated.keys())
        if affected:
            counted = ", ".join(f"{name!r} ({annotated[name]})" for name in affected)
            raise SchemaChangeWouldOrphan(
                f"cannot narrow project {project_id}: annotations already exist under "
                f"{counted}. Migrating them onto a new version is not supported yet, and "
                f"the kernel will not orphan them"
            )

    # --- lookups shared by the operations above ----------------------------

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> Project:
        """The project, or refuse because this workspace does not have it.

        A project belonging to another workspace reads as missing rather than as
        forbidden — the same rule ``ProjectService`` follows, for the same
        reason: this service speaks for one workspace.
        """
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project

    def _by_version(self, uow: UnitOfWork, project_id: UUID) -> dict[int, AnnotationSchema]:
        return {schema.version: schema for schema in uow.schemas.list(project_id)}

    def active(self, uow: UnitOfWork, project_id: UUID) -> AnnotationSchema | None:
        """The version in force, or ``None`` for a project that has no schema yet.

        Public — promoted from a private helper by #207 rather than copied,
        because "active is the highest version" is a doctrine and a second
        spelling of it is free to drift. ``ProjectService.stats`` needs the
        *count* of declared classes for a project that may legitimately have
        none, and :meth:`require_active` answers that ordinary state with an
        exception. Taking a ``uow`` for :meth:`require_active`'s reason: the
        caller is already inside its own transaction.

        Does NOT check the project — every caller has already resolved one.
        """
        return max(uow.schemas.list(project_id), key=lambda schema: schema.version, default=None)

    def require_active(self, uow: UnitOfWork, project_id: UUID) -> AnnotationSchema:
        """The version in force, resolved inside a transaction the caller owns.

        Public, and taking a ``uow``, for the reason ``BatchService.require_batch``
        is: ``ReleaseService`` pins the active version while it is already inside
        its own ``unit_of_work``, and calling :meth:`get_active` there would open
        a second session against the same file. It does NOT check the project —
        every caller has already resolved one.

        Raises:
            SchemaNotFound: the project has no schema yet.
        """
        active = self.active(uow, project_id)
        if active is None:
            raise SchemaNotFound(
                f"project {project_id} has no schema yet; create version 1 with create_version"
            )
        return active

    def _require_version(
        self, versions: dict[int, AnnotationSchema], project_id: UUID, version: int
    ) -> AnnotationSchema:
        if version not in versions:
            raise SchemaNotFound(f"project {project_id} has no schema version {version}")
        return versions[version]

    def _as_version_conflict(
        self, exc: ConstraintViolated, project_id: UUID
    ) -> SchemaVersionConflict | ConstraintViolated:
        """Re-raise the version index's complaint in the vocabulary callers expect.

        Two writers can read the same highest version and then race to insert
        ``N + 1``; the loser is refused by the unique index, one layer below
        where the maximum was read. The violation ends its transaction, so this
        can only happen outside the ``with`` block — see ``ConstraintViolated``.
        Any other constraint is not this service's to reinterpret and travels on
        unchanged.
        """
        if _VERSION_INDEX_MESSAGE in str(exc):
            return SchemaVersionConflict(
                f"another writer created this schema version of project {project_id} first; "
                f"retry to take the next one"
            )
        return exc


def _require_coherent(classes: Sequence[LabelClass]) -> None:
    """Reject a proposed version whose classes cannot stand together.

    Only rules that need the whole version live here. A single ``LabelClass``
    validates itself on construction (``domain/schema.py``), so anything
    malformed never gets this far.

    Class names are compared case-insensitively: ``Annotation.label_class``
    matches them exactly, so "Car" beside "car" is two classes that read as one
    to everybody except the code.
    """
    unsupported = sorted(
        {c.geometry.value for c in classes if c.geometry not in IMPLEMENTED_GEOMETRIES}
    )
    if unsupported:
        supported = ", ".join(sorted(geometry.value for geometry in IMPLEMENTED_GEOMETRIES))
        raise UnsupportedGeometry(
            f"no geometry implementation for {', '.join(repr(g) for g in unsupported)}; "
            f"a class can only use one of {supported}"
        )

    seen: dict[str, str] = {}
    for label_class in classes:
        folded = label_class.name.casefold()
        if folded in seen:
            raise InvalidSchema(
                f"class name {label_class.name!r} collides with {seen[folded]!r}; "
                f"names must be unique within a version, ignoring case"
            )
        seen[folded] = label_class.name


def _annotated_classes(uow: UnitOfWork, project_id: UUID) -> dict[str, int]:
    """How many annotations each label class currently has in this project.

    Walks the project's assets and reads each one's annotations, because the
    persistence port has no cross-table query: ``Repository.list`` takes a single
    ``parent_id``, and an Annotation's parent is its Asset, not its Project. So
    this is N + 1 reads, deliberately — keeping a query language out of the port
    is worth more at M1 scale than the round trips cost. When it does start to
    cost, the fix is a method on the port (``annotations.list_for_project``)
    implemented in the adapter, never a SQLAlchemy import in a service.
    """
    counts: dict[str, int] = {}
    for asset in uow.assets.list(project_id):
        for annotation in uow.annotations.list(asset.id):
            counts[annotation.label_class] = counts.get(annotation.label_class, 0) + 1
    return counts
