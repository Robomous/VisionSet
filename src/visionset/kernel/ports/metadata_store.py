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
    Asset,
    AssetProgress,
    BackgroundJob,
    Batch,
    Dataset,
    DatasetChange,
    DatasetMember,
    IngestJob,
    Project,
    Release,
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
    ) -> AssetProgress | None:
        """Move one asset's progress, and only if it is still where it was read.

        **The first write here that is not a repository** — :meth:`claim_job` is
        the second, and it is here for the same reason — for the reason
        :meth:`batches_holding` is not a read: ``Repository`` replaces a whole
        entity by id, and an ``AnnotationJob`` carries every asset's progress. Two
        annotators moving *different* assets of one job therefore write the same
        entity, and the second write puts back the copy of the map the first one
        had already changed — the lost update in #302, answered ``200`` on the
        wire. Narrowing the write to one asset makes those two disjoint by
        construction, and there is no way to say that in terms of ``Repository``
        without giving projects and tokens a per-asset method as well.

        ``expected`` is what the caller read before it decided, and it is checked
        **in the same statement that writes**, so nothing can move in between. It
        is the version stamp this row already has: the contended datum is the
        progress itself, so a separate version column would only be a second name
        for it — and a second thing to keep in step.

        Returns ``None`` when the write landed. Returns the **stored** value when
        it did not, which is the whole answer the caller needs: it says both that
        the write was refused and where the asset actually is. A caller finding
        its own target there has nothing left to do.

        Raises ``EntityNotFound`` if the job does not carry that asset at all,
        matching ``Repository.update`` on an id that is not stored.
        """
        ...

    def add_batch_assets(self, batch_id: UUID, asset_ids: Sequence[UUID]) -> list[UUID]:
        """Append assets to a batch's membership, skipping any it already holds.

        **The membership twin of :meth:`set_asset_progress`, and it exists for
        the identical reason.** ``batch_asset`` is keyed ``(batch_id,
        asset_id)`` — one row per member, which is exactly the shape a disjoint
        write wants — but a ``Batch`` carries every member, so two callers
        adding *different* assets to one draft wrote the same entity through
        ``Repository.update`` and the second put back the membership the first
        had already changed. Same lost update as #302, answered ``200`` twice.
        Narrowing the write to one row makes those two disjoint by construction.

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
