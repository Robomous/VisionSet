# usage: from visionset.kernel.domain import IngestJob
"""One ingestion run: the record of it, and the report it hands back.

Two shapes live here and they are not the same kind of thing. ``IngestJob`` is a
**row** — it outlives the call, and #19 is what gives it a transition table,
progress counters and a persisted error report. ``IngestResult`` is a **return
value** — it exists for the caller of ``IngestService.ingest`` and is never
stored. #20 keeps them apart deliberately: the pipeline works today and reports
in memory, and #19 turns that report into columns without changing what the
pipeline computes.

Counts are derived properties rather than stored fields, the way batch
completion and per-asset progress are derived elsewhere in this domain. #19's
counters are a different thing: a running total written to a row *while* a job
is in flight, which a summary of a finished object cannot serve.
"""

from __future__ import annotations

from enum import StrEnum
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.domain.asset import Asset


class IngestState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class IngestJob(BaseModel):
    """Tracks one ingestion run of a Source into a Project's asset pool."""

    id: UUID = Field(default_factory=uuid4)
    source_id: UUID
    state: IngestState = IngestState.PENDING
    error: str | None = None
    #: The batch this run materialized into, NULL until it has reached one.
    #: Declared last: it arrives by ``ALTER TABLE`` in migration 8.
    batch_id: UUID | None = None


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


class IngestResult(BaseModel):
    """What one call to ``IngestService.ingest`` did.

    In memory only: nothing reads this back, and #19 is what persists a report.
    ``assets`` carries whole models rather than ids because there is no door
    that reads an ``Asset`` back — a caller that has just ingested should not
    have to reach into a repository to learn what it got.
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
