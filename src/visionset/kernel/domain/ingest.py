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
from pathlib import Path
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    """What became of one item the run could not simply read, split by remedy.

    An enum rather than a plain ``str``, on exactly ``SourceKind``'s terms: the
    set is closed, no writer outside this build produces a value, and the kernel
    branches on it. What makes it worth a type at all is that a report has to be
    **grouped**, not read — ``CorruptMedia``'s docstring is explicit that a
    report unable to separate the kinds would bury real data loss under ordinary
    operator noise, and a reason sentence cannot be grouped on.

    ``PARTIAL`` is the third member and the only one that is not a total loss.
    It exists because the two below cannot say the thing an operator most needs
    to hear about a damaged clip: *some of it is in your batch*. Filing a
    truncated video as ``CORRUPT`` is true of the file and misleading about the
    run, which had just created assets from it.
    """

    #: Intact, and not something VisionSet accepts. Operator noise, usually.
    UNSUPPORTED = "unsupported"
    #: A format we do accept, whose bytes will not decode. Data loss.
    CORRUPT = "corrupt"
    #: Read in part. What arrived is stored; what did not is gone. Data loss too,
    #: but with a remainder, which is why the counts below travel with it.
    PARTIAL = "partial"


class IngestFailure(BaseModel):
    """What became of one item an ingest run could not simply read.

    ``name`` is the run's own name for the item — a filename for a file on disk,
    ``clip.mp4#frame=42`` for a frame — and never the exception's, which
    ``MediaError`` documents as reporting rather than identity. ``reason`` never
    repeats the name, which is what lets a report be a table instead of a list
    of sentences. It is built by ``report_name`` below, which is what keeps a
    server path out of it.

    **The counts belong to ``PARTIAL`` alone**, and the model refuses any other
    arrangement. That is not tidiness: a report entry has to be groupable on its
    kind, so an ``UNSUPPORTED`` entry allowed to carry ``frames_produced=0``
    would give the report two ways to say "nothing arrived" and force every
    reader to check both. The invariant runs the other way too: ``PARTIAL``
    without a count is a prose sentence where a number belongs.

    A **positive** count, specifically. Zero frames out of a clip is not a
    partial read of it; it is a clip that did not read, which the adapter already
    reports as ``UnsupportedMedia`` and this report already has a kind for.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    kind: IngestFailureKind
    reason: str
    #: How many frames of a damaged clip were extracted and kept. ``PARTIAL``
    #: only; NULL everywhere else. Exact — it is the length of what the run kept.
    frames_produced: int | None = Field(default=None, gt=0)
    #: What the container claimed to hold, as ``duration × extraction_fps`` off
    #: the probe the source already carries. ``PARTIAL`` only, and **optional
    #: within it**: it is an estimate and is named as one. ``VideoMetadata``
    #: deliberately carries no frame count — for a variable-rate stream the
    #: product is a guess — and a damaged container's own metadata is suspect
    #: besides. A partial with no denominator still states what it recovered.
    frames_expected_estimate: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _counts_belong_to_a_partial_read(self) -> IngestFailure:
        counted = self.kind is IngestFailureKind.PARTIAL
        if counted and self.frames_produced is None:
            raise ValueError("a partial read must say how many frames it produced")
        if not counted and (
            self.frames_produced is not None or self.frames_expected_estimate is not None
        ):
            raise ValueError(f"{self.kind.value} recovered nothing, so it counts no frames")
        return self


def report_name(item: Path | str, *, root: Path | None = None) -> str:
    """What a report calls one item, with the server's own layout left out.

    ``Source.path`` and ``Asset.uri`` are deliberately unpublished — an absolute
    path is useless to a client and needlessly disclosive, which is why
    ``SourceOut.name`` carries a basename and reaching bytes goes through a
    route keyed on an asset id. ``IngestFailure.name`` used to carry one anyway,
    by accident: it was whatever the run's own loop happened to be holding, so a
    directory ingest published one path spelling and a clip published another.

    ``root`` is the directory the run was reading, when it has one. The answer
    is then the path **relative to** it, so a file stays distinguishable from a
    namesake in a sibling directory without naming the machine either lives on.
    With no root — a clip, or an asset whose source is no longer in hand — the
    answer is the basename, which is the rule every neighbouring decision makes.

    A frame's ``clip.mp4#frame=42`` survives either branch: the fragment holds no
    separator, so it belongs to the basename rather than going with the path.
    """
    path = Path(item)
    if root is not None:
        try:
            relative = path.relative_to(root)
        except ValueError:
            # Not under that root after all. Nothing to report about the
            # mismatch — the basename below is still an honest answer.
            pass
        else:
            if relative != Path("."):
                return str(relative)
    return path.name


class IngestJob(BaseModel):
    """Tracks one ingestion run of a Source into a Project's asset pool.

    Declared after ``IngestFailure`` because it holds a tuple of them, and
    pydantic resolves that annotation when the class is created rather than when
    it is first used.

    Field order here mirrors ``IngestJobRow``'s column order, which is pinned by
    the ordering rule in ``adapters/_tables.py``: SQLite appends a column added
    by ``ALTER TABLE``, so the tail of that table is not free to be rearranged.
    """

    id: UUID = Field(default_factory=uuid4)
    source_id: UUID
    state: IngestState = IngestState.PENDING
    #: The fatal cause that stopped the run, as opposed to the per-file report
    #: below. One broken machine is not five thousand broken files.
    error: str | None = None
    #: The batch this run materialized into, NULL until it has reached one.
    batch_id: UUID | None = None
    #: The name a batch this run creates will take, decided before the decode so
    #: that resuming a run which never reached a batch still lands where the
    #: first attempt meant it to. NULL when the caller named no batch.
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
    #:
    #: It holds every item that was not simply read, including the ones that were
    #: read *in part*. An item read whole is absent: silence
    #: is the ok-state, and a run that reported one line per healthy file would
    #: be five thousand lines of nothing on a directory ingest.
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
        """How many items could not be read at all.

        A ``PARTIAL`` entry is deliberately **not** one of them: counting a clip
        that put eight frames in the batch as a file the run could not read would
        contradict the assets it just created.
        """
        return len(self.failures) - self.partial

    @property
    def partial(self) -> int:
        """How many items were read in part, with what arrived kept."""
        return sum(1 for failure in self.failures if failure.kind is IngestFailureKind.PARTIAL)


class ThumbnailBackfill(BaseModel):
    """What one pass of ``IngestService.backfill_thumbnails`` found and repaired.

    A report rather than a count or an exception, on ``ReleaseVerification``'s
    terms: someone running a repair over a damaged workspace needs the list and
    not the verdict, and one asset nobody can render must not abort the other
    five thousand.

    ``missing`` and ``unreadable`` are different faults with different remedies
    and are never merged. A content blob that is gone is workspace damage a
    thumbnail pass cannot repair and must not hide; a blob that is present and
    will not decode is an asset that will simply never have a preview.

    That ``unreadable`` reuses ``IngestFailure`` is deliberate — the
    ``UNSUPPORTED``/``CORRUPT`` split says exactly the right thing about stored
    bytes, and the remedy is identical. That ``missing`` does **not** is equally
    deliberate: ``IngestFailureKind`` answers "what is wrong with this file",
    and a blob that is not there is not a file. Nothing here is a
    ``WorkspaceCorrupt``, because raising would abandon the repair of every
    healthy asset over one bad row.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    project_id: UUID
    #: Assets that now have a preview they did not have before this pass.
    filled: tuple[UUID, ...] = ()
    #: Assets whose content blob is gone from the store.
    missing: tuple[UUID, ...] = ()
    #: Assets whose stored bytes are present and will not render.
    unreadable: tuple[IngestFailure, ...] = ()

    @property
    def examined(self) -> int:
        """How many assets this pass found without a preview.

        Derived rather than stored, so it cannot disagree with the three lists
        it counts — the rule ``IngestResult.created`` already follows.
        """
        return len(self.filled) + len(self.missing) + len(self.unreadable)
