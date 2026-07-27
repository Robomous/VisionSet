# usage: from visionset.kernel import EntityNotFound, VisionSetError
"""Domain errors raised by the kernel.

Every error the kernel raises derives from ``VisionSetError``, so a delivery
surface can translate the whole family to an HTTP status or an exit code with a
single ``except`` clause. The kernel NEVER raises a framework exception —
``HTTPException`` and friends belong to the boundary, not here.

Persistence, workspace, project, schema and batch errors live here; later
services add their own as they land.
"""

from __future__ import annotations


class VisionSetError(Exception):
    """Base class for every error the kernel raises."""


class EntityNotFound(VisionSetError):
    """An operation addressed an entity id that is not in the store."""


class EntityAlreadyExists(VisionSetError):
    """An insert collided with an existing primary key."""


class ConstraintViolated(VisionSetError):
    """The store refused a write that broke one of its constraints.

    A foreign key with no parent, or a uniqueness rule the store enforces on the
    services' behalf. The translation happens in the adapter so that no
    SQLAlchemy exception ever escapes the kernel.

    A violation ends the transaction it happened in: SQLAlchemy refuses further
    work on it, so a service cannot catch this and carry on. That is why service
    rules check *before* writing rather than relying on the write to fail.
    """


class NotAWorkspace(VisionSetError):
    """There is no VisionSet workspace at that path.

    Either nothing is there, or the directory holds no metadata store — the
    presence of the database file is what makes a directory a workspace.
    """


class WorkspaceNotEmpty(VisionSetError):
    """``init`` refused to create a workspace over existing content.

    Initializing never writes into a directory that already holds something.
    The safe failure is refusing, not merging.
    """


class WorkspaceAlreadyExists(VisionSetError):
    """``init`` was pointed at a directory that is already a workspace.

    Separate from ``WorkspaceNotEmpty`` because the remedy differs: open it.
    """


class WorkspaceCorrupt(VisionSetError):
    """The workspace layout is present but unusable.

    A metadata store that is not a readable database, that carries no VisionSet
    schema, or that does not hold exactly one workspace row. Distinct from
    ``NotAWorkspace`` (nothing there) and from ``WorkspaceFormatTooNew``
    (readable, merely newer than this build).
    """


class WorkspaceFormatTooNew(VisionSetError):
    """The stored ``format_version`` is newer than this VisionSet understands.

    Migrations only ever run forward, so a workspace written by a later version
    is unreadable rather than silently downgraded.
    """


class InvalidName(VisionSetError):
    """A name was empty, or blank once surrounding whitespace was removed."""


class ProjectNameTaken(VisionSetError):
    """Another project in this workspace already uses that name.

    Names are unique per workspace, ignoring case and surrounding whitespace.
    The rule is enforced twice on purpose — see ``WorkspaceService``.
    """


class ProjectNotFound(VisionSetError):
    """No project with that id lives in this workspace.

    Deliberately not an ``EntityNotFound``: that one means a row was missing
    where the store required one (an ``update`` against a vanished primary key),
    which is a programming error. This one is the ordinary answer to a caller
    naming a project that was never created, or was deleted, or belongs to a
    different workspace — a delivery surface turns it into a 404, not a 500.
    """


class ConfirmationRequired(VisionSetError):
    """A destructive operation was called without ``confirm=True``.

    The guard is a parameter rather than a prompt because the kernel has no
    terminal and no user: every surface — CLI, REST, MCP — asks in its own
    idiom and then passes the answer down. Refusing by default means a caller
    that forgets to ask cannot delete anything by accident.

    This guards the destruction of *data*. Narrowing a *contract* — a schema
    version that removes a class — is guarded by ``allow_destructive`` and
    ``DestructiveSchemaChange`` instead, because the two have different
    remedies and should not be caught by one ``except``.
    """


class InvalidSchema(VisionSetError):
    """A proposed schema version is not a valid schema.

    Rules that span the whole version: two classes sharing a name, a geometry
    with no implementation. Per-class and per-attribute validity is pydantic's,
    enforced in ``domain/schema.py`` — a malformed ``LabelClass`` cannot be
    constructed in the first place, so it never reaches a service to be
    reported here.
    """


class UnsupportedGeometry(InvalidSchema):
    """A class was bound to a ``GeometryType`` that has no implementation.

    ``GeometryType`` names the whole roadmap; ``IMPLEMENTED_GEOMETRIES`` names
    the part of it an Annotation can actually carry. Declaring a class outside
    that set would create a class nobody could ever label, so it is refused at
    the schema rather than discovered at the first annotation.
    """


class SchemaNotFound(VisionSetError):
    """The project has no schema at all, or not the version that was asked for.

    A project is created without a schema — ``SchemaService.create_version``
    makes version 1 — so this is the ordinary answer for a project nobody has
    given an ontology to yet, not a sign of damage.
    """


class DestructiveSchemaChange(VisionSetError):
    """A proposed version narrows the contract and was not allowed to.

    Destructive means an annotation that was valid under the previous version
    would not be valid under this one: a class removed, a geometry changed, a
    required attribute added, a ``select`` narrowed. Pass
    ``allow_destructive=True`` to proceed — the flag exists so that narrowing
    is always a decision somebody made, never a side effect of an edit.
    """


class SchemaChangeWouldOrphan(VisionSetError):
    """A destructive change was refused because annotations already depend on it.

    Deliberately NOT a subclass of ``DestructiveSchemaChange``: there is no flag
    that overrides this one, and a caller that caught the base class and retried
    with ``allow_destructive=True`` would loop. Migrating existing annotations
    onto a new version is out of scope for M1, and until it exists the kernel
    refuses rather than leaving labels pointing at a class the contract no
    longer describes.
    """


class InvalidTransition(VisionSetError):
    """A state machine was asked to make a move that is not in its table.

    The legal moves are data — ``BATCH_TRANSITIONS`` and its siblings — so this
    is raised by consulting the table, never by a chain of hand-written guards
    that could disagree with it.
    """


class BatchNotFound(VisionSetError):
    """No batch with that id lives in this workspace.

    Like ``ProjectNotFound``, and for the same reason: a batch belonging to
    another workspace reads as missing rather than as forbidden, and a delivery
    surface turns it into a 404 rather than a 500.
    """


class BatchNotEditable(VisionSetError):
    """Membership was changed on a batch that is no longer a draft.

    Deliberately not an ``InvalidTransition``: nothing is transitioning, and the
    remedy is different. After approval the batch is partitioned into jobs
    against a pinned schema, so adding or removing an asset would leave a job
    describing work that no longer exists. Excluding an asset from that point on
    is a per-asset ``skipped`` decision, which is recorded rather than erased.
    """


class EmptyBatch(VisionSetError):
    """Approval was asked for on a batch with no assets.

    It would partition into no jobs at all, and a batch completes when all its
    jobs complete — so an empty approved batch is one that can never finish.
    """


class BatchNotComplete(VisionSetError):
    """A batch was told to complete while at least one of its jobs is not.

    Completion is *derived*: the service recomputes it from the jobs rather than
    taking the caller's word, because a batch marked complete is what lets its
    annotated assets be promoted into the Dataset.
    """


class JobNotFound(VisionSetError):
    """No annotation job with that id lives in this workspace.

    Like ``BatchNotFound`` and ``ProjectNotFound``: a job belonging to another
    workspace reads as missing rather than as forbidden.
    """


class BatchNotInAnnotation(VisionSetError):
    """Work was attempted on a job whose batch is not open for annotation.

    A batch is open only while it is ``in_annotation``. Before that it is still
    being curated or has only just been approved; after it, the work is closed.
    Either way, recording progress would be describing work on a batch nobody is
    working on.

    ``AnnotationService`` raises this too — writing an annotation into a job
    whose batch is not ``in_annotation`` is the same refusal, and there should be
    one error for it rather than two.
    """


class JobNotComplete(VisionSetError):
    """A job was told to complete while one of its assets is still unsettled.

    Sibling of ``BatchNotComplete``, and separate from it because the remedy
    differs: there, finish the jobs; here, deal with the assets — label them,
    skip them, or get the outstanding reviews done. ``SETTLED_PROGRESS`` names
    what counts as dealt with.
    """


class AssetNotInJob(VisionSetError):
    """An asset id was addressed in a job that does not carry it.

    A job's assets are fixed at approval, when the batch was partitioned. An
    asset outside that segment belongs to a different job, or to no job at all.
    """


class InvalidPartition(VisionSetError):
    """The proposed segments are not an exact partition of the batch.

    An asset in two jobs is two annotators labeling it unaware of each other; an
    asset in no job is a batch that can never complete. Both are silent failures,
    so the segments are checked against the batch rather than trusted.
    """


class AssetNotFound(VisionSetError):
    """An asset id does not belong to the project it was used in.

    Same rule as every other cross-scope reference in the kernel: an asset in a
    different project reads as missing, not as forbidden.
    """


class SchemaVersionConflict(VisionSetError):
    """Two writers raced for the same next version number, and this one lost.

    Version ``N + 1`` is computed from the versions already stored, so two
    concurrent ``create_version`` calls can agree on it; the unique index on
    ``(project_id, version)`` refuses the second. The remedy is to retry, which
    re-reads the maximum and lands on ``N + 2``.
    """
