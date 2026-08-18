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


OPEN_JOB_STATES: Final[frozenset[AnnotationJobState]] = frozenset(
    {AnnotationJobState.PENDING, AnnotationJobState.IN_PROGRESS}
)
"""The job states work may still happen in.

``JobService`` and ``AnnotationService`` both consult this before touching
anything a job carries — labels through the four annotation writes, progress
through ``mark`` — and :func:`~visionset.kernel.domain.capabilities.asset_actions`
reads the same set, so what an asset declares and what it accepts cannot drift.

A ``completed`` job is a statement that every asset in it was dealt with, and
``JOB_TRANSITIONS`` gives it no way back. Without this gate that statement was
decoration: the batch stays ``in_annotation`` until somebody completes it
separately, so a finished job's assets kept accepting labels — the word
"finished" describing nothing, and work landing where nobody would look for it.

Stated outright rather than derived as "the states with a move left", on
``PROMOTABLE_PROGRESS``'s argument: the two sets agree today by coincidence, and
whether a new job state admits writes is a decision that should have to be made
rather than inherited from a table row.

Not to be read beside ``SETTLED_JOB_STATES``, which is about a *background* job —
an ingest — and shares nothing with this but the word. Bare "job" in this module
is the annotation job, the way ``JOB_TRANSITIONS`` is and
``BACKGROUND_JOB_TRANSITIONS`` is not.
"""


ASSET_PROGRESS_TRANSITIONS: Final[Mapping[AssetProgress, frozenset[AssetProgress]]] = {
    AssetProgress.UNANNOTATED: frozenset(
        {AssetProgress.ANNOTATED, AssetProgress.SKIPPED, AssetProgress.REVIEW_PENDING}
    ),
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
- ``unannotated -> review_pending`` — labels arrived that nobody has judged, so
  they enter awaiting review rather than claiming to be somebody's work.
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


WRITABLE_PROGRESS: Final[frozenset[AssetProgress]] = frozenset(
    {AssetProgress.UNANNOTATED, AssetProgress.ANNOTATED}
)
"""The states in which an asset's labels may still be added to, edited or removed.

``AnnotationService.add``, ``update`` and ``delete`` consult this on every
write, beside the batch gate. The two answer different questions — is this
batch open at all, and is *this asset* still being labeled — and both have to
hold. ``enter_unreviewed`` is narrower still and does not consult this set at
all: it writes only onto ``unannotated``, because a model's unattended labels
must never land over work a person has already touched.

Exactly the two states those three writes may touch. The other three are
settled: ``skipped`` says a person chose not to label this, ``accepted`` says a
reviewer took it, and ``review_pending`` says either a person submitted it or a
model wrote it unattended. A write through ``add``, ``update`` or ``delete``
onto any of the three settled states lands labels the progress machine will not
account for — and for ``skipped`` it is worse than untidy, because
``PROMOTABLE_PROGRESS`` leaves the asset out of the trunk, so the work is
accepted, stored, and then silently dropped at promotion with nothing anywhere
saying so.

Refusing is what makes that unreachable. The remedy is to move the progress first
where the transition table allows it — ``skipped -> unannotated`` is the
take-it-back edge — and where it does not, to correct the work in a new batch
rather than behind the record's back.
"""


def progress_after_annotating(
    current: AssetProgress, *, has_annotations: bool, judged: bool = True
) -> AssetProgress | None:
    """Where this asset's progress should land now, or ``None`` to leave it.

    The only moves a row appearing or disappearing can justify: an annotation's
    last row going moves it ``annotated -> unannotated``, and its first row
    landing moves it to ``annotated`` or, unjudged, straight to
    ``review_pending`` — see ``judged`` below.

    Everything else is somebody's decision rather than a consequence.
    ``skipped`` says a person chose not to label this; ``accepted`` says a
    reviewer took it. Neither is contradicted by an annotation being drawn or
    erased, so annotations never move them — ``JobService.mark`` is the door for
    a decision, and it consults ``ASSET_PROGRESS_TRANSITIONS`` the same way.

    Pure, and separate from ``AnnotationService`` on purpose: "what does this
    mean for progress" is a domain question, and keeping it here is what lets
    a test sweep it against the transition table rather than against prose.

    ``judged`` says whether a person exercised judgement on the labels that just
    arrived. Unattended prediction is a silent write, so its labels enter at
    ``review_pending`` rather than claiming to be work somebody did — and they get
    there in one move, because a path through ``annotated`` has a window in which a
    crash would leave unreviewed labels looking reviewed.
    """
    if current is AssetProgress.UNANNOTATED and has_annotations:
        return AssetProgress.ANNOTATED if judged else AssetProgress.REVIEW_PENDING
    if current is AssetProgress.ANNOTATED and not has_annotations:
        return AssetProgress.UNANNOTATED
    return None


def initial_progress(*, has_annotations: bool) -> AssetProgress:
    """Where an asset's progress starts when a job is cut over it.

    ``unannotated`` for the ordinary case, and ``annotated`` for an asset that
    already carries labels — which is a real case rather than an exotic one, and
    the whole reason this is a function instead of a literal. Annotations hang
    off an ``asset_id`` and nothing else, so a **correction batch** over an
    already-labeled asset opens with the earlier round's boxes drawn on it (see
    ``docs/batches.md``). Starting such an asset at ``unannotated`` would file it
    under "nothing labeled here" while the annotator is displaying three boxes,
    which is a lie a gallery filter repeats.

    It is also what keeps those labels editable. ``WRITABLE_PROGRESS`` is
    ``{unannotated, annotated}``, so both answers leave the asset writable today
    — but only one of them stays true after somebody deletes the last box:
    ``progress_after_annotating`` moves ``annotated -> unannotated`` and would
    otherwise be asked to move a state the asset was never honestly in.

    Uniform, and deliberately blind to *why* the asset has labels: nothing here
    asks whether the batch is a correction. A correction batch is an ordinary
    batch that happens to be cut over labeled assets, and the rule that reads
    the asset rather than the batch is the one that cannot be wrong about a case
    nobody thought of.

    Pure, and here rather than in ``BatchService``, for :func:`progress_after_annotating`'s
    reason: "what does this mean for progress" is a domain question, and the two
    have to agree — a fresh asset that has labels must start where an
    ``unannotated`` one carrying its first annotation would land.
    """
    return AssetProgress.ANNOTATED if has_annotations else AssetProgress.UNANNOTATED


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
    assignee: str | None = None
    """Who is working (or worked) this job — a name, not an account.

    Purely informational: VisionSet has no identity model, so nothing checks
    that the person writing annotations is the person named here. Stored
    normalized (``normalize_name``); ``None`` means unassigned.
    """
