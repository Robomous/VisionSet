# usage: from visionset.kernel.ports import JobQueue
"""The queue: where work waits, and how exactly one runner picks it up.

**What this port is not.** It is not an executor. Nothing here starts a thread, a
process or a coroutine — :meth:`JobQueue.claim` hands out a row and says nothing
about who runs it or where. That separation is what lets the default adapter be a
table in the workspace's own SQLite file while a later one is a hosted queue: the
thing that changes is where rows live, not how the product asks for work.

**One writer's worth of concurrency is assumed, and it is enforced by the claim.**
:meth:`claim` is the only method here that two callers may race, and an
implementation owes it atomicity — see the method's own docstring. Everything else
is addressed by id.

Three obligations an implementation owes, none of which the signature can express:

- **A claim is exactly-once.** Two concurrent claims never return the same job.
  The default adapter gets this from a guarded ``UPDATE`` whose ``rowcount`` is
  the answer, the same shape ``UnitOfWork.set_asset_progress`` uses; a hosted
  queue gets it from a visibility timeout. Either way the caller may assume it.
- **A settled job never moves again.** ``finish`` on a job that is already
  ``succeeded``, ``failed`` or ``cancelled`` raises rather than overwriting: a
  second answer for one run means two runners had it, which is the failure this
  port exists to make impossible.
- **Nothing here blocks.** ``claim`` on an empty queue returns ``None``
  immediately rather than waiting. A dispatcher that wants to wait owns its own
  interval, because how long to sleep is a property of the deployment and not of
  the queue.

**Payloads must survive a pickle and a JSON column, and that is measured rather
than assumed.** Against a real workspace, ``WorkspaceService``,
``SqliteMetadataStore``, the SQLAlchemy ``Engine``, the auth provider and *every*
kernel service fail to pickle — each one transitively holds an engine, whose
``connect`` is a closure. So a payload names a workspace by **path** and its
subject by **id**, and the handler opens what it needs on the other side. This
is why :class:`~visionset.kernel.domain.BackgroundJobSpec` types its payload as
``JsonValue`` rather than ``Any``: the refusal then happens where the mistake is,
at ``enqueue``, instead of inside a worker whose traceback names neither the job
nor its caller.
"""

from collections.abc import Collection
from typing import Protocol, runtime_checkable
from uuid import UUID

from visionset.kernel.domain import (
    BackgroundJob,
    BackgroundJobOutcome,
    BackgroundJobSpec,
    BackgroundJobState,
)


@runtime_checkable
class JobQueue(Protocol):
    """Durable storage for background work, plus the one atomic hand-off."""

    def enqueue(self, spec: BackgroundJobSpec) -> BackgroundJob:
        """Record that work was asked for, and return the row to poll.

        The row exists before this returns, which is the whole point: a surface
        answering ``202`` has to hand back an id somebody can ask about, and an
        id for a row nobody wrote is worse than a refusal.

        **Whether anything can actually run ``spec.type`` is not checked here**,
        and an implementation must not try: resolving a type to code means
        reading a handler registry, which lives outside the kernel because a
        handler may name a format plugin. ``UnknownJobType`` is therefore raised
        by whoever builds the spec — where there is still a caller to tell — and
        again by the dispatcher, which fails the row. See
        ``visionset/jobs/registry.py``.
        """
        ...

    def get(self, job_id: UUID) -> BackgroundJob | None:
        """The job with that id, or ``None``.

        ``None`` rather than a refusal, because the two callers want different
        things from a miss: a route turns it into a 404 naming the id, and a
        dispatcher checking whether a job was cancelled underneath it treats a
        vanished row as "stop". A service raising would make the second one
        write a ``try``.
        """
        ...

    def claim(self, worker: str) -> BackgroundJob | None:
        """Take the oldest queued job for ``worker``, or ``None`` if there is none.

        **The one operation two callers may race, and the only one that has to be
        atomic.** An implementation moves the row ``queued -> running``, stamps
        ``started_at`` and ``worker`` and increments ``attempt``, and it does the
        test and the write in one statement — a read followed by a write has a
        window wide enough for a second dispatcher to fit into, and the symptom is
        one job running twice with one row to report it.

        Oldest first, by ``created_at``. Not a priority queue: priorities are a
        product decision nobody has asked for, and adding a column now would mean
        every future caller choosing a number for no reason.

        ``worker`` is recorded, not validated. It exists so that a person reading
        a list of running jobs can tell which of them belongs to a process that
        is no longer there.
        """
        ...

    def finish(self, job_id: UUID, outcome: BackgroundJobOutcome) -> BackgroundJob:
        """Settle a running job and stamp ``finished_at``.

        Takes an outcome rather than a state plus three optionals so that the
        model's own validator can refuse a succeeded run carrying an error, and so
        that adding a field to what a run reports is one edit rather than a
        signature change on every implementation.

        Raises:
            BackgroundJobNotFound: no such job.
            InvalidTransition: the job is not running, or the outcome is not a
                state it can reach. Both go through
                ``BACKGROUND_JOB_TRANSITIONS`` rather than being restated here.
        """
        ...

    def request_cancel(self, job_id: UUID) -> BackgroundJob:
        """Ask for a job to stop, and say where that left it.

        **Two different things behind one verb, and the difference is visible in
        the answer.** A ``queued`` job has not started, so there is nothing to ask
        and it is settled ``cancelled`` outright. A ``running`` job is only
        *told*: the flag is set, the state does not move, and the handler decides
        at its next :meth:`ProgressReporter.is_cancelled` where stopping is safe.
        A caller that needs to know which happened reads ``state`` off what comes
        back.

        Cancelling a settled job is a **no-op that returns it unchanged**, not a
        refusal. The caller wanted it stopped and it is stopped; raising would
        make every cancel button need a race-condition branch.

        Raises:
            BackgroundJobNotFound: no such job.
        """
        ...

    def sweep_orphans(self, *, reason: str) -> list[BackgroundJob]:
        """Settle every job left ``running`` by a process that is gone.

        Called once at startup, before any worker starts. **It is exact rather
        than heuristic, and only because of how this product is deployed**: one
        server process owns every worker, so a ``running`` row observed before
        that process has started anything cannot belong to anybody. That is the
        entire argument for shipping no lease column and no heartbeat — there is
        no third party whose liveness would have to be guessed at. A queue shared
        by several servers needs both, and needs them in *its* adapter.

        Returns what it settled, so a caller can log how much a crash cost. An
        idempotent orphan is re-enqueued as a **new** job — see
        ``BACKGROUND_JOB_TRANSITIONS`` for why a retry is never the same row —
        and the returned list is the orphans as settled, not the replacements.
        """
        ...

    def list(self, *, states: Collection[BackgroundJobState] | None = None) -> list[BackgroundJob]:
        """Every job, newest first, optionally narrowed to some states.

        Newest first because the caller is a person looking at what is happening
        now, which is the opposite of :meth:`claim`'s order — and the two are
        stated separately rather than shared, because they are answering opposite
        questions.

        Declared **last** in this protocol: a method named ``list`` shadows the
        builtin for every annotation after it in the same body, which is the rule
        ``BatchService`` already follows.
        """
        ...
