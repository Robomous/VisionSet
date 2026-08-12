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

from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Final, cast
from uuid import UUID

from sqlalchemy import (
    Connection,
    Engine,
    create_engine,
    delete,
    event,
    func,
    insert,
    inspect,
    literal,
    select,
    text,
    update,
)
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import URL, CursorResult
from sqlalchemy.exc import DatabaseError, IntegrityError, OperationalError
from sqlalchemy.orm import Session

from visionset.kernel.adapters import _mappers as m
from visionset.kernel.adapters import _tables as t
from visionset.kernel.adapters._tables import META_TABLE, Base, MetaRow
from visionset.kernel.adapters.migrations import FORMAT_VERSION, MIGRATIONS
from visionset.kernel.domain import (
    AnnotationTotals,
    AssetProgress,
    BackgroundJob,
    BackgroundJobState,
)
from visionset.kernel.errors import (
    ConstraintViolated,
    EntityAlreadyExists,
    EntityNotFound,
    VisionSetError,
    WorkspaceBusy,
    WorkspaceCorrupt,
    WorkspaceFormatTooNew,
    WorkspaceSchemaMismatch,
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


def _first_gap(connection: Connection) -> str | None:
    """What this build declares and the file does not have, or ``None``.

    Only *missing* things are looked for. A file holding more than ``_tables``
    declares was written by a later build, and this store never selects a column
    it does not name, so the extra one is inert — while the version stamp is
    what is supposed to catch that direction anyway. Missing is the direction
    that breaks, and it breaks at the first statement to name the gap.

    The answer is the first gap in a stable order rather than every gap, because
    it is read by a person deciding what to do about one file: the second line
    of a list nobody can act on separately buys nothing, and a stable order is
    what keeps two runs over one file saying the same thing.
    """
    inspector = inspect(connection)
    present = set(inspector.get_table_names())
    for name, table in sorted(Base.metadata.tables.items()):
        if name not in present:
            return f"table {name!r} is missing"
        columns = {column["name"] for column in inspector.get_columns(name)}
        for column_name in (c.name for c in table.columns):
            if column_name not in columns:
                return f"table {name!r} is missing column {column_name!r}"
    return None


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

    def _write_children(self, entity: T, *, inserting: bool) -> None:
        if self._mapping.write_children is not None:
            self._mapping.write_children(self._session, entity, inserting=inserting)

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
        # Flushed **before** the children, because they carry a foreign key to
        # the row just added and there is no ORM relationship for SQLAlchemy to
        # order the two by. It used to happen by accident, through the autoflush
        # of a child writer's opening `delete(...)`; without this line, dropping
        # such a delete answers `FOREIGN KEY constraint failed`.
        self._flush()
        self._write_children(entity, inserting=True)
        self._flush()
        return entity

    def update(self, entity: T) -> T:
        if self._row(entity.id) is None:
            raise EntityNotFound(f"no {self._mapping.row.__tablename__} with id {entity.id}")
        self._session.merge(self._mapping.to_row(entity))
        self._write_children(entity, inserting=False)
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
        self._session = session
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
        self.jobs = SqlRepository(session, m.BACKGROUND_JOBS)
        self.inference_connections = SqlRepository(session, m.INFERENCE_CONNECTIONS)

    def claim_job(self, *, worker: str, now: datetime) -> BackgroundJob | None:
        """One guarded ``UPDATE`` — see the port's docstring for why it exists.

        Two statements, and the **second** one is the whole guarantee. The first
        only nominates a candidate; the ``UPDATE`` then re-tests ``state =
        'queued'`` on that exact id while holding the write lock, so between the
        test and the write there is no window at all. Two dispatchers that both
        nominate the same row therefore produce one winner and one ``rowcount``
        of zero — never two runners.

        The loser answers ``None`` even when another job was queued behind the
        one it lost. That is deliberate rather than a shortcoming: it is
        indistinguishable from an empty queue to the caller, both mean "ask
        again", and the alternative is a retry loop inside a store that has no
        business deciding how long anybody waits.

        ``attempt`` is incremented from the column rather than from a value read
        in Python, so a count cannot be lost to the same race.

        The final ``get`` is not a re-check — the write already decided. It
        hydrates the row this caller now owns, inside this transaction, so
        nothing can change it before the caller sees it.
        """
        candidate = self._session.scalar(
            select(t.JobRow.id)
            .where(t.JobRow.state == BackgroundJobState.QUEUED)
            # ``rowid`` breaks a tie, and ties are real: ``created_at`` has
            # microsecond resolution and two jobs queued by one request handler
            # can share one. Without it "oldest first" would be arbitrary among
            # them, which is the kind of ordering a test discovers on CI.
            .order_by(t.JobRow.created_at, text("rowid"))
            .limit(1)
        )
        if candidate is None:
            return None

        result = cast(
            "CursorResult[Any]",
            self._session.execute(
                update(t.JobRow)
                .where(t.JobRow.id == candidate)
                .where(t.JobRow.state == BackgroundJobState.QUEUED)
                .values(
                    state=BackgroundJobState.RUNNING,
                    started_at=now.isoformat(),
                    worker=worker,
                    attempt=t.JobRow.attempt + 1,
                )
            ),
        )
        if result.rowcount != 1:
            return None
        return self.jobs.get(candidate)

    def set_asset_progress(
        self,
        job_id: UUID,
        asset_id: UUID,
        *,
        expected: AssetProgress,
        progress: AssetProgress,
        touched_at: datetime,
    ) -> AssetProgress | None:
        """One guarded ``UPDATE`` — see the port's docstring for why it exists.

        The guard is the third ``WHERE`` term, and it is what makes a successful
        return mean the write is durable: SQLite evaluates it while holding the
        write lock, so between testing ``progress = :expected`` and storing the
        new value there is no window at all for another connection to fit into.
        Reading first and writing second — which is what every other write here
        does through ``Repository.update`` — has exactly that window, and it is
        wide enough to fit two whole requests.

        ``rowcount`` is the answer, not a follow-up read: zero means the guard
        failed, and the ``SELECT`` after it is only to say *where the asset is*
        rather than to decide whether the write happened. That second read runs
        inside this transaction, so a third writer cannot change what it reports
        before this one commits.

        ``touched_at`` rides in the same ``values``, so it is stamped under the
        same guard: a write that loses the race writes neither column, and there
        is no ordering in which the timestamp records work that did not happen.
        """
        # `Session.execute` is typed as returning `Result`, which has no
        # `rowcount`; a DML statement always yields the `CursorResult` that does.
        result = cast(
            "CursorResult[Any]",
            self._session.execute(
                update(t.AnnotationJobAssetRow)
                .where(t.AnnotationJobAssetRow.job_id == job_id)
                .where(t.AnnotationJobAssetRow.asset_id == asset_id)
                .where(t.AnnotationJobAssetRow.progress == expected)
                .values(progress=progress, touched_at=touched_at.isoformat())
            ),
        )
        if result.rowcount == 1:
            return None

        stored = self._session.scalar(
            select(t.AnnotationJobAssetRow.progress)
            .where(t.AnnotationJobAssetRow.job_id == job_id)
            .where(t.AnnotationJobAssetRow.asset_id == asset_id)
        )
        if stored is None:
            raise EntityNotFound(f"job {job_id} does not carry asset {asset_id}")
        return AssetProgress(stored)

    def last_touched(self, job_id: UUID) -> datetime | None:
        """One ``max()`` over the job's rows — see the port's docstring.

        The aggregate runs on the stored **strings**, and that is sound rather
        than lucky: every timestamp in this schema is written by
        ``datetime.isoformat()`` at a fixed UTC offset, and ISO-8601 in that form
        orders lexicographically exactly as it orders chronologically. A column
        holding two different offsets would not, which is one more reason the
        write side stamps in one place.

        ``max()`` over no rows, or over rows that are all NULL, is NULL — so a
        job whose assets nobody has touched needs no separate branch here.
        """
        stamped = self._session.scalar(
            select(func.max(t.AnnotationJobAssetRow.touched_at)).where(
                t.AnnotationJobAssetRow.job_id == job_id
            )
        )
        return None if stamped is None else datetime.fromisoformat(stamped)

    def add_batch_assets(self, batch_id: UUID, asset_ids: Sequence[UUID]) -> list[UUID]:
        """One ``INSERT ... SELECT`` per asset — see the port's docstring for why.

        **The position comes from a subquery inside the insert, never from a
        read before it**, and that is the whole of what makes two concurrent
        appends safe. ``COALESCE(MAX(position), -1) + 1`` is evaluated while the
        statement holds the write lock, so the second appender sees the first
        one's row; reading the maximum first and inserting second has a window
        between the two, and two callers in it land on the same number.

        ``ON CONFLICT DO NOTHING`` on the composite key is what makes a repeated
        add a no-op rather than a constraint violation, and ``rowcount`` is what
        says which of the two happened — no read is needed to find out.

        One statement per asset rather than one for the list: each needs its own
        maximum, since the ones before it have already moved it.
        """
        stored = self._session.get(t.BatchRow, batch_id)
        if stored is None:
            raise EntityNotFound(f"no batch {batch_id}")

        added: list[UUID] = []
        for asset_id in asset_ids:
            next_position = (
                select(func.coalesce(func.max(t.BatchAssetRow.position), -1) + 1)
                .where(t.BatchAssetRow.batch_id == batch_id)
                .scalar_subquery()
            )
            statement = sqlite_insert(t.BatchAssetRow).from_select(
                ["batch_id", "asset_id", "position"],
                select(
                    literal(batch_id, type_=t.BatchAssetRow.batch_id.type),
                    literal(asset_id, type_=t.BatchAssetRow.asset_id.type),
                    next_position,
                ),
            )
            result = cast(
                "CursorResult[Any]",
                self._session.execute(
                    statement.on_conflict_do_nothing(index_elements=["batch_id", "asset_id"])
                ),
            )
            if result.rowcount == 1:
                added.append(asset_id)
        return added

    def remove_batch_assets(self, batch_id: UUID, asset_ids: Sequence[UUID]) -> list[UUID]:
        """One ``DELETE`` over the ids given, and a read to say which ones matched.

        ``rowcount`` alone would answer *how many* went, and the caller needs
        *which* — a bulk remove reports what it removed. So membership is read
        first, inside this transaction, and intersected: a row another writer
        takes between that read and the delete simply is not in the answer,
        which is the same thing the delete would have said about it.
        """
        stored = self._session.get(t.BatchRow, batch_id)
        if stored is None:
            raise EntityNotFound(f"no batch {batch_id}")

        wanted = list(dict.fromkeys(asset_ids))
        if not wanted:
            return []
        held = set(
            self._session.scalars(
                select(t.BatchAssetRow.asset_id)
                .where(t.BatchAssetRow.batch_id == batch_id)
                .where(t.BatchAssetRow.asset_id.in_(wanted))
            ).all()
        )
        if not held:
            return []
        self._session.execute(
            delete(t.BatchAssetRow)
            .where(t.BatchAssetRow.batch_id == batch_id)
            .where(t.BatchAssetRow.asset_id.in_(held))
        )
        return [asset_id for asset_id in wanted if asset_id in held]

    def batches_holding(self, asset_id: UUID) -> list[UUID]:
        """The port's one non-repository read — see its docstring for why.

        Ordered by ``position`` within a batch and then by nothing else, which
        for this question means *the order the memberships were written*: an
        asset put in one batch and later in a correction of it comes back in that
        order. SQLite has no stable tie-break to offer beyond the rowid it is
        already scanning, so the ordering is stated as "oldest membership first"
        rather than promised to be anything finer.
        """
        return list(
            self._session.scalars(
                select(t.BatchAssetRow.batch_id)
                .where(t.BatchAssetRow.asset_id == asset_id)
                .order_by(t.BatchAssetRow.position)
            ).all()
        )

    def annotation_totals(self, project_id: UUID) -> AnnotationTotals:
        """The port's other non-repository read — see its docstring for why.

        **One scan for both numbers**, which is the whole reason they are one
        method: the join is the expensive part and the two aggregates ride it
        together.

        ``select_from`` is stated rather than inferred. With only aggregate
        functions in the select list there is no table for SQLAlchemy to derive
        a FROM clause from, and the ``join`` alone would leave it guessing.

        ``one()`` rather than ``scalar_one_or_none``: an aggregate over an empty
        match is a row of zeros, never the absence of a row. A project with no
        assets and an unknown project are therefore indistinguishable here, which
        is what the port promises.
        """
        annotations, annotated_assets = self._session.execute(
            select(func.count(), func.count(func.distinct(t.AnnotationRow.asset_id)))
            .select_from(t.AnnotationRow)
            .join(t.AssetRow, t.AnnotationRow.asset_id == t.AssetRow.id)
            .where(t.AssetRow.project_id == project_id)
        ).one()
        return AnnotationTotals(annotations=annotations, annotated_assets=annotated_assets)


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

        What the stamp cannot answer is checked afterwards, every time. The
        stamp is a claim about the schema, and it is only as good as the rule
        that every schema change arrives with a version — a rule this file
        states and nothing enforces. Migration 1 is ``create_all`` of *today's*
        ``_tables``, and ``create_all`` creates missing tables while leaving an
        existing one exactly as it found it, so a file that missed a column
        stays stamped at the current generation forever and opens as current.
        Comparing the schema against what is declared costs one reflection per
        open and turns that into ``WorkspaceSchemaMismatch`` here, rather than
        an opaque 500 out of whichever route reaches the column first.

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
                    f"understands (max {FORMAT_VERSION}); it was written either by a "
                    f"later VisionSet, which opening it needs, or by one whose "
                    f"generations were numbered differently, which no build will open"
                )
            pending = [mig for mig in MIGRATIONS if stored is None or mig.version > stored]
            for migration in pending:
                migration.upgrade(connection)
            if pending:
                _stamp(connection, FORMAT_VERSION)
        # Its own connection, after the migrations have committed: a gap found
        # here raises, and inside that block the raise would roll back the very
        # schema a fresh file had just been given.
        with _readable(self._db_path), self._engine.connect() as connection:
            gap = _first_gap(connection)
        if gap is not None:
            raise WorkspaceSchemaMismatch(
                f"{self._db_path} is stamped at format_version {FORMAT_VERSION}, which this "
                f"VisionSet understands, but {gap}. It was written by a different build. "
                f"Recreate the workspace, or use the build that wrote it"
            )

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
