# usage: registered as job type "inference.check_integrity"
"""The integrity-check handler: re-read a snapshot and say whether it survived.

**A background job because of what it costs, which is every byte.** The whole
mechanism is a full read of the cached snapshot — gigabytes for a model of this
class — and there is no cheaper one that answers the question (see
``visionset.inference.integrity``). So the route answers 202 and points at a row,
the launch-and-poll contract the download, export and ingest routes already use.

**The work is one call, for the download handler's reason.**
``visionset.inference.check_integrity`` is the whole sequence — gate, read,
purge, stand down — and it is the sequence the CLI runs too. Two implementations
of "what checking means" is how a terminal and an API come to disagree about
whether a model is usable, and the disagreement would only show up on the day
somebody used both.

**Both have a real total, and they count different things.** A check owns its
loop and knows how many files it has before it starts, so it reports files; a
download hands its transfer to a library that reports nothing a caller can use,
so it measures bytes off the disk. Either is an absolute count of the unit that
run works in, which is all a job row's ``processed`` and ``total`` ever claimed
to be — and which unit it is, is named where the job type is known and nowhere
else.

**Failure is a verdict, and the verdict is already written when it arrives.** A
run that finds damage purges the bad blobs and records the connection
``not_set_up`` *before* raising, so the failed row a reader finds describes a
state the workspace is already in. That is the opposite of the download handler,
where failure means nothing was written — and it is the difference between an
operation that fetches and one that judges.

**Idempotent, and the word is earned.** Checking twice reads the same files and
reaches the same verdict; a second run after a purge finds the files missing,
purges nothing, and records a connection that is already ``not_set_up``. So
``sweep_orphans`` can point at this safely.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from pydantic import JsonValue

from visionset.inference import check_integrity
from visionset.jobs.context import workspace_for
from visionset.jobs.registry import HandlerRef, register
from visionset.kernel.domain import (
    CONNECTION_JOB_KEY,
    INTEGRITY_CHECK_JOB_TYPE,
    connection_job_payload,
)
from visionset.kernel.ports import ProgressReporter

JOB_TYPE = INTEGRITY_CHECK_JOB_TYPE
"""This handler's type, taken from the domain rather than spelled here.

The type has a second reader: a connection finds its own check by it, so that a
screen can show a run it did not start. The kernel may not import this package,
so the constant lives there and this names it — one spelling, and a handler
registered under a type nothing can look up becomes impossible rather than merely
unlikely.
"""

HANDLER = register(HandlerRef(type=JOB_TYPE, func=f"{__name__}:run", idempotent=True))


def payload_for(connection_id: UUID) -> dict[str, JsonValue]:
    """The payload this handler expects, built where the type is known.

    ``weights.payload_for``'s rule and its reason: the one place naming the key
    is the one place that reads it, so a route spelling it by hand cannot spell
    it differently and surface the mismatch as a ``KeyError`` inside a worker.

    The shape itself comes from the domain, shared with the download: both jobs
    are about exactly one connection, and the lookup that finds either matches on
    this key.
    """
    return connection_job_payload(connection_id)


def run(
    workspace_root: Path,
    payload: dict[str, JsonValue],
    reporter: ProgressReporter,
) -> dict[str, JsonValue]:
    """Re-read the named connection's snapshot and report what it cost.

    ``reporter`` is consulted **once, before starting**, on the download
    handler's terms — but it is *reported to* on every file, which that one
    cannot do. The asymmetry is real: this handler owns its loop and knows its
    total, so the progress is a count of files rather than a phase.

    Cancellation stays at the single point before the first read, deliberately.
    Stopping partway through a check does not leave anything half-written —
    every write happens after the last file — but it also does not leave an
    *answer*, and a job that settled as cancelled having read most of a snapshot
    would invite the reading that it found nothing wrong. The honest stopping
    point is the one before any bytes are read.

    The result carries what was read rather than what was found, because
    "found" is the absence of a failure: a run that returns at all is a run in
    which every file matched. Damage leaves through the exception, where the
    filenames are.
    """
    if reporter.is_cancelled():
        return {}
    connection_id = UUID(str(payload[CONNECTION_JOB_KEY]))
    # Never a ``with``: the handle belongs to the worker and outlives this task.
    # See ``jobs/context.py``.
    workspace = workspace_for(workspace_root)
    report = check_integrity(
        workspace,
        connection_id,
        on_file=lambda checked, total: reporter.report(processed=checked, total=total),
    )
    return {CONNECTION_JOB_KEY: str(connection_id), **report.counts()}
