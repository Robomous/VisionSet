# usage: from visionset.kernel.domain import Batch, BatchState, BATCH_TRANSITIONS
from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


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
