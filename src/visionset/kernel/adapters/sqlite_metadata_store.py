"""Default MetadataStore adapter: SQLite via SQLAlchemy.

One workspace is one SQLite file. The store owns the engine, the schema
generation (``format_version``), and a repository per entity type; the
row/model translation lives in ``_mappers`` so that nothing SQLAlchemy-shaped
escapes this package.

That last part includes exceptions. Every ``DatabaseError`` SQLAlchemy raises is
translated by :func:`_translated` — into ``ConstraintViolated``,
``WorkspaceBusy`` or ``WorkspaceCorrupt`` — because a service that had to catch
the originals would need a SQLAlchemy import to do it, which is exactly the leak
this package exists to prevent. There is one such function and every entry point
routes through it, so "no SQLAlchemy exception escapes" is a property of one
place rather than a habit spread across several.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Final
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
    VisionSetError,
    WorkspaceBusy,
    WorkspaceCorrupt,
    WorkspaceFormatTooNew,
)
from visionset.kernel.ports.metadata_store import UNINITIALIZED, UnitOfWork

#: How long a connection waits for a lock before giving up, in milliseconds.
#: Long enough to absorb the write bursts of a background ingest running beside
#: request handlers, short enough that a wedged writer surfaces as an error
#: rather than as a request that never returns.
DEFAULT_BUSY_TIMEOUT_MS: Final = 5_000

#: SQLite's own names for "someone else has it". ``sqlite_errorname`` reports
#: the *extended* result code, so a prefix test covers ``SQLITE_BUSY_SNAPSHOT``
#: and ``SQLITE_BUSY_TIMEOUT`` without listing them. Matching the name rather
#: than the message text means a reworded SQLite release cannot silently reroute
#: contention into ``WorkspaceCorrupt``.
_BUSY_ERROR_NAMES: Final = ("SQLITE_BUSY", "SQLITE_LOCKED")


def _constraint_violated(exc: IntegrityError) -> ConstraintViolated:
    """Translate SQLite's constraint complaint into a domain error.

    A violation ends the transaction — SQLAlchemy refuses further work on it — so
    a service cannot catch this and carry on. That is why service-level rules
    check before writing instead of relying on the write to fail: the constraint
    is the guarantee, the pre-check is the error message.
    """
    return ConstraintViolated(str(exc.orig))


def _is_busy(exc: OperationalError) -> bool:
    """Whether this is contention rather than damage."""
    name = getattr(exc.orig, "sqlite_errorname", "")
    if name:
        return name.startswith(_BUSY_ERROR_NAMES)
    # A DBAPI that does not carry the result code — nothing does today, but the
    # engine URL is not a promise — leaves only the wording to go on.
    return "is locked" in str(exc.orig)


def _translated(exc: DatabaseError, db_path: Path) -> VisionSetError:
    """The adapter's entire exception vocabulary, in one place.

    ``IntegrityError`` and ``OperationalError`` are both ``DatabaseError``
    subclasses, so the order of these tests *is* the dispatch. Everything that
    reaches the last line is a database this build cannot work with, which is
    what ``WorkspaceCorrupt`` means — including the environmental failures
    (cannot open the file, disk I/O error, disk full) that waiting will not fix.
    """
    if isinstance(exc, IntegrityError):
        return _constraint_violated(exc)
    if isinstance(exc, OperationalError) and _is_busy(exc):
        return WorkspaceBusy(
            f"{db_path} is held by another writer and the wait ran out: {exc.orig}"
        )
    return WorkspaceCorrupt(f"{db_path} is not a readable VisionSet metadata store: {exc.orig}")


@contextmanager
def _readable(db_path: Path) -> Iterator[None]:
    """Let no SQLAlchemy exception out of a read or a schema change."""
    try:
        yield
    except DatabaseError as exc:
        raise _translated(exc, db_path) from exc


def _connection_posture(busy_timeout_ms: int) -> Callable[[Any, Any], None]:
    """Build the ``connect`` listener that says what a connection is.

    Both pragmas are per connection — SQLite forgets them on close — so they are
    re-issued on every connection the engine opens, including the one that runs
    migrations, since that is the same engine. Neither writes to the file, which
    is what lets them run against a database this build has not yet vouched for.

    ``journal_mode`` is deliberately *not* here; see :meth:`SqliteMetadataStore.
    initialize`.
    """

    def listener(dbapi_connection: Any, _: Any) -> None:
        cursor = dbapi_connection.cursor()
        # Without this every ``ForeignKey`` in ``_tables`` is decorative: SQLite
        # ships with foreign keys off, so orphan rows would insert happily and
        # cascades would never fire.
        cursor.execute("PRAGMA foreign_keys = ON")
        cursor.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
        cursor.close()

    return listener


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
        # Only the constraint case is caught here, so that a caller wrapping a
        # single ``add()`` sees the right type at the point of the call. Anything
        # broader — a lock, an unusable file — propagates to ``unit_of_work``,
        # which translates it on the way out; there is nothing to gain from
        # naming those twice.
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
        self.tokens = SqlRepository(session, m.TOKENS)


class SqliteMetadataStore:
    """One SQLite file, in WAL mode, with a bounded wait for contention.

    ``busy_timeout_ms`` is keyword-only with a default so that the class itself
    still satisfies ``MetadataStoreFactory`` — a plain ``Callable[[Path],
    MetadataStore]`` — and can go on being passed to ``WorkspaceService.init``
    and ``open`` as a bare class reference. A caller who wants a different wait
    supplies ``partial(SqliteMetadataStore, busy_timeout_ms=...)`` as the
    factory rather than growing the port's signature for a tuning knob.
    """

    def __init__(self, db_path: Path, *, busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db_path = db_path
        #: Built through ``URL.create`` rather than an f-string: a path containing
        #: ``#`` or ``?`` parses as a URL fragment or query and the engine would
        #: silently target a *different* file (a truncated sibling of this one).
        self._engine: Engine = create_engine(URL.create("sqlite", database=str(db_path)))
        #: Registered on this engine, never on the ``Engine`` class: a global
        #: listener would reach engines this store knows nothing about.
        event.listen(self._engine, "connect", _connection_posture(busy_timeout_ms))

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

        Journal mode is set here rather than on every connection, and the reason
        is an invariant one file up: ``WorkspaceService.open`` creates nothing
        when it refuses. Switching a database to WAL *writes its header* — an
        empty file grows to a full page — so a connect-time pragma would leave a
        4 KB mark on any stranger's file merely inspected by ``format_version``.
        By the time this method runs, the caller has established that the file is
        ours to write to. WAL is recorded in the header and persists, so setting
        it once is what it takes, and re-running it is how a workspace written
        before WAL converts on its next open. It also has to sit outside the
        migration transaction: SQLite refuses to change journal mode inside one.
        """
        with _readable(self._db_path), self._engine.connect() as connection:
            connection.exec_driver_sql("PRAGMA journal_mode = WAL")
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
            except DatabaseError as exc:
                # Broader than the repositories' own translation, because this is
                # the last place anything can be caught: a constraint and a lock
                # can both fire at commit time, i.e. after the final repository
                # call has already returned cleanly.
                raise _translated(exc, self._db_path) from exc

    def close(self) -> None:
        """Dispose the engine, which checkpoints and removes the WAL sidecars."""
        self._engine.dispose()
