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
from datetime import UTC, datetime
from typing import NoReturn
from uuid import UUID

from visionset.kernel.domain import (
    IMPLEMENTED_GEOMETRIES,
    REPINNABLE_STATES,
    AnnotationSchema,
    ChangeKind,
    ClassCount,
    ClassShape,
    GeometryType,
    LabelClass,
    Project,
    SchemaChangePreview,
    SchemaDiff,
    SchemaProvenance,
    SchemaPublication,
    diff_classes,
    orphanable_shapes,
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
    WorkspaceCorrupt,
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
        """Which geometries a version permits: the union across its classes.

        Derived rather than stored, so it cannot disagree with the classes. It
        answers "what may this project draw?", and it is deliberately **not** the
        test a write goes through: an annotation is judged against its own
        class's ``geometries``, which this union is wider than as soon as two
        classes accept different shapes. ``AnnotationService._validate`` owns
        that narrower test.

        Raises:
            ProjectNotFound: no such project in this workspace.
            SchemaNotFound: no such version, or no schema at all.
        """
        schema = self.get_active(project_id) if version is None else self.get(project_id, version)
        return frozenset(
            geometry for label_class in schema.classes for geometry in label_class.geometries
        )

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

    def preview(self, project_id: UUID, classes: Sequence[LabelClass]) -> SchemaChangePreview:
        """How ``create_version`` would judge these classes, without writing.

        Both gates, asked and not enforced. ``diff`` is what
        :meth:`_refuse_narrowing` decides on — whether this needs
        ``allow_destructive`` — and ``blockers`` is what the guarded insert would
        refuse over: the classes being dropped that already carry labels. A
        surface can therefore say *this removes 2 classes* **or** *this cannot be
        published, 12 labels use 'lane'* before it asks, instead of asking and
        then translating a refusal.

        ``blockers`` is the same report :class:`SchemaChangeWouldOrphan` carries,
        so a client renders the warning and the refusal with one piece of code.

        **Advisory, and it says so.** Nothing is locked and nothing is reserved:
        somebody can label a class between this call and the publish, in which
        case the publish refuses and *that* refusal is the authoritative one. The
        guard inside the insert is what makes the answer safe to act on — not
        this. What this removes is the round trip that was doomed before it was
        sent, which is a question about the interface rather than about
        correctness.

        Empty ``blockers`` under a destructive diff is the ordinary safe
        narrowing, and is what ``allow_destructive`` confirms.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            active = self.active(uow, project_id)
            previous = () if active is None else active.classes
            diff = diff_classes(previous, classes)
            # The *same* set the guard will match on, not a name-level
            # approximation of it: a preview that warned about a class whose
            # doomed shape nobody has drawn would promise a refusal that never
            # comes, which is the disagreement this model exists to prevent.
            return SchemaChangePreview(
                diff=diff, blockers=_blockers(uow, project_id, orphanable_shapes(previous, diff))
            )

    # --- writing: the only door --------------------------------------------

    def create_version(
        self,
        project_id: UUID,
        classes: Sequence[LabelClass],
        *,
        description: str | None = None,
        provenance: SchemaProvenance | None = None,
        allow_destructive: bool = False,
    ) -> SchemaPublication:
        """Add the next version of the project's schema, and catch the open batches up.

        The version number is one past the highest stored, so versions are
        1..N with no gaps and no reuse. Nothing is edited: this always inserts,
        which is what makes an old version safe to read forever.

        **Publishing the contract that is already in force writes nothing** and
        returns the active version unchanged. A history whose entries include
        "and then nothing changed" is a history somebody has to read past, and a
        schema editor that answers "saved" is impossible to tell from one that
        answered "already saved" — so the two are made the same thing.

        Identical means the classes compare equal, which — the models being
        frozen — covers names, geometries, colours, attributes and order. That is
        deliberately *not* the same question as an empty ``diff_classes``:
        ``domain/schema_diff.py`` classifies whether existing annotations survive
        and ignores ``color`` on purpose, so gating this on the diff would answer
        "saved" to somebody who changed a swatch and then discard the swatch.
        Equality implies an empty diff, never the other way round, so the diff
        remains the one definition of *changed in a way that matters* and no
        second one is written here.

        Only the **active** version is compared. Re-publishing an older
        version's contract is a real change — it is what a revert is — and
        answering it with that old version would leave the newer one in force.

        ``description`` is the version's **commit message**: written here and
        never afterwards, because there is no ``update`` on this service and the
        model is frozen. Blank is legal and stored as ``None`` — an empty commit
        message is an ordinary thing — and the tidying happens in the domain, so
        no other door can write an untidied one. ``created_at`` is stamped here
        for the same reason the version number is: it is a fact about the
        publication, not an opinion of the caller, so whatever arrived in the
        field is replaced.

        ``provenance`` is the opposite of both: it is the caller's own answer and
        is stored **verbatim**, because the only thing that knows whether a class
        was designed or needed-right-now is the surface the person was using.
        Nothing here infers it and nothing validates it beyond the enum, so a
        caller with no opinion — an SDK script, a test — omits it and the version
        records ``None``, which readers group with the deliberate ones. It changes
        no behaviour: it is not a gate, it does not enter any diff, and two
        versions differing only in provenance are the same contract.

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
                if active is not None and proposed == active.classes:
                    # Nothing was written, so nothing follows it. A no-op that
                    # caught a lagging batch up would be a no-op with an effect.
                    return SchemaPublication(published=active)

                previous = () if active is None else active.classes
                diff = diff_classes(previous, proposed)
                guarded: frozenset[ClassShape] = frozenset()
                if diff.is_destructive:
                    self._refuse_narrowing(uow, project_id, diff, allow_destructive)
                    guarded = orphanable_shapes(previous, diff)

                stored = uow.add_schema_version_unless_annotated(
                    AnnotationSchema(
                        project_id=project_id,
                        version=1 if active is None else active.version + 1,
                        classes=proposed,
                        description=description,
                        created_at=datetime.now(UTC),
                        provenance=provenance,
                    ),
                    guarded,
                )
                if stored is None:
                    self._refuse_orphaning(uow, project_id, guarded)

                # Read once for the whole call: every open batch's pin is judged
                # against this version, and a lagging batch's pin is a version the
                # caller's own `diff` says nothing about.
                #
                # After the guarded insert, and that ordering is #589's rule rather
                # than a convenience: the insert is the first *write*, so it is what
                # opens the transaction. Reading the versions before it would leave
                # this read in autocommit and reopen the window that fix closed, one
                # scope over.
                advanced = (
                    ()
                    if diff.is_destructive
                    else _advance_pins(uow, project_id, stored, self._by_version(uow, project_id))
                )
                return SchemaPublication(published=stored, advanced_batches=advanced)
        except ConstraintViolated as exc:
            raise self._as_version_conflict(exc, project_id) from exc

    # --- the two gates -----------------------------------------------------

    def _refuse_narrowing(
        self, uow: UnitOfWork, project_id: UUID, diff: SchemaDiff, allow_destructive: bool
    ) -> None:
        """Let a narrowing change through only if it was asked for.

        The first of the two refusals, and it is about *intent*: being told "you
        must pass a flag" before being told "the flag would not have helped" is
        the more useful sequence. The second — whether labels already depend on
        what this drops — is :meth:`_refuse_orphaning`, and it is asked by the
        insert itself rather than here, because a question answered before the
        write can be answered again by somebody else before the write lands.
        """
        if not allow_destructive:
            raise DestructiveSchemaChange(
                f"this version narrows the schema "
                f"({diff.describe(ChangeKind.DESTRUCTIVE)}); pass allow_destructive=True "
                f"to proceed",
                classes=tuple(sorted(diff.destructive_classes)),
            )

    def _refuse_orphaning(
        self, uow: UnitOfWork, project_id: UUID, guarded: frozenset[ClassShape]
    ) -> NoReturn:
        """Name the classes the guarded insert refused over, and their counts.

        Reached only when ``add_schema_version_unless_annotated`` wrote nothing,
        so the verdict is already in and this is not a second opinion — it is the
        report. Counting here rather than before the insert is what keeps the
        walk off the path where the publish succeeds, and it is the only place
        the count is still true of a decision already made: this read runs after
        the guard, inside the same transaction.

        A count that comes back empty is not a contradiction. The labels can have
        been deleted between the guard and this read, and the refusal still
        stands, because the guard is what decided — so the classes are named
        without counts rather than a refusal being downgraded to a success
        nobody asked for.
        """
        annotated = _annotated_classes(uow, project_id, guarded)
        # Named by class even though the guard matched pairs: a class losing two
        # of its shapes is one thing to fix, and the counts are already only the
        # annotations that carry a doomed shape.
        affected = sorted(annotated.keys()) or sorted({name for name, _ in guarded})
        counted = ", ".join(
            f"{name!r} ({annotated[name].annotations})" if name in annotated else repr(name)
            for name in affected
        )
        raise SchemaChangeWouldOrphan(
            f"cannot narrow this schema: annotations already exist under "
            f"{counted}. Migrating them onto a new version is not supported yet, and "
            f"the kernel will not orphan them",
            blockers=tuple(annotated[name] for name in affected if name in annotated),
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

        Public rather than copied into its callers, because "active is the
        highest version" is a doctrine and a second spelling of it is free to
        drift. ``ProjectService.stats`` needs the
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
        {
            geometry.value
            for c in classes
            for geometry in c.geometries
            if geometry not in IMPLEMENTED_GEOMETRIES
        }
    )
    if unsupported:
        supported = ", ".join(sorted(geometry.value for geometry in IMPLEMENTED_GEOMETRIES))
        raise UnsupportedGeometry(
            f"no geometry implementation for {', '.join(repr(g) for g in unsupported)}; "
            f"a class can only use {supported}"
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


def _blockers(
    uow: UnitOfWork, project_id: UUID, guarded: frozenset[ClassShape]
) -> tuple[ClassCount, ...]:
    """Which of ``guarded`` already carry labels, counted — the report, not a gate.

    The read half of what the guarded insert decides, shared by
    :meth:`SchemaService.preview` (which asks in advance) and by
    :meth:`SchemaService._refuse_orphaning` (which asks afterwards, to say what it
    refused over), so the warning and the refusal cannot report different things
    about the same project.

    Empty ``guarded`` short-circuits: a change that removes nothing has nothing
    to block it, and walking every asset to establish that is a cost with no
    question behind it.
    """
    if not guarded:
        return ()
    annotated = _annotated_classes(uow, project_id, guarded)
    return tuple(annotated[name] for name in sorted(annotated))


def _advance_pins(
    uow: UnitOfWork,
    project_id: UUID,
    created: AnnotationSchema,
    by_version: dict[int, AnnotationSchema],
) -> tuple[UUID, ...]:
    """Move the open batches this version is additive *for* onto it.

    **The diff is per batch, against that batch's own pin — never against the
    version this one replaced.** That distinction is the whole correctness of this
    function, and getting it wrong is not theoretical: a batch may be lagging,
    having already declined to follow a narrowing, and a version that only widens
    the *active* contract can still be a narrowing of **its** one. Diffing once
    against active would then drag it across the very change it was protected
    from, and the labels it holds under a class its pin still declares would be
    left describing a contract it no longer does.

    So the rule is stated per batch: advance it when `diff_classes(its pin, this
    version)` is additive. For a batch already on the active version that is the
    same diff the caller ran, which is why the common case costs nothing extra.

    This is deliberately **not** ``BatchService.repin``, and cannot be:
    ``BatchService`` imports ``SchemaService``, so the reverse import would close
    a cycle. What it shares is the question, not the code — and the two gates it
    does not need are the ones an additive answer makes vacuous. ``repin``'s
    ``SchemaChangeWouldOrphan`` counts labels under classes a change breaks, and
    an additive change breaks none; its ``DestructiveSchemaChange`` is the flag
    this path never offers, because a flag says *publish this*, not *and drag
    every open batch across it*.

    ``REPINNABLE_STATES`` is the state filter, and each state it excludes is
    excluded for its own reason: a ``draft`` has no pin yet — approval takes the
    active version, which is now this one — and a ``completed`` batch's pin is the
    record of what its finished work was judged against, which is not ours to
    rewrite.

    ``by_version`` is passed in rather than read here so the versions are fetched
    **once** for the whole call. Walked in Python rather than filtered in the
    port, which is the shape ``SummaryService`` and ``JobService`` already use:
    ``Repository.list`` takes a single ``parent_id`` and no query language leaks
    into it.
    """
    moved: list[UUID] = []
    for batch in uow.batches.list(project_id):
        if batch.state not in REPINNABLE_STATES or batch.schema_version is None:
            continue
        pinned = by_version.get(batch.schema_version)
        if pinned is None:
            # Versions are never deleted, so this is damage rather than a state
            # any operation leaves behind — the same answer `BatchService`'s own
            # `_pinned_schema` gives, and for the same reason.
            raise WorkspaceCorrupt(
                f"batch {batch.id} is pinned to schema version {batch.schema_version}, "
                f"which is not stored for project {project_id}"
            )
        if diff_classes(pinned.classes, created.classes).is_destructive:
            continue
        uow.batches.update(batch.model_copy(update={"schema_version": created.version}))
        moved.append(batch.id)
    return tuple(moved)


def _annotated_classes(
    uow: UnitOfWork, project_id: UUID, guarded: frozenset[ClassShape]
) -> dict[str, ClassCount]:
    """How much of this project is at risk from ``guarded``, per class.

    **Counts the annotations the guard would actually orphan**, which since #592
    is a question about the pair an annotation carries and not about its class:
    a ``car`` losing its polygon must not be reported as *12 car annotations* when
    eleven of them are boxes that survive. So an annotation is counted only when
    its own ``(class, shape)`` is in ``guarded``.

    Keyed by class name all the same, because a class is what somebody fixes —
    two of its shapes going at once is one problem, not two — and because
    ``ClassCount`` is the shape both the warning and the refusal already publish.

    Walks the project's assets and reads each one's annotations, because the
    persistence port has no cross-table query: ``Repository.list`` takes a single
    ``parent_id``, and an Annotation's parent is its Asset, not its Project. So
    this is N + 1 reads, deliberately — keeping a query language out of the port
    is worth more at M1 scale than the round trips cost. When it does start to
    cost, the fix is a method on the port (``annotations.list_for_project``)
    implemented in the adapter, never a SQLAlchemy import in a service.

    ``ClassCount`` rather than a bare count, and reused rather than re-spelled:
    both numbers mean here exactly what they mean for the trunk, and a class
    carrying the same two fields is how two counts of one thing start to
    disagree. The second number is what turns "12 annotations" into "12
    annotations across 3 images", which is the difference between a blast radius
    somebody can judge and a number they cannot.
    """
    annotations: dict[str, int] = {}
    assets: dict[str, set[UUID]] = {}
    for asset in uow.assets.list(project_id):
        for annotation in uow.annotations.list(asset.id):
            if (annotation.label_class, annotation.geometry.type) not in guarded:
                continue
            annotations[annotation.label_class] = annotations.get(annotation.label_class, 0) + 1
            assets.setdefault(annotation.label_class, set()).add(asset.id)
    return {
        name: ClassCount(label_class=name, annotations=count, assets=len(assets[name]))
        for name, count in annotations.items()
    }
