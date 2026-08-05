# usage: from visionset.kernel.domain import Batch, BatchState, BATCH_TRANSITIONS
from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field


class BatchState(StrEnum):
    """Lifecycle: draft -> approved -> in_annotation -> completed.

    Membership is editable in ``draft`` and nowhere else: approval freezes the
    batch, pins its schema version and cuts it into jobs. ``BatchService`` owns
    the moves; ``BATCH_TRANSITIONS`` below is the whole of what is legal.
    """

    DRAFT = "draft"
    APPROVED = "approved"
    IN_ANNOTATION = "in_annotation"
    COMPLETED = "completed"


BATCH_TRANSITIONS: Final[Mapping[BatchState, frozenset[BatchState]]] = {
    BatchState.DRAFT: frozenset({BatchState.APPROVED}),
    BatchState.APPROVED: frozenset({BatchState.IN_ANNOTATION}),
    BatchState.IN_ANNOTATION: frozenset({BatchState.COMPLETED}),
    BatchState.COMPLETED: frozenset(),
}
"""Every move a batch may make. Anything absent raises ``InvalidTransition``.

A table rather than a chain of guards inside the service, so that "which moves
are legal" is one readable fact and the test for it can sweep the whole
``BatchState`` square instead of restating a list somebody has to keep in sync.

The lifecycle is one-way on purpose: there is no route back to ``draft``. A
batch's schema version is pinned at approval and its jobs are already partitioned
against that pin, so reopening membership would silently invalidate work already
done. Making another batch is cheap; un-freezing one is not.
"""


REPINNABLE_STATES: Final[frozenset[BatchState]] = frozenset(
    {BatchState.APPROVED, BatchState.IN_ANNOTATION}
)
"""The states in which ``BatchService.repin`` may move the schema pin.

Named for *annotation work is live or still to come*, which is the only window
where moving the pin changes anything a person can act on. A ``draft`` has no pin
to move — approval is what sets one, and re-pinning before then would be a second
door to the same decision. A ``completed`` batch's pin is **history**: it says
what its finished work was judged against, and rewriting it would rewrite the
record rather than the rules.

Written out rather than derived by subtracting the two ends, on
``PROMOTABLE_PROGRESS``' terms: a new ``BatchState`` should have to be classified
deliberately instead of falling into a set by arithmetic.
"""


EDITABLE_STATES: Final[frozenset[BatchState]] = frozenset({BatchState.DRAFT})
"""The states in which a batch's membership may still be changed.

What ``BatchService.require_draft`` consults, and therefore what gates
``add_assets``, ``remove_assets`` and an ingest that targets an existing batch.
One member today, and named rather than written inline anyway: membership
editability is a fact about a batch that something other than the service asks
about — a client deciding whether to offer the control — and two spellings of it
is exactly how the browser's copy of these rules drifted from the kernel's.

The refusal is ``BatchNotEditable`` rather than ``InvalidTransition``, which is
why this set is consulted beside :func:`require_move` rather than through it:
nothing is transitioning, and that error's docstring owns the reason.
"""


PROMOTABLE_STATES: Final[frozenset[BatchState]] = frozenset({BatchState.COMPLETED})
"""The states from which a batch's assets may enter the project's Dataset.

What ``DatasetService.promote`` consults. Promotion is deliberately **not** a
transition — it moves assets into the trunk and leaves the batch exactly where it
was, so it appears in no row of ``BATCH_TRANSITIONS`` and needs a set of its own
to be answerable at all.

The asset-level counterpart is ``PROMOTABLE_PROGRESS`` in ``domain/task.py``, and
the two are read together: this says which batches may promote, that says which
of their assets go. The refusal here is ``BatchNotComplete``.
"""


CORRECTABLE_STATES: Final[frozenset[BatchState]] = frozenset({BatchState.COMPLETED})
"""The states from which a correction batch may be cut.

**The forward-only model's answer to "this needs fixing".** ``completed`` has no
exit in ``BATCH_TRANSITIONS`` and none is coming, so the way to change settled
work is a new batch over the same assets carrying lineage back to this one.

``completed`` alone, and the same membership as ``PROMOTABLE_STATES`` for a
different reason — which is why it is a second set rather than a shared one.
Promotion asks *is this work finished enough to enter the trunk*; this asks *is
this batch closed to further work*. Both happen to be answered by the same state
today; a fifth state would not necessarily answer them the same way, and merging
them now would hide that.

Correcting an *open* batch is not a correction: it is the work, and it happens in
the batch that is already there. The refusal is ``InvalidTransition``, through
``require_state`` — the same funnel ``repin`` uses, because a caller cannot
usefully tell "wrong state for this move" from "wrong state for this act".
"""


DELETABLE_STATES: Final[frozenset[BatchState]] = frozenset(
    {BatchState.DRAFT, BatchState.APPROVED, BatchState.IN_ANNOTATION}
)
"""The states in which a batch may be deleted.

Everything except ``completed``, and written out rather than as a subtraction for
``PROMOTABLE_PROGRESS``' reason. A completed batch is the record of finished
work — which assets were labeled, against which pinned schema version, and which
were deliberately skipped — and that record is what promotion, releases and any
later correction are read against. ``BATCH_TRANSITIONS`` already says a completed
batch has no exit; a delete that emptied it anyway would be an exit through the
back door, so the guard is here rather than in a caller's discipline.

The refusal is ``BatchImmutable``, and it holds regardless of ``confirm``:
confirmation is for destroying something the caller is allowed to destroy.
"""


class Batch(BaseModel):
    """A curated slice of a Project's assets that moves through annotation together.

    ``schema_version`` is the pin: the version of the project's annotation schema
    that every annotation in this batch is validated against. It is ``None``
    while the batch is a draft and set at approval; from there it moves **only**
    through ``BatchService.repin``, which somebody has to ask for. It never
    follows the active version on its own — a schema that evolved mid-batch would
    change the rules under work in flight, which is what versioning exists to
    prevent. See :data:`REPINNABLE_STATES` for when asking is legal.
    """

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    name: str
    state: BatchState = BatchState.DRAFT
    schema_version: int | None = Field(default=None, ge=1)
    asset_ids: list[UUID] = Field(default_factory=list)
    #: The batch this one was cut from, when it is a correction of another.
    #:
    #: A **lineage fact**, set once at creation and never afterwards: it records
    #: where this batch came from, which is not a thing that changes. Nothing in
    #: the domain reads it yet — correction batches have no creation surface —
    #: and it is here first because the alternative is discovering at that point
    #: that recording it needs a migration.
    #:
    #: ``None`` means **not a correction of anything**, which is true of every
    #: batch that exists today. It is not "unknown": a batch either was cut from
    #: another or was not, and both answers are complete.
    parent_batch_id: UUID | None = None


class MembershipChange(BaseModel):
    """A membership edit's outcome: the batch afterwards, and what actually moved.

    Two facts rather than one, because the batch alone cannot answer the question
    a caller asks after a bulk edit. ``changed`` is what **this call** wrote —
    every id it was given minus the ones the batch already agreed about — so
    "removed 3" can be told from "3 were already gone", which is exactly the
    distinction an idempotent operation loses when it reports only the final
    state. It is the ``ExportResult`` bargain: the operation reports what it did,
    not merely what is now true.

    Ordered as the caller gave them, with duplicates already collapsed. Empty
    means the batch already held (or already lacked) every id — a no-op, and
    deliberately not an error: a caller who lost a race to another writer aiming
    at the same asset finds its target true, which is nothing left to do.
    """

    model_config = ConfigDict(frozen=True)

    batch: Batch
    #: Named ``changed`` and not ``asset_ids`` on purpose: this model carries a
    #: ``Batch``, which has an ``asset_ids`` of its own meaning the membership
    #: afterwards. Two fields one dot apart meaning "what moved" and "what is
    #: there now" is a mistake nothing would catch at the call site.
    changed: tuple[UUID, ...] = ()
