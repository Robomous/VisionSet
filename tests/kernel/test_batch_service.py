"""BatchService: the state machine, the pin, and what approval freezes.

No JobService exists yet, so the tests that need a job in a particular state set
it through the unit of work. That is setup, not usage — every batch in here
still moves through the one door.
"""

from __future__ import annotations

from collections.abc import Callable
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from visionset.kernel import (
    AssetNotFound,
    AssetNotInBatch,
    BatchImmutable,
    BatchNotComplete,
    BatchNotEditable,
    BatchNotFound,
    ConfirmationRequired,
    DestructiveSchemaChange,
    EmptyBatch,
    InvalidName,
    InvalidPartition,
    InvalidTransition,
    ProjectNotFound,
    SchemaChangeWouldOrphan,
    SchemaNotFound,
    WorkspaceCorrupt,
)
from visionset.kernel.domain import (
    BATCH_TRANSITIONS,
    REPINNABLE_STATES,
    Annotation,
    AnnotationJobState,
    Asset,
    AssetProgress,
    Batch,
    BatchState,
    BboxGeometry,
    BySegments,
    BySize,
    GeometryType,
    LabelClass,
    PolygonGeometry,
    SingleJob,
)
from visionset.kernel.services import (
    BatchService,
    JobService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)

SIGN = LabelClass(name="sign", geometries=(GeometryType.BBOX,))
LANE = LabelClass(name="lane", geometries=(GeometryType.POLYGON,))


class Fixture:
    """A workspace with one project, one schema version, and some assets."""

    def __init__(self, tmp_path: Path, name: str = "ws", *, assets: int = 4) -> None:
        self.workspace = WorkspaceService.init(tmp_path / name)
        self.projects = ProjectService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.project = self.projects.create(f"{name}-project")
        self.schemas.create_version(self.project.id, [SIGN])
        self.assets = [self._asset(f"{name}-{index}") for index in range(assets)]

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

    def in_state(self, state: BatchState) -> UUID:
        """A batch walked to ``state`` through the real transitions."""
        batch = self.batches.create(self.project.id, f"batch-{state.value}", self.assets)
        if state is BatchState.DRAFT:
            return batch.id
        self.batches.approve(batch.id)
        if state is BatchState.APPROVED:
            return batch.id
        self.batches.start(batch.id)
        if state is BatchState.IN_ANNOTATION:
            return batch.id
        self.finish_jobs(batch.id)
        self.batches.complete(batch.id)
        return batch.id

    def finish_jobs(self, batch_id: UUID) -> None:
        """Mark every job of the batch completed, the way ``JobService`` does."""
        with self.workspace.unit_of_work() as uow:
            for job in self.batches.jobs(batch_id):
                uow.annotation_jobs.update(
                    job.model_copy(update={"state": AnnotationJobState.COMPLETED})
                )

    def close(self) -> None:
        self.workspace.close()


# --- the transition table, swept in full --------------------------------------

#: Every move, mapped to the operation that attempts it.
MOVES = {
    BatchState.APPROVED: lambda fixture, batch_id: fixture.batches.approve(batch_id),
    BatchState.IN_ANNOTATION: lambda fixture, batch_id: fixture.batches.start(batch_id),
    BatchState.COMPLETED: lambda fixture, batch_id: fixture.batches.complete(batch_id),
}


@pytest.mark.parametrize("origin", list(BatchState), ids=lambda s: f"from-{s.value}")
@pytest.mark.parametrize("target", list(MOVES), ids=lambda s: f"to-{s.value}")
def test_the_transition_table_is_the_whole_of_what_is_legal(
    tmp_path: Path, origin: BatchState, target: BatchState
) -> None:
    """Every square of BatchState x BatchState, checked against the table itself.

    Stated this way rather than as a list of allowed pairs, so the test cannot
    drift from ``BATCH_TRANSITIONS`` — it reads it.
    """
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(origin)
    if target is BatchState.COMPLETED and origin is BatchState.IN_ANNOTATION:
        fixture.finish_jobs(batch_id)  # otherwise the derived check refuses first

    if target in BATCH_TRANSITIONS[origin]:
        assert MOVES[target](fixture, batch_id).state is target
    else:
        with pytest.raises(InvalidTransition, match="cannot become"):
            MOVES[target](fixture, batch_id)
        assert fixture.batches.get(batch_id).state is origin
    fixture.close()


def test_a_completed_batch_can_go_nowhere() -> None:
    assert BATCH_TRANSITIONS[BatchState.COMPLETED] == frozenset()


def test_the_refusal_says_where_the_batch_can_actually_go(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.DRAFT)
    with pytest.raises(InvalidTransition, match="can only become approved"):
        fixture.batches.start(batch_id)
    fixture.close()


# --- creating and curating ----------------------------------------------------


def test_a_new_batch_is_a_draft_with_no_pin_and_no_jobs(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    assert (batch.state, batch.schema_version) == (BatchState.DRAFT, None)
    assert fixture.batches.jobs(batch.id) == []
    fixture.close()


def test_a_batch_name_is_normalized_and_never_blank(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    assert fixture.batches.create(fixture.project.id, "  round two  ").name == "round two"
    with pytest.raises(InvalidName, match="batch name"):
        fixture.batches.create(fixture.project.id, "   ")
    fixture.close()


def test_batch_names_need_not_be_unique(tmp_path: Path) -> None:
    """Unlike a project, a batch is an ephemeral work unit — two "round 2" batches
    are a schedule, not a collision."""
    fixture = Fixture(tmp_path)
    first = fixture.batches.create(fixture.project.id, "round 2")
    second = fixture.batches.create(fixture.project.id, "round 2")
    assert first.id != second.id
    assert len(fixture.batches.list(fixture.project.id)) == 2
    fixture.close()


def test_assets_can_be_added_and_removed_while_it_is_a_draft(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets[:2])

    added = fixture.batches.add_assets(batch.id, fixture.assets[2:])
    assert added.batch.asset_ids == fixture.assets
    assert added.changed == tuple(fixture.assets[2:])

    removed = fixture.batches.remove_assets(batch.id, [fixture.assets[0]])
    assert removed.batch.asset_ids == fixture.assets[1:]
    assert removed.changed == (fixture.assets[0],)
    fixture.close()


def test_adding_an_asset_the_batch_already_holds_changes_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    again = fixture.batches.add_assets(batch.id, [fixture.assets[1], fixture.assets[1]])
    assert again.batch.asset_ids == fixture.assets
    # Nothing was written, and that is reported rather than left to be inferred
    # from a membership that happens to look the same as before.
    assert again.changed == ()
    fixture.close()


def test_removing_an_asset_the_batch_does_not_hold_is_a_no_op(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    outcome = fixture.batches.remove_assets(batch.id, [uuid4()])
    assert outcome.batch.asset_ids == fixture.assets
    assert outcome.changed == ()
    fixture.close()


def test_removing_from_a_draft_leaves_no_job_behind_because_there_are_none(
    tmp_path: Path,
) -> None:
    """Why `draft` is the gate, asserted rather than argued in a docstring.

    Removal is safe here precisely because jobs are cut at approval, so a draft
    has nothing downstream describing the asset going away — no partition to
    invalidate, no per-asset progress row to orphan. That is the whole reason the
    membership routes need no reconciliation step, and it is the kind of claim
    that stays true silently until it does not.
    """
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    assert fixture.batches.jobs(batch.id) == []

    fixture.batches.remove_assets(batch.id, [fixture.assets[0]])

    assert fixture.batches.jobs(batch.id) == []
    assert fixture.batches.get(batch.id).asset_ids == fixture.assets[1:]
    fixture.close()


def test_reading_a_batchs_assets_gives_them_in_membership_order(tmp_path: Path) -> None:
    """The read behind "what did that ingest gather" — order is the stored position,
    so a caller reading twice sees one sequence and `add_assets` appends."""
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets[:2])
    fixture.batches.add_assets(batch.id, fixture.assets[2:])

    assert [asset.id for asset in fixture.batches.assets(batch.id)] == fixture.assets
    fixture.close()


def test_an_empty_batch_has_no_assets_rather_than_no_answer(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "empty")
    assert fixture.batches.assets(batch.id) == []
    fixture.close()


def test_an_asset_from_another_project_cannot_join_the_batch(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    stranger = Fixture(tmp_path, "other")
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)

    with pytest.raises(AssetNotFound, match=str(stranger.assets[0])):
        fixture.batches.add_assets(batch.id, [stranger.assets[0]])
    with pytest.raises(AssetNotFound):
        fixture.batches.create(fixture.project.id, "second", [stranger.assets[0]])
    fixture.close()
    stranger.close()


@pytest.mark.parametrize(
    "state",
    [BatchState.APPROVED, BatchState.IN_ANNOTATION, BatchState.COMPLETED],
    ids=lambda s: str(s.value),
)
def test_membership_is_frozen_once_the_batch_leaves_draft(
    tmp_path: Path, state: BatchState
) -> None:
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(state)

    with pytest.raises(BatchNotEditable, match="skipped"):
        fixture.batches.add_assets(batch_id, [fixture.assets[0]])
    with pytest.raises(BatchNotEditable):
        fixture.batches.remove_assets(batch_id, [fixture.assets[0]])
    fixture.close()


# --- approval: the pin and the partition --------------------------------------


def test_approval_pins_the_active_schema_version(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)

    assert fixture.batches.approve(batch.id).schema_version == 2
    fixture.close()


def test_an_additive_version_moves_every_open_pin_onto_it(tmp_path: Path) -> None:
    """#381, and the inversion of the rule that stood before it.

    The pin used to move only when somebody asked. It now follows a version that
    *widens* the contract, across every batch open enough to take one — because a
    wider contract cannot invalidate a label already drawn, so there is nothing for
    the old rule to have been protecting on this path.

    What the old rule was really about is the test below: a schema that **narrows**
    mid-batch would change the rules under work in flight, and that still never
    happens on its own.
    """
    fixture = Fixture(tmp_path)
    approved = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    fixture.batches.approve(approved.id)
    working = fixture.in_state(BatchState.IN_ANNOTATION)

    published = fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])

    assert fixture.batches.get(approved.id).schema_version == 2
    assert fixture.batches.get(working).schema_version == 2
    # Named, not merely moved: a publish that silently caught two batches up is
    # exactly the invisible success this return value exists to prevent.
    assert set(published.advanced_batches) == {approved.id, working}
    fixture.close()


def test_a_narrowing_version_moves_no_pin_at_all(tmp_path: Path) -> None:
    """The half of the old rule that survives, and the whole of the safety argument.

    A narrowing version is the one that would change the rules under work in
    flight, so it never follows on its own — with the flag or without it. The flag
    says *publish this*, never *and drag every open batch across it*; moving a pin
    over a narrowing is still `repin`, one batch at a time, against that batch's
    own labels.
    """
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    fixture.batches.approve(batch.id)

    published = fixture.schemas.create_version(fixture.project.id, [LANE], allow_destructive=True)

    assert fixture.batches.get(batch.id).schema_version == 1
    assert published.advanced_batches == ()
    fixture.close()


def test_a_batch_left_behind_by_a_narrowing_is_not_dragged_across_it_later(
    tmp_path: Path,
) -> None:
    """The defect a browser walk found, and the reason the diff is **per batch**.

    A batch that declined to follow a narrowing is *behind* the active version.
    The next version can then be additive against **active** while being a
    narrowing against **that batch's own pin** — and diffing once against active
    would drag it across the very change it was protected from, leaving the labels
    it holds under a class its pin still declares describing a contract it no
    longer does.

    Here: pinned at v1 with `sign`; v2 drops `sign` for `lane` and the batch
    rightly stays; v3 adds `crossing` to v2 and is additive against active — but
    against v1 it still loses `sign`, so this batch must not move.

    Every earlier test in this file has its batch already on the active version,
    where the two diffs are the same one. That is why none of them could see this.
    """
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    fixture.batches.approve(batch.id)
    assert fixture.batches.get(batch.id).schema_version == 1

    fixture.schemas.create_version(fixture.project.id, [LANE], allow_destructive=True)
    assert fixture.batches.get(batch.id).schema_version == 1

    published = fixture.schemas.create_version(
        fixture.project.id, [LANE, LabelClass(name="crossing", geometry=GeometryType.BBOX)]
    )

    assert published.published.version == 3
    assert published.advanced_batches == ()
    assert fixture.batches.get(batch.id).schema_version == 1
    # And the manual route is still open, which is the whole point of it existing:
    # crossing a narrowing is a decision about *this* batch's labels.
    assert fixture.batches.repin(batch.id, allow_destructive=True).schema_version == 3
    fixture.close()


def test_two_batches_at_different_versions_are_judged_one_at_a_time(tmp_path: Path) -> None:
    """One publish, two answers — which a single diff against active cannot give."""
    fixture = Fixture(tmp_path)
    behind = fixture.batches.create(fixture.project.id, "behind", fixture.assets)
    fixture.batches.approve(behind.id)
    fixture.schemas.create_version(fixture.project.id, [LANE], allow_destructive=True)

    current = fixture.batches.create(fixture.project.id, "current", fixture.assets)
    fixture.batches.approve(current.id)
    assert fixture.batches.get(current.id).schema_version == 2

    published = fixture.schemas.create_version(
        fixture.project.id, [LANE, LabelClass(name="crossing", geometry=GeometryType.BBOX)]
    )

    assert published.advanced_batches == (current.id,)
    assert fixture.batches.get(behind.id).schema_version == 1
    assert fixture.batches.get(current.id).schema_version == 3
    fixture.close()


def test_a_draft_and_a_completed_batch_are_left_where_they_are(tmp_path: Path) -> None:
    """The two states outside `REPINNABLE_STATES`, and they are outside it for opposite reasons.

    A draft has no pin to move — approval takes the active version, which is this
    one anyway. A completed batch's pin is the record of what its work was judged
    against, and rewriting it would rewrite the record rather than the rules.
    """
    fixture = Fixture(tmp_path)
    draft = fixture.in_state(BatchState.DRAFT)
    completed = fixture.in_state(BatchState.COMPLETED)
    pinned = fixture.batches.get(completed).schema_version

    published = fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])

    assert fixture.batches.get(draft).schema_version is None
    assert fixture.batches.get(completed).schema_version == pinned
    assert published.advanced_batches == ()
    # And the draft takes the new version when it is approved, rather than the one
    # that was active when it was created.
    assert fixture.batches.approve(draft).schema_version == 2
    fixture.close()


def test_publishing_the_contract_already_in_force_moves_nothing(tmp_path: Path) -> None:
    """#583's no-op stays a no-op: nothing was written, so nothing follows it.

    Catching a lagging batch up here would give an operation that writes nothing
    an effect, which is the one thing "publishing what is already in force writes
    nothing" cannot mean.
    """
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    fixture.batches.approve(batch.id)

    published = fixture.schemas.create_version(fixture.project.id, [SIGN])

    assert published.published.version == 1
    assert published.advanced_batches == ()
    assert fixture.batches.get(batch.id).schema_version == 1
    fixture.close()


def test_approval_needs_a_schema_to_pin(tmp_path: Path) -> None:
    """Inventing version 1 here would be the second door SchemaService closed."""
    workspace = WorkspaceService.init(tmp_path / "bare")
    project = ProjectService(workspace).create("no-schema")
    batches = BatchService(workspace)
    content_hash = workspace.blob_store.put(BytesIO(b"pixels"))
    with workspace.unit_of_work() as uow:
        asset = uow.assets.add(
            Asset(project_id=project.id, content_hash=content_hash, uri="/tmp/a.png")
        )
    batch = batches.create(project.id, "first", [asset.id])

    with pytest.raises(SchemaNotFound):
        batches.approve(batch.id)
    assert batches.get(batch.id).state is BatchState.DRAFT
    workspace.close()


def test_an_empty_batch_cannot_be_approved(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "empty")
    with pytest.raises(EmptyBatch, match="could never complete"):
        fixture.batches.approve(batch.id)
    fixture.close()


def test_approval_creates_one_task_group_and_one_job_per_segment(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    fixture.batches.approve(batch.id, BySize(size=2))

    with fixture.workspace.unit_of_work() as uow:
        groups = uow.task_groups.list(batch.id)
    jobs = fixture.batches.jobs(batch.id)

    assert len(groups) == 1
    assert len(jobs) == 2
    assert [sorted(job.progress) for job in jobs] == [
        sorted(fixture.assets[:2]),
        sorted(fixture.assets[2:]),
    ]
    fixture.close()


def test_every_asset_starts_unannotated(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    fixture.batches.approve(batch.id)

    progress = {a: p for job in fixture.batches.jobs(batch.id) for a, p in job.progress.items()}
    assert progress == dict.fromkeys(fixture.assets, AssetProgress.UNANNOTATED)
    fixture.close()


def test_the_default_partition_is_a_single_job(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    implied = fixture.batches.create(fixture.project.id, "implied", fixture.assets[:2])
    spelled = fixture.batches.create(fixture.project.id, "spelled", fixture.assets[2:])

    fixture.batches.approve(implied.id)
    fixture.batches.approve(spelled.id, SingleJob())

    assert len(fixture.batches.jobs(implied.id)) == 1
    assert len(fixture.batches.jobs(spelled.id)) == 1
    fixture.close()


def test_explicit_segments_become_the_jobs(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    segments = ((fixture.assets[0],), tuple(fixture.assets[1:]))

    fixture.batches.approve(batch.id, BySegments(segments=segments))

    assert [len(job.progress) for job in fixture.batches.jobs(batch.id)] == [1, 3]
    fixture.close()


def test_a_refused_approval_leaves_no_group_and_no_jobs(tmp_path: Path) -> None:
    """Approval is one transaction: it freezes everything or nothing."""
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)

    with pytest.raises(InvalidPartition):
        fixture.batches.approve(batch.id, BySegments(segments=((fixture.assets[0],),)))

    with fixture.workspace.unit_of_work() as uow:
        assert uow.task_groups.list(batch.id) == []
    assert fixture.batches.jobs(batch.id) == []
    assert fixture.batches.get(batch.id).state is BatchState.DRAFT
    fixture.close()


# --- completion is derived ----------------------------------------------------


@pytest.mark.parametrize(
    "unfinished",
    [AnnotationJobState.PENDING, AnnotationJobState.IN_PROGRESS],
    ids=lambda s: str(s.value),
)
def test_a_batch_cannot_complete_while_a_job_is_outstanding(
    tmp_path: Path, unfinished: AnnotationJobState
) -> None:
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.IN_ANNOTATION)
    fixture.finish_jobs(batch_id)
    with fixture.workspace.unit_of_work() as uow:
        first = fixture.batches.jobs(batch_id)[0]
        uow.annotation_jobs.update(first.model_copy(update={"state": unfinished}))

    with pytest.raises(BatchNotComplete, match="1 of 1 jobs still unfinished"):
        fixture.batches.complete(batch_id)
    assert fixture.batches.get(batch_id).state is BatchState.IN_ANNOTATION
    fixture.close()


def test_a_batch_completes_once_every_job_has(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.IN_ANNOTATION)
    fixture.finish_jobs(batch_id)
    assert fixture.batches.complete(batch_id).state is BatchState.COMPLETED
    fixture.close()


# --- reading and deleting -----------------------------------------------------


def test_batches_are_listed_in_the_order_they_were_created(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    for name in ("first", "second", "third"):
        fixture.batches.create(fixture.project.id, name)
    assert [b.name for b in fixture.batches.list(fixture.project.id)] == [
        "first",
        "second",
        "third",
    ]
    fixture.close()


@pytest.mark.parametrize(
    ("call", "expected", "match"),
    [
        pytest.param(
            lambda fx: fx.batches.get(uuid4()),
            BatchNotFound,
            "no batch",
            id="getting-an-unknown-batch",
        ),
        pytest.param(
            lambda fx: fx.batches.assets(uuid4()),
            BatchNotFound,
            None,
            id="reading-an-unknown-batchs-assets",
        ),
        pytest.param(
            lambda fx: fx.batches.repin(uuid4()),
            BatchNotFound,
            None,
            id="re-pinning-an-unknown-batch",
        ),
        pytest.param(
            lambda fx: fx.batches.list(uuid4()),
            ProjectNotFound,
            None,
            id="listing-the-batches-of-an-unknown-project",
        ),
    ],
)
def test_naming_something_that_does_not_exist_is_refused(
    tmp_path: Path,
    call: Callable[[Fixture], object],
    expected: type[Exception],
    match: str | None,
) -> None:
    """The not-found answers, in one table.

    The last row is the one the table exists for: three of these refuse the batch
    and the fourth refuses the *project*, because listing is scoped by project and
    an unknown one is not an empty listing.
    """
    fixture = Fixture(tmp_path)
    with pytest.raises(expected, match=match):
        call(fixture)
    fixture.close()


def test_a_batch_from_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, "one")
    stranger = Fixture(tmp_path, "two")
    theirs = stranger.batches.create(stranger.project.id, "theirs", stranger.assets)

    with pytest.raises(BatchNotFound):
        fixture.batches.get(theirs.id)
    fixture.close()
    stranger.close()


def test_deleting_a_batch_needs_confirmation(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.APPROVED)
    with pytest.raises(ConfirmationRequired, match="confirm=True"):
        fixture.batches.delete(batch_id)
    assert fixture.batches.get(batch_id).state is BatchState.APPROVED
    fixture.close()


def test_deleting_an_unknown_batch_is_refused_with_or_without_confirmation(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    for confirm in (False, True):
        with pytest.raises(BatchNotFound):
            fixture.batches.delete(uuid4(), confirm=confirm)
    fixture.close()


def test_a_completed_batch_cannot_be_deleted_and_no_flag_lifts_it(tmp_path: Path) -> None:
    """`BATCH_TRANSITIONS` says completed has no exit; delete is not a back door."""
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.COMPLETED)

    for confirm in (False, True):
        with pytest.raises(BatchImmutable, match="completed"):
            fixture.batches.delete(batch_id, confirm=confirm)

    assert fixture.batches.get(batch_id).state is BatchState.COMPLETED
    fixture.close()


@pytest.mark.parametrize("state", [BatchState.DRAFT, BatchState.APPROVED, BatchState.IN_ANNOTATION])
def test_every_other_state_still_deletes(tmp_path: Path, state: BatchState) -> None:
    """The guard is `DELETABLE_STATES`, not a blanket new obstacle."""
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(state)

    fixture.batches.delete(batch_id, confirm=True)

    with pytest.raises(BatchNotFound):
        fixture.batches.get(batch_id)
    fixture.close()


def test_deleting_a_batch_takes_its_groups_and_jobs(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.APPROVED)

    fixture.batches.delete(batch_id, confirm=True)

    with fixture.workspace.unit_of_work() as uow:
        assert uow.task_groups.list(batch_id) == []
    with pytest.raises(BatchNotFound):
        fixture.batches.get(batch_id)
    fixture.close()


def test_deleting_a_batch_leaves_the_annotations_alone(tmp_path: Path) -> None:
    """Annotations hang off assets, not off batches: deleting the unit of work
    must never delete the work."""
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.APPROVED)
    with fixture.workspace.unit_of_work() as uow:
        uow.annotations.add(
            Annotation(
                asset_id=fixture.assets[0],
                label_class="sign",
                schema_version=1,
                geometry=BboxGeometry(x=0, y=0, width=4, height=4),
                provenance="human",
            )
        )

    fixture.batches.delete(batch_id, confirm=True)

    with fixture.workspace.unit_of_work() as uow:
        assert len(uow.annotations.list(fixture.assets[0])) == 1
        assert uow.assets.get(fixture.assets[0]) is not None
    fixture.close()


# --- re-pinning: the one way the pin moves ------------------------------------


def _annotate(fixture: Fixture, asset_id: UUID, label_class: str, version: int) -> None:
    """Put one annotation on an asset, the way the delete tests above do.

    Straight through the unit of work rather than ``AnnotationService``: what
    these tests need is a label sitting under a class, and routing it through the
    service would drag a job and a progress transition in with it.
    """
    geometry = (
        BboxGeometry(x=0, y=0, width=4, height=4)
        if label_class == "sign"
        else PolygonGeometry(points=[(0.0, 0.0), (4.0, 0.0), (4.0, 4.0)])
    )
    with fixture.workspace.unit_of_work() as uow:
        uow.annotations.add(
            Annotation(
                asset_id=asset_id,
                label_class=label_class,
                schema_version=version,
                geometry=geometry,
                provenance="human",
            )
        )


@pytest.mark.parametrize("state", list(BatchState), ids=lambda s: s.value)
def test_repinning_is_legal_exactly_where_the_domain_says_it_is(
    tmp_path: Path, state: BatchState
) -> None:
    """Every BatchState, checked against ``REPINNABLE_STATES`` itself.

    Reads the set rather than restating it, the way the transition sweep above
    reads ``BATCH_TRANSITIONS``, so the test cannot drift from the rule.
    """
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(state)
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])

    if state in REPINNABLE_STATES:
        assert fixture.batches.repin(batch_id).schema_version == 2
    else:
        with pytest.raises(InvalidTransition, match="schema pin cannot move"):
            fixture.batches.repin(batch_id)
        assert fixture.batches.get(batch_id).schema_version == (
            None if state is BatchState.DRAFT else 1
        )
    fixture.close()


def test_a_new_class_re_pins_with_no_flag(tmp_path: Path) -> None:
    """The overwhelmingly common change, and the whole point of the operation."""
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.IN_ANNOTATION)
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])

    repinned = fixture.batches.repin(batch_id)

    assert repinned.schema_version == 2
    assert fixture.batches.get(batch_id).schema_version == 2
    pinned = fixture.schemas.get(fixture.project.id, 2)
    assert [c.name for c in pinned.classes] == ["sign", "lane"]
    fixture.close()


def test_re_pinning_onto_the_version_already_pinned_changes_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.APPROVED)

    before = fixture.batches.get(batch_id)
    assert fixture.batches.repin(batch_id) == before
    assert fixture.batches.get(batch_id) == before
    fixture.close()


def test_a_narrowing_schema_needs_the_flag(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])
    batch_id = fixture.in_state(BatchState.IN_ANNOTATION)
    fixture.schemas.create_version(fixture.project.id, [SIGN], allow_destructive=True)

    with pytest.raises(DestructiveSchemaChange, match="allow_destructive=True"):
        fixture.batches.repin(batch_id)
    assert fixture.batches.get(batch_id).schema_version == 2

    assert fixture.batches.repin(batch_id, allow_destructive=True).schema_version == 3
    fixture.close()


def test_the_flag_does_not_help_when_this_batch_holds_the_labels(tmp_path: Path) -> None:
    """The batch-scoped sibling of ``SchemaChangeWouldOrphan``. No override."""
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])
    batch_id = fixture.in_state(BatchState.IN_ANNOTATION)
    # Version 3 is creatable because nothing is labeled 'lane' yet; the label
    # arrives afterwards, judged against this batch's own pin of 2.
    fixture.schemas.create_version(fixture.project.id, [SIGN], allow_destructive=True)
    _annotate(fixture, fixture.assets[0], "lane", version=2)

    with pytest.raises(SchemaChangeWouldOrphan, match="'lane' \\(1\\)"):
        fixture.batches.repin(batch_id, allow_destructive=True)
    assert fixture.batches.get(batch_id).schema_version == 2
    fixture.close()


def test_a_label_in_another_batch_does_not_block_this_one(tmp_path: Path) -> None:
    """The scope is what makes this different from ``SchemaService``'s refusal.

    That one asks about the whole project, because it is narrowing the project's
    contract. This one asks about one batch, because only labels judged by *this*
    pin are at stake.
    """
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])
    mine = fixture.batches.create(fixture.project.id, "mine", fixture.assets[:2])
    theirs = fixture.batches.create(fixture.project.id, "theirs", fixture.assets[2:])
    fixture.batches.approve(mine.id)
    fixture.batches.approve(theirs.id)
    fixture.schemas.create_version(fixture.project.id, [SIGN], allow_destructive=True)
    _annotate(fixture, fixture.assets[2], "lane", version=2)

    assert fixture.batches.repin(mine.id, allow_destructive=True).schema_version == 3

    with pytest.raises(SchemaChangeWouldOrphan):
        fixture.batches.repin(theirs.id, allow_destructive=True)
    fixture.close()


def test_annotations_already_written_keep_the_version_they_were_stamped_with(
    tmp_path: Path,
) -> None:
    """Releases already mix versions; a re-pin does not rewrite history either."""
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.IN_ANNOTATION)
    _annotate(fixture, fixture.assets[0], "sign", version=1)
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])

    fixture.batches.repin(batch_id)

    with fixture.workspace.unit_of_work() as uow:
        assert [a.schema_version for a in uow.annotations.list(fixture.assets[0])] == [1]
    fixture.close()


def test_a_batch_pinned_to_a_version_that_is_not_stored_is_corruption(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch_id = fixture.in_state(BatchState.APPROVED)
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])
    with fixture.workspace.unit_of_work() as uow:
        batch = uow.batches.get(batch_id)
        assert batch is not None
        uow.batches.update(batch.model_copy(update={"schema_version": 99}))

    with pytest.raises(WorkspaceCorrupt, match="not stored"):
        fixture.batches.repin(batch_id)
    fixture.close()


# --- lineage (audit G4) -------------------------------------------------------


def test_a_batch_records_no_parent_by_default(tmp_path: Path) -> None:
    """``None`` means *not a correction of anything*, which every batch is today.

    It is not "unknown": a batch either was cut from another or was not, and both
    answers are complete. Nothing creates a correction batch yet — the field is
    here first because the alternative is discovering at that point that
    recording it needs a migration.
    """
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)

    assert batch.parent_batch_id is None


def test_lineage_survives_a_round_trip_through_the_store(tmp_path: Path) -> None:
    # Not a foreign key — `batch` carries `batch_asset` children, so it could not
    # be rebuilt to give the column one — which means nothing but this checks it
    # is written and read back.
    fixture = Fixture(tmp_path)
    parent = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    with fixture.workspace.unit_of_work() as uow:
        child = uow.batches.add(
            Batch(
                project_id=fixture.project.id,
                name="correction of first",
                asset_ids=list(fixture.assets),
                parent_batch_id=parent.id,
            )
        )

    read_back = fixture.batches.get(child.id)

    assert read_back.parent_batch_id == parent.id


def test_lineage_is_not_moved_by_the_lifecycle(tmp_path: Path) -> None:
    """A lineage fact is set at creation and never afterwards.

    Approving cuts jobs and pins a schema; starting and completing move the
    state. None of them is a statement about where the batch came from, so none
    of them may touch it.
    """
    fixture = Fixture(tmp_path)
    parent = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    with fixture.workspace.unit_of_work() as uow:
        child = uow.batches.add(
            Batch(
                project_id=fixture.project.id,
                name="correction",
                asset_ids=list(fixture.assets),
                parent_batch_id=parent.id,
            )
        )

    fixture.batches.approve(child.id)
    fixture.batches.start(child.id)

    assert fixture.batches.get(child.id).parent_batch_id == parent.id


def test_an_asset_in_no_batch_is_held_by_nothing(tmp_path: Path) -> None:
    """`[]`, not a refusal — this is a question about membership, not existence.

    Only buildable here: over HTTP every asset arrives through an ingest, and an
    ingest puts what it gathered into a batch whether or not the caller named
    one, so the API can never produce an orphan.
    """
    fixture = Fixture(tmp_path)

    assert fixture.batches.holding(fixture.assets[0]) == []


def test_an_asset_lists_every_batch_that_carries_it_oldest_first(tmp_path: Path) -> None:
    """The membership edge walked backwards — what lineage looks like from an asset."""
    fixture = Fixture(tmp_path)
    first = fixture.batches.create(fixture.project.id, "first", fixture.assets[:2])
    second = fixture.batches.create(fixture.project.id, "second", fixture.assets[:1])

    assert [one.id for one in fixture.batches.holding(fixture.assets[0])] == [
        first.id,
        second.id,
    ]
    # And the asset only in the first is held only by it.
    assert [one.id for one in fixture.batches.holding(fixture.assets[1])] == [first.id]


def test_removing_an_asset_from_a_draft_takes_it_off_the_reverse_lookup(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets[:2])

    fixture.batches.remove_assets(batch.id, [fixture.assets[0]])

    assert fixture.batches.holding(fixture.assets[0]) == []
    assert [one.id for one in fixture.batches.holding(fixture.assets[1])] == [batch.id]


# --- corrections (audit G1, G7) -----------------------------------------------


def _completed(fixture: Fixture, name: str = "first") -> Batch:
    """A batch walked all the way to `completed` — the only state a correction cuts from."""
    batch = fixture.batches.create(fixture.project.id, name, fixture.assets)
    fixture.batches.approve(batch.id)
    (job,) = fixture.batches.jobs(batch.id)
    fixture.batches.start(batch.id)
    jobs = JobService(fixture.workspace)
    jobs.start(job.id)
    for asset_id in fixture.assets:
        jobs.mark(job.id, asset_id, AssetProgress.SKIPPED)
    jobs.complete(job.id)
    return fixture.batches.complete(batch.id)


def test_a_correction_carries_the_parents_whole_membership_by_default(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    parent = _completed(fixture)

    child = fixture.batches.create_correction(parent.id, "round two")

    assert child.asset_ids == parent.asset_ids
    assert child.parent_batch_id == parent.id
    assert child.state is BatchState.DRAFT
    # And the parent has not moved — the whole point of forward-only correction.
    assert fixture.batches.get(parent.id).state is BatchState.COMPLETED


def test_a_correction_may_name_a_subset(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    parent = _completed(fixture)

    child = fixture.batches.create_correction(parent.id, "one frame", fixture.assets[:1])

    assert child.asset_ids == fixture.assets[:1]


def test_a_correction_refuses_an_asset_the_parent_never_carried(tmp_path: Path) -> None:
    """Otherwise the lineage would be a claim about nothing."""
    fixture = Fixture(tmp_path)
    parent = fixture.batches.create(fixture.project.id, "half", fixture.assets[:2])
    fixture.batches.approve(parent.id)
    (job,) = fixture.batches.jobs(parent.id)
    fixture.batches.start(parent.id)
    jobs = JobService(fixture.workspace)
    jobs.start(job.id)
    for asset_id in fixture.assets[:2]:
        jobs.mark(job.id, asset_id, AssetProgress.SKIPPED)
    jobs.complete(job.id)
    fixture.batches.complete(parent.id)

    with pytest.raises(AssetNotInBatch):
        fixture.batches.create_correction(parent.id, "wrong", [fixture.assets[3]])


@pytest.mark.parametrize("state", [BatchState.DRAFT, BatchState.APPROVED, BatchState.IN_ANNOTATION])
def test_an_open_batch_cannot_be_corrected(tmp_path: Path, state: BatchState) -> None:
    """Correcting an open batch is not a correction — it is the work.

    Through `require_state`, so the refusal is the same `InvalidTransition` every
    other named-set gate raises: a caller cannot usefully tell "wrong state for
    this move" from "wrong state for this act".
    """
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "open", fixture.assets)
    if state is not BatchState.DRAFT:
        fixture.batches.approve(batch.id)
    if state is BatchState.IN_ANNOTATION:
        fixture.batches.start(batch.id)

    with pytest.raises(InvalidTransition):
        fixture.batches.create_correction(batch.id, "too soon")


def test_a_correction_pins_the_active_schema_rather_than_the_parents(tmp_path: Path) -> None:
    """The point of correcting under a contract that has moved on.

    Nothing special happens here: the child is an ordinary draft, and approving
    one pins whatever is active. Asserted because it is the behaviour somebody
    would otherwise be tempted to "fix" by copying the parent's pin.
    """
    fixture = Fixture(tmp_path)
    parent = _completed(fixture)
    assert parent.schema_version == 1
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])

    child = fixture.batches.create_correction(parent.id, "round two")
    approved = fixture.batches.approve(child.id)

    assert approved.schema_version == 2
    assert fixture.batches.get(parent.id).schema_version == 1


def test_a_correction_of_a_correction_records_its_own_parent(tmp_path: Path) -> None:
    # Lineage is one hop, not a root pointer: each batch names the one it was cut
    # from, and a reader walks the chain if it wants the origin.
    fixture = Fixture(tmp_path)
    parent = _completed(fixture)
    child = fixture.batches.create_correction(parent.id, "round two")
    fixture.batches.approve(child.id)
    (job,) = fixture.batches.jobs(child.id)
    fixture.batches.start(child.id)
    jobs = JobService(fixture.workspace)
    jobs.start(job.id)
    for asset_id in child.asset_ids:
        jobs.mark(job.id, asset_id, AssetProgress.SKIPPED)
    jobs.complete(job.id)
    fixture.batches.complete(child.id)

    grandchild = fixture.batches.create_correction(child.id, "round three")

    assert grandchild.parent_batch_id == child.id
