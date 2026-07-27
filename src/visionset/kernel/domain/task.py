# usage: from visionset.kernel.domain import TaskGroup, AnnotationJob, AssetProgress
"""The work of annotating, kept separate from its result.

An ``AnnotationJob`` tracks *whether* an asset has been dealt with; the
``Annotation`` records *what* was drawn on it. Keeping the two apart is what lets
an asset be deliberately skipped, or annotated and then sent back for rework,
without any of that showing up as labels.

Two state machines live here, both as tables rather than as guards scattered
through a service — the shape ``BATCH_TRANSITIONS`` established in
``domain/batch.py``. ``JobService`` consults them; nothing restates them.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class AnnotationJobState(StrEnum):
    """Lifecycle: pending -> in_progress -> completed.

    ``JOB_TRANSITIONS`` below is the whole of what is legal; ``JobService`` owns
    the moves.
    """

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class AssetProgress(StrEnum):
    """Per-asset annotation progress inside a job."""

    UNANNOTATED = "unannotated"
    ANNOTATED = "annotated"
    SKIPPED = "skipped"
    REVIEW_PENDING = "review_pending"
    ACCEPTED = "accepted"


JOB_TRANSITIONS: Final[Mapping[AnnotationJobState, frozenset[AnnotationJobState]]] = {
    AnnotationJobState.PENDING: frozenset({AnnotationJobState.IN_PROGRESS}),
    AnnotationJobState.IN_PROGRESS: frozenset({AnnotationJobState.COMPLETED}),
    AnnotationJobState.COMPLETED: frozenset(),
}
"""Every move a job may make. Anything absent raises ``InvalidTransition``.

One-way, like the batch it belongs to: a completed job is a statement that every
asset in it was dealt with, and re-opening one would put the batch's own
completion — which is derived from these — quietly out of date.
"""


ASSET_PROGRESS_TRANSITIONS: Final[Mapping[AssetProgress, frozenset[AssetProgress]]] = {
    AssetProgress.UNANNOTATED: frozenset({AssetProgress.ANNOTATED, AssetProgress.SKIPPED}),
    AssetProgress.ANNOTATED: frozenset(
        {AssetProgress.UNANNOTATED, AssetProgress.SKIPPED, AssetProgress.REVIEW_PENDING}
    ),
    AssetProgress.SKIPPED: frozenset({AssetProgress.UNANNOTATED}),
    AssetProgress.REVIEW_PENDING: frozenset({AssetProgress.ANNOTATED, AssetProgress.ACCEPTED}),
    AssetProgress.ACCEPTED: frozenset(),
}
"""How one asset's progress may move. Each edge is somebody's real action:

- ``unannotated -> annotated`` — it was labeled; ``-> skipped`` — it was decided
  against, which is recorded rather than erased from the batch.
- ``annotated -> unannotated`` — the last annotation on it was deleted;
  ``-> review_pending`` — it was submitted; ``-> skipped`` — it was decided
  against after all.
- ``skipped -> unannotated`` — the decision was reversed while the job is open.
- ``review_pending -> accepted`` — a reviewer took it; ``-> annotated`` — a
  reviewer sent it back for rework.
- ``accepted`` has no exit, for the same reason a completed batch has none:
  reversing it needs a reviewer, and M1 has no review surface.
"""


SETTLED_PROGRESS: Final[frozenset[AssetProgress]] = frozenset(
    {AssetProgress.ANNOTATED, AssetProgress.SKIPPED, AssetProgress.ACCEPTED}
)
"""The states that do not block a job from completing.

Named for what it means rather than "terminal", which would be a lie: an
``annotated`` asset still has three moves left. What it *does not* have is
outstanding work. ``unannotated`` blocks because the labeling has not happened;
``review_pending`` blocks because the review has not.

Review is optional in M1 — an asset may be done at ``annotated`` — so this set is
generous on purpose. Making it ``{accepted, skipped}`` would mean no job could
ever finish without a reviewer, and there is no review surface yet.
"""


PROMOTABLE_PROGRESS: Final[frozenset[AssetProgress]] = frozenset(
    {AssetProgress.ANNOTATED, AssetProgress.ACCEPTED}
)
"""The states that earn an asset a place in the Dataset.

``DatasetService.promote`` reads this. It is stated outright rather than written
as ``SETTLED_PROGRESS - {SKIPPED}``, even though today the two are equal: a
subtraction would quietly promote the next settled state somebody adds, and
whether a state belongs in the curated trunk is a decision that should have to be
made rather than inherited.

``skipped`` is the one settled state left out, and it is the whole point of the
distinction. Settled means *does not block the job from completing*; promotable
means *belongs in the trunk*. A skipped asset is a person's decision against
labeling it — recorded rather than erased from the batch, which is why
``BatchService.remove_assets`` refuses after approval — and promoting it would
put back exactly what that person kept out.

Every state here is in ``SETTLED_PROGRESS``, and it has to be: promotion only
happens from a ``completed`` batch, and a batch cannot complete while any asset
is unsettled, so a promotable-but-unsettled state would be unreachable.
"""


def progress_after_annotating(
    current: AssetProgress, *, has_annotations: bool
) -> AssetProgress | None:
    """Where this asset's progress should land now, or ``None`` to leave it.

    The only two moves a row appearing or disappearing can justify:
    ``unannotated -> annotated`` when the first annotation lands, and
    ``annotated -> unannotated`` when the last one goes.

    Everything else is somebody's decision rather than a consequence.
    ``skipped`` says a person chose not to label this; ``review_pending`` says
    a person submitted it; ``accepted`` says a reviewer took it. None of those
    is contradicted by an annotation being drawn or erased, so annotations
    never move them — ``JobService.mark`` is the door for a decision, and it
    consults ``ASSET_PROGRESS_TRANSITIONS`` the same way.

    Pure, and separate from ``AnnotationService`` on purpose: "what does this
    mean for progress" is a domain question, and keeping it here is what lets
    a test sweep it against the transition table rather than against prose.
    """
    if current is AssetProgress.UNANNOTATED and has_annotations:
        return AssetProgress.ANNOTATED
    if current is AssetProgress.ANNOTATED and not has_annotations:
        return AssetProgress.UNANNOTATED
    return None


class TaskGroup(BaseModel):
    """One round of annotation work over a Batch, partitioned into jobs.

    Created by ``BatchService.approve``; a later review round would be a second
    group beside the first, over the same batch.
    """

    id: UUID = Field(default_factory=uuid4)
    batch_id: UUID
    name: str


class AnnotationJob(BaseModel):
    """One annotator's unit of work over a set of assets.

    ``progress`` is ordered: it is read back in the batch's own asset order,
    which is ingest order, because ``annotation_job_asset`` stores a
    ``position``. That is what makes ``JobService.next_pending`` deterministic
    and stable across calls rather than dependent on how rows happen to sit.
    """

    id: UUID = Field(default_factory=uuid4)
    task_group_id: UUID
    state: AnnotationJobState = AnnotationJobState.PENDING
    progress: dict[UUID, AssetProgress] = Field(default_factory=dict)
