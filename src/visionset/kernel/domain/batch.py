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
