# usage: registered as job type "inference.download_weights"
"""The weight-download handler: fetch what a connection names, then say so.

**It is a background job because of how long it is, not how complex.** Weights
for a detector of this class are gigabytes; a request that waited for them would
sit behind every proxy timeout between the browser and the server with no way to
report progress. So the route answers 202 and points at a row, which is the
launch-and-poll contract the export and ingest routes already use.

**The work itself is one call, and that is deliberate.**
``visionset.inference.fetch_weights`` is the whole sequence — gate, size,
download, record — and it is the sequence the CLI runs too. Two implementations
of "what downloading means" is how a terminal and an API come to disagree about
what "set up" means, and the disagreement would only show up on the day somebody
used both.

**The row is the only thing that observes it, which is what makes it
observable.** Nothing about this run is coupled to the request that queued it or
to any browser: a client's whole view of a transfer is the job row plus the
connection that names it, so a reload, a second tab or a colleague's machine all
see the same download at the same point. That property is not incidental and
``tests/inference`` holds it: the job completes with nobody polling at all.

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
from visionset.kernel.domain import (
    WEIGHT_DOWNLOAD_CONNECTION_KEY,
    WEIGHT_DOWNLOAD_JOB_TYPE,
    weight_download_payload,
)
from visionset.kernel.ports import ProgressReporter

JOB_TYPE = WEIGHT_DOWNLOAD_JOB_TYPE
"""This handler's type, taken from the domain rather than spelled here.

The type has a second reader: a connection finds its own transfer by it, so that
a screen can show a download it did not start. The kernel may not import this
package, so the constant lives there and this names it — one spelling, and a
handler registered under a type nothing can look up becomes impossible rather
than merely unlikely.
"""

HANDLER = register(HandlerRef(type=JOB_TYPE, func=f"{__name__}:run", idempotent=True))


def payload_for(connection_id: UUID) -> dict[str, JsonValue]:
    """The payload this handler expects, built where the type is known.

    A function rather than a dict literal at the call site, so the one place
    naming the key is the one place that reads it — the rule ``ingest`` and
    ``export`` both follow, for the reason they give: a route spelling it by hand
    would be free to spell it differently, and the mismatch would surface as a
    ``KeyError`` inside a worker.

    The shape itself comes from the domain for :data:`JOB_TYPE`'s reason: the
    connection lookup matches on this key, and a payload written under one
    spelling and read under another produces a download that runs perfectly and
    is invisible to everything watching for it.
    """
    return weight_download_payload(connection_id)


def run(
    workspace_root: Path,
    payload: dict[str, JsonValue],
    reporter: ProgressReporter,
) -> dict[str, JsonValue]:
    """Fetch the named connection's weights and mark it ready.

    ``is_cancelled`` is consulted **once, before starting**, on ``export``'s
    terms and for its reason: what follows is one library call that writes a
    cache, so the honest cancellation point is the one before any bytes are
    fetched. Stopping partway would leave a partial cache the next run has to
    verify anyway — which it does, which is why abandoning it costs nothing but is
    also not a *cancellation* worth claiming.

    **What it reports is bytes**, and the unit is the handler's to choose: a job
    row's ``processed`` and ``total`` are an absolute count of whatever this run
    works in, which is files for the integrity check and bytes for a transfer.
    They were ``1 of 1`` here, reported once at the end, which is a placeholder
    rather than progress — a person watching several gigabytes arrive gets nothing
    from it. ``visionset.kernel.domain.WeightDownload`` is the one place that
    names them as bytes for this type, so no client has to know the mapping.

    The count is measured off the disk by ``fetch_weights`` rather than reported
    by the download library, which reports nothing a caller can use — see
    ``visionset.inference.weights._watching_bytes``. It arrives on a thread, which
    is safe for the same reason the reporter's throttle exists: the writes are
    bounded by the run's duration rather than by anything it fetches.
    """
    if reporter.is_cancelled():
        return {}
    connection_id = UUID(str(payload[WEIGHT_DOWNLOAD_CONNECTION_KEY]))
    # Never a ``with``: the handle belongs to the worker and outlives this task.
    # See ``jobs/context.py``.
    workspace = workspace_for(workspace_root)
    # No flag for the re-run: ``download_weights`` is legal at ``ready`` too, so
    # an orphan re-enqueued after a crash and a person asking a set-up connection
    # to check itself are the same idempotent call.
    ready = fetch_weights(
        workspace,
        connection_id,
        on_bytes=lambda done, total: reporter.report(processed=done, total=total),
    )
    return {
        "connection_id": str(ready.id),
        "model_id": ready.model_id,
        "model_revision": ready.model_revision,
        "setup_state": ready.setup_state.value,
    }
