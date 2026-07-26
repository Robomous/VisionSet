"""Persistence port: repositories, a unit of work, and the store that owns them.

Nothing here knows about SQL. The port speaks in domain models and UUIDs only —
translating those into rows is the adapter's job, which is exactly why a service
written against this file cannot accidentally depend on SQLite.
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from typing import Protocol, runtime_checkable
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
    Workspace,
)


class Repository[T](Protocol):
    """Storage for one entity type, addressed by UUID.

    Every entity in the domain has at most one parent — a Project belongs to a
    Workspace, an Annotation to an Asset — so a single ``parent_id`` filter
    covers every scoped read the services need, and no query language leaks into
    the port.

    ``add`` and ``update`` are deliberately separate rather than one upsert: a
    service that inserts a duplicate, or updates something that was deleted, has
    a bug and should hear about it instead of silently overwriting.
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


@runtime_checkable
class MetadataStore(Protocol):
    """Persistence for domain entities (projects, assets, annotations, ...).

    ``format_version`` is the stored schema generation. It is what makes a
    workspace readable — or knowably unreadable — by a different VisionSet
    build, and it is checked on every open, not only at creation.
    """

    @property
    def format_version(self) -> int: ...

    def initialize(self) -> None:
        """Create or migrate the storage schema. Idempotent.

        Raises ``WorkspaceFormatTooNew`` if the stored ``format_version`` is
        ahead of this build: migrations only ever run forward.
        """
        ...

    def unit_of_work(self) -> AbstractContextManager[UnitOfWork]:
        """Open a transaction; commit on clean exit, roll back on any exception."""
        ...

    def close(self) -> None: ...
