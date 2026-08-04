"""Persistence port: repositories, a unit of work, and the store that owns them.

Nothing here knows about SQL. The port speaks in domain models and UUIDs only —
translating those into rows is the adapter's job, which is exactly why a service
written against this file cannot accidentally depend on SQLite.
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from typing import Final, Protocol, runtime_checkable
from uuid import UUID

from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationSchema,
    Asset,
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
