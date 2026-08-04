"""DatasetService: the gate work comes through, and the log of what came through it.

`PROMOTABLE_PROGRESS` is checked *against* `SETTLED_PROGRESS` rather than restated,
so a state added to one and forgotten in the other cannot pass quietly. Assets are
walked to a progress state through `JobService`'s real moves, never by writing rows.
"""

from __future__ import annotations

from datetime import UTC
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from visionset.kernel import (
    BatchImmutable,
    BatchNotComplete,
    BatchNotFound,
    DatasetNotFound,
    WorkspaceCorrupt,
)
from visionset.kernel.domain import (
    PROMOTABLE_PROGRESS,
    SETTLED_PROGRESS,
    Annotation,
    AnnotationJob,
    Asset,
    AssetProgress,
    BboxGeometry,
    BySegments,
    Dataset,
    DatasetOperation,
    GeometryType,
    LabelClass,
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

#: The shortest legal walk from ``unannotated`` to each state, as in #7's and #9's tests.
_ROUTES: dict[AssetProgress, tuple[AssetProgress, ...]] = {
    UNANNOTATED: (),
    ANNOTATED: (ANNOTATED,),
    SKIPPED: (SKIPPED,),
    REVIEW_PENDING: (ANNOTATED, REVIEW_PENDING),
    ACCEPTED: (ANNOTATED, REVIEW_PENDING, ACCEPTED),
}


class Fixture:
    """A workspace whose one batch can be walked to ``completed`` and promoted."""

    def __init__(self, tmp_path: Path, name: str = "ws", *, assets: int = 3) -> None:
        self.workspace = WorkspaceService.init(tmp_path / name)
        self.projects = ProjectService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.datasets = DatasetService(self.workspace)
        self.project = self.projects.create(f"{name}-project")
        self.schemas.create_version(self.project.id, [SIGN])
        self.assets = [self._asset(f"{name}-{index}") for index in range(assets)]
        self.batch = self.batches.create(self.project.id, "first", self.assets)

    @property
    def dataset(self) -> Dataset:
        return self.projects.get_dataset(self.project.id)

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

    def working(self, partition: BySegments | None = None) -> list[AnnotationJob]:
        """Approve, open the batch, and start every job: work can happen."""
        self.batches.approve(self.batch.id, partition)
        jobs = self.batches.jobs(self.batch.id)
        self.batches.start(self.batch.id)
        for job in jobs:
            self.jobs.start(job.id)
        return jobs

    def settle(self, job: AnnotationJob, asset_id: UUID, progress: AssetProgress) -> None:
        """Walk one asset to ``progress`` through JobService's real moves."""
        for step in _ROUTES[progress]:
            self.jobs.mark(job.id, asset_id, step)

    def completed(self, *progress: AssetProgress) -> list[AnnotationJob]:
        """One job over the whole batch, each asset settled as named, batch closed."""
        (job,) = self.working()
        for asset_id, state in zip(self.assets, progress, strict=True):
            self.settle(job, asset_id, state)
        self.jobs.complete(job.id)
        self.batches.complete(self.batch.id)
        return [job]

    def member_ids(self) -> list[UUID]:
        return [asset.id for asset in self.datasets.assets(self.dataset.id)]

    def close(self) -> None:
        self.workspace.close()


def _box(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="sign",
        schema_version=1,
        geometry=BboxGeometry(x=1.0, y=2.0, width=30.0, height=40.0),
        provenance="human",
    )


# --- the domain rule ----------------------------------------------------------


def test_every_promotable_state_is_one_that_does_not_block_completion() -> None:
    """Promotion only happens from a completed batch, so the reverse is unreachable.

    Read as a subset check rather than as two restated literals: a state added to
    ``SETTLED_PROGRESS`` and forgotten here is fine, but the other way round would
    declare a state promotable that no completed batch could ever hold.
    """
    assert PROMOTABLE_PROGRESS <= SETTLED_PROGRESS


def test_skipped_is_the_one_settled_state_that_is_not_promotable() -> None:
    assert SKIPPED not in PROMOTABLE_PROGRESS
    assert PROMOTABLE_PROGRESS | {SKIPPED} == SETTLED_PROGRESS


# --- the promotion gate -------------------------------------------------------


@pytest.mark.parametrize("stop_at", ["draft", "approved", "in_annotation"])
def test_promoting_a_batch_that_is_not_completed_raises(tmp_path: Path, stop_at: str) -> None:
    fixture = Fixture(tmp_path)
    if stop_at != "draft":
        fixture.batches.approve(fixture.batch.id)
    if stop_at == "in_annotation":
        fixture.batches.start(fixture.batch.id)

    with pytest.raises(BatchNotComplete, match=stop_at):
        fixture.datasets.promote(fixture.batch.id)
    assert fixture.member_ids() == []
    fixture.close()


def test_a_completed_batch_promotes_its_annotated_assets(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)

    promoted = fixture.datasets.promote(fixture.batch.id)

    assert [asset.id for asset in promoted] == fixture.assets
    assert fixture.member_ids() == fixture.assets
    fixture.close()


def test_a_skipped_asset_is_left_behind(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, SKIPPED, ANNOTATED)

    fixture.datasets.promote(fixture.batch.id)

    assert fixture.member_ids() == [fixture.assets[0], fixture.assets[2]]
    fixture.close()


def test_an_accepted_asset_is_promoted(tmp_path: Path) -> None:
    """Review is optional in M1, so both ends of the settled-and-wanted range count."""
    fixture = Fixture(tmp_path)
    fixture.completed(ACCEPTED, SKIPPED, ANNOTATED)

    fixture.datasets.promote(fixture.batch.id)

    assert fixture.member_ids() == [fixture.assets[0], fixture.assets[2]]
    fixture.close()


def test_a_batch_of_nothing_but_skips_promotes_nothing_and_logs_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(SKIPPED, SKIPPED, SKIPPED)

    assert fixture.datasets.promote(fixture.batch.id) == []
    assert fixture.member_ids() == []
    assert fixture.datasets.changes(fixture.dataset.id) == []
    fixture.close()


def test_promoting_brings_the_annotations_without_a_membership_row_of_their_own(
    tmp_path: Path,
) -> None:
    """A label hangs off its asset, so admitting the asset admits what was drawn."""
    fixture = Fixture(tmp_path)
    (job,) = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    for asset_id in fixture.assets[1:]:
        fixture.settle(job, asset_id, ANNOTATED)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(fixture.batch.id)

    (promoted, *_) = fixture.datasets.promote(fixture.batch.id)

    assert promoted.id == fixture.assets[0]
    assert fixture.annotations.get(stored.id) == stored
    fixture.close()


# --- idempotency --------------------------------------------------------------


def test_promoting_the_same_batch_twice_adds_nothing_the_second_time(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)

    assert fixture.datasets.promote(fixture.batch.id) == []
    assert fixture.member_ids() == fixture.assets
    fixture.close()


def test_a_promotion_that_changes_nothing_writes_no_log_entry(tmp_path: Path) -> None:
    """The log records mutations, not calls."""
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    fixture.datasets.promote(fixture.batch.id)

    assert len(fixture.datasets.changes(fixture.dataset.id)) == 1
    fixture.close()


def test_promoting_an_unrelated_batch_leaves_a_curators_removal_alone(tmp_path: Path) -> None:
    """Promotion is scoped to its own batch: it never reasons about anybody else's."""
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[1])

    elsewhere = fixture.batches.create(fixture.project.id, "second", [fixture.assets[2]])
    fixture.batches.approve(elsewhere.id)
    (job,) = fixture.batches.jobs(elsewhere.id)
    fixture.batches.start(elsewhere.id)
    fixture.jobs.start(job.id)
    fixture.settle(job, fixture.assets[2], ANNOTATED)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(elsewhere.id)

    assert fixture.datasets.promote(elsewhere.id) == []
    assert fixture.member_ids() == [fixture.assets[0], fixture.assets[2]]
    fixture.close()


# --- ordering -----------------------------------------------------------------


def test_membership_follows_the_batch_order_not_the_partition_order(tmp_path: Path) -> None:
    """A segment's turn to be walked must not decide how the trunk reads."""
    fixture = Fixture(tmp_path, assets=4)
    first, second, third, fourth = fixture.assets
    # Segments deliberately out of the batch's own order.
    jobs = fixture.working(BySegments(segments=((third, fourth), (first, second))))
    for job in jobs:
        for asset_id in job.progress:
            fixture.settle(job, asset_id, ANNOTATED)
        fixture.jobs.complete(job.id)
    fixture.batches.complete(fixture.batch.id)

    fixture.datasets.promote(fixture.batch.id)

    assert fixture.member_ids() == [first, second, third, fourth]
    fixture.close()


def test_a_second_batch_appends_rather_than_reshuffles(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, SKIPPED)
    fixture.datasets.promote(fixture.batch.id)

    later = fixture.batches.create(fixture.project.id, "second", [fixture.assets[2]])
    fixture.batches.approve(later.id)
    (job,) = fixture.batches.jobs(later.id)
    fixture.batches.start(later.id)
    fixture.jobs.start(job.id)
    fixture.settle(job, fixture.assets[2], ANNOTATED)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(later.id)

    fixture.datasets.promote(later.id)

    assert fixture.member_ids() == fixture.assets
    fixture.close()


# --- removal ------------------------------------------------------------------


def test_removing_a_member_takes_it_out_and_says_so(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)

    assert fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[1]) is True
    assert fixture.member_ids() == [fixture.assets[0], fixture.assets[2]]
    fixture.close()


def test_removing_something_that_is_not_a_member_is_a_no_op(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, SKIPPED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    before = fixture.datasets.changes(fixture.dataset.id)

    assert fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[1]) is False
    assert fixture.datasets.remove_asset(fixture.dataset.id, uuid4()) is False
    assert fixture.datasets.changes(fixture.dataset.id) == before
    fixture.close()


def test_removal_takes_membership_and_nothing_else(tmp_path: Path) -> None:
    """The asset, its annotations and its blob all outlive the curation."""
    fixture = Fixture(tmp_path)
    (job,) = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    for asset_id in fixture.assets[1:]:
        fixture.settle(job, asset_id, ANNOTATED)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(fixture.batch.id)
    fixture.datasets.promote(fixture.batch.id)

    fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[0])

    with fixture.workspace.unit_of_work() as uow:
        asset = uow.assets.get(fixture.assets[0])
    assert asset is not None
    assert fixture.workspace.blob_store.exists(asset.content_hash)
    assert fixture.annotations.get(stored.id) == stored
    fixture.close()


def test_a_removed_asset_can_be_promoted_back_by_its_batch(tmp_path: Path) -> None:
    """Promotion is a union against current membership; it has no memory of removals.

    The batch is still `completed`, so re-promoting is the documented way back —
    and it appends rather than restoring the asset to where it used to sit,
    because membership order is the order things arrived.
    """
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[0])

    (again,) = fixture.datasets.promote(fixture.batch.id)

    assert again.id == fixture.assets[0]
    assert fixture.member_ids() == [fixture.assets[1], fixture.assets[2], fixture.assets[0]]
    fixture.close()


# --- the change log -----------------------------------------------------------


def test_a_promotion_logs_the_batch_and_then_the_assets(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, SKIPPED, ANNOTATED)

    fixture.datasets.promote(fixture.batch.id, actor="ana")

    (entry,) = fixture.datasets.changes(fixture.dataset.id)
    assert entry.operation == DatasetOperation.PROMOTE
    assert entry.subject_ids == [fixture.batch.id, fixture.assets[0], fixture.assets[2]]
    assert entry.actor == "ana"
    assert entry.dataset_id == fixture.dataset.id
    fixture.close()


def test_a_removal_logs_the_one_asset(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)

    fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[1], actor="ana")

    _, entry = fixture.datasets.changes(fixture.dataset.id)
    assert entry.operation == DatasetOperation.REMOVE_ASSET
    assert entry.subject_ids == [fixture.assets[1]]
    assert entry.actor == "ana"
    fixture.close()


def test_an_actor_nobody_supplied_is_recorded_as_absent(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)

    (entry,) = fixture.datasets.changes(fixture.dataset.id)
    assert entry.actor is None
    fixture.close()


def test_the_log_accumulates_oldest_first_and_is_never_rewritten(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[0])
    fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[1])
    fixture.datasets.promote(fixture.batch.id)

    operations = [entry.operation for entry in fixture.datasets.changes(fixture.dataset.id)]

    assert operations == [
        DatasetOperation.PROMOTE,
        DatasetOperation.REMOVE_ASSET,
        DatasetOperation.REMOVE_ASSET,
        DatasetOperation.PROMOTE,
    ]
    fixture.close()


def test_a_dataset_nobody_has_promoted_into_has_an_empty_log(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    assert fixture.datasets.changes(fixture.dataset.id) == []
    assert fixture.datasets.assets(fixture.dataset.id) == []
    fixture.close()


def test_the_log_survives_a_close_and_a_reopen(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, SKIPPED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id, actor="ana")
    fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[0])
    root, dataset_id, assets = fixture.workspace.root, fixture.dataset.id, fixture.assets
    before = fixture.datasets.changes(dataset_id)
    fixture.close()

    reopened = WorkspaceService.open(root)
    datasets = DatasetService(reopened)

    assert datasets.changes(dataset_id) == before
    assert [asset.id for asset in datasets.assets(dataset_id)] == [assets[2]]
    reopened.close()


def test_a_stored_timestamp_comes_back_timezone_aware(tmp_path: Path) -> None:
    """SQLite has no ``DATETIME`` with a zone, so the mapper's ISO round trip matters."""
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    root, dataset_id = fixture.workspace.root, fixture.dataset.id
    fixture.close()

    reopened = WorkspaceService.open(root)
    (entry,) = DatasetService(reopened).changes(dataset_id)

    assert entry.occurred_at.tzinfo is not None
    assert entry.occurred_at.utcoffset() == UTC.utcoffset(None)
    reopened.close()


# --- what the trunk does not depend on ----------------------------------------


def test_a_batch_that_has_promoted_can_no_longer_be_deleted_at_all(tmp_path: Path) -> None:
    """The trunk's provenance is structurally safe, not merely well behaved.

    Promotion needs a ``completed`` batch and a completed batch is not deletable,
    so the batch a change-log entry names is always still there to be read.
    """
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)

    with pytest.raises(BatchImmutable):
        fixture.batches.delete(fixture.batch.id, confirm=True)

    assert fixture.member_ids() == fixture.assets
    fixture.close()


def test_deleting_some_other_batch_leaves_the_trunk_and_its_log_alone(tmp_path: Path) -> None:
    """Members hang off the dataset and the asset, never off a unit of work.

    A second batch over the same assets, because the batch that *promoted* them
    can no longer be deleted — which is the test above.
    """
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    second = fixture.batches.create(fixture.project.id, "second", fixture.assets)

    fixture.batches.delete(second.id, confirm=True)

    assert fixture.member_ids() == fixture.assets
    assert len(fixture.datasets.changes(fixture.dataset.id)) == 1
    fixture.close()


# --- scoping ------------------------------------------------------------------


def test_a_dataset_id_that_is_not_stored_reads_as_missing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(DatasetNotFound):
        fixture.datasets.get(uuid4())
    fixture.close()


def test_another_workspaces_dataset_reads_as_missing(tmp_path: Path) -> None:
    mine, theirs = Fixture(tmp_path, "mine"), Fixture(tmp_path, "theirs")

    with pytest.raises(DatasetNotFound):
        mine.datasets.get(theirs.dataset.id)
    with pytest.raises(DatasetNotFound):
        mine.datasets.remove_asset(theirs.dataset.id, theirs.assets[0])

    mine.close()
    theirs.close()


def test_another_workspaces_batch_reads_as_missing(tmp_path: Path) -> None:
    mine, theirs = Fixture(tmp_path, "mine"), Fixture(tmp_path, "theirs")
    theirs.completed(ANNOTATED, ANNOTATED, ANNOTATED)

    with pytest.raises(BatchNotFound):
        mine.datasets.promote(theirs.batch.id)

    mine.close()
    theirs.close()


def test_the_dataset_a_project_owns_is_the_one_promotion_fills(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)

    dataset = fixture.projects.get_dataset(fixture.project.id)

    assert fixture.datasets.get(dataset.id) == dataset
    assert [asset.id for asset in fixture.datasets.assets(dataset.id)] == fixture.assets
    fixture.close()


def test_a_member_whose_asset_vanished_is_corruption_not_a_short_dataset(
    tmp_path: Path,
) -> None:
    """`dataset_member.asset_id` cascades, so this needs the guarantee switched off.

    Which is the point: a dataset that quietly holds less than it says would build a
    Release that is short, with nothing anywhere saying why.
    """
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    dataset_id = fixture.dataset.id

    store = fixture.workspace.metadata_store
    with store.engine.begin() as connection:  # type: ignore[attr-defined]
        connection.execute(text("PRAGMA foreign_keys = OFF"))
        connection.execute(
            text(
                "INSERT INTO dataset_member (id, dataset_id, asset_id) "
                "VALUES (:id, :dataset_id, :asset_id)"
            ),
            {"id": uuid4().hex, "dataset_id": dataset_id.hex, "asset_id": uuid4().hex},
        )

    with pytest.raises(WorkspaceCorrupt, match="not stored"):
        fixture.datasets.assets(dataset_id)
    fixture.close()


# --- stats: what the trunk holds, counted -------------------------------------


def test_an_empty_trunk_counts_zero_of_everything(tmp_path: Path) -> None:
    """A project nobody has promoted into is the ordinary starting state."""
    fixture = Fixture(tmp_path)
    stats = fixture.datasets.stats(fixture.dataset.id)

    assert stats.dataset_id == fixture.dataset.id
    assert (stats.asset_count, stats.annotated_asset_count, stats.annotation_count) == (0, 0, 0)
    assert stats.per_class == ()
    fixture.close()


def test_stats_count_the_members_and_their_labels(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    (job,) = fixture.working()
    for asset_id in fixture.assets:
        fixture.annotations.add(job.id, [_box(asset_id)])
    fixture.jobs.complete(job.id)
    fixture.batches.complete(fixture.batch.id)
    fixture.datasets.promote(fixture.batch.id)

    stats = fixture.datasets.stats(fixture.dataset.id)

    assert stats.asset_count == 3
    assert stats.annotated_asset_count == 3
    assert stats.annotation_count == 3
    assert [(count.label_class, count.annotations, count.assets) for count in stats.per_class] == [
        ("sign", 3, 1 + 1 + 1)
    ]
    fixture.close()


def test_an_unlabeled_member_counts_as_an_asset_and_not_as_an_annotated_one(
    tmp_path: Path,
) -> None:
    """A promoted asset carrying no labels is legitimate — only a release of zero refuses."""
    fixture = Fixture(tmp_path)
    (job,) = fixture.working()
    fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    for asset_id in fixture.assets[1:]:
        fixture.jobs.mark(job.id, asset_id, ANNOTATED)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(fixture.batch.id)
    fixture.datasets.promote(fixture.batch.id)

    stats = fixture.datasets.stats(fixture.dataset.id)

    assert stats.asset_count == 3
    assert stats.annotated_asset_count == 1
    assert stats.annotation_count == 1
    fixture.close()


def test_the_two_per_class_numbers_tell_spread_apart_from_volume(tmp_path: Path) -> None:
    """Four boxes on one asset and four across four are the same total, not the same data."""
    fixture = Fixture(tmp_path)
    (job,) = fixture.working()
    crowded = fixture.assets[0]
    fixture.annotations.add(job.id, [_box(crowded) for _ in range(4)])
    for asset_id in fixture.assets[1:]:
        fixture.jobs.mark(job.id, asset_id, ANNOTATED)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(fixture.batch.id)
    fixture.datasets.promote(fixture.batch.id)

    (count,) = fixture.datasets.stats(fixture.dataset.id).per_class

    assert (count.annotations, count.assets) == (4, 1)
    fixture.close()


def test_per_class_counts_come_back_in_class_name_order(tmp_path: Path) -> None:
    """Canonical ordering belongs to the artifact, not to whatever the walk visited first."""
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(
        fixture.project.id,
        [SIGN, LabelClass(name="alpha", geometry=GeometryType.BBOX)],
        allow_destructive=True,
    )
    (job,) = fixture.working()
    fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    fixture.annotations.add(
        job.id,
        [
            Annotation(
                asset_id=fixture.assets[1],
                label_class="alpha",
                schema_version=1,
                geometry=BboxGeometry(x=0.0, y=0.0, width=5.0, height=5.0),
                provenance="human",
            )
        ],
    )
    fixture.jobs.mark(job.id, fixture.assets[2], ANNOTATED)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(fixture.batch.id)
    fixture.datasets.promote(fixture.batch.id)

    stats = fixture.datasets.stats(fixture.dataset.id)

    assert [count.label_class for count in stats.per_class] == ["alpha", "sign"]
    fixture.close()


def test_a_class_nobody_used_is_absent_from_the_counts(tmp_path: Path) -> None:
    """Which classes exist is a fact about the schema, read from the schema."""
    fixture = Fixture(tmp_path)
    fixture.completed(ANNOTATED, ANNOTATED, ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)

    assert fixture.datasets.stats(fixture.dataset.id).per_class == ()
    fixture.close()


def test_removing_an_asset_takes_its_labels_out_of_the_counts(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    (job,) = fixture.working()
    for asset_id in fixture.assets:
        fixture.annotations.add(job.id, [_box(asset_id)])
    fixture.jobs.complete(job.id)
    fixture.batches.complete(fixture.batch.id)
    fixture.datasets.promote(fixture.batch.id)
    fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[0])

    stats = fixture.datasets.stats(fixture.dataset.id)

    assert (stats.asset_count, stats.annotation_count) == (2, 2)
    fixture.close()


def test_stats_of_an_unknown_dataset_are_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(DatasetNotFound):
        fixture.datasets.stats(uuid4())
    fixture.close()


# --- who is in the trunk, asked cheaply ---------------------------------------
#
# `member_asset_ids` exists because promotion was unobservable: the batch stays
# `completed`, so nothing on a batch read moved when its assets entered the
# dataset, and three different outcomes looked identical to a client. The wire's
# `promoted_asset_count` is an intersection against this set.


def test_an_unpromoted_dataset_has_no_members(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    assert fixture.datasets.member_asset_ids(fixture.dataset.id) == frozenset()


def test_the_ids_are_exactly_what_promotion_put_there(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.completed(AssetProgress.ANNOTATED, AssetProgress.SKIPPED, AssetProgress.ANNOTATED)
    promoted = fixture.datasets.promote(fixture.batch.id)

    ids = fixture.datasets.member_asset_ids(fixture.dataset.id)

    assert ids == {asset.id for asset in promoted}
    # And the skipped one is genuinely out — `PROMOTABLE_PROGRESS` excludes it,
    # which is the whole reason a count of 2 over a batch of 3 is not a failure.
    assert fixture.assets[1] not in ids


def test_it_answers_the_same_set_assets_does_without_resolving_them(tmp_path: Path) -> None:
    # The cheap half of `assets`, and it has to stay the same answer: two walks of
    # `dataset_member` that disagree is exactly what putting both beside each
    # other is meant to prevent.
    fixture = Fixture(tmp_path)
    fixture.completed(AssetProgress.ANNOTATED, AssetProgress.ANNOTATED, AssetProgress.ACCEPTED)
    fixture.datasets.promote(fixture.batch.id)

    assert fixture.datasets.member_asset_ids(fixture.dataset.id) == {
        asset.id for asset in fixture.datasets.assets(fixture.dataset.id)
    }


def test_a_removed_asset_leaves_the_set(tmp_path: Path) -> None:
    # Current membership, never a promotion log. "Is my work in the dataset" is a
    # question about now, and a curator taking something out has answered it.
    fixture = Fixture(tmp_path)
    fixture.completed(AssetProgress.ANNOTATED, AssetProgress.ANNOTATED, AssetProgress.ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    fixture.datasets.remove_asset(fixture.dataset.id, fixture.assets[0])

    ids = fixture.datasets.member_asset_ids(fixture.dataset.id)

    assert fixture.assets[0] not in ids
    assert len(ids) == 2


def test_promoting_twice_does_not_double_the_membership(tmp_path: Path) -> None:
    # Promotion is a union, so the second press moves nothing — which is the
    # outcome a client could not tell from a failure, and the one this set makes
    # reportable.
    fixture = Fixture(tmp_path)
    fixture.completed(AssetProgress.ANNOTATED, AssetProgress.ANNOTATED, AssetProgress.ANNOTATED)
    fixture.datasets.promote(fixture.batch.id)
    first = fixture.datasets.member_asset_ids(fixture.dataset.id)

    again = fixture.datasets.promote(fixture.batch.id)

    assert again == []
    assert fixture.datasets.member_asset_ids(fixture.dataset.id) == first


def test_an_unknown_dataset_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(DatasetNotFound):
        fixture.datasets.member_asset_ids(uuid4())
