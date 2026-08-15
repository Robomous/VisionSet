# usage: from visionset.kernel import EntityNotFound, VisionSetError
"""Domain errors raised by the kernel.

Every error the kernel raises derives from ``VisionSetError``, so a delivery
surface can translate the whole family to an HTTP status or an exit code with a
single ``except`` clause. The kernel NEVER raises a framework exception —
``HTTPException`` and friends belong to the boundary, not here.

Persistence, workspace, project, schema, batch, job, annotation, dataset, release,
media and token errors live here; later services add their own as they land.
"""

from __future__ import annotations


class VisionSetError(Exception):
    """Base class for every error the kernel raises."""

    index: int | None = None
    """Which item of a sequence the caller passed is the one at fault.

    A typed class-level default rather than a constructor parameter, so every
    error in this module is still constructible from one message and nothing in
    the hierarchy has to opt in. A service that takes a ``Sequence`` — today
    only ``AnnotationService.add``/``update``/``delete`` — sets it on the way
    out of its per-item loop; everything else leaves it ``None``.

    It is a kernel fact, not a delivery one: "the third annotation you gave me"
    is about the call, and a surface reporting a bulk write cannot recover the
    position afterwards because the refusal is raised before anything is
    written. ``server/errors.py`` publishes it as ``detail.index``.
    """


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
    """The workspace layout is present but unusable, whatever the cause.

    A metadata store that is not a readable database, that carries no VisionSet
    schema, or that does not hold exactly one workspace row — and also the
    environmental failures that leave nothing to work with: a file that cannot
    be opened, a disk I/O error, a full disk. Distinct from ``NotAWorkspace``
    (nothing there), from ``WorkspaceFormatTooNew`` (readable, merely newer than
    this build), and from ``WorkspaceBusy`` (fine, just held by someone else).

    "Corrupt" is the widest of these on purpose: it is where the adapter files
    everything it could not open, read or write for a reason the caller cannot
    fix by waiting. Splitting the causes further would invent errors nobody
    catches — the remedy for all of them is to look at the file and the disk.
    """


class WorkspaceBusy(VisionSetError):
    """Another connection holds the workspace and the wait ran out.

    Transient, unlike ``WorkspaceCorrupt``: nothing is wrong with the file,
    something else is writing to it. The remedy is to retry, which is the whole
    reason this is its own error rather than a flavour of corruption — a surface
    can answer it with a retry-after where corruption gets a hard failure.

    Raised when a write waited out the store's ``busy_timeout`` behind another
    writer. Under WAL a reader never reaches here, because readers do not
    contend with the writer at all.
    """


class WorkspaceFormatTooNew(VisionSetError):
    """The stored ``format_version`` is newer than this VisionSet understands.

    Migrations only ever run forward, so a workspace written by a later version
    is unreadable rather than silently downgraded.
    """


class WorkspaceSchemaMismatch(VisionSetError):
    """The stamped generation is one this build knows, and the schema is not.

    ``format_version`` says which generation a file holds, and the whole of that
    claim rests on every schema change arriving with a version to go with it.
    When one does not, a file carries the old shape under the current number and
    nothing about the stamp can tell it apart from a current file — the store
    opens it, and the first statement naming a column the file lacks fails deep
    inside a request, as an opaque 500 from a route with no connection to the
    real problem.

    So the store compares what it found against what it declares, and refuses
    here instead. Deliberately not a ``WorkspaceCorrupt``: nothing is damaged.
    This is a valid database of a different generation, and saying "corrupt"
    would send whoever reads it looking at their disk. It is also not a
    ``WorkspaceFormatTooNew``, which is about a *stated* difference; this is the
    difference nobody stated.

    The message names the table and the column, because the remedy depends on
    which way the gap runs and neither answer is guessable from "it broke".
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

    #: Which classes the change narrows — a ``tuple[str, ...]``, the blast radius
    #: a confirmation has to name.
    #:
    #: Names only, with no counts, and that is the whole difference from
    #: ``SchemaChangeWouldOrphan.blockers``. This refusal is about *intent* and is
    #: raised before anything on disk is consulted, so attaching counts here would
    #: put a walk over every asset in the project in front of the one refusal that
    #: does not need it — and would invert the "intent first, then facts on disk"
    #: ordering the two gates are built on. A caller who wants the counts asks
    #: ``SchemaService.preview``, which is what it is for.
    #:
    #: A class attribute rather than a constructor parameter, for the reason
    #: ``SchemaChangeWouldOrphan.blockers`` gives.
    classes: object | None = None

    def __init__(self, message: str, *, classes: object | None = None) -> None:
        super().__init__(message)
        if classes is not None:
            self.classes = classes


class SchemaChangeWouldOrphan(VisionSetError):
    """A destructive change was refused because annotations already depend on it.

    Deliberately NOT a subclass of ``DestructiveSchemaChange``: there is no flag
    that overrides this one, and a caller that caught the base class and retried
    with ``allow_destructive=True`` would loop. Migrating existing annotations
    onto a new version is out of scope for M1, and until it exists the kernel
    refuses rather than leaving labels pointing at a class the contract no
    longer describes.
    """

    #: Which classes stand in the way, and how many labels each carries — a
    #: ``tuple[ClassCount, ...]``.
    #:
    #: A class attribute with a ``None`` default and **not** a constructor
    #: parameter, exactly as ``VisionSetError.index`` and
    #: ``LossyExportNotConsented.compatibility`` are — so this error is still
    #: constructible from one message, ``ERROR_RULES``' exact-correspondence test
    #: is untouched, and ``test_every_mapped_error_can_be_constructed_with_one_argument``
    #: still holds. The service sets it as a keyword.
    #:
    #: Typed ``object`` because this module may not import a domain model; the
    #: type comes back at the boundary through an ``isinstance`` narrowing, which
    #: is the same round trip ``compatibility`` makes.
    blockers: object | None = None

    def __init__(self, message: str, *, blockers: object | None = None) -> None:
        super().__init__(message)
        if blockers is not None:
            self.blockers = blockers


class InvalidTransition(VisionSetError):
    """A state machine was asked to make a move that is not in its table.

    The legal moves are data — ``BATCH_TRANSITIONS`` and its siblings — so this
    is raised by consulting the table, never by a chain of hand-written guards
    that could disagree with it.
    """


class StaleWrite(VisionSetError):
    """Something moved between the caller's read and the caller's write.

    The concurrency sibling of ``InvalidTransition``: there the move was never in
    the table, here it was legal from the state the caller read and that state is
    no longer the stored one. Two annotators on one frame, or an agent and a
    person on one job — the second write was decided against an answer that had
    already expired.

    Refused rather than applied, because applying it is the defect this exists to
    close: a write judged against a state nobody is in any more lands on top of
    somebody else's and reports success for both. The message names where
    the asset actually is, so the remedy is exactly one round trip — read again,
    decide again, resubmit — and the caller never has to guess whether its own
    write survived.

    Deliberately **not** raised when the stored value is already the one asked
    for. Concurrency does not change what ``JobService.mark`` means: re-stating a
    state an asset is already in is a no-op, whoever else put it there.
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


class BatchImmutable(VisionSetError):
    """A completed batch was told to delete itself.

    ``DELETABLE_STATES`` is everything except ``completed``, and this holds
    **regardless of ``confirm``** — confirmation is for destroying something the
    caller is allowed to destroy, and answering ``ConfirmationRequired`` here
    would name a flag that does not work.

    ``BATCH_TRANSITIONS`` already says a completed batch has no exit. A delete
    that emptied one anyway would be an exit through the back door, and it would
    take the record with it: which assets were labeled, against which pinned
    schema version, and which were deliberately skipped. Releases, promotion and
    any later correction are all read against that.

    Separate from ``BatchNotEditable``, which is about *membership* in a batch
    that is very much still alive. This one says the batch itself stays.
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


class JobFinished(VisionSetError):
    """Work was attempted on a job that has already been completed.

    ``OPEN_JOB_STATES`` is the two states this allows. A ``completed`` job is a
    statement that every asset in it was dealt with, and ``JOB_TRANSITIONS``
    gives it no way back — so a label written into one, or a progress marker
    moved inside one, would be work the statement does not cover.

    Not a ``BatchNotInAnnotation``, on ``AssetNotWritable``'s reasoning. That one
    is about the *batch* — nobody opened it, or everybody closed it — and applies
    to every job in it at once. This one is about *this job* inside a batch that
    is still open, which is the ordinary case: a batch is partitioned into jobs
    that finish at different times, and the first to finish freezes its own
    frames while its neighbours carry on.

    The remedy is not a move: nothing re-opens a job. Correcting finished work is
    a correction batch, the same forward-only route a completed batch offers.
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


class AssetNotInBatch(VisionSetError):
    """An asset was named for a correction of a batch that never carried it.

    A correction batch is a correction *of what was in* its parent, so admitting
    an asset the parent never held would make the lineage a claim about nothing —
    the child would say "I correct that batch" while working on frames that batch
    never saw.

    The sibling of :class:`AssetNotInJob`, one level up: that one is about a
    partition, this one about membership. Two errors rather than one because the
    remedies differ — an asset outside a job is in another job of the same batch,
    while an asset outside a batch wants an ordinary new batch instead.
    """


class AssetNotWritable(VisionSetError):
    """Labels were written onto an asset whose progress says labeling is over.

    ``WRITABLE_PROGRESS`` is the two states this allows — ``unannotated`` and
    ``annotated`` — and the other three each record a decision: skipped, awaiting
    review, accepted by one. The write is refused rather than stored, because
    stored is worse: a ``skipped`` asset is left out of ``PROMOTABLE_PROGRESS``,
    so the labels would be accepted, kept, and then dropped at promotion with
    nothing telling anybody it happened.

    Not a ``BatchNotInAnnotation``, though the two fire on the same call and one
    reads much like the other. That one is about the *batch* — nobody opened it —
    and its remedy is to start it. This one is about *this asset* inside an open
    batch, and its remedy is to move the progress back where the transition table
    allows (``skipped -> unannotated``) or, where it does not, to correct the work
    in a new batch rather than behind the record's back.

    Not an ``InvalidAnnotation`` either: nothing is wrong with the annotation.
    Catching that base is safe precisely because every member of it is a defect
    in the payload, and this is a defect in the timing.
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


class BackgroundJobNotFound(VisionSetError):
    """No background job with that id lives in this workspace.

    The third error in this file saying "no job", and the third *entity* it says
    it about. ``JobNotFound`` is an annotation job — a slice of human work;
    ``IngestJobNotFound`` is one ingestion run; this is a row on the generic
    executor's queue. They share a word and nothing else, so they stay three
    classes for the reason ``IngestJobNotFound`` gives: one ``except`` catching
    all three would be catching them because of the English.
    """


class UnknownJobType(VisionSetError):
    """Nothing is registered to run work of that type.

    Raised at **enqueue**, not at dispatch, and that placement is the whole
    value: at enqueue there is still a caller to tell, while a job that reaches
    the dispatcher and finds no handler can only be marked failed on a row
    somebody has to go and read. It is therefore a refusal of the request rather
    than an outcome of the work.

    In practice it means one of two things and the message says which is likelier:
    a typo in a job type, or a handler module that was never imported — the
    registry is populated by import, so a type is only known once something has
    named it.
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
    """The annotation's geometry is not one its class accepts.

    A ``LabelClass`` declares a set of ``geometries``, so this is membership in
    **that class's** set. ``SchemaService.allowed_geometries`` is the union
    across a version's classes — the right answer to "what may this project
    draw?" and the wrong one here, where a polygon under a boxes-only class
    would sail through.
    """


class DuplicateClassificationTag(InvalidAnnotation):
    """This asset already carries a tag of this class.

    A ``ClassificationGeometry`` has **zero fields** and is frozen, so two tags
    of one class on one asset are the same statement made twice — not two facts
    the way two boxes under one class are. A partial unique index on
    ``(asset_id, label_class)``, restricted to tag geometry, makes it
    unrepresentable; this refusal is so a caller meets a sentence rather than a
    raw ``ConstraintViolated``.

    Deliberately inside the :class:`InvalidAnnotation` family even though it is
    the only one of the six that reads the *store* rather than the schema. What
    puts it here is the remedy, which is the family's rule: fix the annotation.
    There is no flag that overrides it and no state to change first — the tag is
    already there, which is what "already tagged" means.

    Raised for a duplicate **within one call** as well as against what is
    stored. ``add`` writes its whole list or none of it, so a request carrying
    the same tag twice would otherwise be refused by the index at commit time,
    where nothing can say which position was at fault.
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


class ExportFormatNotFound(VisionSetError):
    """No exporter is registered under that format name.

    Raised by the plugin registry in ``visionset.formats``, which is a *delivery*
    module and not the kernel — the kernel may not import it, and takes an
    ``Exporter`` instance rather than a name for exactly that reason. The class
    lives here anyway, with every other refusal, because a surface that invented
    its own error shape for this would be a second error contract.

    A missing format is the caller naming something that is not there, not a
    machine that is missing a tool: the sibling to compare it with is
    ``SourceNotFound``, not ``MediaToolUnavailable``. Installing a distribution
    that registers the format is what fixes it.
    """


class ExportSourceUnreadable(VisionSetError):
    """A release names bytes an export cannot use: gone, or not decodable.

    The remedy is ``ReleaseService.verify``, which says whether the blob is
    missing or corrupt, and then restoring it. A release is immutable, so the
    export cannot route around the asset — and it must not: a training set that
    is quietly one image short is worse than one that refused to be written, and
    that exact silence is what a previous generation of this tool shipped, an
    exporter whose blob read was wrapped in ``except Exception: pass``.

    **409 rather than 500**, the ``UnserializableManifest`` call: the request is
    well-formed and the defect is in stored state, so the message names the asset
    and reaches the caller instead of becoming an incident id. It names the asset
    id and the content hash and nothing else — a workspace path is not a client's
    business.

    Raised by a format plugin, through the reader ``ReleaseService.export``
    composes for it, which is why an implementation never sees a
    ``FileNotFoundError``.
    """


class LossyExportNotConsented(VisionSetError):
    """The chosen format cannot carry everything this release holds.

    A format declares ``lossy`` once, on the ``Exporter`` port, because it is a
    property of the format and not of a particular release — a bbox-only format
    drops a polygon whether or not today's dataset happens to contain one.

    Overridable, and the flag is ``allow_lossy`` rather than ``confirm``. Those
    two words guard different things and are never one ``except``: ``confirm=``
    guards destroying data and ``allow_destructive=`` guards narrowing a
    contract, while this guards *emitting an incomplete copy* of something that
    stays intact. Nothing in the workspace changes either way.
    """

    #: What the format would drop.
    #:
    #: A class attribute with a ``None`` default and **not** a constructor
    #: parameter, exactly as ``VisionSetError.index`` is — so this error is still
    #: constructible from one message, ``ERROR_RULES``' exact-correspondence test
    #: is untouched, and ``test_every_mapped_error_can_be_constructed_with_one_argument``
    #: still holds. The service sets it as a keyword.
    compatibility: object | None = None

    def __init__(self, message: str, *, compatibility: object | None = None) -> None:
        super().__init__(message)
        if compatibility is not None:
            self.compatibility = compatibility


class ThumbnailNotCached(VisionSetError):
    """No preview has been rendered for this asset.

    Not damage. ``Asset.thumbnail_hash`` is a cache key, so NULL has one meaning
    with three causes — an asset written before the cache existed, one whose
    bytes would not render, and one no run has reached yet — and none of them
    says anything about whether the content is still there.

    A 404 rather than an empty success because a caller asked for a specific
    thing that is not there, and because the remedy is a real one:
    ``IngestService.backfill_thumbnails`` reads exactly this state and fills what
    it can.
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


class TokenNotFound(VisionSetError):
    """No API token with that id or name lives in this workspace.

    The ``ProjectNotFound`` rule at workspace scope: a token belonging to a
    different workspace reads as *missing*, never as forbidden.

    Note what this is **not**. Presenting a token that does not verify — unknown,
    malformed or revoked — raises nothing at all: ``AuthProvider.verify`` answers
    ``False`` and the surface decides what that means. This error is for
    *administering* a token an operator named, not for failing to authenticate
    with one. Conflating the two would let a 404 on this error become an oracle
    for which secrets exist.
    """


class TokenNameTaken(VisionSetError):
    """Another token in this workspace already uses that name.

    The ``ProjectNameTaken`` rule, one entity over, and enforced twice for the
    same reason: the service checks before writing so the caller gets a sentence,
    and a unique index refuses the write so a race cannot slip past the check.

    Case-insensitive, like a project name and unlike a release tag. A token name
    is a label an operator reads back in a list and types into ``token revoke``,
    so ``ci`` and ``CI`` naming two credentials is a trap rather than a feature —
    and the name has to resolve to exactly one token for revocation by name to
    mean anything.
    """


class InferenceConnectionNotFound(VisionSetError):
    """No inference connection with that id or name lives in this workspace.

    The ``TokenNotFound`` rule, one entity over: a connection is workspace-scoped
    by living in this file, so "not here" and "never existed" are the same
    sentence and neither is a permission answer.
    """


class InferenceConnectionNameTaken(VisionSetError):
    """Another inference connection in this workspace already uses that name.

    Case-insensitive, on ``TokenNameTaken``'s terms and for its reason: the name
    is what a person reads in a list and types at a terminal, so ``local`` and
    ``Local`` naming two connections is a trap rather than a feature. Enforced
    twice — the service checks so the caller gets a sentence, and
    ``uq_inference_connection_name`` refuses the write so a race cannot pass the
    check.
    """


class InferenceConnectionInvalid(VisionSetError):
    """The parameters do not describe a usable connection of that kind.

    A local connection with no device, an HTTP one with no endpoint, or either
    carrying the other's parameters — the cross-field rule
    ``InferenceConnection`` enforces, in the kernel's own vocabulary.

    It exists because that rule is a *pydantic* refusal at the point it is
    caught, and letting a ``ValidationError`` out would break the rule
    ``_read_manifest`` states: no exception from outside the kernel's vocabulary
    escapes the kernel. The wire model cannot answer this instead — restating a
    cross-field rule on ``ConnectionCreate`` would be a second encoding of a
    domain invariant, which is the mirror this repo has paid for twice.
    """


class UnsupportedPrompt(VisionSetError):
    """The provider was asked in a way this model does not answer.

    A detector handed points, or a segmenter handed words. Not a harder question
    — a *different* one — and a provider that guessed which box the click meant
    would be inventing an answer nobody could check.

    A payload error rather than a state one, on ``DuplicateClassificationTag``'s
    reading: nothing about the connection needs to change and no wait helps, so
    "change the state and resubmit" would be a promise that cannot be kept. What
    is wrong is the request, and the remedy is a different prompt or a different
    connection.

    Sits beside ``UnsupportedGeometry`` and ``UnsupportedMedia`` on purpose:
    all three say "this is well formed and this build has nothing that consumes
    it", which is one thought worth spelling one way.
    """


class PromptPointOutOfBounds(VisionSetError):
    """A prompt point names a place that is not on the asset.

    Prompt coordinates are in the asset's own pixel frame, so a point past its
    width or height is a question about nothing. A segmenter handed one does not
    fail — it returns a mask with a confidence attached — and that confidence is
    about a place nobody asked about, which is worse than an error because it
    looks like an answer.

    Not clamped onto the nearest edge, and the difference from a drag is the
    whole reason: a drag that left the picture still means "make the box this
    big", while a point off the picture is not a point on anything, and moving
    it would place a prompt somebody never gave.

    ``UnsupportedPrompt``'s sibling in status and its opposite in remedy — that
    one wants a different kind of prompt or a different connection, this one
    wants a different coordinate with everything else unchanged — which is why
    it carries its own code rather than folding into it.
    """


class InferenceConnectionNotDownloadable(VisionSetError):
    """This connection cannot be asked to fetch weights.

    Two ways to arrive and one answer, because the remedy for both is to stop
    asking: the connection is already set up, so there is nothing left to fetch;
    or it is an ``http`` connection, which has no weights of its own at all. The
    message says which.

    The refusal `CONNECTION_GATES` and `CONNECTION_KINDS` describe, raised
    through ``connection_actions`` rather than beside it — so a client that
    renders ``allowed_actions`` and a caller that asks anyway get the same
    answer from the same table, and narrowing the gate narrows both.
    """


class WeightsDamaged(VisionSetError):
    """A cached snapshot's files do not match what the hub published.

    The verdict of an integrity check, and the only error in this module that is
    raised **after** the state it describes has already been written: by the
    time it surfaces the damaged blobs are gone and the connection is back to
    ``not_set_up``. That is the point of it rather than a wrinkle — a caller
    reading this sentence is being told what was found *and* what was done
    about it, and the remedy it names is an action the connection now declares.

    Not a sibling of ``LocalInferenceUnavailable``, which the same check raises
    when it could not reach the hub: that one is an absence of evidence and
    changes nothing, while this is evidence.

    The message names the files, because a count tells somebody looking at a
    disk nothing about which disk.
    """


class InferenceConnectionNotCheckable(VisionSetError):
    """This connection's weights cannot be re-read, because they are not here.

    ``InferenceConnectionNotDownloadable``'s sibling and not its synonym.
    Two ways to arrive, and unlike that one they do not share a remedy: an
    ``http`` connection has no files here in any state, while a ``local`` one at
    ``not_set_up`` is one download away from being checkable. The message says
    which, and names the download where there is one.

    The refusal ``CONNECTION_GATES`` and ``CONNECTION_KINDS`` describe for
    ``check_integrity``, raised through ``connection_actions`` rather than beside
    it — so the declaration a client rendered and the answer a caller gets come
    from the same table.
    """


class InferenceConnectionNotSetUp(VisionSetError):
    """A local connection was asked to predict before its weights arrived.

    Genuinely change-the-state-and-resubmit, which is what separates it from
    ``InferenceConnectionNotRunnable`` below: the state to change is real, the
    action that changes it is ``download_weights``, and the identical request
    succeeds afterwards. The message names that action, because "not set up" on
    its own tells an operator what they already knew.
    """


class InferenceConnectionNotRunnable(VisionSetError):
    """Nothing in this build can run a connection of that kind.

    The ``MediaToolUnavailable`` reading, one layer up: this answers "what is
    missing from this software?" rather than "what is wrong with this
    connection?". An ``http`` connection is perfectly well formed and perfectly
    unusable here, because the adapter that would speak to an endpoint is a
    later slice — and no amount of editing the row, waiting, or retrying changes
    that. It is deliberately **not** a sibling of
    ``InferenceConnectionNotSetUp``: one is a state a user can leave, the other
    is a version of this program they do not have.

    The message carries what a reader can act on, which is the kind that was
    asked for and the fact that this build has no adapter for it.
    """


class LocalInferenceUnavailable(VisionSetError):
    """Running a model locally needs the optional runtime, and it is absent.

    ``MediaToolUnavailable``'s exact shape, and it is here for the same three
    reasons that error gives. It answers "what is wrong with this machine?",
    never "what is wrong with this connection?" — so a run that hits it records
    one fatal cause rather than blaming the configuration it was handed. It is
    not transient, so it is not a 503: retrying never succeeds until somebody
    installs the extra. And the **message is the remedy**, carrying the exact
    command, because an error that merely says "unavailable" has told an
    operator nothing they had not already worked out.

    Which command that is lives at the raise site, in ``visionset.inference``,
    for the reason ``MediaToolUnavailable`` is "named for the tool rather than
    for the program": the kernel does not know what the extra is called, and
    should not learn — it knows only that something outside it declined to be
    importable.

    Being raised at all is a fact about the *installation*, never about the
    domain, which is why no capability is gated on it: ``download_weights`` is
    declared on a connection whose state permits it and refused here if the
    machine cannot carry it out. Hiding the control instead would be the bare
    disabled control design principle 9 forbids, and would leave the install
    command with nowhere to be shown.
    """
