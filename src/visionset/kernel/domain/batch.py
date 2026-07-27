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


class Batch(BaseModel):
    """A curated slice of a Project's assets that moves through annotation together.

    ``schema_version`` is the pin: the version of the project's annotation schema
    that every annotation in this batch is validated against. It is ``None``
    while the batch is a draft, set once at approval, and never moved after —
    a schema that evolved mid-batch would change the rules under work in flight.
    """

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    name: str
    state: BatchState = BatchState.DRAFT
    schema_version: int | None = Field(default=None, ge=1)
    asset_ids: list[UUID] = Field(default_factory=list)
