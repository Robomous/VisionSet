"""Persistence port: repositories, a unit of work, and the store that owns them.

Nothing here knows about SQL. The port speaks in domain models and UUIDs only —
translating those into rows is the adapter's job, which is exactly why a service
written against this file cannot accidentally depend on SQLite.
"""

from __future__ import annotations

from collections.abc import Sequence
from contextlib import AbstractContextManager
from datetime import datetime
from typing import Final, Protocol, runtime_checkable
from uuid import UUID

from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationSchema,
    AnnotationTotals,
    Asset,
    AssetProgress,
    BackgroundJob,
    Batch,
    ClassShape,
    Dataset,
    DatasetChange,
    DatasetMember,
    InferenceConnection,
    IngestJob,
    Project,
    Release,
    SchemaDraft,
    Source,
    TaskGroup,
    Token,
    Workspace,
)

#: ``format_version`` of a store whose schema has not been created yet.
#:
#: Part of the port, not of one adapter: telling "never initialized" apart from
#: "initialized at generation N" is how a caller decides whether a file is a
#: workspace at all, and it must not have to import an adapter to ask.
UNINITIALIZED: Final = 0


class Repository[T](Protocol):
    """Storage for one entity type, addressed by UUID.

    Every entity in the domain has at most one parent — a Project belongs to a
    Workspace, an Annotation to an Asset — so a single ``parent_id`` filter
    covers every scoped read the services need, and no query language leaks into
    the port.

    ``add`` and ``update`` are deliberately separate rather than one upsert: a
    service that inserts a duplicate, or updates something that was deleted, has
    a bug and should hear about it instead of silently overwriting.

    Any write may raise ``ConstraintViolated`` — a missing parent, or a
    uniqueness rule the store enforces. That ends the transaction, so it cannot
    be caught and recovered from inside a unit of work.
    """

    def add(self, entity: T) -> T:
        """Insert. Raises ``EntityAlreadyExists`` if the id is already stored."""
        ...

    def update(self, entity: T) -> T:
        """Replace by id. Raises ``EntityNotFound`` if the id is not stored."""
        ...

    def get(self, entity_id: UUID) -> T | None: ...

    def list(self, parent_id: UUID | None = None) -> list[T]:
        """All entities, or only those under ``parent_id``.

        Ordering is insertion order. Passing a ``parent_id`` for a root entity
        that has no parent raises ``ValueError``.
        """
        ...

    def delete(self, entity_id: UUID) -> bool:
        """Remove by id; returns False if it was not there."""
        ...


@runtime_checkable
class UnitOfWork(Protocol):
    """One transaction, with a repository per entity type.

    The scope of a unit of work is one operation on a Project aggregate: open
    it, do the whole operation, let it close. Everything inside commits together
    or not at all — a batch approval that partitions into jobs must never leave
    half its jobs behind.

    The repositories are read-only properties rather than attributes because a
    mutable protocol attribute is invariant: an adapter would then have to hand
    back exactly ``Repository[Project]`` and never its own implementation of it.
    """

    @property
    def workspaces(self) -> Repository[Workspace]: ...

    @property
    def projects(self) -> Repository[Project]: ...

    @property
    def schemas(self) -> Repository[AnnotationSchema]: ...

    @property
    def schema_drafts(self) -> Repository[SchemaDraft]: ...

    @property
    def sources(self) -> Repository[Source]: ...

    @property
    def ingest_jobs(self) -> Repository[IngestJob]: ...

    @property
    def assets(self) -> Repository[Asset]: ...

    @property
    def batches(self) -> Repository[Batch]: ...

    @property
    def task_groups(self) -> Repository[TaskGroup]: ...

    @property
    def annotation_jobs(self) -> Repository[AnnotationJob]: ...

    @property
    def annotations(self) -> Repository[Annotation]: ...

    @property
    def datasets(self) -> Repository[Dataset]: ...

    @property
    def dataset_members(self) -> Repository[DatasetMember]: ...

    @property
    def dataset_changes(self) -> Repository[DatasetChange]: ...

    @property
    def releases(self) -> Repository[Release]: ...

    @property
    def jobs(self) -> Repository[BackgroundJob]:
        """The background executor's queue.

        The **second** root entity, after ``Workspace``, and the only other place
        ``list()`` with no argument is the correct call — a job has no parent, so
        there is nothing to scope it by. See ``JobRow`` for why it carries no
        foreign key, and ``BACKGROUND_JOBS`` in ``_mappers`` for the trap that
        makes this worth saying out loud.
        """
        ...

    @property
    def inference_connections(self) -> Repository[InferenceConnection]:
        """Where inference may be asked to run, as configured by a person.

        The **third** root entity, and a root for the same reason the second is:
        a connection belongs to the workspace, the workspace is this file, so
        ``list()`` with no argument is the correct read rather than the
        every-row-in-the-table trap it is on a scoped entity.

        A plain repository and no narrow write beside it: nothing here is
        contended the way progress and the job queue are, because a connection is
        edited by a person in a form rather than by two writers racing.
        """
        ...

    def claim_job(self, *, worker: str, now: datetime) -> BackgroundJob | None:
        """Take the oldest queued job, atomically, or answer ``None``.

        **The second write here that is not a repository**, and it is here for
        exactly :meth:`set_asset_progress`' reason: ``Repository.update``
        replaces a whole entity read a moment earlier, and between that read and
        that write is a window a second dispatcher fits into — with the symptom
        being one job run twice and one row reporting whichever finished last.
        Narrowing it to a guarded ``UPDATE`` makes two claims disjoint by
        construction.

        The guard is ``state = 'queued'`` on the row the sub-select picked, so
        the choosing and the taking happen in one statement. ``rowcount`` is the
        answer, the way it is for progress: one means this caller holds the job,
        zero means somebody else got there first and the caller simply asks again.

        ``now`` is passed in rather than read here, because this is the layer that
        must not decide anything: the same instant stamps ``started_at`` and is
        reported in whatever the caller logs, and a store reaching for a clock is
        a store a test cannot pin.

        Answers ``None`` when the queue is empty **and** when a race was lost.
        The two are indistinguishable to a dispatcher and both mean "poll again",
        so distinguishing them would be a return value nobody could act on.
        """
        ...

    def set_asset_progress(
        self,
        job_id: UUID,
        asset_id: UUID,
        *,
        expected: AssetProgress,
        progress: AssetProgress,
        touched_at: datetime,
    ) -> AssetProgress | None:
        """Move one asset's progress, and only if it is still where it was read.

        **A write that is not a repository**, like :meth:`claim_job`, and for the
        same reason: ``Repository`` replaces a whole entity by id, and an
        ``AnnotationJob`` carries every asset's progress. Two annotators moving
        *different* assets of one job would therefore write the same entity, and
        the second would put back the copy of the map the first had already
        changed — a lost update that answers ``200`` on the wire. Narrowing the
        write to one asset makes those two disjoint by construction, and there is
        no way to say that in terms of ``Repository`` without giving projects and
        tokens a per-asset method as well.

        ``expected`` is what the caller read before it decided, and it is checked
        **in the same statement that writes**, so nothing can move in between. It
        is the version stamp this row already has: the contended datum is the
        progress itself, so a separate version column would only be a second name
        for it — and a second thing to keep in step.

        Returns ``None`` when the write landed. Returns the **stored** value when
        it did not, which is the whole answer the caller needs: it says both that
        the write was refused and where the asset actually is. A caller finding
        its own target there has nothing left to do.

        ``touched_at`` is stamped on the row **in the same statement**, so the
        record of when somebody worked this frame is as atomic as the move it
        records and there is no window in which one landed without the other. It
        is passed in rather than read here, on ``claim_job``'s terms: an adapter
        that reaches for a clock is one a test cannot place in time.

        A refused write stamps nothing, which is the behaviour worth having:
        losing a race is not work, and a caller whose move was rejected did not
        touch the frame.

        Raises ``EntityNotFound`` if the job does not carry that asset at all,
        matching ``Repository.update`` on an id that is not stored.
        """
        ...

    def last_touched(self, job_id: UUID) -> datetime | None:
        """When somebody last moved any of this job's assets, or NULL if nobody has.

        The read side of :meth:`set_asset_progress`'s stamp, and a named
        aggregate rather than a repository scan for ``annotation_totals``'
        reason: ``Repository[AnnotationJob]`` answers whole jobs, and a caller
        ranking every open batch in a workspace by recency wants one number per
        job rather than every asset's progress map.

        NULL means the whole job predates the column or nobody has worked it
        since — deliberately one answer rather than two, because a caller ranking
        by recency treats both the same way and telling them apart would need a
        second timestamp nobody records.

        A caller ranking many jobs pays one query each. That is the same N+1 the
        workspace summary already accepts elsewhere, and if it starts to cost the
        fix is a form of this method taking several job ids — never a SQLAlchemy
        import in a service.
        """
        ...

    def add_batch_assets(self, batch_id: UUID, asset_ids: Sequence[UUID]) -> list[UUID]:
        """Append assets to a batch's membership, skipping any it already holds.

        **The membership twin of :meth:`set_asset_progress`, and it exists for
        the identical reason.** ``batch_asset`` is keyed ``(batch_id,
        asset_id)`` — one row per member, which is exactly the shape a disjoint
        write wants — but a ``Batch`` carries every member, so two callers
        adding *different* assets to one draft would write the same entity
        through ``Repository.update`` and the second would put back the membership
        the first had already changed, both answering ``200``. Narrowing the write
        to one row makes those two disjoint by construction.

        There is **no ``expected``** here, and that is the difference from
        ``set_asset_progress`` rather than an omission: progress is a value that
        moves between states, so the caller has one to have read. Membership is
        row *existence*, which is its own version stamp — the row is either
        there or it is not, and the insert says which. That is also why no
        version column appears: it would be a second name for the same fact.

        Returns the ids this call actually wrote, in the order given. An id the
        batch already holds is **absent from the return and is not an error**:
        adding a member twice is not new information, and a caller that lost the
        race to a writer aiming at the same asset finds its target already true,
        which is nothing left to do. The count is what a surface reports.

        Position — and so the batch's asset order — is assigned by appending
        after the current maximum, evaluated inside the writing statement rather
        than read first, so two concurrent appends cannot land on one number.

        Raises ``EntityNotFound`` if there is no such batch, matching
        ``Repository.update`` on an id that is not stored. Assets are *not*
        checked against the project here: that is a domain rule and belongs to
        the service that already reads them.
        """
        ...

    def remove_batch_assets(self, batch_id: UUID, asset_ids: Sequence[UUID]) -> list[UUID]:
        """Drop assets from a batch's membership, ignoring any it does not hold.

        The other half of :meth:`add_batch_assets`, and symmetric with it: one
        row per asset, so two callers removing different assets cannot undo each
        other. Returns the ids this call actually removed; an id the batch does
        not hold is absent from the return and is **not** an error, for the same
        reason a repeated add is not — the state the caller wanted already
        holds.

        Positions are left as they are rather than closed up. They order the
        membership and nothing reads them as a dense sequence, so renumbering
        would be a whole-collection write reintroduced to tidy a gap nobody can
        see.

        Raises ``EntityNotFound`` if there is no such batch.
        """
        ...

    def batches_holding(self, asset_id: UUID) -> list[UUID]:
        """Which batches carry this asset, oldest membership first.

        **The one read here that is not a repository**, and it is the shape
        ``Repository`` deliberately cannot express: membership is a join table
        with a composite key, and every scoped read the repositories serve is one
        ``parent_id`` filter in the other direction — a batch's assets. This is
        the same edge walked backwards, which is a different question and has no
        parent to filter on.

        A method rather than a widened ``Repository[Batch]``: that protocol is
        generic over every entity, so a batch-specific lookup on it would appear
        on projects and releases and tokens as well.

        Ids, not entities, for the reason ``member_asset_ids`` returns ids: the
        join table already holds exactly this and hydrating a batch to answer
        "which ones" is work the caller may not need. ``BatchService.holding``
        does the hydration for the callers that do.

        An asset in no batch answers ``[]`` — the ordinary state of anything
        freshly ingested into a project whose ingest targeted nothing, not an
        error.
        """
        ...

    def add_schema_version_unless_annotated(
        self, schema: AnnotationSchema, guarded_shapes: frozenset[ClassShape]
    ) -> AnnotationSchema | None:
        """Publish the version, and only if none of ``guarded_shapes`` is in use.

        ``Repository.add`` with the orphan check moved **inside the statement that
        writes**, which is :meth:`set_asset_progress`' bargain and is here for the
        same reason. ``SchemaService`` reads how many annotations use each class
        it is about to drop and then inserts; those two sit in one
        ``unit_of_work``, but a unit of work is not a snapshot — the reads run
        before this transaction has written anything, so a label committed
        between them is invisible to the count and orphaned by the insert. The
        window is one walk over every asset in the project, so it is wide, and it
        grows with the project.

        ``guarded_shapes`` is what the caller decided it may remove, so the
        contended datum is *whether any annotation carries one of them* — a
        predicate, not a row, which is why there is no version column to compare:
        a stamp on the schema would say nothing about the annotations, and a
        stamp on every annotation would be a second name for the rows themselves.

        **A pair, never a class name.** An annotation carries one class and one
        shape, so that pair is the grain the question has; guarding by name
        refuses a change that takes one shape from a class whose labels all carry
        another, which orphans nothing. ``orphanable_shapes`` computes the set and
        owns the argument for what belongs in it. — #592

        Empty ``guarded_shapes`` means an unguarded insert. A change that removes
        nothing has nothing to orphan, and a predicate over an empty set would
        refuse to say so.

        Answers the stored version when the write landed and ``None`` when the
        guard refused it, on ``claim_job``'s terms: the caller knows what it
        proposed, so the refusal carries no payload and the caller re-reads the
        counts to say which class it lost to. Nothing is written either way — a
        refused publish leaves no version behind.

        **What this relies on**, stated because it is not "SQLite serializes
        writers": a single ``INSERT`` whose ``WHERE NOT EXISTS`` is evaluated as
        part of the same statement. Every SQL engine evaluates a statement
        atomically against committed state, so the predicate cannot be true when
        it is tested and false when the row lands. On a backend with snapshot
        isolation a concurrent *uncommitted* annotation is still invisible to the
        predicate and would commit afterwards; closing that needs a shared row
        both transactions touch, which would put a write on every annotation, and
        is deliberately not done here.
        """
        ...

    def repin_batch_unless_annotated(
        self, batch_id: UUID, schema_version: int, guarded_shapes: frozenset[ClassShape]
    ) -> bool:
        """Move the batch's pin, and only if none of ``guarded_shapes`` is in use *here*.

        :meth:`add_schema_version_unless_annotated` one scope down, and the scope
        is the whole difference: a re-pin can only orphan labels written into
        this batch, so the predicate walks its membership rather than the
        project. ``BatchService.repin`` has the same read-then-write window for
        the same reason.

        ``True`` when the pin moved, ``False`` when the guard refused it. Empty
        ``guarded_shapes`` is an unguarded update, as above, and the pair rather
        than the name is the grain here too.

        Raises ``EntityNotFound`` if there is no such batch — which tells that
        apart from a guard that fired, since both would otherwise write nothing.
        """
        ...

    def annotation_totals(self, project_id: UUID) -> AnnotationTotals:
        """How much of this project is labeled, in two numbers.

        **The method two service docstrings already asked for by name.** Both
        ``ProjectService.stats`` and ``JobService.project_progress`` describe the
        same remedy in the same words — *"when it does start to cost, the fix is
        a method on the port implemented in the adapter, never a SQLAlchemy
        import in a service"* — and this is that method, taken when a caller
        finally appeared that walks every project at once.

        The cost it removes is not incidental. ``Repository[Annotation]`` is
        parented on the **asset**, so counting a project's labels through the
        repositories is one query per asset; a workspace summary doing that for
        every project reads the whole store to produce a single number. Here it
        is one aggregate.

        Counts rather than the rows, because the caller wants the numbers: the
        rows are the expensive half and nothing that asks this needs them.

        Not a widened ``Repository``: that protocol is generic over every entity,
        so a project-scoped count on it would appear on tokens and releases as
        well and mean nothing there. ``batches_holding`` is the precedent for a
        read that lives here instead.

        A project with no assets, or with assets nobody has labeled, answers two
        zeros — the ordinary state of a fresh ingest, not an error. An unknown
        project answers two zeros too: existence is the caller's question and
        every caller has already resolved the project before asking this.
        """
        ...

    @property
    def tokens(self) -> Repository[Token]:
        """API credentials, parented on the workspace rather than on a project.

        The only repository here whose parent is the workspace itself, which is
        why ``list(workspace_id)`` and not ``list()`` is the correct read: a
        ``parent_id`` of ``None`` is not an error on a scoped entity, it means
        *every row in the table*.
        """
        ...


@runtime_checkable
class MetadataStore(Protocol):
    """Persistence for domain entities (projects, assets, annotations, ...).

    ``format_version`` is the stored schema generation. It is what makes a
    workspace readable — or knowably unreadable — by a different VisionSet
    build, and it is checked on every open, not only at creation.
    """

    @property
    def format_version(self) -> int:
        """The stored schema generation, or ``UNINITIALIZED`` if there is none.

        Raises ``WorkspaceCorrupt`` if the backing store cannot be read at all.
        """
        ...

    def initialize(self) -> None:
        """Create or migrate the storage schema. Idempotent.

        Raises ``WorkspaceFormatTooNew`` if the stored ``format_version`` is
        ahead of this build: migrations only ever run forward. Raises
        ``WorkspaceCorrupt`` if the backing store is not readable.
        """
        ...

    def unit_of_work(self) -> AbstractContextManager[UnitOfWork]:
        """Open a transaction; commit on clean exit, roll back on any exception."""
        ...

    def close(self) -> None: ...
