"""BatchService: the state machine, the pin, and what approval freezes.

No JobService exists yet, so the tests that need a job in a particular state set
it through the unit of work. That is setup, not usage — every batch in here
still moves through the one door.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from visionset.kernel import (
    AssetNotFound,
    BatchNotComplete,
    BatchNotEditable,
    BatchNotFound,
    ConfirmationRequired,
    EmptyBatch,
    InvalidName,
    InvalidPartition,
    InvalidTransition,
    ProjectNotFound,
    SchemaNotFound,
)
from visionset.kernel.domain import (
    BATCH_TRANSITIONS,
    Annotation,
    AnnotationJobState,
    Asset,
    AssetProgress,
    BatchState,
    BboxGeometry,
    BySegments,
    BySize,
    GeometryType,
    LabelClass,
    SingleJob,
)
from visionset.kernel.services import (
    BatchService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)

SIGN = LabelClass(name="sign", geometry=GeometryType.BBOX)
LANE = LabelClass(name="lane", geometry=GeometryType.POLYGON)


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
        """Mark every job of the batch completed, the way #9 eventually will."""
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
    assert added.asset_ids == fixture.assets

    removed = fixture.batches.remove_assets(batch.id, [fixture.assets[0]])
    assert removed.asset_ids == fixture.assets[1:]
    fixture.close()


def test_adding_an_asset_the_batch_already_holds_changes_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    again = fixture.batches.add_assets(batch.id, [fixture.assets[1], fixture.assets[1]])
    assert again.asset_ids == fixture.assets
    fixture.close()


def test_removing_an_asset_the_batch_does_not_hold_is_a_no_op(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    assert fixture.batches.remove_assets(batch.id, [uuid4()]).asset_ids == fixture.assets
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


def test_a_later_schema_version_does_not_move_an_existing_pin(tmp_path: Path) -> None:
    """A schema that evolved mid-batch would change the rules under work in flight."""
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.assets)
    fixture.batches.approve(batch.id)

    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE])

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


def test_an_unknown_batch_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(BatchNotFound, match="no batch"):
        fixture.batches.get(uuid4())
    fixture.close()


def test_a_batch_from_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, "one")
    stranger = Fixture(tmp_path, "two")
    theirs = stranger.batches.create(stranger.project.id, "theirs", stranger.assets)

    with pytest.raises(BatchNotFound):
        fixture.batches.get(theirs.id)
    fixture.close()
    stranger.close()


def test_listing_the_batches_of_an_unknown_project_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(ProjectNotFound):
        fixture.batches.list(uuid4())
    fixture.close()


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
