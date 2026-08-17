# usage: from visionset.kernel.domain import BackgroundJob
"""Background work: the record of a run that outlives the call that asked for it.

**Why these names carry a prefix.** ``JobState`` and ``JOB_TRANSITIONS`` are
already taken, by ``domain/task.py``, and they mean something else entirely: an
``AnnotationJob`` is a unit of *human* work — a slice of a batch somebody sits
down and labels — and every route that touches one answers inside its own
request. What lives here is machine work that a request launches and walks away
from. Two different things wanted the same word, so the newer one is spelled
``BackgroundJob`` rather than shadowing a shipped vocabulary.

**This is plumbing, and it is deliberately thin.** A job row records that
something was asked for, who is running it, how far it has got and how it ended.
It records **nothing about what the work means** — that stays with whatever
domain object the work is about, which is why :class:`BackgroundJobSpec` carries
an opaque ``payload`` rather than a union of every operation the product might
one day queue. A handler reads its own payload; nothing else does.

**It coexists with ``IngestJob`` rather than replacing it.** An ``IngestJob`` is
a *domain record* — it is what ``GET /ingest-jobs/{id}`` publishes, what the
ingest screen polls, and what ``resume`` reads to find the batch a dead attempt
was heading for. This is *execution plumbing*. An ingest therefore has two rows
for one run, and the duplication is transitional and known: collapsing them is a
migration with its own wire-contract discussion, not a side effect of introducing
an executor. Progress for every job type introduced from here on lives on **this**
row.

**Payloads are plain data, and that is a hard requirement rather than a style.**
A handler runs in a separate process, so its arguments cross a pickle *and* a
JSON column. Nothing in a payload may be a service, a path-bearing object with
behaviour, or anything holding a database connection — see
``ports/job_queue.py`` for the measurement behind that rule.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, JsonValue

#: What a handler is handed and what it hands back: JSON-shaped, nothing else.
#:
#: A type alias rather than ``dict[str, Any]`` so that "this crosses a process
#: boundary and a database column" is stated in the signature instead of in a
#: comment somebody can skip. ``JsonValue`` is pydantic's own recursive union, so
#: a payload holding a service or an open handle fails validation at the door
#: rather than at ``pickle.dumps`` inside a worker, where the traceback names
#: neither the job nor the caller.
type JobPayload = Mapping[str, JsonValue]


class BackgroundJobState(StrEnum):
    """Lifecycle: queued -> running -> (succeeded | failed | cancelled).

    Five states rather than four. ``cancelled`` is not a flavour of ``failed``
    because the two answer different questions for the person reading a list:
    a failure is something to look into, a cancellation is something somebody
    did. Merging them would make "why did this stop?" unanswerable from the row.
    """

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


#: Terminal states: nothing moves out of these, and a poller stops here.
#:
#: Written out rather than derived by subtracting the two live states, on
#: ``PROMOTABLE_PROGRESS``' terms — a state added later must be classified
#: deliberately rather than fall into a set by omission.
SETTLED_JOB_STATES: Final[frozenset[BackgroundJobState]] = frozenset(
    {
        BackgroundJobState.SUCCEEDED,
        BackgroundJobState.FAILED,
        BackgroundJobState.CANCELLED,
    }
)


#: The two states in which a job is still somebody's to finish: it has been asked
#: for and no outcome has been written.
#:
#: Written out rather than derived as the complement of :data:`SETTLED_JOB_STATES`,
#: for the reason that set is written out: a state added later must be classified
#: deliberately, and a complement classifies it by omission — into *live*, which is
#: the answer that makes a caller wait for something that will never finish.
#:
#: What reads it is a caller asking *is one of these already under way* before it
#: asks for another. That question is not the same as "not settled" only by
#: accident of there being five states today.
LIVE_JOB_STATES: Final[frozenset[BackgroundJobState]] = frozenset(
    {BackgroundJobState.QUEUED, BackgroundJobState.RUNNING}
)


BACKGROUND_JOB_TRANSITIONS: Final[Mapping[BackgroundJobState, frozenset[BackgroundJobState]]] = {
    BackgroundJobState.QUEUED: frozenset(
        {BackgroundJobState.RUNNING, BackgroundJobState.CANCELLED}
    ),
    BackgroundJobState.RUNNING: frozenset(
        {
            BackgroundJobState.SUCCEEDED,
            BackgroundJobState.FAILED,
            BackgroundJobState.CANCELLED,
        }
    ),
    BackgroundJobState.SUCCEEDED: frozenset(),
    BackgroundJobState.FAILED: frozenset(),
    BackgroundJobState.CANCELLED: frozenset(),
}
"""Every move a background job may make. Anything absent raises ``InvalidTransition``.

A table rather than guards inside an adapter, the shape ``BATCH_TRANSITIONS``
established and ``INGEST_TRANSITIONS`` followed.

**``running -> running`` is absent, for the reason it is absent there**: a second
claim on a job already running would mean two workers doing the same work with
one row to report it, and the row would show whichever finished last. The claim
is a guarded ``UPDATE`` keyed on ``queued`` precisely so that this table's
absence is enforced by the database rather than by a check somebody can forget.

**There is no ``failed -> queued`` edge either**, and that is the one deliberate
difference from ``INGEST_TRANSITIONS``. An ingest job is resumed *on its own row*
because a run is the same unit of work continuing; a retry here is a **new job**,
so that ``attempt`` on one row never has to mean two different things and a list
of jobs never hides a history behind a single line. What re-enqueues after a
crash creates a row; it does not reopen one.
"""


class ItemFailure(BaseModel):
    """One item a job could not process, without stopping the job.

    Deliberately **not** ``IngestFailure``, and the difference is one field:
    that model carries an ``IngestFailureKind`` of ``unsupported`` or
    ``corrupt``, which is a statement about *media*. A generic job has no
    modality to classify, and giving every future job type a media vocabulary to
    ignore is how a shared model stops describing anything.

    ``reason`` never repeats ``name``, the rule ``IngestFailure`` states, so a
    report renders as a table rather than as a list of sentences.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    reason: str


class BackgroundJobSpec(BaseModel):
    """What a caller asks for: a type, its arguments, and whether a retry is safe.

    ``type`` is a plain ``str`` and not an enum, on ``DatasetChange.operation``'s
    terms: the set of job types is open by construction — a handler registers
    itself — and a build reading a row written by a build that knew one more type
    must still be able to display it. What *writers* pick from is the registry,
    which is the enum's job done somewhere it can also carry the handler.

    ``idempotent`` is the whole retry policy, and it is one boolean because the
    only decision anybody has to make is whether running the work twice is safe.
    An ingest is: registration is idempotent on ``(kind, path, extraction_fps)``
    and content addressing makes a re-run create nothing. An export is too — it
    clears its destination first. Anything that is not says so and is never
    retried automatically.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: str
    payload: dict[str, JsonValue] = Field(default_factory=dict)
    idempotent: bool = False


class BackgroundJobOutcome(BaseModel):
    """How a run ended, in the one shape :meth:`JobQueue.finish` takes.

    A model rather than four parameters so that "a job ends in exactly one way"
    is expressible: a caller cannot pass ``succeeded`` and an ``error`` together
    without the validator below refusing it.

    ``result`` is the handler's answer to whoever polls — the relative path of an
    export archive, say. Small and JSON-shaped on purpose: the row is read by a
    poller on an interval, so anything large belongs in the blob store with its
    hash in here.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    state: BackgroundJobState
    error: str | None = None
    result: dict[str, JsonValue] = Field(default_factory=dict)
    processed: int = Field(default=0, ge=0)
    total: int | None = Field(default=None, ge=0)
    failures: tuple[ItemFailure, ...] = ()

    def model_post_init(self, _: object, /) -> None:
        if self.state not in SETTLED_JOB_STATES:
            raise ValueError(f"an outcome must be terminal, not {self.state}")
        if self.state is BackgroundJobState.SUCCEEDED and self.error is not None:
            raise ValueError("a succeeded outcome carries no error")
        if self.state is BackgroundJobState.FAILED and not self.error:
            raise ValueError("a failed outcome must say why")


class BackgroundJob(BaseModel):
    """One queued or finished unit of machine work.

    Not frozen, unlike most of this domain, and for the reason ``IngestJob`` is
    not: it is a row whose whole purpose is to be rewritten as a run proceeds,
    and the adapter builds the next version with ``model_copy(update=...)``.

    Field order mirrors ``JobRow``'s column order. That is a convention this
    package keeps because SQLite appends an ``ALTER``-added column, so the tail of
    a table is not free to be rearranged — and a reader comparing the two should
    not have to hunt.
    """

    id: UUID = Field(default_factory=uuid4)
    type: str
    payload: dict[str, JsonValue] = Field(default_factory=dict)
    state: BackgroundJobState = BackgroundJobState.QUEUED
    idempotent: bool = False
    #: Items dealt with so far. Written while the run is in flight, by the
    #: handler's ``ProgressReporter``, which is what makes this pollable.
    processed: int = Field(default=0, ge=0)
    #: Items the work expects, or NULL when that is not knowable up front — the
    #: rule ``IngestJob.total`` states, kept here because the callers that render
    #: it (a progress bar) already tolerate the absence.
    total: int | None = Field(default=None, ge=0)
    #: Items that could not be processed, without stopping the run.
    failures: tuple[ItemFailure, ...] = ()
    #: The fatal cause, as opposed to the per-item report above.
    error: str | None = None
    #: What the handler produced, for whoever polls. See ``BackgroundJobOutcome``.
    result: dict[str, JsonValue] = Field(default_factory=dict)
    #: Somebody asked for this to stop. **A request, not a state**: a queued job
    #: is cancelled outright, but a running handler is only *told*, and it decides
    #: where it is safe to stop. See ``ProgressReporter.is_cancelled``.
    cancel_requested: bool = False
    #: How many times this row has been claimed. One, normally. It exists so that
    #: a claim can be told apart from a re-claim in a log, and it is the reason
    #: retry-after-crash creates a *new* job rather than reopening this one.
    attempt: int = Field(default=0, ge=0)
    #: Which worker holds it, for a person reading a list while something is
    #: running. NULL before the first claim, and left in place afterwards as the
    #: record of who ran it.
    worker: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    finished_at: datetime | None = None

    @property
    def settled(self) -> bool:
        """Whether nothing more will happen to this job.

        Derived rather than stored, so it cannot disagree with ``state`` — the
        rule ``IngestResult.created`` follows. It is also the predicate a poller
        stops on, which is why it is named for the terminal condition rather than
        for "still running": the terminal states are enumerated and the live ones
        are not, so a predicate written the other way round silently keeps polling
        a state somebody adds later.
        """
        return self.state in SETTLED_JOB_STATES
