"""The storage schema baseline, and the mechanism that carries it forward.

One workspace is one SQLite file, and a ``format_version`` stored inside that
file says which generation of the schema it holds. Opening a workspace runs
whatever is missing. There is no alembic here — a local-first, single-file,
single-writer store does not need a migration framework, and ``format_version``
would then have to be kept in sync with a second ledger by hand.

**Generation 1 is the baseline; everything after it is an ordinary migration.**
Today's ``_tables`` *is* generation 1, and a fresh database is created directly
at it. The three rules below hold for every entry appended since.

**There are no downgrade paths, deliberately.** Nothing here walks a file
backwards and the tests no longer do either. A downgrade is a compatibility
promise, and a promise is owed to somebody: it comes back when there is a
published release whose files this build has to keep opening, and not before.

**Adding a migration.** Append a ``Migration`` with the next version number and
an ``upgrade`` that takes a live connection. Do NOT edit an existing one — a
workspace already stamped at that version will never run it again.
``FORMAT_VERSION`` is derived from the list, so it cannot drift from reality.

Three rules, plus a fourth that lives in the tests: a migration that adds a
**column** must also have that column dropped in
``tests/kernel/test_migrations.py``'s ``_at_generation_one``, or it finds the
column already present, returns early, and the fresh-versus-migrated comparison
passes while exercising nothing.

* **Every migration after the first must be idempotent.** Migration 1 is
  ``create_all`` of *today's* metadata, not a frozen snapshot, so adding a
  table, column or index to ``_tables`` retroactively changes what a fresh
  database gets. A later migration therefore exists only for already-stamped
  databases, and yet it still runs against the fresh one that already carries
  its change — hence ``checkfirst`` / ``IF NOT EXISTS``, and hence sharing the
  one schema object with ``_tables`` rather than repeating the DDL. Note that
  SQLAlchemy cannot *reflect* a partial or expression-based index, so
  ``checkfirst`` reports one absent and re-issues a ``CREATE`` that then fails
  on every fresh database; those ask SQLite instead, through
  ``CreateIndex(..., if_not_exists=True)``.
* **A column arriving by ``ALTER`` is declared last on its row class**, because
  SQLite appends it — anywhere else the ``create_all`` path and the migration
  path emit different ``CREATE TABLE`` text.
* **A column carrying a foreign key cannot arrive by ``ALTER`` at all.** SQLite
  spells an added key inline on the column while ``create_all`` spells one as a
  table constraint; the two texts differ. Such a column needs a table rebuild —
  and under ``PRAGMA foreign_keys = ON``, which this store sets on every
  connection, ``DROP TABLE`` runs an implicit ``DELETE`` that cascades to
  children *silently*, so a rebuild has to count those first.

Migrations only run forward. A workspace stamped ahead of this build is
rejected (``WorkspaceFormatTooNew``) rather than silently downgraded.

**The rules above are checked rather than trusted.** With a single generation
every workspace carries the same ``format_version`` forever, so a file that
missed a change is stamped exactly like one that did not and the number cannot
tell them apart. Migration 1 will not repair it either: ``create_all`` leaves an
existing table as it found it, and it only runs while something is pending. Such
a file opens as current and fails at the first statement naming what it lacks,
deep inside a request — so ``SqliteMetadataStore.initialize`` compares the schema
it found against the one declared here and raises ``WorkspaceSchemaMismatch`` at
the door instead.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import Connection, inspect, text
from sqlalchemy.schema import CreateColumn, CreateIndex

from visionset.kernel.adapters._tables import SOURCE_ORIGIN_UNIQUE, Base
from visionset.kernel.domain import ConnectionType, default_origin


@dataclass(frozen=True)
class Migration:
    """One schema generation: what it is called and how to get there."""

    version: int
    name: str
    upgrade: Callable[[Connection], None]


def _create_baseline_schema(connection: Connection) -> None:
    """Create every table, index and constraint that ``_tables`` declares.

    ``create_all`` is ``checkfirst`` by default, which is what makes running it
    against a file that already has the schema a no-op rather than an error.
    """
    Base.metadata.create_all(connection)


def _add_column(connection: Connection, table: str, column: str) -> None:
    """Append a column a file does not have yet, compiled from its own definition.

    Idempotent by asking the file rather than by ``IF NOT EXISTS``, which SQLite
    has no spelling for on ``ADD COLUMN`` — that check *is* the idempotency the
    module docstring requires, and it matters because migration 1 is
    ``create_all`` of *today's* metadata: a fresh database already carries every
    column below, and then runs this anyway.

    The DDL comes from the shared ``Column`` object through ``CreateColumn``,
    never hand-written, so the two creation paths cannot drift in type or
    nullability. What ``CreateColumn`` silently omits is a ``REFERENCES`` clause,
    which is why neither column here declares a foreign key — see their
    docstrings in ``_tables``.
    """
    if column in {found["name"] for found in inspect(connection).get_columns(table)}:
        return
    definition = CreateColumn(Base.metadata.tables[table].columns[column]).compile(
        bind=connection.engine
    )
    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {definition}"))


def _add_batch_lineage(connection: Connection) -> None:
    """``batch.parent_batch_id``: which batch this one was cut from.

    **Nothing to backfill, and that is a fact rather than a shortcut.** NULL here
    means "not a correction of anything", which is true of every batch that has
    ever existed — correction batches do not exist yet. A backfill would have
    nothing to read and nothing to say.
    """
    _add_column(connection, "batch", "parent_batch_id")


def _add_annotation_provenance(connection: Connection) -> None:
    """``annotation.job_id``: which round of work produced this label.

    **The backfill is honest about what it cannot know.** An annotation records
    only its ``asset_id``, and a job records which assets it carries — so an
    annotation whose asset belongs to exactly one job can be attributed with
    certainty, and one whose asset is carried by two cannot be attributed at all.
    The second case is not rare in principle: nothing stops an asset sitting in
    several batches, and reconciling that is an open question (audit F14).

    So the ``UPDATE`` sets a value only where the count is exactly one, and
    leaves the ambiguous rows NULL. Writing "the first job we found" instead
    would put a confident wrong answer where an honest absent one belongs, and
    every reader downstream would have no way to tell which it had.

    Idempotent twice over: ``_add_column`` returns early on a file that has the
    column, and the ``UPDATE`` is guarded on ``job_id IS NULL`` so a re-run
    cannot overwrite an attribution a *service* has since written.
    """
    _add_column(connection, "annotation", "job_id")
    connection.execute(
        text(
            """
            UPDATE annotation
               SET job_id = (
                     SELECT aja.job_id
                       FROM annotation_job_asset AS aja
                      WHERE aja.asset_id = annotation.asset_id
                   )
             WHERE job_id IS NULL
               AND (
                     SELECT COUNT(*)
                       FROM annotation_job_asset AS aja
                      WHERE aja.asset_id = annotation.asset_id
                   ) = 1
            """
        )
    )


def _add_job_queue(connection: Connection) -> None:
    """``job``: the background executor's queue, created whole.

    **A table, not a column, and that is what makes this the easy kind of
    migration.** The third rule in the module docstring — a column carrying a
    foreign key cannot arrive by ``ALTER`` — never comes up, because ``JobRow``
    declares no key at all (see its own docstring for why that is a decision
    about what a job *is*, not a dodge around this rule).

    ``create_all`` restricted to the one table, rather than a bare
    ``Base.metadata.create_all(connection)``: unrestricted it would also create
    anything else a *later* baseline happens to declare, which would let this
    migration silently do a future one's work on an old file. ``checkfirst`` is
    on by default and is this migration's idempotency — migration 1 is
    ``create_all`` of today's metadata, so a fresh database already has this
    table and then runs this anyway.

    **Nothing to backfill.** A queue's contents are in-flight work, and a
    workspace written before the executor existed had none. The empty table is
    the honest starting state rather than a shortcut.
    """
    Base.metadata.create_all(connection, tables=[Base.metadata.tables["job"]])


def _add_schema_provenance(connection: Connection) -> None:
    """``annotation_schema.provenance``: which kind of work published a version.

    **Nothing to backfill, and unlike migration 3 there is nothing that *could*
    be.** Migration 3 could attribute a label because the schema recorded enough
    to answer it in the unambiguous case; here nothing anywhere records who
    published a version or from which surface. Every existing version therefore
    stays NULL, which the domain reads as "nobody said" rather than as a third
    kind — see ``SchemaProvenance``.

    Guessing was considered and is worse than absence: "a version with one class
    more than its predecessor was probably added while annotating" is a heuristic,
    and a history that groups versions on a guess would be confidently wrong about
    exactly the milestones a reader opened it to find.
    """
    _add_column(connection, "annotation_schema", "provenance")


def _add_inference_connections(connection: Connection) -> None:
    """``inference_connection``: where a model may be asked to predict.

    Migration 4's kind — a table created whole — so the rule about a key column
    never arriving by ``ALTER`` does not come up: ``InferenceConnectionRow``
    declares no foreign key at all, and its unique name index is created with the
    table rather than after it.

    ``create_all`` restricted to this one table, never a bare
    ``Base.metadata.create_all``, for migration 4's reason: unrestricted it would
    also create whatever a *later* baseline happens to declare, letting this
    migration silently do a future one's work on an old file. ``checkfirst`` is on
    by default and is what makes a re-run a no-op.

    **Nothing to backfill.** A workspace that predates this table has no
    connections, which is exactly what an empty table says — and the product it
    describes is one where nothing predicts until somebody configures where.
    """
    Base.metadata.create_all(connection, tables=[Base.metadata.tables["inference_connection"]])


def _add_model_family(connection: Connection) -> None:
    """``inference_connection.model_family``: what kind of model this one is.

    **The backfill cannot happen here, and that is a layering fact rather than a
    shortcut.** The value is read from a model's own config, which sits in a
    cache under the workspace root that only ``visionset.inference`` knows how to
    address — and this module is in the kernel, which is forbidden from importing
    it. So every existing row starts NULL, meaning *nobody has looked yet*, and
    the look happens where the resolver already lives: at the next download, and
    on the first read of a connection that is set up (see
    ``visionset.inference.weights.with_families``).

    NULL is therefore the honest starting value rather than a gap. It is
    distinguishable from the empty string, which the resolver writes when it did
    look and the config declared nothing — so a row that has been asked and
    answered nothing is never asked again, and a row that has never been asked
    still will be.
    """
    _add_column(connection, "inference_connection", "model_family")


def _add_progress_touched(connection: Connection) -> None:
    """``annotation_job_asset.touched_at``: when somebody last worked this frame.

    **Nothing to backfill, and nothing that could be.** The value this column
    holds is a moment that was never recorded, so there is no other row, no
    derived field and no file timestamp to reconstruct it from — a workspace's
    entire history of who-worked-when begins at this migration. Every existing
    row therefore stays NULL, which reads as *nobody has touched this frame since
    the column existed* rather than as *nobody ever has*, and the summary's
    ranking is written to say exactly that: an untouched batch is ordered by the
    progress rule that came before, behind every batch that has a stamp.

    Migration 5's posture on ``annotation_schema.provenance``, for the same
    reason and with the same consequence — a NULL that converges to a real value
    as soon as somebody uses the workspace, and never lies in the meantime.
    """
    _add_column(connection, "annotation_job_asset", "touched_at")


def _add_job_assignee(connection: Connection) -> None:
    """``annotation_job.assignee``: who is working the job — a name, not an account.

    Nothing to backfill: no prior row ever recorded a person, so every existing
    job stays NULL, which reads as *unassigned* and never lies. Migration 8's
    posture on ``touched_at``, for the same reason.
    """
    _add_column(connection, "annotation_job", "assignee")


def _add_schema_drafts(connection: Connection) -> None:
    """``schema_draft``: the schema version a project is still writing.

    Migration 4's kind — a table created whole — so the rule about a key column
    never arriving by ``ALTER`` does not come up.

    **Nothing to backfill, and nothing that could be.** Before this table a draft
    existed only inside one browser tab's memory and was never written anywhere,
    so an existing workspace starts with none. The empty table is the honest
    starting state rather than a shortcut.
    """
    Base.metadata.create_all(connection, tables=[Base.metadata.tables["schema_draft"]])


def _add_provider_id(connection: Connection) -> None:
    """``inference_connection.provider_id``: which installed driver serves it.

    **Nothing is backfilled, and no guess is available to make.** Which driver
    would run an existing connection is worked out today from the family its
    downloaded config declares — a derivation that lives outside the kernel, and
    one that answers nothing at all for a connection whose weights were never
    fetched or whose model runs elsewhere. Writing whichever driver happens to
    serve that family today would record a decision nobody made, on rows created
    before the question was asked.

    So every existing row starts NULL, meaning *nobody recorded one*, and
    resolution falls back to the family for those exactly as it did for all of
    them before. The value arrives later from whoever genuinely knows it: a
    connection created against a catalog entry names the driver that offered it,
    and a download that resolves a driver records the one it actually used.

    ``_add_model_family`` is the precedent, and the reason differs in a way worth
    keeping straight: that column could not be filled because the kernel may not
    reach the model cache, and this one could not be filled because the answer
    did not exist to be read.
    """
    _add_column(connection, "inference_connection", "provider_id")


def _add_job_error_code(connection: Connection) -> None:
    """``job.error_code``: the stable identifier of a failed job's ``error``.

    Nothing is backfilled. A settled row carries only the sentence its exception
    was rendered to, and the class that sentence came from was discarded at the
    settle — so there is nothing on disk to derive a code from, and guessing one
    from the wording would couple the store to the kernel's prose. Existing
    failures stay NULL, which reads as *no code was recorded*, and rows settled
    from now on carry the one the runner was handed.
    """
    _add_column(connection, "job", "error_code")


def _add_credential_env(connection: Connection) -> None:
    """``inference_connection.credential_env``: the name of the environment
    variable holding an http connection's credential.

    Nothing is backfilled: no row written before this column could have named
    one, and NULL reads as *no credential*, which is what every such connection
    has been sending all along.
    """
    _add_column(connection, "inference_connection", "credential_env")


def _add_project_created_at(connection: Connection) -> None:
    """``project.created_at``: when the project was made.

    Nothing is backfilled, and nothing could be: a project row records no moment
    at all, and the only order on disk is insertion order, which says *before*
    and *after* but never *when*. Existing projects stay NULL, which reads as *the
    workspace did not record it*, and every project created from now on carries
    the stamp ``ProjectService.create`` writes.
    """
    _add_column(connection, "project", "created_at")


def _add_connection_origin(connection: Connection) -> None:
    """``inference_connection.origin``: where a connection's weights come from.

    Backfilled from the kind, because the kind is the whole of what an old row
    knows and it is enough: a local connection could only ever have fetched from
    the hub, and an http one points at an endpoint somebody stood up. The rule is
    the domain's own (``default_origin``), applied here in SQL so a file and a
    fresh row cannot disagree about what silence meant.
    """
    _add_column(connection, "inference_connection", "origin")
    for kind in ConnectionType:
        connection.execute(
            text(
                "UPDATE inference_connection SET origin = :origin"
                " WHERE origin IS NULL AND connection_type = :kind"
            ),
            {"origin": default_origin(kind).value, "kind": kind.value},
        )


def _reshape_source_origin_index(connection: Connection) -> None:
    """The source-origin index grows a canonical-ranges term.

    Clip ranges joined the source's identity beside ``extraction_fps``, so the
    uniqueness backstop has to compare them too. SQLite cannot alter an index:
    the old one is dropped by name. Creating the replacement moved to the head
    reshape (migration 18): only one migration may execute the shared
    declaration, because it is always the *current* spelling and here it would
    reference a column a generation-16 file does not have yet. Nothing is
    backfilled — a row written before ranges existed has no ``$.ranges`` key,
    which the final index reads as ``''``, the same term a whole-clip
    selection serializes to.
    """
    connection.execute(text("DROP INDEX IF EXISTS uq_source_project_kind_path_fps"))


def _add_source_scale(connection: Connection) -> None:
    """Scale joins the source's identity, so the origin index compares it.

    One new term beside fps and ranges: a clip's ``$.scale_percent``, omitted
    at 100 so pre-scale rows and unscaled rows share one spelling. SQLite
    cannot alter an index: the old one is dropped by name and the shared
    declaration created in its place. As the head reshape this is the one
    migration that may execute the shared declaration — see
    ``_reshape_source_origin_index``.
    """
    connection.execute(text("DROP INDEX IF EXISTS uq_source_project_kind_path_fps_ranges"))
    connection.execute(CreateIndex(SOURCE_ORIGIN_UNIQUE, if_not_exists=True))


def _add_preprocessing_recipes(connection: Connection) -> None:
    """``preprocessing_recipes``: the named recipes a project's exports can apply.

    Migration 4's kind — a table created whole, ``create_all`` restricted to it
    for migration 6's reason — so the rule about a key column never arriving by
    ``ALTER`` does not come up.

    **Nothing to backfill.** Before this table no recipe existed anywhere, and
    an export that applied none is exactly what every earlier export was, so an
    existing workspace starts with an empty table and loses nothing.
    """
    Base.metadata.create_all(connection, tables=[Base.metadata.tables["preprocessing_recipes"]])


MIGRATIONS: list[Migration] = [
    Migration(version=1, name="baseline_schema", upgrade=_create_baseline_schema),
    Migration(version=2, name="batch_lineage", upgrade=_add_batch_lineage),
    Migration(version=3, name="annotation_provenance", upgrade=_add_annotation_provenance),
    Migration(version=4, name="job_queue", upgrade=_add_job_queue),
    Migration(version=5, name="schema_provenance", upgrade=_add_schema_provenance),
    Migration(version=6, name="inference_connections", upgrade=_add_inference_connections),
    Migration(version=7, name="model_family", upgrade=_add_model_family),
    Migration(version=8, name="progress_touched", upgrade=_add_progress_touched),
    Migration(version=9, name="job_assignee", upgrade=_add_job_assignee),
    Migration(version=10, name="schema_drafts", upgrade=_add_schema_drafts),
    Migration(version=11, name="provider_id", upgrade=_add_provider_id),
    Migration(version=12, name="job_error_code", upgrade=_add_job_error_code),
    Migration(version=13, name="credential_env", upgrade=_add_credential_env),
    Migration(version=14, name="project_created_at", upgrade=_add_project_created_at),
    Migration(version=15, name="connection_origin", upgrade=_add_connection_origin),
    Migration(version=16, name="source_clip_ranges", upgrade=_reshape_source_origin_index),
    Migration(version=17, name="preprocessing_recipes", upgrade=_add_preprocessing_recipes),
    Migration(version=18, name="source_scale", upgrade=_add_source_scale),
]

FORMAT_VERSION: int = MIGRATIONS[-1].version
