# usage: from visionset.kernel.ports import ProgressReporter
"""What a running handler is allowed to say, and the one question it may ask.

A handler runs in a process with no request, no response and nobody waiting on
its return value. This is its whole channel back: two methods, one outbound and
one inbound.

**It is a port rather than a function argument of ``JobQueue``** because the two
are used at opposite ends of a process boundary. The queue lives in the API
process, where the dispatcher polls it; a reporter lives in the worker, where the
handler holds it for the length of one run and writes through it dozens of times.
Handing a handler the queue would hand it ``claim`` and ``finish`` as well —
methods that let a run settle itself, which is exactly the authority the
dispatcher must keep.

**Nothing here raises for a job that has vanished.** A row deleted underneath a
run leaves the work still worth doing, and losing it over a missing receipt is
the worse answer — the rule ``IngestService._record_progress`` already follows.

A test double is two counters and a boolean, which is the point: a handler is
tested by driving it with a fake reporter and reading what it said, with no
database anywhere near it.
"""

from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import ItemFailure


@runtime_checkable
class ProgressReporter(Protocol):
    """Where a handler says how far it has got, and asks whether to stop."""

    def report(
        self,
        *,
        processed: int,
        total: int | None = None,
        failures: Sequence[ItemFailure] = (),
    ) -> None:
        """Publish how far the run has got.

        **Absolute, never a delta.** ``processed`` is the count so far, not the
        number since the last call, so a dropped write costs nothing and a
        retried one is not double-counted. The same goes for ``failures``: it is
        the whole report, and an implementation replaces rather than appends.

        ``total`` is ``None`` when the work cannot know it in advance — the rule
        ``IngestJob.total`` states for a clip, and the one every progress bar in
        this product already tolerates. Passing ``None`` does not *clear* a total
        an earlier call established; it says nothing about it, because a handler
        that learns its total halfway through should not have to repeat it
        forever afterwards.

        **An implementation may throttle, and callers must assume it does.** The
        default one writes at most once every so often, because the cost of a
        progress write is a commit against a single-writer store that the work
        itself is also writing to. So this is a hint about the present, not a
        journal: a handler that needs every step recorded is describing a
        different feature.
        """
        ...

    def is_cancelled(self) -> bool:
        """Whether somebody has asked this run to stop.

        **Cooperative, and there is no other kind here.** Nothing kills a worker
        mid-statement: a handler that is halfway through writing rows would leave
        a workspace in a state no reader could interpret. So a handler calls this
        where it knows stopping is safe — between items, before a transaction —
        and returns when it says yes.

        Returning normally after a ``True`` is what marks a run **cancelled**
        rather than succeeded; raising is a failure like any other. A handler that
        never calls this simply cannot be cancelled once it starts, which is an
        honest thing for a short job to be.

        An implementation may cache, and the default one does, for the reason
        :meth:`report` may throttle — this is asked in a loop, and answering it
        from the database every time would put a read between every pair of items.
        """
        ...
