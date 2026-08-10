# usage: registered as job type "inference.download_weights"
"""The weight-download handler: fetch what a connection names, then say so.

**It is a background job because of how long it is, not how complex.** Weights
for a detector of this class are gigabytes; a request that waited for them would
sit behind every proxy timeout between the browser and the server with no way to
report progress. So the route answers 202 and points at a row, which is the
launch-and-poll contract the export and ingest routes already use.

**The work itself is four lines, and that is deliberate.**
``visionset.inference.fetch_weights`` is the whole sequence — gate, download,
record — and it is the sequence the CLI runs too. Two implementations of "what
downloading means" is how a terminal and an API come to disagree about what "set
up" means, and the disagreement would only show up on the day somebody used both.

**Idempotent, and this is a type where the word is earned twice over.** The
snapshot download verifies a cache it already filled rather than re-fetching it,
and ``record_weights_ready`` returns a connection that is already ready
unchanged. So an orphan re-queued after a crash does the cheap half of its work
again and settles, which is what makes ``sweep_orphans`` safe to point at this.

**Failure leaves the connection where it was.** The state flip is the last
statement of ``fetch_weights``, so a run that dies mid-download has written no
row at all: the job carries the error, the connection is still ``not_set_up``,
and the remedy is to ask again. There is no half-``ready`` state because there is
no moment at which one could be written.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from pydantic import JsonValue

from visionset.inference import fetch_weights
from visionset.jobs.context import workspace_for
from visionset.jobs.registry import HandlerRef, register
from visionset.kernel.ports import ProgressReporter

JOB_TYPE = "inference.download_weights"

HANDLER = register(HandlerRef(type=JOB_TYPE, func=f"{__name__}:run", idempotent=True))


def payload_for(connection_id: UUID) -> dict[str, JsonValue]:
    """The payload this handler expects, built where the type is known.

    A function rather than a dict literal at the call site, so the one place
    naming the key is the one place that reads it — the rule ``ingest`` and
    ``export`` both follow, for the reason they give: a route spelling it by hand
    would be free to spell it differently, and the mismatch would surface as a
    ``KeyError`` inside a worker.
    """
    return {"connection_id": str(connection_id)}


def run(
    workspace_root: Path,
    payload: dict[str, JsonValue],
    reporter: ProgressReporter,
) -> dict[str, JsonValue]:
    """Fetch the named connection's weights and mark it ready.

    ``reporter`` is consulted **once, before starting**, on ``export``'s terms
    and for its reason: what follows is one library call that writes a cache and
    reports nothing this process can subdivide, so the honest cancellation point
    is the one before any bytes are fetched. Stopping partway would leave a
    partial cache the next run has to verify anyway — which it does, which is why
    abandoning it costs nothing but is also not a *cancellation* worth claiming.

    The counts it reports afterwards are the one connection this run was about.
    A byte total would be the better number and is not available: the download
    library owns the transfer and reports through its own progress bar, and
    inventing a file count over a cache nobody asked about would be a number that
    looks like progress without being any.
    """
    if reporter.is_cancelled():
        return {}
    connection_id = UUID(str(payload["connection_id"]))
    # Never a ``with``: the handle belongs to the worker and outlives this task.
    # See ``jobs/context.py``.
    workspace = workspace_for(workspace_root)
    # No flag for the re-run: ``download_weights`` is legal at ``ready`` too, so
    # an orphan re-enqueued after a crash and a person asking a set-up connection
    # to check itself are the same idempotent call.
    ready = fetch_weights(workspace, connection_id)
    reporter.report(processed=1, total=1)
    return {
        "connection_id": str(ready.id),
        "model_id": ready.model_id,
        "model_revision": ready.model_revision,
        "setup_state": ready.setup_state.value,
    }
