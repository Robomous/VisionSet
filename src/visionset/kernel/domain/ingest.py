# usage: from visionset.kernel.domain import IngestJob
"""One ingestion run: the record of it, and the report it hands back.

Two shapes live here and they are not the same kind of thing. ``IngestJob`` is a
**row** — it outlives the call, carries the run's state machine, its progress
counters and its per-file report. ``IngestResult`` is a **return value** — it
exists for the caller of ``IngestService.ingest`` and is never stored. The two
overlap on purpose: the row is what a *poller* reads while the run is in flight
or long after it, and the result is what the caller who waited already has in
hand.

Summary counts on ``IngestResult`` stay derived properties, the way batch
completion and per-asset progress are derived elsewhere in this domain. The
job's counters are a different thing: a running total written to a row *while*
the work is happening, which a summary of a finished object cannot serve.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.domain.asset import Asset


class IngestState(StrEnum):
    """Lifecycle: pending -> running -> (completed | failed) -> running.

    ``IngestService`` owns the moves; ``INGEST_TRANSITIONS`` below is the whole
    of what is legal.
    """

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


INGEST_TRANSITIONS: Final[Mapping[IngestState, frozenset[IngestState]]] = {
    IngestState.PENDING: frozenset({IngestState.RUNNING, IngestState.FAILED}),
    IngestState.RUNNING: frozenset({IngestState.COMPLETED, IngestState.FAILED}),
    IngestState.COMPLETED: frozenset(),
    IngestState.FAILED: frozenset({IngestState.RUNNING}),
}
"""Every move a run may make. Anything absent raises ``InvalidTransition``.

A table rather than guards inside the service, the shape ``BATCH_TRANSITIONS``
established: "which moves are legal" is one readable fact, and the test for it
sweeps the whole ``IngestState`` column against this dict instead of restating
it.

``failed -> running`` is **the first backward edge in this kernel**, and the
argument against reopening a batch does not transfer. A batch pins a schema
version at approval and its jobs are already partitioned against that pin, so
un-freezing one would invalidate work already done. Nothing is pinned against an
ingest run: it is a record of work, not an artifact with dependents. Resuming is
therefore the same unit of work continuing, and a second row per attempt would
fork ``batch_id`` and fill ``IngestService.list`` with retries.

``running -> running`` is deliberately **absent**, which means a run stuck at
``running`` cannot be resumed. That state is a process that died without
reporting anything, not a failure somebody can read — and the remedy already
exists: ingest the source again, which content addressing makes create nothing.
Letting a resume overwrite the row would erase the only evidence the crash left.
"""


class IngestFailureKind(StrEnum):
    """Why one item did not become an asset, split by what to do about it.

    An enum rather than a plain ``str``, on exactly ``SourceKind``'s terms: the
    set is closed, no writer outside this build produces a value, and the kernel
    branches on it. What makes it worth a type at all is that a report has to be
    **grouped**, not read — ``CorruptMedia``'s docstring is explicit that a
    report unable to separate the two would bury real data loss under ordinary
    operator noise, and a reason sentence cannot be grouped on.
    """

    #: Intact, and not something VisionSet accepts. Operator noise, usually.
    UNSUPPORTED = "unsupported"
    #: A format we do accept, whose bytes will not decode. Data loss.
    CORRUPT = "corrupt"


class IngestFailure(BaseModel):
    """One item an ingest run could not turn into an asset.

    ``name`` is the run's own name for the item — a path for a file on disk,
    ``clip.mp4#frame=42`` for a frame — and never the exception's, which
    ``MediaError`` documents as reporting rather than identity. ``reason`` never
    repeats the name, which is what lets a report be a table instead of a list
    of sentences.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    kind: IngestFailureKind
    reason: str


class IngestJob(BaseModel):
    """Tracks one ingestion run of a Source into a Project's asset pool.

    Declared after ``IngestFailure`` because it holds a tuple of them, and
    pydantic resolves that annotation when the class is created rather than when
    it is first used.

    The last four fields arrive by ``ALTER TABLE`` and are therefore declared
    **last, in migration order** — the rule ``AssetRow`` and ``AnnotationRow``
    already follow, and the reason is that SQLite appends an added column, so a
    different order here would make the ``create_all`` path and the migration
    path emit different DDL.
    """

    id: UUID = Field(default_factory=uuid4)
    source_id: UUID
    state: IngestState = IngestState.PENDING
    #: The fatal cause that stopped the run, as opposed to the per-file report
    #: below. One broken machine is not five thousand broken files.
    error: str | None = None
    #: The batch this run materialized into, NULL until it has reached one.
    #: Declared last as of migration 8.
    batch_id: UUID | None = None
    #: The name a batch this run creates will take, decided before the decode so
    #: that resuming a run which never reached a batch still lands where the
    #: first attempt meant it to. NULL only on a row written before migration 9.
    batch_name: str | None = None
    #: Items read so far — decoded, hashed and stored, or reported as unreadable.
    #: Written while the run is in flight, which is what makes it pollable.
    processed: int = Field(default=0, ge=0)
    #: Items the source offered, or NULL when that is not knowable in advance.
    #: A directory can be listed; a clip cannot, because ``VideoMetadata``
    #: deliberately carries no frame count — the number an ingest wants is what
    #: extraction produced, and anything else would be a guess with a VFR clip.
    total: int | None = Field(default=None, ge=0)
    #: The per-file report of the **current** attempt. A resumed run starts a
    #: fresh one rather than accumulating across attempts.
    failures: tuple[IngestFailure, ...] = ()


class IngestResult(BaseModel):
    """What one call to ``IngestService.ingest`` did.

    The caller's copy of what the run's own row records, handed back so that
    waiting for a synchronous run does not then require reading it. ``assets``
    carries whole models rather than ids because there is no door that reads an
    ``Asset`` back — a caller that has just ingested should not have to reach
    into a repository to learn what it got, and that is the one part of this
    that the row cannot hold.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    job_id: UUID
    project_id: UUID
    source_id: UUID
    batch_id: UUID
    #: Everything this run put in the batch, in ingest order.
    assets: tuple[Asset, ...] = ()
    #: The subset of ``assets`` that was new to the project.
    created_asset_ids: tuple[UUID, ...] = ()
    failures: tuple[IngestFailure, ...] = ()

    @property
    def asset_ids(self) -> tuple[UUID, ...]:
        """Every asset in the batch after this run, in ingest order."""
        return tuple(asset.id for asset in self.assets)

    @property
    def created(self) -> int:
        """How many assets did not exist in this project before the run."""
        return len(self.created_asset_ids)

    @property
    def deduplicated(self) -> int:
        """How many items resolved to content the project already held."""
        return len(self.assets) - len(self.created_asset_ids)

    @property
    def failed(self) -> int:
        """How many items could not be read at all."""
        return len(self.failures)
