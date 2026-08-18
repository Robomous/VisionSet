# usage: registered as job type "annotation.pre_label"
"""The pre-labeling handler: ask a model about a batch, and enter what it finds.

**A background job because of how long it is, not how complex.** A batch is
hundreds of images and each is a forward pass; a request that waited for them
would sit behind every proxy timeout between the browser and the server with no
way to report progress. So the route answers 202 and points at a row, which is
the launch-and-poll contract the download, integrity and export routes use.

**The work itself is one call**, and that is deliberate:
``visionset.inference.pre_label`` is the whole sequence, and it is the sequence a
command or a tool would run too. Two implementations of "what pre-labeling means"
is how a terminal and an API come to disagree about what a batch now contains.

**Idempotent, and the word is earned by the entry rule rather than by luck.** A
run writes only where nothing has been written, so an orphan re-enqueued after a
crash collects the assets the dead attempt never reached and leaves the rest
exactly as it found them.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from pydantic import JsonValue

from visionset.inference import pre_label
from visionset.jobs.context import workspace_for
from visionset.jobs.registry import HandlerRef, register
from visionset.kernel.domain import (
    BATCH_JOB_KEY,
    CONNECTION_JOB_KEY,
    PRE_LABEL_CONFIDENCE_KEY,
    PRE_LABEL_JOB_TYPE,
    pre_label_job_payload,
)
from visionset.kernel.ports import ProgressReporter

JOB_TYPE = PRE_LABEL_JOB_TYPE
"""This handler's type, taken from the domain rather than spelled here.

The type has a second reader: a batch finds its own run by it, so that a screen
can show a run it did not start. The kernel may not import this package, so the
constant lives there and this names it.
"""

HANDLER = register(HandlerRef(type=JOB_TYPE, func=f"{__name__}:run", idempotent=True))


def payload_for(
    batch_id: UUID, connection_id: UUID, minimum_confidence: float
) -> dict[str, JsonValue]:
    """The payload this handler expects, built where the type is known."""
    return pre_label_job_payload(batch_id, connection_id, minimum_confidence)


def run(
    workspace_root: Path,
    payload: dict[str, JsonValue],
    reporter: ProgressReporter,
) -> dict[str, JsonValue]:
    """Pre-label the named batch's untouched assets and say what that came to.

    ``is_cancelled`` is consulted **both up front and passed through as
    should_stop**, which is where this differs from the transfer handlers: what
    follows is a loop over assets rather than one library call, and every
    iteration boundary is a point at which the last asset is committed and the
    next is untouched. Stopping there leaves a batch partly pre-labeled, which is
    a coherent state precisely because a run only ever writes where nothing was
    written.

    **What it reports is assets.** A job row's ``processed`` and ``total`` are an
    absolute count of whatever this run works in, and the total is known before
    the first forward pass because the asset set is derived up front.

    **An asset somebody starts working while this runs is skipped, not fatal.**
    The batch is open for annotation, so a person touching an asset mid-run is
    the ordinary case; the run passes it over and keeps going, and
    ``assets_skipped`` in the result says how many.

    **A region the model answered with a label nobody asked for is discarded,
    not fatal either.** A text-prompted detector answers with decoded text
    rather than a choice from the prompt's phrases, so a merged answer is
    dropped before it is ever written; ``regions_discarded`` in the result says
    how many.
    """
    if reporter.is_cancelled():
        return {}
    batch_id = UUID(str(payload[BATCH_JOB_KEY]))
    connection_id = UUID(str(payload[CONNECTION_JOB_KEY]))
    minimum_confidence = float(str(payload[PRE_LABEL_CONFIDENCE_KEY]))
    # Never a ``with``: the handle belongs to the worker and outlives this task.
    # See ``jobs/context.py``.
    workspace = workspace_for(workspace_root)
    outcome = pre_label(
        workspace,
        batch_id=batch_id,
        connection_id=connection_id,
        minimum_confidence=minimum_confidence,
        on_progress=lambda done, total: reporter.report(processed=done, total=total),
        should_stop=reporter.is_cancelled,
    )
    return {
        "batch_id": str(batch_id),
        "assets_considered": outcome.assets_considered,
        "assets_labeled": outcome.assets_labeled,
        "annotations_written": outcome.annotations_written,
        "model_ref": outcome.model_ref,
        "stopped_early": outcome.stopped_early,
        "assets_skipped": outcome.assets_skipped,
        "regions_discarded": outcome.regions_discarded,
    }
