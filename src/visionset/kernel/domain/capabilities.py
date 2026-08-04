# usage: from visionset.kernel.domain import batch_actions, job_actions, asset_actions
"""What a resource can be asked to do, right now, said out loud.

Every legality rule in this domain already exists as a table or a named set, and
every service consults one. What did not exist was a way to *ask* — so a client
deciding whether to offer a control had no answer but to re-derive the rules, and
the browser did exactly that: a helper in ``batchState.ts`` described itself as "a
mirror of two rows of the kernel's ``ASSET_PROGRESS_TRANSITIONS``", and the mirror
drifted by omitting the batch-state dimension. Two shipped blockers came out of
that one omission.

So the three functions here answer the question the mirror was answering, and they
answer it **by reading the same tables and sets the services consult**. There is no
second encoding of any rule: ``BATCH_TRANSITIONS`` decides ``approve``,
``REPINNABLE_STATES`` decides ``repin``, ``WRITABLE_PROGRESS`` decides
``annotate``. What is genuinely new here is only the *vocabulary* — that the edge
``skipped -> unannotated`` is called ``restore`` — and even that is checked against
the tables rather than asserted beside them (see ``MOVES`` below and
``tests/kernel/test_capabilities.py``).

**These are declarations, not permissions.** A declared action is one the resource's
state does not refuse; it can still fail on something no pure function can see —
``approve`` on a project with no schema, ``complete`` while a job is outstanding.
Each is noted where it applies. The converse is the strong half and the one worth
relying on: an action that is *not* declared will be refused.

Pure, and in the domain rather than in a service, on ``progress_after_annotating``'s
terms: a question about domain values, answered from domain tables, with no I/O —
which is what lets every surface project the same answer and one test sweep the
whole matrix.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Final

from visionset.kernel.domain.batch import (
    BATCH_TRANSITIONS,
    DELETABLE_STATES,
    EDITABLE_STATES,
    PROMOTABLE_STATES,
    REPINNABLE_STATES,
    BatchState,
)
from visionset.kernel.domain.task import (
    ASSET_PROGRESS_TRANSITIONS,
    JOB_TRANSITIONS,
    SETTLED_PROGRESS,
    WRITABLE_PROGRESS,
    AnnotationJobState,
    AssetProgress,
    progress_after_annotating,
)


class BatchAction(StrEnum):
    """What can be asked of a batch. Declaration order is display order."""

    APPROVE = "approve"
    START = "start"
    COMPLETE = "complete"
    REPIN = "repin"
    PROMOTE = "promote"
    EDIT_MEMBERSHIP = "edit_membership"
    DELETE = "delete"


class JobAction(StrEnum):
    """What can be asked of an annotation job."""

    START = "start"
    COMPLETE = "complete"


class AssetAction(StrEnum):
    """What can be asked of one asset inside a batch.

    ``ANNOTATE`` is the odd one and the important one: it is not a progress move
    but the right to write labels at all, which is ``WRITABLE_PROGRESS`` and the
    batch gate together. The other five each name one edge of
    ``ASSET_PROGRESS_TRANSITIONS`` — see :data:`ASSET_MOVES`.
    """

    ANNOTATE = "annotate"
    SKIP = "skip"
    RESTORE = "restore"
    SUBMIT_FOR_REVIEW = "submit_for_review"
    ACCEPT = "accept"
    RETURN_TO_ANNOTATOR = "return_to_annotator"


@dataclass(frozen=True, slots=True)
class Move[S: StrEnum]:
    """One named edge of a transition table: where it goes, and from where.

    ``origins`` is why this is a dataclass and not a plain target state. Most
    actions are the only name for their target and could be derived from the table
    alone — but ``unannotated`` is reachable from two states and means two
    different things arriving from each, so a bare target would let ``restore``
    claim an edge it is not the name of.

    ``origins`` is the naming, never the rule. A move is legal only when the table
    says so; this narrows *which of the legal ones this action is called*, and
    ``test_every_named_move_is_an_edge_the_table_actually_has`` refuses an origin
    the table does not back.
    """

    to: S
    origins: frozenset[S]

    def offered_from(self, current: S, transitions: Mapping[S, frozenset[S]]) -> bool:
        """Is this action's move both legal from ``current`` and named for it?"""
        return current in self.origins and self.to in transitions[current]


BATCH_MOVES: Final[Mapping[BatchAction, Move[BatchState]]] = {
    BatchAction.APPROVE: Move(BatchState.APPROVED, frozenset({BatchState.DRAFT})),
    BatchAction.START: Move(BatchState.IN_ANNOTATION, frozenset({BatchState.APPROVED})),
    BatchAction.COMPLETE: Move(BatchState.COMPLETED, frozenset({BatchState.IN_ANNOTATION})),
}
"""The three batch actions that are moves in ``BATCH_TRANSITIONS``."""


BATCH_GATES: Final[Mapping[BatchAction, frozenset[BatchState]]] = {
    BatchAction.REPIN: REPINNABLE_STATES,
    BatchAction.PROMOTE: PROMOTABLE_STATES,
    BatchAction.EDIT_MEMBERSHIP: EDITABLE_STATES,
    BatchAction.DELETE: DELETABLE_STATES,
}
"""The four batch actions that change no state, and so appear in no table row.

Each is the named set its own service gate consults, referenced rather than
restated — which is the whole point of those sets being named. Promotion is the
clearest case: it moves assets into the trunk and leaves the batch exactly where
it was, so ``BATCH_TRANSITIONS`` has nothing to say about it.
"""


JOB_MOVES: Final[Mapping[JobAction, Move[AnnotationJobState]]] = {
    JobAction.START: Move(AnnotationJobState.IN_PROGRESS, frozenset({AnnotationJobState.PENDING})),
    JobAction.COMPLETE: Move(
        AnnotationJobState.COMPLETED, frozenset({AnnotationJobState.IN_PROGRESS})
    ),
}
"""Both job actions are moves in ``JOB_TRANSITIONS``."""


ASSET_MOVES: Final[Mapping[AssetAction, Move[AssetProgress]]] = {
    AssetAction.SKIP: Move(
        AssetProgress.SKIPPED,
        frozenset({AssetProgress.UNANNOTATED, AssetProgress.ANNOTATED}),
    ),
    AssetAction.RESTORE: Move(AssetProgress.UNANNOTATED, frozenset({AssetProgress.SKIPPED})),
    AssetAction.SUBMIT_FOR_REVIEW: Move(
        AssetProgress.REVIEW_PENDING, frozenset({AssetProgress.ANNOTATED})
    ),
    AssetAction.ACCEPT: Move(AssetProgress.ACCEPTED, frozenset({AssetProgress.REVIEW_PENDING})),
    AssetAction.RETURN_TO_ANNOTATOR: Move(
        AssetProgress.ANNOTATED, frozenset({AssetProgress.REVIEW_PENDING})
    ),
}
"""The five progress edges that have a name somebody can click.

``accept`` and ``return_to_annotator`` are the two halves of ``review_pending``,
and the second is named for what it does rather than for the edge it rides: "back
to annotated" describes the table, "return to annotator" describes the act.
"""


UNNAMED_EDGES: Final[frozenset[tuple[AssetProgress, AssetProgress]]] = frozenset(
    (current, landed)
    for current in AssetProgress
    for has_annotations in (True, False)
    if (landed := progress_after_annotating(current, has_annotations=has_annotations)) is not None
)
"""Legal progress edges that deliberately have no action name.

Exactly the two moves an annotation appearing or disappearing makes on its own —
``unannotated -> annotated`` when the first label lands, and back again when the
last one goes — so this is *computed from* ``progress_after_annotating`` rather
than listed beside it. Nobody performs these: ``AnnotationService`` makes them in
the same transaction as the write, and they are the consequence of ``annotate``,
which is an action and is declared.

Offering either as its own control would be offering to change a marker while its
labels stay put, which is the one thing the progress machine exists to prevent.

Named at all so that a *new* edge cannot quietly arrive with no capability:
``test_every_edge_is_named_by_an_action_or_deliberately_not`` requires every edge
of ``ASSET_PROGRESS_TRANSITIONS`` to be claimed by an action or to fall in here,
and this set can only grow if the domain's own derivation rule does.
"""


def batch_actions(state: BatchState) -> list[BatchAction]:
    """Everything this batch's state does not refuse, in declaration order.

    ``complete`` is declared from ``BATCH_TRANSITIONS`` alone and is the one
    declaration that can still be refused: completion is *derived*, so
    ``BatchService.complete`` reads the jobs and answers ``BatchNotComplete``
    while any is outstanding. Refining it here would need those jobs, which is a
    read this function cannot do and which two of its callers do not have in hand.
    Declaring it from the table keeps every surface's answer identical; a client
    treats it as "the batch is at the point where completing is the next move",
    and renders the refusal if the jobs are not done.

    ``approve`` carries the smaller version of the same caveat: an empty batch or
    a project with no schema refuses it, and neither is a state of the batch.
    """
    return [
        action
        for action in BatchAction
        if (
            BATCH_MOVES[action].offered_from(state, BATCH_TRANSITIONS)
            if action in BATCH_MOVES
            else state in BATCH_GATES[action]
        )
    ]


def job_actions(
    state: AnnotationJobState, *, batch_state: BatchState, progress: Iterable[AssetProgress]
) -> list[JobAction]:
    """Everything this job can be asked to do, given its batch and its assets.

    Both actions need the batch open — ``JobService`` runs ``require_open_batch``
    before it consults ``JOB_TRANSITIONS``, so a job that is otherwise startable
    inside an ``approved`` batch declares nothing, which is precisely the
    dimension the browser's mirror dropped.

    ``complete`` is refined here rather than caveated, unlike a batch's: the
    kernel's extra condition is that every asset is in ``SETTLED_PROGRESS``, and
    a job carries its own per-asset map, so the refinement costs no read at all.
    """
    if batch_state is not BatchState.IN_ANNOTATION:
        return []
    settled = all(p in SETTLED_PROGRESS for p in progress)
    return [
        action
        for action in JobAction
        if JOB_MOVES[action].offered_from(state, JOB_TRANSITIONS)
        and (settled or action is not JobAction.COMPLETE)
    ]


def asset_actions(progress: AssetProgress | None, *, batch_state: BatchState) -> list[AssetAction]:
    """Everything one asset of a batch can be asked to do, in declaration order.

    ``progress`` is ``None`` exactly while the batch is a draft — a draft has no
    jobs, so no asset in it has progress — and the answer is empty either way,
    because nothing may be written into a batch nobody opened.

    ``annotate`` is not a progress move and is the one action here that is not in
    ``ASSET_MOVES``: it is the right to add, change or remove labels, which is
    ``WRITABLE_PROGRESS`` and the batch gate together. It is also the declaration
    the annotator wants, because "can I open this in edit mode" is exactly that
    question — and answering it wrong is what left work stranded in a browser
    against a batch that had closed.
    """
    if batch_state is not BatchState.IN_ANNOTATION or progress is None:
        return []
    return [
        action
        for action in AssetAction
        if (
            progress in WRITABLE_PROGRESS
            if action is AssetAction.ANNOTATE
            else ASSET_MOVES[action].offered_from(progress, ASSET_PROGRESS_TRANSITIONS)
        )
    ]
