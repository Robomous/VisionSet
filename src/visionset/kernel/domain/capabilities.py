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
    CORRECTABLE_STATES,
    DELETABLE_STATES,
    EDITABLE_STATES,
    PRE_LABELABLE_STATES,
    PROMOTABLE_STATES,
    REPINNABLE_STATES,
    BatchState,
)
from visionset.kernel.domain.inference import (
    CHECKABLE_STATES,
    EVERY_CONNECTION_TYPE,
    EVERY_SETUP_STATE,
    RETARGETABLE_STATES,
    WEIGHT_HOLDING_TYPES,
    ConnectionSetupState,
    ConnectionType,
)
from visionset.kernel.domain.task import (
    ASSET_PROGRESS_TRANSITIONS,
    JOB_TRANSITIONS,
    OPEN_JOB_STATES,
    SETTLED_PROGRESS,
    WRITABLE_PROGRESS,
    AnnotationJobState,
    AssetProgress,
    progress_after_annotating,
)
from visionset.kernel.domain.vocabulary import OpenVocabulary


# A declaration is a promise: under the `ui-capabilities` contract a conforming
# client renders what the wire declares, so an action named here obliges every
# client to offer it. A name may therefore only land in the same change as the
# route, the MCP tool and the control that honour it — an orphan makes the wire
# the source of a control that cannot work.
#
# `delete` is declared **last**, which is a display decision `registered_tools`
# makes the same way: it is the only batch action that ends the resource rather
# than moving it along, and a listing whose order doubles as the workflow should
# not put a dead end in the middle of it.
#
# The reasoning lives here rather than in the docstring because FastAPI copies a
# docstring verbatim into `openapi.json` as the schema's `description`, where an
# internal rationale is noise and RST markup renders as literal backticks. The
# docstring stays the one short sentence a client should read.
class BatchAction(OpenVocabulary):
    """What can be asked of a batch. Declaration order is display order."""

    APPROVE = "approve"
    START = "start"
    COMPLETE = "complete"
    REPIN = "repin"
    PROMOTE = "promote"
    CREATE_CORRECTION = "create_correction"
    PRE_LABEL = "pre_label"
    EDIT_MEMBERSHIP = "edit_membership"
    DELETE = "delete"


class JobAction(OpenVocabulary):
    """What can be asked of an annotation job."""

    START = "start"
    COMPLETE = "complete"


class AssetAction(OpenVocabulary):
    """What can be asked of one asset inside a batch.

    ``ANNOTATE`` is the odd one and the important one: it is not a progress move
    but the right to write labels at all, which is ``WRITABLE_PROGRESS`` and the
    batch gate together. The other six each name one edge of
    ``ASSET_PROGRESS_TRANSITIONS`` — see :data:`ASSET_MOVES`.
    """

    ANNOTATE = "annotate"
    SKIP = "skip"
    RESTORE = "restore"
    CONFIRM = "confirm"
    SUBMIT_FOR_REVIEW = "submit_for_review"
    ACCEPT = "accept"
    RETURN_TO_ANNOTATOR = "return_to_annotator"


# ``download_weights`` arrives here in the same change as the route, the command
# and the job that perform it, per the rule above. ``test_endpoint`` arrives the
# same way, in the same change as the route, the command and the tool that
# perform it.
#
# It is declared **first**, which is a display decision. This is the only
# connection action that moves the resource forward — it is what takes a local
# connection from `not_set_up` to `ready` — and the batch listing already puts
# the moves ahead of the housekeeping for the same reason. ``delete`` stays last,
# because it ends the resource rather than changing it.
#
# ``check_integrity`` is the second action over the same files and deliberately
# not a second reading of the first. ``download_weights`` at ``ready``
# asks *is every file here*, which the download library answers from its own
# index without opening one; this asks *does every file still hold the bytes it
# was written with*, which can only be answered by reading all of them and
# comparing digests the hub published. One name for two costs would misstate the
# contract to every client: a listing is a second, a full re-read of a
# multi-gigabyte snapshot is not.
#
# It is declared **between** the download and the housekeeping, which is the
# display decision the ordering rule above implies: it is about the weights, so
# it belongs beside the action that fetched them, and it moves the resource
# (backwards, on failure) rather than editing or ending it.
class ConnectionAction(OpenVocabulary):
    """What can be asked of an inference connection. Order is display order."""

    DOWNLOAD_WEIGHTS = "download_weights"
    CHECK_INTEGRITY = "check_integrity"
    TEST_ENDPOINT = "test_endpoint"
    UPDATE = "update"
    #: Point it at a different model or revision — declared only while nothing
    #: has been committed to the one it names; ``update`` alone stays for the
    #: name and the runtime parameters.
    UPDATE_MODEL = "update_model"
    DELETE = "delete"


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
    BatchAction.CREATE_CORRECTION: CORRECTABLE_STATES,
    BatchAction.PRE_LABEL: PRE_LABELABLE_STATES,
    BatchAction.EDIT_MEMBERSHIP: EDITABLE_STATES,
    BatchAction.DELETE: DELETABLE_STATES,
}
"""The six batch actions that change no state, and so appear in no table row.

``create_correction`` is the odd one even here, and worth naming: every other
action in this file is something done **to** the resource declaring it, while
this one creates a *different* batch and leaves its subject untouched. It is
declared on the parent anyway, because "can this be corrected" is a question
about the parent's state and about nothing else — the same reason ``promote`` is
declared on the batch whose assets move rather than on the dataset they move
into.

Each is the named set its own service gate consults, referenced rather than
restated — which is the whole point of those sets being named. Promotion is the
clearest case: it moves assets into the trunk and leaves the batch exactly where
it was, so ``BATCH_TRANSITIONS`` has nothing to say about it.

``delete`` is the odd one in the other direction: it ends the resource rather
than changing it, so a client renders it apart from the rest — but "may this
batch be deleted" is a question about the batch's state and about nothing else,
which is what this table answers. The entry is ``DELETABLE_STATES`` itself, the
set ``BatchService.delete`` raises ``BatchImmutable`` against; a second frozenset
spelled out beside it is exactly the hand-mirror this module exists to remove.

``pre_label`` is declared from the batch's state alone, on ``complete``'s
precedent: whether this machine has the local runtime installed, and whether the
pinned schema declares a class a detection can land on, are not facts about the
batch. Hiding the control on either ground would leave their refusals — one of
which carries an install command — with nowhere to be shown.
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
        frozenset({AssetProgress.UNANNOTATED, AssetProgress.ANNOTATED, AssetProgress.PRE_LABELED}),
    ),
    AssetAction.RESTORE: Move(AssetProgress.UNANNOTATED, frozenset({AssetProgress.SKIPPED})),
    AssetAction.CONFIRM: Move(AssetProgress.ANNOTATED, frozenset({AssetProgress.PRE_LABELED})),
    AssetAction.SUBMIT_FOR_REVIEW: Move(
        AssetProgress.REVIEW_PENDING, frozenset({AssetProgress.ANNOTATED})
    ),
    AssetAction.ACCEPT: Move(AssetProgress.ACCEPTED, frozenset({AssetProgress.REVIEW_PENDING})),
    AssetAction.RETURN_TO_ANNOTATOR: Move(
        AssetProgress.ANNOTATED, frozenset({AssetProgress.REVIEW_PENDING})
    ),
}
"""The six actions naming a progress edge somebody can click.

``accept`` and ``return_to_annotator`` are the two halves of ``review_pending``,
and the second is named for what it does rather than for the edge it rides: "back
to annotated" describes the table, "return to annotator" describes the act.

``skip`` claims three origins rather than one: a person may decide against
labeling a frame whether it has never been touched, already carries a person's
work, or still carries only a model's — the decision is the same act from all
three.

``confirm`` is a person keeping a model's labels as the frame's own: the same
edge an edit rides, reached without the lie of a nudged box. Labels exist
either way; the marker records judgment.
"""


UNNAMED_EDGES: Final[frozenset[tuple[AssetProgress, AssetProgress]]] = frozenset(
    (current, landed)
    for current in AssetProgress
    for has_annotations in (True, False)
    for judged in (True, False)
    if (
        landed := progress_after_annotating(current, has_annotations=has_annotations, judged=judged)
    )
    is not None
)
"""Legal progress edges that deliberately have no action name of their own — except
``pre_labeled -> annotated``, which ``confirm`` also names.

Five edges, all of them *computed from* ``progress_after_annotating`` rather
than listed beside it. The first two are an annotation appearing or
disappearing on its own — ``unannotated -> annotated`` when the first label
lands, and back again when the last one goes. Nobody performs these:
``AnnotationService`` makes them in the same transaction as the write, and they
are the consequence of ``annotate``, which is an action and is declared.

The other three are the same shape one state over. ``unannotated ->
pre_labeled`` is what an unjudged write makes in the same transaction as its
labels; ``pre_labeled -> annotated`` is a person's edit taking the frame over,
and ``pre_labeled -> unannotated`` is that edit deleting the model's last
label. Each is derived here for the reason the first two are: this set can
only grow if the domain's own derivation rule does.

``pre_labeled -> annotated`` is the one edge with two ways to ride it — an edit,
which lands here, and ``confirm``, which is named. The other four stay unnamed:
offering one of them as a control would change a marker while its labels stay
put, which is the one thing the progress machine exists to prevent.

Named at all so that a *new* edge cannot quietly arrive with no capability:
``test_every_edge_is_named_by_an_action_or_deliberately_not`` requires every edge
of ``ASSET_PROGRESS_TRANSITIONS`` to be claimed by an action or to fall in here,
and this set can only grow if the domain's own derivation rule does.
"""


CONNECTION_GATES: Final[Mapping[ConnectionAction, frozenset[ConnectionSetupState]]] = {
    ConnectionAction.DOWNLOAD_WEIGHTS: EVERY_SETUP_STATE,
    ConnectionAction.CHECK_INTEGRITY: CHECKABLE_STATES,
    ConnectionAction.TEST_ENDPOINT: EVERY_SETUP_STATE,
    ConnectionAction.UPDATE: EVERY_SETUP_STATE,
    ConnectionAction.UPDATE_MODEL: RETARGETABLE_STATES,
    ConnectionAction.DELETE: EVERY_SETUP_STATE,
}
"""Which setup states each connection action is legal in.

**``download_weights`` is legal in both, and that is a decision rather than a
widening for convenience.** The work behind it is idempotent by the download
library's own design: files already in the cache under this revision are found
rather than re-fetched, and ``record_weights_ready`` returns a ``ready``
connection unchanged. So the same request against a ``ready`` connection answers
"is this snapshot still complete?" — a real question on a machine where a disk
filled or a cache was pruned mid-download. It is completeness rather than
integrity, and ``visionset.inference.weights`` says why that distinction is worth
keeping. A client renders it under its own label; the wire keeps one name,
because it is one call doing one thing.

**``update_model`` is conditional in both halves**: a ``local`` connection may be
pointed at a different model only while it is ``not_set_up``, because until
the weights arrive the reference is a plan and afterwards it is what the
connection is; an ``http`` connection is born ``ready`` and never declares it —
its model is fixed at creation, and a different one is a new connection.
:data:`~visionset.kernel.domain.inference.RETARGETABLE_STATES` carries the why.

**``check_integrity`` is the row that makes this table conditional in state**, and it is
exactly the one-line narrowing the previous paragraph left room for. It is legal
at ``ready`` and nowhere else, because it
re-reads the snapshot a download left behind: at ``not_set_up`` there is no
snapshot, so the action is not merely useless but unanswerable. That is
:data:`~visionset.kernel.domain.inference.CHECKABLE_STATES`, named in the domain
beside the states it narrows rather than spelled out here — the discipline
``DELETABLE_STATES`` gets above, and the reason the other three rows still name
:data:`~visionset.kernel.domain.inference.EVERY_SETUP_STATE` itself.

There is still no ``CONNECTION_MOVES`` and no transition table beside this, and
that survives ``check_integrity`` adding the second edge. There are now two —
``not_set_up -> ready`` when a download finishes, and ``ready -> not_set_up``
when a check finds damage and purges it — and **neither is a move somebody
performs**. Each is what an operation over the *cache* leaves behind, written in
the same transaction, the way an annotation appearing moves an asset to
``annotated`` without anybody clicking it: nobody asks for "make this connection
not set up", they ask for the files to be checked. A transition table earns its
place when the edges are what a caller names — ``BATCH_TRANSITIONS`` has eight of
those. So both gates answer the question a client actually asks, and both edges
live in the service that writes them.
"""


ENDPOINT_TYPES: Final = frozenset({ConnectionType.HTTP})
"""The kinds that have an endpoint to ask — the complement of
:data:`WEIGHT_HOLDING_TYPES` today, and named on its own so neither set has to
be derived from the other."""


CONNECTION_KINDS: Final[Mapping[ConnectionAction, frozenset[ConnectionType]]] = {
    ConnectionAction.DOWNLOAD_WEIGHTS: WEIGHT_HOLDING_TYPES,
    ConnectionAction.CHECK_INTEGRITY: WEIGHT_HOLDING_TYPES,
    ConnectionAction.TEST_ENDPOINT: ENDPOINT_TYPES,
    ConnectionAction.UPDATE: EVERY_CONNECTION_TYPE,
    ConnectionAction.UPDATE_MODEL: WEIGHT_HOLDING_TYPES,
    ConnectionAction.DELETE: EVERY_CONNECTION_TYPE,
}
"""Which kinds each connection action is legal for — the second half of the gate.

The first capability in this module whose legality is not a function of state
alone, and the reason it needs its own table rather than a widened one: an
``http`` connection has **no weights to fetch at all**, which is a fact about
what it *is* and not about where it has got to. Folding that into
:data:`CONNECTION_GATES` would mean inventing a setup state to carry it — a
``not_applicable`` that exists only so a table can be square, and that every
reader of the row would then have to interpret. ``test_endpoint`` is the same
fact read the other way: only a kind with an endpoint can be asked what it
answers.

Two maps read by one function is also what keeps the failure honest.
``connection_actions`` requires **both**, so an action added to one table and
forgotten in the other raises ``KeyError`` at the first call rather than
silently defaulting to allowed — which is what a single table with a ``.get``
would have done.
"""


def connection_actions(
    setup_state: ConnectionSetupState, *, connection_type: ConnectionType
) -> list[ConnectionAction]:
    """Everything this connection does not refuse, in declaration order.

    Both dimensions, and neither is optional. A local connection declares
    ``download_weights`` in either state — fetching what is missing, verifying
    what is there — and an ``http`` connection never does in any state, because
    it has no weights of its own. That is the whole of :data:`CONNECTION_GATES`
    and :data:`CONNECTION_KINDS` read together, and
    `InferenceConnectionService.require_downloadable` gates on this same function
    rather than restating either table — the hand-mirror this module exists to
    prevent, and the antipattern this repository has paid for twice.

    A client that wants to *label* the two readings differently reads
    ``setup_state``, which is a field of the resource and not a second capability
    table. Deriving the word on a control from a state the wire states is not the
    banned mirror; computing whether the control may exist would be.

    ``download_weights`` being declared says the *connection* is ready to be
    asked, never that this installation can carry it out: whether the local
    runtime extra is present is a fact about the machine, which no pure function
    over domain values can see. A deployment without it refuses with an install
    hint rather than hiding the control — design principle 9, never a bare
    disabled control.

    ``delete`` never depends on what a connection's annotations say, and cannot:
    provenance is denormalised onto the label at write time, so deleting a
    connection takes nothing with it.
    """
    return [
        action
        for action in ConnectionAction
        if setup_state in CONNECTION_GATES[action] and connection_type in CONNECTION_KINDS[action]
    ]


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


def asset_actions(
    progress: AssetProgress | None,
    *,
    batch_state: BatchState,
    job_state: AnnotationJobState | None,
) -> list[AssetAction]:
    """Everything one asset of a batch can be asked to do, in declaration order.

    ``progress`` and ``job_state`` are ``None`` together and exactly while the
    batch is a draft — a draft has no jobs, so no asset in it has either — and
    the answer is empty either way, because nothing may be written into a batch
    nobody opened.

    **Three dimensions, and none of them optional.** The batch has to be open,
    the job has to be open, and the asset's own progress decides the rest. The
    job dimension is not implied by the batch one: a job completing does not
    complete its batch — ``BatchService`` derives that separately — so without it
    a finished job's assets go on declaring ``annotate``, and the annotation
    workspace, which reads this declaration to decide whether it is an editor or a
    viewer, stays an editor over work that is done. ``OPEN_JOB_STATES`` is the
    set, shared with the services that refuse the same writes, so the declaration
    and the refusal cannot disagree.

    Keyword-only and defaulted nowhere, like ``job_actions``' ``batch_state``: a
    caller that could omit a dimension is a caller that will, and a dropped
    dimension is how a hand-mirrored client produced two blockers.

    ``annotate`` is not a progress move and is the one action here that is not in
    ``ASSET_MOVES``: it is the right to add, change or remove labels, which is
    ``WRITABLE_PROGRESS`` and the two gates together. It is also the declaration
    the annotator wants, because "can I open this in edit mode" is exactly that
    question — and answering it wrong is what left work stranded in a browser
    against a batch that had closed.
    """
    if batch_state is not BatchState.IN_ANNOTATION or progress is None:
        return []
    if job_state is None or job_state not in OPEN_JOB_STATES:
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
