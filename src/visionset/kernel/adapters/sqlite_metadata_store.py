"""Default MetadataStore adapter: SQLite via SQLAlchemy.

One workspace is one SQLite file. The store owns the engine, the schema
generation (``format_version``), and a repository per entity type; the
row/model translation lives in ``_mappers`` so that nothing SQLAlchemy-shaped
escapes this package.

That last part includes exceptions. SQLAlchemy's ``IntegrityError`` and
``DatabaseError`` are translated here into ``ConstraintViolated`` and
``WorkspaceCorrupt``, because a service that had to catch them would need a
SQLAlchemy import to do it — which is exactly the leak this package exists to
prevent.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import (
    Connection,
    Engine,
    create_engine,
    delete,
    event,
    insert,
    inspect,
    select,
    text,
)
from sqlalchemy.engine import URL
from sqlalchemy.exc import DatabaseError, IntegrityError, OperationalError
from sqlalchemy.orm import Session

from visionset.kernel.adapters import _mappers as m
from visionset.kernel.adapters._tables import META_TABLE, MetaRow
from visionset.kernel.adapters.migrations import FORMAT_VERSION, MIGRATIONS
from visionset.kernel.errors import (
    ConstraintViolated,
    EntityAlreadyExists,
    EntityNotFound,
    WorkspaceCorrupt,
    WorkspaceFormatTooNew,
)
from visionset.kernel.ports.metadata_store import UNINITIALIZED, UnitOfWork


def _constraint_violated(exc: IntegrityError) -> ConstraintViolated:
    """Translate SQLite's constraint complaint into a domain error.

    A violation ends the transaction — SQLAlchemy refuses further work on it — so
    a service cannot catch this and carry on. That is why service-level rules
    check before writing instead of relying on the write to fail: the constraint
    is the guarantee, the pre-check is the error message.
    """
    return ConstraintViolated(str(exc.orig))


@contextmanager
def _readable(db_path: Path) -> Iterator[None]:
    """Report an unreadable database as ``WorkspaceCorrupt``, not as SQLAlchemy.

    ``OperationalError`` is re-raised untranslated on purpose: "database is
    locked" and "unable to open database file" are environmental, and calling
    them corruption would be a lie. Surfacing them as a domain error needs a
    port vocabulary for transient failure, which nothing needs yet.
    """
    try:
        yield
    except OperationalError:
        raise
    except IntegrityError as exc:
        raise _constraint_violated(exc) from exc
    except DatabaseError as exc:
        raise WorkspaceCorrupt(
            f"{db_path} is not a readable VisionSet metadata store: {exc.orig}"
        ) from exc


def _enable_foreign_keys(dbapi_connection: Any, _: Any) -> None:
    """SQLite ships with foreign keys OFF, per connection.

    Without this every ``ForeignKey`` in ``_tables`` is decorative: orphan rows
    would insert happily and cascades would never fire.
    """
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys = ON")
    cursor.close()


def _stored_format_version(connection: Connection) -> int | None:
    """The version stamped in this file, or None if it was never initialized."""
    if not inspect(connection).has_table(META_TABLE):
        return None
    return connection.execute(select(MetaRow.format_version)).scalar_one_or_none()


def _stamp(connection: Connection, version: int) -> None:
    connection.execute(delete(MetaRow))
    connection.execute(insert(MetaRow).values(id=1, format_version=version))


class SqlRepository[T: m.Entity]:
    """Generic repository driven by one ``EntityMapping``.

    Fourteen entity types share this implementation because they share a shape:
    a UUID primary key and at most one parent. Anything that needs more than
    that is a query a service should express, not a method the port should grow.
    """

    def __init__(self, session: Session, mapping: m.EntityMapping[T]) -> None:
        self._session = session
        self._mapping = mapping

    def _row(self, entity_id: UUID) -> Any:
        return self._session.get(self._mapping.row, entity_id)

    def _sync_children(self, entity: T) -> None:
        if self._mapping.sync_children is not None:
            self._mapping.sync_children(self._session, entity)

    def _flush(self) -> None:
        try:
            self._session.flush()
        except IntegrityError as exc:
            raise _constraint_violated(exc) from exc

    def add(self, entity: T) -> T:
        if self._row(entity.id) is not None:
            raise EntityAlreadyExists(
                f"{self._mapping.row.__tablename__} {entity.id} already exists"
            )
        self._session.add(self._mapping.to_row(entity))
        self._sync_children(entity)
        self._flush()
        return entity

    def update(self, entity: T) -> T:
        if self._row(entity.id) is None:
            raise EntityNotFound(f"no {self._mapping.row.__tablename__} with id {entity.id}")
        self._session.merge(self._mapping.to_row(entity))
        self._sync_children(entity)
        self._flush()
        return entity

    def get(self, entity_id: UUID) -> T | None:
        row = self._row(entity_id)
        return None if row is None else self._mapping.to_domain(self._session, row)

    def list(self, parent_id: UUID | None = None) -> list[T]:
        parent_column = self._mapping.parent_column
        if parent_id is not None and parent_column is None:
            raise ValueError(
                f"{self._mapping.row.__tablename__} is a root entity: it has no parent"
            )
        statement = select(self._mapping.row)
        if parent_id is not None and parent_column is not None:
            statement = statement.where(getattr(self._mapping.row, parent_column) == parent_id)
        rows = list(self._session.scalars(statement.order_by(text("rowid"))))
        return [self._mapping.to_domain(self._session, row) for row in rows]

    def delete(self, entity_id: UUID) -> bool:
        row = self._row(entity_id)
        if row is None:
            return False
        self._session.delete(row)
        self._flush()
        return True


class SqlUnitOfWork:
    """The repositories of one transaction, all sharing a single session."""

    def __init__(self, session: Session) -> None:
        self.workspaces = SqlRepository(session, m.WORKSPACES)
        self.projects = SqlRepository(session, m.PROJECTS)
        self.schemas = SqlRepository(session, m.SCHEMAS)
        self.sources = SqlRepository(session, m.SOURCES)
        self.ingest_jobs = SqlRepository(session, m.INGEST_JOBS)
        self.assets = SqlRepository(session, m.ASSETS)
        self.batches = SqlRepository(session, m.BATCHES)
        self.task_groups = SqlRepository(session, m.TASK_GROUPS)
        self.annotation_jobs = SqlRepository(session, m.ANNOTATION_JOBS)
        self.annotations = SqlRepository(session, m.ANNOTATIONS)
        self.datasets = SqlRepository(session, m.DATASETS)
        self.dataset_members = SqlRepository(session, m.DATASET_MEMBERS)
        self.dataset_changes = SqlRepository(session, m.DATASET_CHANGES)
        self.releases = SqlRepository(session, m.RELEASES)


class SqliteMetadataStore:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db_path = db_path
        #: Built through ``URL.create`` rather than an f-string: a path containing
        #: ``#`` or ``?`` parses as a URL fragment or query and the engine would
        #: silently target a *different* file (a truncated sibling of this one).
        self._engine: Engine = create_engine(URL.create("sqlite", database=str(db_path)))
        event.listen(self._engine, "connect", _enable_foreign_keys)

    @property
    def engine(self) -> Engine:
        return self._engine

    @property
    def format_version(self) -> int:
        """The stamped schema generation, or ``UNINITIALIZED`` before creation."""
        with _readable(self._db_path), self._engine.connect() as connection:
            stored = _stored_format_version(connection)
        return UNINITIALIZED if stored is None else stored

    def initialize(self) -> None:
        """Create or migrate the storage schema. Idempotent.

        A fresh file gets every migration and is stamped at ``FORMAT_VERSION``;
        an existing one gets only what it is missing. A file stamped ahead of
        this build raises rather than being opened on a guess.
        """
        with _readable(self._db_path), self._engine.begin() as connection:
            stored = _stored_format_version(connection)
            if stored is not None and stored > FORMAT_VERSION:
                raise WorkspaceFormatTooNew(
                    f"workspace format_version {stored} is newer than this VisionSet "
                    f"understands (max {FORMAT_VERSION}); upgrade VisionSet to open it"
                )
            pending = [mig for mig in MIGRATIONS if stored is None or mig.version > stored]
            if not pending:
                return
            for migration in pending:
                migration.upgrade(connection)
            _stamp(connection, FORMAT_VERSION)

    @contextmanager
    def unit_of_work(self) -> Iterator[UnitOfWork]:
        """One transaction: commits on clean exit, rolls back on any exception."""
        with Session(self._engine) as session:
            try:
                with session.begin():
                    yield SqlUnitOfWork(session)
            except IntegrityError as exc:
                # A constraint can also fire at commit time, i.e. after the last
                # repository call has already returned.
                raise _constraint_violated(exc) from exc

    def close(self) -> None:
        self._engine.dispose()
