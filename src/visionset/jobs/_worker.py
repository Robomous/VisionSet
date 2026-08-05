# usage: internal to visionset.jobs — the far side of the process boundary
"""The one function a pool calls, and the shape of what it hands back.

**A module-level function, because that is the only kind a pool can call.** The
two submit sites this replaces were ``runner.submit(lambda: ingest.resume(job.id))``
— a closure over a service, unpicklable twice over.

Everything here is written for ``spawn``: a worker is a fresh interpreter that has
imported nothing and is handed only what pickles. Rebuilding the rest on the far
side is :mod:`visionset.jobs.context`'s job; this module is what calls it.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from pydantic import BaseModel, ConfigDict, JsonValue

from visionset.jobs.context import workspace_for
from visionset.jobs.registry import HandlerRef, load
from visionset.kernel.adapters.sqlite_progress_reporter import SqliteProgressReporter
from visionset.kernel.domain import ItemFailure


class WorkerResult(BaseModel):
    """What a worker hands back, and why it is more than the handler's dict.

    The dispatcher settles the job, so it needs three things a handler's return
    value does not carry: whether the run stopped because somebody cancelled it,
    and the final progress numbers.

    Those numbers come from what the handler *said* rather than from the row,
    because the reporter throttles — the last item's write is the one most likely
    to fall inside the interval, and it is the one a finished job is read for.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    result: dict[str, JsonValue]
    cancelled: bool
    processed: int
    total: int | None
    failures: tuple[ItemFailure, ...]


def execute(
    ref: HandlerRef,
    workspace_root: Path,
    job_id: UUID,
    payload: dict[str, JsonValue],
    progress_min_interval_s: float,
) -> WorkerResult:
    """Resolve the handler, run it, and report what happened.

    Five arguments and every one of them pickles: a frozen model of three scalars,
    a ``Path``, a ``UUID``, a JSON dict and a float. That property is the whole
    reason this signature looks the way it does.

    **Exceptions are not caught.** A handler that raises lets the exception travel
    back through the pool's future, where the dispatcher turns it into a failed job
    carrying its text. Catching it here would mean inventing an error shape in the
    one process that has no queue to write it to.
    """
    workspace = workspace_for(workspace_root)
    reporter = SqliteProgressReporter(
        workspace.metadata_store, job_id, min_interval_s=progress_min_interval_s
    )
    handler = load(ref)
    result = handler(workspace_root, payload, reporter)
    return WorkerResult(
        result=result,
        cancelled=reporter.is_cancelled(),
        processed=reporter.reported_processed,
        total=reporter.reported_total,
        failures=reporter.reported_failures,
    )
