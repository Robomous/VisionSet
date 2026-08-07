"""The declarations and the enforcement are the same rules, proved by running both.

`kernel/domain/capabilities.py` says what a batch, a job or an asset may be asked
to do. The services decide what actually happens. Nothing in the type system ties
the two together, and a client that trusts the declaration is trusting exactly
that tie — which is the tie the browser's hand-written copy of these rules broke.

So this module drives the **real services** over a **real workspace** and compares
what happened against what was declared, for every state a resource can reach:

- *sound* — a declared action, invoked, is not refused, and lands the resource
  where the action's name says it will;
- *complete* — an undeclared action, invoked, is refused, with the two documented
  exceptions derived rather than listed (`JobService.mark` treats a move to the
  state an asset is already in as a no-op, and `UNNAMED_EDGES` is the legal edge
  nobody clicks);
- *covered* — every edge of every table is claimed by an action or deliberately
  named as unclaimed, so a new edge cannot arrive with no capability.

The matrices are enumerated from the tables and from what the kernel can actually
be walked into, never by hand. Adding a state, an edge or an action changes the
number of cases here without anybody editing a list.
"""

from __future__ import annotations

from collections.abc import Callable
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from visionset.kernel import (
    AssetNotWritable,
    BatchImmutable,
    BatchNotComplete,
    BatchNotEditable,
    BatchNotFound,
    BatchNotInAnnotation,
    InvalidTransition,
    JobNotComplete,
)
from visionset.kernel.domain import (
    ASSET_MOVES,
    ASSET_PROGRESS_TRANSITIONS,
    BATCH_GATES,
    BATCH_MOVES,
    BATCH_TRANSITIONS,
    DELETABLE_STATES,
    JOB_MOVES,
    JOB_TRANSITIONS,
    UNNAMED_EDGES,
    Annotation,
    AnnotationJobState,
    Asset,
    AssetAction,
    AssetProgress,
    BatchAction,
    BatchState,
    BboxGeometry,
    GeometryType,
    JobAction,
    LabelClass,
    Move,
    asset_actions,
    batch_actions,
    job_actions,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)

SIGN = LabelClass(name="sign", geometry=GeometryType.BBOX)

UNANNOTATED = AssetProgress.UNANNOTATED
ANNOTATED = AssetProgress.ANNOTATED
SKIPPED = AssetProgress.SKIPPED
REVIEW_PENDING = AssetProgress.REVIEW_PENDING
ACCEPTED = AssetProgress.ACCEPTED

#: What a refusal grounded in *state* looks like, whichever resource made it.
#: Named as one tuple so a case can assert "this was refused for being in the
#: wrong state" without the matrix also having to know which error each action
#: picks — that correspondence is `server/errors.py`'s business, and it has its
#: own exhaustive test.
STATE_REFUSALS = (
    InvalidTransition,
    BatchNotEditable,
    BatchNotComplete,
    BatchImmutable,
    BatchNotInAnnotation,
    JobNotComplete,
    AssetNotWritable,
)


class Fixture:
    """A workspace whose batch can be walked to any reachable state.

    Three assets, two of them in the batch: the third is what `edit_membership`
    adds, so that action is proved by a membership that actually grew rather than
    by a call that returned.
    """

    def __init__(self, tmp_path: Path) -> None:
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.datasets = DatasetService(self.workspace)
        self.project = ProjectService(self.workspace).create("caps")
        SchemaService(self.workspace).create_version(self.project.id, [SIGN])
        self.assets = [self._asset(f"a{index}") for index in range(3)]
        self.spare = self.assets[-1]
        self.batch = self.batches.create(self.project.id, "b", self.assets[:2])

    def _asset(self, seed: str) -> UUID:
        content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
        with self.workspace.unit_of_work() as uow:
            return uow.assets.add(
                Asset(project_id=self.project.id, content_hash=content_hash, uri=f"/{seed}.png")
            ).id

    # --- walking, only ever through the real doors -------------------------

    def walk_batch(self, state: BatchState) -> None:
        """Take the batch to ``state``, finishing its jobs on the way if needed."""
        if state is BatchState.DRAFT:
            return
        self.batches.approve(self.batch.id)
        if state is BatchState.APPROVED:
            return
        self.batches.start(self.batch.id)
        # Even for IN_ANNOTATION: `complete` is declared from the transition table
        # alone and refuses while a job is outstanding, so a batch parked here
        # with unfinished work would fail the soundness half for a reason the
        # declaration already documents. That caveat has its own test below.
        self.settle_everything()
        if state is BatchState.IN_ANNOTATION:
            return
        self.batches.complete(self.batch.id)

    def settle_everything(self) -> None:
        """Every asset annotated and every job finished — jobs are born pending."""
        for job in self.batches.jobs(self.batch.id):
            for asset_id in job.progress:
                self.jobs.mark(job.id, asset_id, ANNOTATED)
            self.jobs.start(job.id)
            self.jobs.complete(job.id)

    def walk_job(self, state: AnnotationJobState, *, settled: bool) -> UUID:
        """The batch's one job, taken to ``state`` with its assets settled or not."""
        job = self.batches.jobs(self.batch.id)[0]
        if settled:
            for asset_id in job.progress:
                self.jobs.mark(job.id, asset_id, ANNOTATED)
        if state is AnnotationJobState.PENDING:
            return job.id
        self.jobs.start(job.id)
        if state is AnnotationJobState.IN_PROGRESS:
            return job.id
        self.jobs.complete(job.id)
        return job.id

    def walk_asset(self, progress: AssetProgress) -> tuple[UUID, UUID]:
        """One asset taken to ``progress``. Returns ``(job_id, asset_id)``."""
        job = self.batches.jobs(self.batch.id)[0]
        asset_id = next(iter(job.progress))
        for step in _ROUTE_TO[progress]:
            self.jobs.mark(job.id, asset_id, step)
        return job.id, asset_id

    def state_of(self, job_id: UUID, asset_id: UUID) -> AssetProgress:
        return self.jobs.get(job_id).progress[asset_id]

    def close(self) -> None:
        self.workspace.close()


#: The shortest legal walk from ``unannotated`` to each progress state.
_ROUTE_TO: dict[AssetProgress, tuple[AssetProgress, ...]] = {
    UNANNOTATED: (),
    ANNOTATED: (ANNOTATED,),
    SKIPPED: (SKIPPED,),
    REVIEW_PENDING: (ANNOTATED, REVIEW_PENDING),
    ACCEPTED: (ANNOTATED, REVIEW_PENDING, ACCEPTED),
}


def _box(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="sign",
        schema_version=1,
        geometry=BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
        provenance="human",
    )


def _edges[S](transitions: dict[S, frozenset[S]]) -> set[tuple[S, S]]:
    return {(origin, to) for origin, targets in transitions.items() for to in targets}


def _claimed[S](moves: dict[Any, Move[S]]) -> list[tuple[S, S]]:
    return [(origin, move.to) for move in moves.values() for origin in move.origins]


# --- structural: the vocabulary agrees with the tables it names ----------------


@pytest.mark.parametrize(
    ("label", "moves", "transitions"),
    [
        ("batch", BATCH_MOVES, BATCH_TRANSITIONS),
        ("job", JOB_MOVES, JOB_TRANSITIONS),
        ("asset", ASSET_MOVES, ASSET_PROGRESS_TRANSITIONS),
    ],
)
def test_every_named_move_is_an_edge_the_table_actually_has(
    label: str, moves: dict[Any, Move[Any]], transitions: dict[Any, frozenset[Any]]
) -> None:
    """`Move.origins` narrows a name; it may never invent a transition.

    Without this, a typo in an origin would declare an action the kernel refuses,
    and the enforcement matrix below would be the only thing to catch it — after
    a workspace, a walk and a service call, rather than here.
    """
    assert set(_claimed(moves)) <= _edges(transitions), label


@pytest.mark.parametrize(
    ("label", "moves", "transitions", "unnamed"),
    [
        ("batch", BATCH_MOVES, BATCH_TRANSITIONS, set()),
        ("job", JOB_MOVES, JOB_TRANSITIONS, set()),
        ("asset", ASSET_MOVES, ASSET_PROGRESS_TRANSITIONS, UNNAMED_EDGES),
    ],
)
def test_every_edge_is_named_by_an_action_or_deliberately_not(
    label: str,
    moves: dict[Any, Move[Any]],
    transitions: dict[Any, frozenset[Any]],
    unnamed: set[tuple[Any, Any]],
) -> None:
    """A new edge cannot arrive with no capability and nobody noticing.

    An unnamed edge is legal and simply has no control — `annotated ->
    unannotated` is the only one, and it happens when the last label is deleted.
    Listing it is what makes the omission a decision instead of an oversight.
    """
    assert set(_claimed(moves)) | unnamed == _edges(transitions), label


@pytest.mark.parametrize(
    ("label", "moves", "transitions"),
    [
        ("batch", BATCH_MOVES, BATCH_TRANSITIONS),
        ("job", JOB_MOVES, JOB_TRANSITIONS),
        ("asset", ASSET_MOVES, ASSET_PROGRESS_TRANSITIONS),
    ],
)
def test_no_two_actions_claim_the_same_edge(
    label: str, moves: dict[Any, Move[Any]], transitions: dict[Any, frozenset[Any]]
) -> None:
    """One edge, one name — otherwise a client is offered the same move twice."""
    claimed = _claimed(moves)
    assert len(claimed) == len(set(claimed)), label


def test_every_action_is_decided_by_exactly_one_source() -> None:
    """No action falls through undecided, and none is decided twice.

    A batch action is either a move in `BATCH_TRANSITIONS` or a named set in
    `BATCH_GATES`; `batch_actions` branches on exactly that, so an action in
    neither would raise `KeyError` and one in both would have two answers.
    """
    assert set(BATCH_MOVES) | set(BATCH_GATES) == set(BatchAction)
    assert not set(BATCH_MOVES) & set(BATCH_GATES)
    assert set(JOB_MOVES) == set(JobAction)
    assert set(ASSET_MOVES) | {AssetAction.ANNOTATE} == set(AssetAction)


# --- enforcement: batches -----------------------------------------------------


def _invoke_batch(fixture: Fixture, action: BatchAction) -> Callable[[], None]:
    """What the SDK caller behind each declared batch action actually does.

    Each closure also asserts the effect the action's *name* promises, so a
    declaration cannot be satisfied by a call that returned and did nothing.
    """
    batch_id = fixture.batch.id

    def approve() -> None:
        assert fixture.batches.approve(batch_id).state is BatchState.APPROVED

    def start() -> None:
        assert fixture.batches.start(batch_id).state is BatchState.IN_ANNOTATION

    def complete() -> None:
        assert fixture.batches.complete(batch_id).state is BatchState.COMPLETED

    def repin() -> None:
        assert fixture.batches.repin(batch_id).id == batch_id

    def promote() -> None:
        fixture.datasets.promote(batch_id)

    def edit_membership() -> None:
        grown = fixture.batches.add_assets(batch_id, [fixture.spare])
        assert fixture.spare in grown.batch.asset_ids
        assert grown.changed == (fixture.spare,)

    def delete() -> None:
        # The one action whose effect is the subject's absence, so the assertion
        # is a refusal: `get` on a deleted batch is `BatchNotFound`, which is
        # outside `STATE_REFUSALS` and so cannot be confused with a decline.
        fixture.batches.delete(batch_id, confirm=True)
        with pytest.raises(BatchNotFound):
            fixture.batches.get(batch_id)

    def create_correction() -> None:
        # The one action here whose effect is on a *different* batch, so the
        # assertion is about the child rather than about the subject: a new draft
        # over the parent's assets, pointing back at it.
        child = fixture.batches.create_correction(batch_id, "correction")
        assert child.id != batch_id
        assert child.parent_batch_id == batch_id
        assert child.state is BatchState.DRAFT
        assert child.asset_ids == fixture.batches.get(batch_id).asset_ids

    return {
        BatchAction.APPROVE: approve,
        BatchAction.START: start,
        BatchAction.COMPLETE: complete,
        BatchAction.REPIN: repin,
        BatchAction.PROMOTE: promote,
        BatchAction.CREATE_CORRECTION: create_correction,
        BatchAction.EDIT_MEMBERSHIP: edit_membership,
        BatchAction.DELETE: delete,
    }[action]


@pytest.mark.parametrize("action", list(BatchAction), ids=lambda a: a.value)
@pytest.mark.parametrize("state", list(BatchState), ids=lambda s: s.value)
def test_a_batch_allows_exactly_what_it_declares(
    tmp_path: Path, state: BatchState, action: BatchAction
) -> None:
    """Every square of `BatchState` x `BatchAction`, run against the real service."""
    fixture = Fixture(tmp_path)
    fixture.walk_batch(state)
    invoke = _invoke_batch(fixture, action)

    if action in batch_actions(state):
        invoke()
    else:
        with pytest.raises(STATE_REFUSALS):
            invoke()
        assert fixture.batches.get(fixture.batch.id).state is state
    fixture.close()


def test_completing_a_batch_is_declared_from_the_table_and_can_still_refuse(
    tmp_path: Path,
) -> None:
    """The one caveat on the batch declarations, pinned rather than left in prose.

    Completion is *derived* from the jobs, and two of the three serialization
    sites do not have them in hand. So `complete` is declared wherever the
    transition table allows it, and a client renders the refusal if the work is
    not done — which is strictly better than the same batch declaring differently
    depending on which endpoint answered.
    """
    fixture = Fixture(tmp_path)
    fixture.batches.approve(fixture.batch.id)
    fixture.batches.start(fixture.batch.id)

    assert BatchAction.COMPLETE in batch_actions(BatchState.IN_ANNOTATION)
    with pytest.raises(BatchNotComplete):
        fixture.batches.complete(fixture.batch.id)

    fixture.settle_everything()
    assert fixture.batches.complete(fixture.batch.id).state is BatchState.COMPLETED
    fixture.close()


# --- enforcement: jobs --------------------------------------------------------

#: Every ``(batch state, job state, assets settled)`` a job can actually be in.
#: Not the cartesian product: a job only exists once its batch is approved, it
#: cannot leave ``pending`` until the batch is open, and a completed batch's jobs
#: are completed with every asset settled by construction.
JOB_SCENARIOS: list[tuple[BatchState, AnnotationJobState, bool]] = [
    (BatchState.APPROVED, AnnotationJobState.PENDING, False),
    (BatchState.IN_ANNOTATION, AnnotationJobState.PENDING, False),
    (BatchState.IN_ANNOTATION, AnnotationJobState.PENDING, True),
    (BatchState.IN_ANNOTATION, AnnotationJobState.IN_PROGRESS, False),
    (BatchState.IN_ANNOTATION, AnnotationJobState.IN_PROGRESS, True),
    (BatchState.IN_ANNOTATION, AnnotationJobState.COMPLETED, True),
    (BatchState.COMPLETED, AnnotationJobState.COMPLETED, True),
]


@pytest.mark.parametrize("action", list(JobAction), ids=lambda a: a.value)
@pytest.mark.parametrize(
    "scenario",
    JOB_SCENARIOS,
    ids=lambda s: f"{s[0].value}-{s[1].value}-{'settled' if s[2] else 'open'}",
)
def test_a_job_allows_exactly_what_it_declares(
    tmp_path: Path,
    scenario: tuple[BatchState, AnnotationJobState, bool],
    action: JobAction,
) -> None:
    """Every reachable job state under every batch state, run for real.

    The `approved` row is the one that matters most: a `pending` job there looks
    startable from `JOB_TRANSITIONS` alone, and is not. That is the dimension the
    browser's mirror dropped.
    """
    batch_state, job_state, settled = scenario
    fixture = Fixture(tmp_path)
    fixture.batches.approve(fixture.batch.id)
    if batch_state is not BatchState.APPROVED:
        fixture.batches.start(fixture.batch.id)
    job_id = fixture.walk_job(job_state, settled=settled)
    if batch_state is BatchState.COMPLETED:
        fixture.batches.complete(fixture.batch.id)

    job = fixture.jobs.get(job_id)
    declared = job_actions(job.state, batch_state=batch_state, progress=job.progress.values())
    move = JOB_MOVES[action]

    if action in declared:
        assert _run_job(fixture, job_id, action).state is move.to
    else:
        with pytest.raises(STATE_REFUSALS):
            _run_job(fixture, job_id, action)
        assert fixture.jobs.get(job_id).state is job_state
    fixture.close()


def _run_job(fixture: Fixture, job_id: UUID, action: JobAction) -> Any:
    return (fixture.jobs.start if action is JobAction.START else fixture.jobs.complete)(job_id)


# --- enforcement: batch assets ------------------------------------------------

#: Every ``(batch state, asset progress)`` an asset can actually be in. A draft
#: has no jobs, so its assets have no progress at all; an `approved` batch's
#: assets are all `unannotated`, because `mark` needs the batch open; and a
#: completed batch's are settled, because a job cannot finish otherwise.
ASSET_SCENARIOS: list[tuple[BatchState, AssetProgress | None]] = [
    (BatchState.DRAFT, None),
    (BatchState.APPROVED, UNANNOTATED),
    *[(BatchState.IN_ANNOTATION, p) for p in AssetProgress],
    *[(BatchState.COMPLETED, p) for p in (ANNOTATED, SKIPPED, ACCEPTED)],
]


@pytest.mark.parametrize("action", list(AssetAction), ids=lambda a: a.value)
@pytest.mark.parametrize(
    "scenario", ASSET_SCENARIOS, ids=lambda s: f"{s[0].value}-{s[1].value if s[1] else 'nojob'}"
)
def test_an_asset_allows_exactly_what_it_declares(
    tmp_path: Path,
    scenario: tuple[BatchState, AssetProgress | None],
    action: AssetAction,
) -> None:
    """Every reachable ``(batch state, progress)`` under every asset action.

    The `completed` rows are the reported blocker: the gallery offered skip and
    restore there, the kernel refused every frame, and the reason never reached
    the user. Declared is empty for all of them, and this proves the kernel
    agrees.
    """
    batch_state, progress = scenario
    fixture = Fixture(tmp_path)
    job_id, asset_id = _reach(fixture, batch_state, progress)
    declared = asset_actions(progress, batch_state=batch_state)

    if action in declared:
        _run_asset(fixture, job_id, asset_id, action)
        assert _landed(fixture, job_id, asset_id, action, progress)
    else:
        _assert_undeclared_is_refused(fixture, job_id, asset_id, action, progress, batch_state)
    fixture.close()


def _reach(
    fixture: Fixture, batch_state: BatchState, progress: AssetProgress | None
) -> tuple[UUID | None, UUID]:
    """Walk the fixture to the scenario. ``job_id`` is None only for a draft."""
    if batch_state is BatchState.DRAFT:
        return None, fixture.batch.asset_ids[0]
    fixture.batches.approve(fixture.batch.id)
    if batch_state is BatchState.APPROVED:
        job = fixture.batches.jobs(fixture.batch.id)[0]
        return job.id, next(iter(job.progress))
    fixture.batches.start(fixture.batch.id)
    assert progress is not None
    job_id, asset_id = fixture.walk_asset(progress)
    if batch_state is BatchState.COMPLETED:
        for other in fixture.jobs.get(job_id).progress:
            if other != asset_id:
                fixture.jobs.mark(job_id, other, ANNOTATED)
        fixture.jobs.start(job_id)
        fixture.jobs.complete(job_id)
        fixture.batches.complete(fixture.batch.id)
    return job_id, asset_id


def _run_asset(fixture: Fixture, job_id: UUID | None, asset_id: UUID, action: AssetAction) -> None:
    assert job_id is not None
    if action is AssetAction.ANNOTATE:
        fixture.annotations.add(job_id, [_box(asset_id)])
    else:
        fixture.jobs.mark(job_id, asset_id, ASSET_MOVES[action].to)


def _landed(
    fixture: Fixture,
    job_id: UUID | None,
    asset_id: UUID,
    action: AssetAction,
    progress: AssetProgress | None,
) -> bool:
    """Did the action do what its name promises, not merely return?"""
    assert job_id is not None
    if action is AssetAction.ANNOTATE:
        return len(fixture.annotations.for_asset(job_id, asset_id)) == 1
    return fixture.state_of(job_id, asset_id) is ASSET_MOVES[action].to


def _assert_undeclared_is_refused(
    fixture: Fixture,
    job_id: UUID | None,
    asset_id: UUID,
    action: AssetAction,
    progress: AssetProgress | None,
    batch_state: BatchState,
) -> None:
    """An undeclared action is refused — with the two exceptions the kernel documents.

    Both are derived from the tables rather than listed as cases: a move to the
    state an asset is already in is `JobService.mark`'s documented no-op, and
    `UNNAMED_EDGES` is the legal edge no action is the name of. Everything else
    must raise.
    """
    if job_id is None:
        # A draft has no jobs, so there is nothing to address in the first place.
        assert fixture.batches.jobs(fixture.batch.id) == []
        return

    if batch_state is not BatchState.IN_ANNOTATION:
        # The batch gate fires before the no-op check, deliberately: writing into
        # a closed batch is a bug whether or not the value would have changed.
        with pytest.raises(STATE_REFUSALS):
            _run_asset(fixture, job_id, asset_id, action)
        return

    assert progress is not None
    if action is AssetAction.ANNOTATE:
        with pytest.raises(AssetNotWritable):
            _run_asset(fixture, job_id, asset_id, action)
        return

    move = ASSET_MOVES[action]
    if move.to is progress:
        _run_asset(fixture, job_id, asset_id, action)
        assert fixture.state_of(job_id, asset_id) is progress
    elif (progress, move.to) in UNNAMED_EDGES:
        _run_asset(fixture, job_id, asset_id, action)
        assert fixture.state_of(job_id, asset_id) is move.to
    else:
        with pytest.raises(InvalidTransition):
            _run_asset(fixture, job_id, asset_id, action)
        assert fixture.state_of(job_id, asset_id) is progress


# --- the two claims the matrices exist to make, stated once --------------------


def test_a_completed_batch_offers_its_assets_nothing(tmp_path: Path) -> None:
    """The reported blocker, as a sentence rather than as sixty parametrized cases."""
    for progress in (ANNOTATED, SKIPPED, ACCEPTED):
        assert asset_actions(progress, batch_state=BatchState.COMPLETED) == []


def test_an_approved_batch_offers_its_jobs_nothing(tmp_path: Path) -> None:
    """`JOB_TRANSITIONS` alone would say a pending job here is startable. It is not."""
    assert JOB_MOVES[JobAction.START].offered_from(AnnotationJobState.PENDING, JOB_TRANSITIONS)
    assert (
        job_actions(
            AnnotationJobState.PENDING,
            batch_state=BatchState.APPROVED,
            progress=[UNANNOTATED],
        )
        == []
    )


def test_declaration_order_is_stable(tmp_path: Path) -> None:
    """A client may render these in order; the order is the enum's, not a set's."""
    assert batch_actions(BatchState.DRAFT) == [
        BatchAction.APPROVE,
        BatchAction.EDIT_MEMBERSHIP,
        # Last, and deliberately: the only batch action that ends the resource
        # rather than moving it along, so a listing whose order doubles as the
        # workflow does not put a dead end in the middle of it.
        BatchAction.DELETE,
    ]
    assert asset_actions(ANNOTATED, batch_state=BatchState.IN_ANNOTATION) == [
        AssetAction.ANNOTATE,
        AssetAction.SKIP,
        AssetAction.SUBMIT_FOR_REVIEW,
    ]


def test_delete_is_declared_from_the_kernels_own_gate_and_not_from_a_copy() -> None:
    """#376: the declaration returned with the route, and it reads one set.

    #331 withdrew the member because nothing outside the SDK could perform it,
    and said it comes back "in the same change" as the route. This is the
    replacement for that absence assertion, and it makes the stronger claim: not
    that `delete` is declared, but that it is declared **exactly** where
    `BatchService.delete` permits it — computed from `DELETABLE_STATES` rather
    than from a list of states retyped here.

    A second frozenset beside the first is the hand-mirror the whole capabilities
    module exists to remove, and it is the failure this repo has paid for twice
    (`cf. #358`). Reading the set is what makes that impossible rather than
    merely discouraged: a change to `DELETABLE_STATES` moves both sides at once,
    and a `BATCH_GATES` entry that stopped pointing at it turns this red.
    """
    assert BATCH_GATES[BatchAction.DELETE] is DELETABLE_STATES
    for state in BatchState:
        assert (BatchAction.DELETE in batch_actions(state)) is (state in DELETABLE_STATES)
