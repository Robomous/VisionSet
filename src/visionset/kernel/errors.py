# usage: from visionset.kernel import EntityNotFound, VisionSetError
"""Domain errors raised by the kernel.

Every error the kernel raises derives from ``VisionSetError``, so a delivery
surface can translate the whole family to an HTTP status or an exit code with a
single ``except`` clause. The kernel NEVER raises a framework exception —
``HTTPException`` and friends belong to the boundary, not here.

Persistence, workspace, project, schema, batch, job, annotation, dataset, release
and media errors live here; later services add their own as they land.
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

    Two methods are deliberately exempt, and both are somebody's ordinary edit
    loop rather than the destruction of a lifecycle entity:

    - ``AnnotationService.delete`` — drawing a box, looking at it and taking it
      off again is annotating. The batch gate is the guard: once the work closes,
      nothing can touch those labels at all.
    - ``DatasetService.remove_asset`` — curating the trunk. Nothing is destroyed:
      the asset, its annotations and its blob all stay, and the append-only
      change log records the removal, so the state before it is still on record
      and re-promoting is an informed decision rather than an undo nobody kept.

    An exemption is a decision written down here. Do not add a third without one.
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
    """The batch is not finished, said by whichever service needed it to be.

    Two readings, one refusal, on purpose — the precedent is
    ``BatchNotInAnnotation``, which ``JobService`` and ``AnnotationService``
    share rather than spelling twice:

    - ``BatchService.complete`` raises it when a job is still outstanding.
      Completion is *derived*: the service recomputes it from the jobs rather
      than taking the caller's word.
    - ``DatasetService.promote`` raises it when the batch never reached
      ``completed`` at all.

    Both say the same thing to a caller — this batch's work is not done — and
    both have the same remedy, which is to finish it. A second error would only
    make a surface catch two names for one condition. And the reason the gate is
    there in the first place is the second reading: a completed batch is exactly
    what lets its annotated assets into the Dataset.
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


class SourceNotFound(VisionSetError):
    """A source id does not belong to the project or workspace it was used in.

    Same rule as every other cross-scope reference in the kernel: a source in a
    different project reads as missing, not as forbidden.

    Note what this is *not*. A path that does not exist on disk is a
    ``FileNotFoundError`` and a path that is a file where a directory was wanted
    is a ``NotADirectoryError`` — both are about the machine, not about the
    workspace, and both stay outside the ``VisionSetError`` tree for the reason
    ``MediaToolUnavailable`` sits outside ``MediaError``.
    """


class IngestJobNotFound(VisionSetError):
    """No ingest job with that id lives in this workspace.

    Deliberately **not** ``JobNotFound``, which is an *annotation* job. The two
    are different entities with different lifecycles, and a single ``except``
    catching both would be catching two things because they share a word.
    """


class SchemaVersionConflict(VisionSetError):
    """Two writers raced for the same next version number, and this one lost.

    Version ``N + 1`` is computed from the versions already stored, so two
    concurrent ``create_version`` calls can agree on it; the unique index on
    ``(project_id, version)`` refuses the second. The remedy is to retry, which
    re-reads the maximum and lands on ``N + 2``.
    """


class InvalidAnnotation(VisionSetError):
    """An annotation does not satisfy the schema version its batch pinned.

    The base of the five refusals below, so a delivery surface can turn the
    whole family into one 422 without enumerating them. Catching it is safe in
    a way catching ``DestructiveSchemaChange`` is not: there is no flag that
    overrides any of these, so a caller that catches the base cannot retry its
    way into a loop. The remedy is always to fix the annotation, or to write a
    schema version that describes it.

    Per-*value* validity is not here — an annotation whose ``confidence`` is
    outside [0, 1], or whose ``provenance`` is ``'model'`` with no
    ``model_ref``, cannot be constructed at all (``domain/annotation.py``), so
    it never reaches a service. This family is what needs the schema to judge.
    """


class LabelClassNotInSchema(InvalidAnnotation):
    """The annotation names a class the pinned version does not declare.

    Matched by exact name, like everything else that resolves a class — see
    ``domain/schema_diff.py``. A class the *project* has since added does not
    help: the batch pinned a version at approval, and that is what its work is
    judged against.
    """


class DisallowedGeometry(InvalidAnnotation):
    """The annotation's geometry is not the one its class is bound to.

    A ``LabelClass`` declares a single ``geometry``, so this is an equality
    test, not a membership one. ``SchemaService.allowed_geometries`` is the
    union across a version's classes — the right answer to "what may this
    project draw?" and the wrong one here, where a polygon under a bbox class
    would sail through.
    """


class MissingRequiredAttribute(InvalidAnnotation):
    """The class asks for an attribute value the annotation does not carry.

    ``required`` and ``default`` are independent: a default is what a surface
    should offer, not a value the kernel fills in. Substituting one here would
    invent data nobody entered.
    """


class UnknownAttribute(InvalidAnnotation):
    """The annotation carries an attribute the class does not declare.

    Refused rather than dropped, for the same reason ``extra='forbid'`` is on
    the schema models: a misspelled key that stores quietly is a value the
    annotator believes they recorded and nobody will ever read.
    """


class InvalidAttributeValue(InvalidAnnotation):
    """An attribute value is the wrong type, or outside a ``select``'s options.

    The judgement is ``Attribute.rejects``, the same method the attribute's own
    ``default`` is checked with, so a value and a default can never be held to
    different standards.
    """


class DatasetNotFound(VisionSetError):
    """No dataset with that id lives in this workspace.

    Like ``ProjectNotFound`` and its siblings: a dataset belonging to another
    workspace reads as missing rather than as forbidden.

    Distinct from the ``WorkspaceCorrupt`` a project with no dataset raises. That
    one means the 1:1 invariant broke on disk — every project is created with a
    dataset, in the same transaction — whereas this is the ordinary answer to a
    caller naming an id that was never a dataset, or whose project is gone.
    """


class AnnotationNotFound(VisionSetError):
    """No annotation with that id lives in this workspace.

    Like ``ProjectNotFound`` and ``JobNotFound``: an annotation belonging to
    another workspace reads as missing rather than as forbidden.
    """


class ReleaseNotFound(VisionSetError):
    """No release with that id lives in this workspace.

    Like ``DatasetNotFound`` and its siblings: a release belonging to another
    workspace reads as missing rather than as forbidden.
    """


class ReleaseTagTaken(VisionSetError):
    """Another release of this dataset already carries that tag.

    The ``ProjectNameTaken`` rule, one scope down, and enforced twice for the
    same reason: the service checks before writing so the caller gets a sentence,
    and a unique index refuses the write so a race cannot slip past the check.

    Case-sensitive, unlike a project name. A tag is an identifier a person types
    once and a script repeats — closer to a git tag than to a display name — so
    ``v1.0`` and ``V1.0`` are two releases, and the pre-check compares exactly
    what the index compares.
    """


class EmptyRelease(VisionSetError):
    """Publication was asked for on a dataset with nothing in it.

    The ``EmptyBatch`` sibling: a release of no assets is an artifact nobody can
    train on, and the remedy is to promote a completed batch first.

    A release with assets but no *annotations* is a different matter and is
    allowed — unlabeled images are legitimate training data, and refusing them
    would rule out the background-and-negatives set on purpose.
    """


class NoSplitRecipe(VisionSetError):
    """A split was asked of a release that was published without a recipe.

    Not an error in the release: a release with no recipe is the ordinary
    default, and it means the whole snapshot is one undivided set. Inventing an
    all-train assignment here would answer a question nobody asked, and the
    caller cannot tell the invention from a real recipe afterwards.
    """


class UnserializableManifest(VisionSetError):
    """A manifest holds a value canonical JSON cannot express.

    In practice that is a NaN or infinite coordinate: ``Geometry`` accepts any
    float, so such an annotation can be written and stored, and it is only when
    a release tries to freeze it that the problem surfaces. Refused rather than
    written as ``null`` or as the token ``NaN`` — the first loses data silently
    and the second produces a document no other tool can parse, in a file whose
    whole purpose is to be verifiable.
    """


class MediaError(VisionSetError):
    """A media file could not be turned into an asset, and this says which one.

    The base of the two refusals below, so an ingest run can catch the family
    once, record the failure against the item it was reading, and carry on with
    the next file — which is the whole point of a *per-file* error. Catching the
    base is safe in the way catching ``InvalidAnnotation`` is safe and catching
    ``DestructiveSchemaChange`` is not: neither child has a flag that overrides
    it, so nothing here can be retried into a loop.

    Structured, unlike every other error in this module, and the only one with a
    constructor. Two concrete reasons. An ingest job persists a per-file error
    report, and rebuilding one by re-parsing ``str(exc)`` means parsing a
    sentence written for a human. And ``Exception.args[0]`` is ``Any``, so under
    mypy-strict a typed report needs typed attributes to read.

    ``name`` is whatever the caller called the stream — a path for a file on
    disk, something like ``clip.mp4#frame=42`` for a decoded video frame,
    ``None`` for bytes nobody named. It is **reporting, never identity**: nothing
    looks a file up by it, and a caller that already knows which item it was
    iterating should key its report on that rather than on this. ``reason`` never
    repeats the name; the name is a field, and a report that spelled it into every
    sentence would be a list of strings rather than a table.

    Named for media rather than for images because the video processor raises the
    same two: a codec ffmpeg will not open is ``UnsupportedMedia`` and a truncated
    clip is ``CorruptMedia``. The split is by *remedy*, not by modality — a
    modality split would have produced four errors describing two situations.
    """

    def __init__(self, reason: str, *, name: str | None = None) -> None:
        super().__init__(f"{name or '<unnamed stream>'}: {reason}")
        self.name = name
        self.reason = reason


class UnsupportedMedia(MediaError):
    """The bytes are not something VisionSet accepts, and never will be as they are.

    Three readings, one refusal: not an image at all (a README that happened to
    be in the folder), an image in a format outside ``ImageFormat``, and an image
    declaring so many pixels that decoding it is a denial of service rather than
    an ingest. All three end the same way — the file does not enter the dataset —
    and all three are the operator's to fix, by not pointing at it, by converting
    it, or by asking for the format to be accepted.

    Deliberately not split into ``NotAnImage`` and ``UnsupportedFormat``. A
    decoder cannot reliably tell them apart: an unidentifiable container and an
    exotic one both come back as "I do not know what this is", so the split would
    be a distinction the kernel guesses at and a caller cannot act on.

    Distinct from ``CorruptMedia`` because the remedies are opposite. This one
    says the file is intact and is not for us; that one says the file is for us
    and is broken. An ingest report that could not separate the two would bury
    real data loss under ordinary operator noise.
    """


class CorruptMedia(MediaError):
    """An accepted format whose bytes will not decode.

    A truncated download, a half-written copy, a bad sector. The header is
    convincing enough to identify — which is why this is not ``UnsupportedMedia``
    — and the pixels are what fail.

    Raised by *decoding*, never by inspecting. A header says what a file claims
    to be, and admitting a file on that claim is how a dataset acquires an asset
    whose bytes nobody can read until a training run trips over it. That is why
    probing pays for a full decode per file instead of sniffing.
    """


class MediaToolUnavailable(VisionSetError):
    """A media adapter needs an external program, and it is not installed.

    Deliberately **not** a ``MediaError``, and the distance is the whole point.
    Every error in that family answers "what is wrong with this file?"; this one
    answers "what is wrong with this machine?". An ingest catches the media
    family per item and carries on, so if this were in it, a missing decoder
    would be recorded five thousand times against five thousand innocent files
    and the run would report a data problem it does not have. It is the *fatal
    cause* an ingest job records once, next to the per-file report.

    Named for the tool rather than for the program, because the kernel does not
    know which program: only the adapter does, and only the adapter spells its
    name. The message is where that lands, and it carries an install hint — the
    remedy here is a package manager, so an error that merely says "unavailable"
    has told the operator nothing they did not already suspect.
    """
