# usage: registered as job type "ingest.resume"
"""The ingest handler: pick a recorded run up and do it.

**It is four lines, and that is the whole point of the migration.** Ingest was
already split into ``enqueue`` and ``resume`` — the row exists before the work
starts, ``resume`` picks up anything ``INGEST_TRANSITIONS`` lets reach
``running``, and progress is written to the ``ingest_job`` row as the run goes. So
moving ingest onto the executor is a change of *who calls ``resume``*, and nothing
about ingest itself.

**Two rows for one run, deliberately and transitionally.** The ``job`` row is
execution plumbing; the ``ingest_job`` row is the domain record — it is what
``GET /ingest-jobs/{id}`` publishes, what the ingest screen polls, and what a
resumed attempt reads to find the batch it was heading for. Collapsing them is a
migration with its own wire-contract discussion, so until then this handler
reports its progress to *neither* through the generic reporter:
``IngestService`` writes ``processed``/``total``/``failures`` on its own row, and
duplicating that here would give a poller two numbers that could disagree.

What the reporter *is* used for is the cancel check — see below.

**Idempotent, and this is the type where that word was earned.** Registration is
idempotent on ``(kind, path, extraction_fps)``, blobs are content-addressed and
assets deduplicate by content, so a second run of the same source creates nothing.
That is exactly why ``resume``'s docstring calls itself a redo rather than a skip,
and it is what makes re-queueing an orphan after a crash safe.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from pydantic import JsonValue

from visionset.jobs.context import workspace_for
from visionset.jobs.registry import HandlerRef, register
from visionset.kernel.ports import ProgressReporter
from visionset.kernel.services import IngestService

JOB_TYPE = "ingest.resume"

HANDLER = register(HandlerRef(type=JOB_TYPE, func=f"{__name__}:run", idempotent=True))


def payload_for(ingest_job_id: UUID) -> dict[str, JsonValue]:
    """The payload this handler expects, built where the type is known.

    A function rather than a dict literal at the call site, so that the one place
    naming the key is the one place that reads it. A route that spelled
    ``{"ingest_job_id": ...}`` by hand would be free to spell it differently, and
    the mismatch would surface as a ``KeyError`` inside a worker.
    """
    return {"ingest_job_id": str(ingest_job_id)}


def run(
    workspace_root: Path,
    payload: dict[str, JsonValue],
    reporter: ProgressReporter,
) -> dict[str, JsonValue]:
    """Resume the ingest job named in ``payload``.

    ``reporter`` is consulted **once, before starting**, and not during: a run
    that has already been asked to stop should not read five thousand files, but
    stopping *partway* through one is not something ingest can do usefully. Its
    phases are one decode pass and then a batch of writes; abandoning it in the
    middle leaves the blobs it wrote (harmless — content-addressed, shared, never
    deleted) and no rows, which is exactly the state a re-run resolves. So the
    honest cancellation point is the one before any of it.
    """
    if reporter.is_cancelled():
        return {}
    ingest_job_id = UUID(str(payload["ingest_job_id"]))
    # Never a ``with``: the handle belongs to the worker and outlives this task.
    # See ``jobs/context.py``.
    workspace = workspace_for(workspace_root)
    result = IngestService(workspace).resume(ingest_job_id)
    return {
        "ingest_job_id": str(result.job_id),
        "batch_id": str(result.batch_id),
        "asset_count": len(result.assets),
        "created": result.created,
        "failed": result.failed,
    }
