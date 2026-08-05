"""JobService: two state machines, ordered paging, and derived progress.

The two transition sweeps read `JOB_TRANSITIONS` and `ASSET_PROGRESS_TRANSITIONS`
rather than restating them, so neither test can drift from the table it guards.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from visionset.kernel import (
    AssetNotInJob,
    BatchNotFound,
    BatchNotInAnnotation,
    InvalidTransition,
    JobNotComplete,
    JobNotFound,
    ProjectNotFound,
)
from visionset.kernel.domain import (
    ASSET_PROGRESS_TRANSITIONS,
    JOB_TRANSITIONS,
    SETTLED_PROGRESS,
    AnnotationJob,
    AnnotationJobState,
    Asset,
    AssetProgress,
    BatchState,
    BySize,
    GeometryType,
    LabelClass,
)
from visionset.kernel.services import (
    BatchService,
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


class Fixture:
    """A workspace whose one batch is approved, started, and waiting for work."""

    def __init__(self, tmp_path: Path, name: str = "ws", *, assets: int = 5) -> None:
        self.workspace = WorkspaceService.init(tmp_path / name)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.project = ProjectService(self.workspace).create(f"{name}-project")
        SchemaService(self.workspace).create_version(self.project.id, [SIGN])
        self.assets = [self._asset(f"{name}-{index}") for index in range(assets)]
        self.batch = self.batches.create(self.project.id, "first", self.assets)

    def _asset(self, seed: str) -> UUID:
        content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
        with self.workspace.unit_of_work() as uow:
            return uow.assets.add(
                Asset(
                    project_id=self.project.id,
                    content_hash=content_hash,
                    uri=f"/tmp/{seed}.png",
                )
            ).id

    def open_batch(self) -> AnnotationJob:
        """Approve into one job and open the batch. Returns that job."""
        self.batches.approve(self.batch.id)
        self.batches.start(self.batch.id)
        return self.batches.jobs(self.batch.id)[0]

    def job_in(self, state: AnnotationJobState) -> AnnotationJob:
        """A job walked to ``state`` through the real transitions."""
        job = self.open_batch()
        if state is AnnotationJobState.PENDING:
            return job
        self.jobs.start(job.id)
        if state is AnnotationJobState.IN_PROGRESS:
            return self.jobs.get(job.id)
        for asset_id in self.assets:
            self.jobs.mark(job.id, asset_id, ANNOTATED)
        return self.jobs.complete(job.id)

    def asset_in(self, job: AnnotationJob, progress: AssetProgress) -> UUID:
        """The first asset, walked to ``progress`` through the real transitions."""
        asset_id = self.assets[0]
        for step in _route_to(progress):
            self.jobs.mark(job.id, asset_id, step)
        return asset_id

    def close(self) -> None:
        self.workspace.close()


#: The shortest legal walk from ``unannotated`` to each state.
_ROUTES: dict[AssetProgress, tuple[AssetProgress, ...]] = {
    UNANNOTATED: (),
    ANNOTATED: (ANNOTATED,),
    SKIPPED: (SKIPPED,),
    REVIEW_PENDING: (ANNOTATED, REVIEW_PENDING),
    ACCEPTED: (ANNOTATED, REVIEW_PENDING, ACCEPTED),
}


def _route_to(progress: AssetProgress) -> tuple[AssetProgress, ...]:
    return _ROUTES[progress]


def test_every_state_is_reachable_from_unannotated() -> None:
    """The routes the fixture walks are legal in the table, not shortcuts."""
    for target, route in _ROUTES.items():
        current = UNANNOTATED
        for step in route:
            assert step in ASSET_PROGRESS_TRANSITIONS[current]
            current = step
        assert current is target


# --- the two transition tables, swept in full ---------------------------------


@pytest.mark.parametrize("origin", list(AnnotationJobState), ids=lambda s: f"from-{s.value}")
@pytest.mark.parametrize("target", list(AnnotationJobState), ids=lambda s: f"to-{s.value}")
def test_the_job_transition_table_is_the_whole_of_what_is_legal(
    tmp_path: Path, origin: AnnotationJobState, target: AnnotationJobState
) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(origin)
    move = {
        AnnotationJobState.IN_PROGRESS: fixture.jobs.start,
        AnnotationJobState.COMPLETED: fixture.jobs.complete,
    }.get(target)
    if move is None:  # nothing moves a job back to pending
        assert target not in JOB_TRANSITIONS[origin]
        fixture.close()
        return
    if target is AnnotationJobState.COMPLETED and origin is AnnotationJobState.IN_PROGRESS:
        for asset_id in fixture.assets:
            fixture.jobs.mark(job.id, asset_id, ANNOTATED)

    if target in JOB_TRANSITIONS[origin]:
        assert move(job.id).state is target
    else:
        with pytest.raises(InvalidTransition, match="cannot become"):
            move(job.id)
        assert fixture.jobs.get(job.id).state is origin
    fixture.close()


@pytest.mark.parametrize("origin", list(AssetProgress), ids=lambda s: f"from-{s.value}")
@pytest.mark.parametrize("target", list(AssetProgress), ids=lambda s: f"to-{s.value}")
def test_the_asset_progress_table_is_the_whole_of_what_is_legal(
    tmp_path: Path, origin: AssetProgress, target: AssetProgress
) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    asset_id = fixture.asset_in(job, origin)

    if origin is target:
        assert fixture.jobs.mark(job.id, asset_id, target).progress[asset_id] is origin
    elif target in ASSET_PROGRESS_TRANSITIONS[origin]:
        assert fixture.jobs.mark(job.id, asset_id, target).progress[asset_id] is target
    else:
        with pytest.raises(InvalidTransition, match="cannot become"):
            fixture.jobs.mark(job.id, asset_id, target)
        assert fixture.jobs.get(job.id).progress[asset_id] is origin
    fixture.close()


def test_marking_a_state_the_asset_already_holds_is_a_no_op(tmp_path: Path) -> None:
    """Progress is a marker driven by what annotators do; re-stating it is not a move."""
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    first = fixture.jobs.mark(job.id, fixture.assets[0], ANNOTATED)
    again = fixture.jobs.mark(job.id, fixture.assets[0], ANNOTATED)
    assert again.progress == first.progress
    fixture.close()


def test_a_reviewer_can_accept_or_send_back(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    submitted = fixture.asset_in(job, REVIEW_PENDING)

    assert fixture.jobs.mark(job.id, submitted, ANNOTATED).progress[submitted] is ANNOTATED
    fixture.jobs.mark(job.id, submitted, REVIEW_PENDING)
    assert fixture.jobs.mark(job.id, submitted, ACCEPTED).progress[submitted] is ACCEPTED
    fixture.close()


def test_accepted_and_completed_are_both_dead_ends() -> None:
    assert ASSET_PROGRESS_TRANSITIONS[ACCEPTED] == frozenset()
    assert JOB_TRANSITIONS[AnnotationJobState.COMPLETED] == frozenset()


def test_settled_progress_is_exactly_the_three_that_need_no_more_work() -> None:
    assert sorted(SETTLED_PROGRESS) == sorted({ANNOTATED, SKIPPED, ACCEPTED})
    # the complement is what blocks: work not done, and review not done
    assert set(AssetProgress) - SETTLED_PROGRESS == {UNANNOTATED, REVIEW_PENDING}


# --- completion is derived from the assets ------------------------------------


@pytest.mark.parametrize("blocking", [UNANNOTATED, REVIEW_PENDING], ids=lambda s: str(s.value))
def test_a_job_cannot_complete_while_an_asset_is_unsettled(
    tmp_path: Path, blocking: AssetProgress
) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    for asset_id in fixture.assets[1:]:
        fixture.jobs.mark(job.id, asset_id, ANNOTATED)
    fixture.asset_in(job, blocking)

    with pytest.raises(JobNotComplete, match=f"1 {blocking.value}"):
        fixture.jobs.complete(job.id)
    assert fixture.jobs.get(job.id).state is AnnotationJobState.IN_PROGRESS
    fixture.close()


@pytest.mark.parametrize("settled", sorted(SETTLED_PROGRESS), ids=lambda s: str(s.value))
def test_a_job_completes_once_every_asset_is_settled(
    tmp_path: Path, settled: AssetProgress
) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    for asset_id in fixture.assets:
        for step in _route_to(settled):
            fixture.jobs.mark(job.id, asset_id, step)

    assert fixture.jobs.complete(job.id).state is AnnotationJobState.COMPLETED
    fixture.close()


def test_completing_a_job_does_not_complete_its_batch(tmp_path: Path) -> None:
    """One machine in two places is one too many — BatchService derives its own."""
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.COMPLETED)
    assert job.state is AnnotationJobState.COMPLETED
    assert fixture.batches.get(fixture.batch.id).state is BatchState.IN_ANNOTATION
    fixture.close()


# --- work only happens inside an open batch -----------------------------------


def test_no_work_happens_before_the_batch_is_opened(tmp_path: Path) -> None:
    """An approved batch has jobs, but nobody has opened it for annotation yet.

    There is no `draft` case to test: a draft has no jobs at all — `approve` is
    what creates them.
    """
    fixture = Fixture(tmp_path)
    fixture.batches.approve(fixture.batch.id)
    job = fixture.batches.jobs(fixture.batch.id)[0]
    assert fixture.batches.get(fixture.batch.id).state is BatchState.APPROVED

    with pytest.raises(BatchNotInAnnotation, match="nobody opened"):
        fixture.jobs.start(job.id)
    with pytest.raises(BatchNotInAnnotation):
        fixture.jobs.mark(job.id, fixture.assets[0], ANNOTATED)
    fixture.close()


def test_no_work_happens_after_the_batch_is_closed(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.COMPLETED)
    fixture.batches.complete(fixture.batch.id)
    assert fixture.batches.get(fixture.batch.id).state is BatchState.COMPLETED

    with pytest.raises(BatchNotInAnnotation):
        fixture.jobs.mark(job.id, fixture.assets[0], SKIPPED)
    # even the no-op: writing into a closed batch is a bug whether or not the
    # value would change, and hearing about it only sometimes would hide it
    with pytest.raises(BatchNotInAnnotation):
        fixture.jobs.mark(job.id, fixture.assets[0], ANNOTATED)
    fixture.close()


# --- a job's own writes leave its assets' progress alone (#302) ---------------


def test_writing_a_job_does_not_put_back_progress_that_moved_since_it_was_read(
    tmp_path: Path,
) -> None:
    """The other half of the lost update, and the one with no race in it.

    `JobService.complete` reads a whole job, changes `state`, and writes it back.
    Before this, that write rebuilt every one of the job's per-asset rows from
    the map the read had returned — so any progress that landed while the
    completion was being decided was silently reverted, with nothing refused
    anywhere.

    Written at the repository rather than through `complete`, because the point
    is that *no* job write touches progress: the entity here still carries the
    stale map, and it is put back verbatim.
    """
    fixture = Fixture(tmp_path)
    job = fixture.open_batch()
    fixture.jobs.start(job.id)
    stale = fixture.jobs.get(job.id)
    assert stale.progress[fixture.assets[0]] is UNANNOTATED

    fixture.jobs.mark(job.id, fixture.assets[0], SKIPPED)
    with fixture.workspace.unit_of_work() as uow:
        uow.annotation_jobs.update(stale)

    assert fixture.jobs.get(job.id).progress[fixture.assets[0]] is SKIPPED
    fixture.close()


def test_a_stale_write_names_where_the_asset_actually_is(tmp_path: Path) -> None:
    """The refusal has to be actionable in one round trip, so it says both states.

    Reached through the port rather than by racing two threads — the deterministic
    reproduction of the race lives in `tests/kernel/test_concurrency.py`, and what
    is asserted here is the sentence, which no scheduler decides.
    """
    fixture = Fixture(tmp_path)
    job = fixture.open_batch()
    fixture.jobs.start(job.id)
    asset = fixture.assets[0]

    with fixture.workspace.unit_of_work() as uow:
        # What another writer's commit leaves behind, from this caller's side:
        # the row moved and nothing told it.
        assert uow.set_asset_progress(job.id, asset, expected=UNANNOTATED, progress=SKIPPED) is None
        assert (
            uow.set_asset_progress(job.id, asset, expected=UNANNOTATED, progress=ANNOTATED)
            is SKIPPED
        )
    fixture.close()


# --- next_pending -------------------------------------------------------------


def test_next_pending_returns_the_batch_order(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    assert [a.id for a in fixture.jobs.next_pending(job.id, 5)] == fixture.assets
    fixture.close()


def test_the_order_is_stored_as_a_position_not_left_to_chance(tmp_path: Path) -> None:
    """Read past the mapper: `position` is what the ordering guarantee rests on.

    Without it the round trip would happen to work, because the whole child
    collection is rewritten on every save — an accident, not a contract.
    """
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    fixture.jobs.mark(job.id, fixture.assets[2], SKIPPED)  # forces a full rewrite

    store = fixture.workspace.metadata_store
    with store.engine.connect() as connection:  # type: ignore[attr-defined]
        stored = connection.execute(
            text(
                "select asset_id, position from annotation_job_asset "
                "where job_id = :job order by position"
            ),
            {"job": job.id.hex},
        ).all()

    assert [UUID(hex=asset_id) for asset_id, _ in stored] == fixture.assets
    assert [position for _, position in stored] == list(range(len(fixture.assets)))
    fixture.close()


def test_next_pending_is_stable_across_calls(tmp_path: Path) -> None:
    """Order is a stored position, so nothing reshuffles between calls."""
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    first = [a.id for a in fixture.jobs.next_pending(job.id, 3)]
    assert [a.id for a in fixture.jobs.next_pending(job.id, 3)] == first

    # marking one in the middle must not disturb the order of the rest
    fixture.jobs.mark(job.id, fixture.assets[1], SKIPPED)
    remaining = [a.id for a in fixture.jobs.next_pending(job.id, 5)]
    assert remaining == [a for a in fixture.assets if a != fixture.assets[1]]
    fixture.close()


@pytest.mark.parametrize(
    "progress", [ANNOTATED, SKIPPED, REVIEW_PENDING, ACCEPTED], ids=lambda s: str(s.value)
)
def test_next_pending_excludes_everything_that_is_not_waiting_to_be_labeled(
    tmp_path: Path, progress: AssetProgress
) -> None:
    """Settled assets are done; review_pending is waiting on a reviewer, not a labeler."""
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    moved = fixture.asset_in(job, progress)
    assert moved not in [a.id for a in fixture.jobs.next_pending(job.id, 5)]
    fixture.close()


def test_next_pending_honours_the_count_and_never_invents_assets(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    assert len(fixture.jobs.next_pending(job.id, 2)) == 2
    assert len(fixture.jobs.next_pending(job.id, 99)) == len(fixture.assets)
    fixture.close()


def test_next_pending_is_empty_once_the_job_is_done(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.COMPLETED)
    assert fixture.jobs.next_pending(job.id, 5) == []
    fixture.close()


@pytest.mark.parametrize("count", [0, -1])
def test_asking_for_no_assets_is_a_bug(tmp_path: Path, count: int) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    with pytest.raises(ValueError, match="must be positive"):
        fixture.jobs.next_pending(job.id, count)
    fixture.close()


# --- aggregation --------------------------------------------------------------


def test_progress_always_carries_every_state_even_the_empty_ones(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    tally = fixture.jobs.job_progress(job.id)

    assert set(tally) == set(AssetProgress)
    assert tally[UNANNOTATED] == len(fixture.assets)
    assert tally[ACCEPTED] == 0
    fixture.close()


def test_progress_adds_up_across_the_jobs_of_a_batch(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, assets=4)
    fixture.batches.approve(fixture.batch.id, BySize(size=2))
    fixture.batches.start(fixture.batch.id)
    first, second = fixture.batches.jobs(fixture.batch.id)
    fixture.jobs.start(first.id)
    fixture.jobs.mark(first.id, fixture.assets[0], ANNOTATED)
    fixture.jobs.start(second.id)
    fixture.jobs.mark(second.id, fixture.assets[2], SKIPPED)

    tally = fixture.jobs.batch_progress(fixture.batch.id)
    assert (tally[ANNOTATED], tally[SKIPPED], tally[UNANNOTATED]) == (1, 1, 2)
    fixture.close()


def test_progress_adds_up_across_the_batches_of_a_project(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, assets=3)
    job = fixture.job_in(AnnotationJobState.IN_PROGRESS)
    fixture.jobs.mark(job.id, fixture.assets[0], ANNOTATED)

    second = fixture.batches.create(fixture.project.id, "second", fixture.assets[:2])
    fixture.batches.approve(second.id)

    tally = fixture.jobs.project_progress(fixture.project.id)
    assert tally[ANNOTATED] == 1
    assert tally[UNANNOTATED] == 4  # 2 left in the first batch, 2 in the second
    fixture.close()


def test_a_project_with_no_batches_reports_all_zeros(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    tally = fixture.jobs.project_progress(fixture.project.id)
    assert tally == dict.fromkeys(AssetProgress, 0)
    fixture.close()


# --- refusals -----------------------------------------------------------------


def test_an_unknown_job_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(JobNotFound, match="no job"):
        fixture.jobs.get(uuid4())
    fixture.close()


def test_a_job_from_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, "one")
    stranger = Fixture(tmp_path, "two")
    theirs = stranger.open_batch()

    with pytest.raises(JobNotFound):
        fixture.jobs.get(theirs.id)
    fixture.close()
    stranger.close()


def test_an_asset_the_job_does_not_carry_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, assets=4)
    fixture.batches.approve(fixture.batch.id, BySize(size=2))
    fixture.batches.start(fixture.batch.id)
    first = fixture.batches.jobs(fixture.batch.id)[0]
    fixture.jobs.start(first.id)

    with pytest.raises(AssetNotInJob, match="fixed"):
        fixture.jobs.mark(first.id, fixture.assets[3], ANNOTATED)
    fixture.close()


def test_aggregation_refuses_an_unknown_batch_or_project(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(BatchNotFound):
        fixture.jobs.batch_progress(uuid4())
    with pytest.raises(ProjectNotFound):
        fixture.jobs.project_progress(uuid4())
    fixture.close()


# --- the loop closes ----------------------------------------------------------


def test_a_batch_reaches_completed_through_its_jobs(tmp_path: Path) -> None:
    """The end-to-end proof that #8 and #9 fit: nothing here reaches past a service."""
    fixture = Fixture(tmp_path, assets=4)
    fixture.batches.approve(fixture.batch.id, BySize(size=2))
    fixture.batches.start(fixture.batch.id)

    for job in fixture.batches.jobs(fixture.batch.id):
        fixture.jobs.start(job.id)
        for asset in fixture.jobs.next_pending(job.id, 99):
            fixture.jobs.mark(job.id, asset.id, ANNOTATED)
        fixture.jobs.complete(job.id)

    assert fixture.batches.complete(fixture.batch.id).state is BatchState.COMPLETED
    assert fixture.jobs.batch_progress(fixture.batch.id)[ANNOTATED] == 4
    fixture.close()


# --- the ladder from a job back to its batch ----------------------------------


def test_a_job_id_alone_resolves_to_the_batch_it_is_a_segment_of(tmp_path: Path) -> None:
    """An AnnotationJob records only its task group, so this is the only route."""
    fixture = Fixture(tmp_path, assets=4)
    fixture.batches.approve(fixture.batch.id, BySize(size=2))
    fixture.batches.start(fixture.batch.id)

    for job in fixture.batches.jobs(fixture.batch.id):
        assert fixture.jobs.batch(job.id).id == fixture.batch.id
    fixture.close()


def test_the_batch_of_an_unknown_job_is_a_missing_job(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(JobNotFound):
        fixture.jobs.batch(uuid4())
    fixture.close()
