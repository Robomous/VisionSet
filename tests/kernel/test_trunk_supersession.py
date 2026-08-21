"""Trunk supersession: what the dataset projects when a correction re-annotates.

Audit G5, settled 2026-08 — **asset-level replacement, with corrections seeded on
approval**. The policy is one sentence with two halves, and every test here is one
of them made falsifiable:

- the trunk projects an asset's *whole current annotation set*, one set per asset
  and never one per round, so a correction replaces rather than accumulates; and
- a batch cut over an already-labeled asset opens on those labels and records the
  asset as ``annotated``, so replacement is never data loss for what nobody
  touched.

The reason there is no supersession *machinery* to test is the finding this module
exists to pin: an ``Annotation`` hangs off its ``asset_id`` and nothing else, so
the correction round and the promoted round write into the same set by
construction. These tests therefore assert the *observable* policy — what a reader
of the trunk sees — rather than an implementation that would be free to drift from
it. Deleting the ``_already_labeled`` call in ``BatchService.approve``, or making
``initial_progress`` answer ``UNANNOTATED`` unconditionally, is what turns the
seeding half red.

The sibling question, **F14** (one asset in several *ordinary* batches, and whose
progress it then has), is deliberately still open and nothing here decides it: this
module is about what promotion writes, not about how two batches coordinate.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from visionset.kernel.domain import (
    WRITABLE_PROGRESS,
    Annotation,
    AnnotationJob,
    Asset,
    AssetProgress,
    BboxGeometry,
    GeometryType,
    LabelClass,
    SplitRecipe,
    initial_progress,
    progress_after_annotating,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    WorkspaceService,
)

SIGN = LabelClass(name="sign", geometries=(GeometryType.BBOX,))

UNANNOTATED = AssetProgress.UNANNOTATED
ANNOTATED = AssetProgress.ANNOTATED
PRE_LABELED = AssetProgress.PRE_LABELED
SKIPPED = AssetProgress.SKIPPED

ALL_TRAIN = SplitRecipe(train=1.0, val=0.0, test=0.0)


class Fixture:
    """A project whose batches can be walked to ``completed`` and promoted.

    Deliberately not ``test_dataset_service.py``'s ``Fixture``: that one owns a
    single batch, and every question here needs a *second* batch over assets the
    first one already labeled.
    """

    def __init__(self, tmp_path: Path, *, assets: int = 2) -> None:
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        self.projects = ProjectService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.datasets = DatasetService(self.workspace)
        self.releases = ReleaseService(self.workspace)
        self.project = self.projects.create("p")
        self.schemas.create_version(self.project.id, [SIGN])
        self.assets = [self._asset(f"asset-{index}") for index in range(assets)]

    @property
    def dataset_id(self) -> UUID:
        return self.projects.get_dataset(self.project.id).id

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

    def open_batch(self, name: str, asset_ids: list[UUID]) -> AnnotationJob:
        """A batch over those assets, approved and started, with its one job open."""
        batch = self.batches.create(self.project.id, name, asset_ids)
        return self.opened(batch.id)

    def correction(self, parent_id: UUID, name: str, asset_ids: list[UUID]) -> AnnotationJob:
        """A correction of ``parent_id``, approved and started, with its job open."""
        child = self.batches.create_correction(parent_id, name, asset_ids)
        return self.opened(child.id)

    def opened(self, batch_id: UUID) -> AnnotationJob:
        self.batches.approve(batch_id)
        (job,) = self.batches.jobs(batch_id)
        self.batches.start(batch_id)
        self.jobs.start(job.id)
        return job

    def batch_of(self, job: AnnotationJob) -> UUID:
        return self.jobs.batch(job.id).id

    def finish(self, job: AnnotationJob) -> UUID:
        """Settle every asset of the job, complete it and its batch, return the batch."""
        for asset_id, progress in self.jobs.get(job.id).progress.items():
            if progress is UNANNOTATED:
                self.jobs.mark(job.id, asset_id, ANNOTATED)
        self.jobs.complete(job.id)
        batch_id = self.batch_of(job)
        self.batches.complete(batch_id)
        return batch_id

    def progress_of(self, job: AnnotationJob, asset_id: UUID) -> AssetProgress:
        return self.jobs.get(job.id).progress[asset_id]

    def trunk_labels(self, asset_id: UUID) -> set[str]:
        """The label classes the trunk projects for one asset, read as a curator.

        Through ``DatasetService.assets`` and the annotations hanging off them —
        the same two reads ``ReleaseService`` makes when it cuts a manifest — so
        a membership row that went missing shows up here as an empty answer
        rather than as a passing test about annotations nobody can reach.
        """
        members = {asset.id for asset in self.datasets.assets(self.dataset_id)}
        if asset_id not in members:
            return set()
        with self.workspace.unit_of_work() as uow:
            return {annotation.label_class for annotation in uow.annotations.list(asset_id)}

    def close(self) -> None:
        self.workspace.close()


def _box(asset_id: UUID, label_class: str = "sign", *, x: float = 0.0) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class=label_class,
        schema_version=1,
        geometry=BboxGeometry(x=x, y=0.0, width=10.0, height=10.0),
        provenance="human",
    )


# --- the domain rule ----------------------------------------------------------


def test_an_asset_with_labels_starts_annotated_and_one_without_starts_unannotated() -> None:
    assert initial_progress(has_annotations=True) is ANNOTATED
    assert initial_progress(has_annotations=False) is UNANNOTATED


def test_an_asset_whose_every_label_is_a_models_starts_pre_labeled() -> None:
    """Nobody judged those labels, so a new batch must not open them promotable."""
    assert initial_progress(has_annotations=True, judged=False) is PRE_LABELED
    assert initial_progress(has_annotations=False, judged=False) is UNANNOTATED


def test_where_a_model_only_asset_starts_is_where_an_unjudged_first_label_would_land_it() -> None:
    started = initial_progress(has_annotations=True, judged=False)
    assert started is progress_after_annotating(UNANNOTATED, has_annotations=True, judged=False)


def test_where_an_asset_starts_is_where_annotating_a_fresh_one_would_land_it() -> None:
    """The two rules must agree, or an asset's history would decide its progress.

    ``progress_after_annotating`` moves a fresh asset to wherever its first label
    puts it; :func:`initial_progress` answers the same question for an asset that
    arrived already carrying one. If they disagreed, the same asset with the same
    labels would read differently depending on whether the labels predated the
    job — which is the fact this whole policy exists to stop mattering.
    """
    for has_annotations in (True, False):
        started = initial_progress(has_annotations=has_annotations)
        landed = progress_after_annotating(UNANNOTATED, has_annotations=has_annotations)
        assert started is (landed if landed is not None else UNANNOTATED)


def test_both_starting_states_are_ones_an_annotator_may_write_into() -> None:
    """Read against `WRITABLE_PROGRESS`, so seeding cannot open an unwritable asset."""
    assert {
        initial_progress(has_annotations=True),
        initial_progress(has_annotations=False),
        initial_progress(has_annotations=True, judged=False),
    } <= WRITABLE_PROGRESS


# --- seeding: a batch over labeled assets opens on those labels ---------------


def test_a_correction_opens_on_the_labels_the_parent_round_left(tmp_path: Path) -> None:
    """The seeding *is* the storage: nothing is copied, because nothing had to be."""
    fixture = Fixture(tmp_path)
    first, second = fixture.assets
    parent_job = fixture.open_batch("first", [first, second])
    fixture.annotations.add(parent_job.id, [_box(first, x=0), _box(first, x=20)])
    parent = fixture.finish(parent_job)
    fixture.datasets.promote(parent)

    child_job = fixture.correction(parent, "fix", [first])

    seeded = fixture.annotations.for_asset(child_job.id, first)
    assert len(seeded) == 2
    # Each label still records the round that wrote it and the version it was
    # judged against; being seen by a later job does not rewrite either.
    assert {annotation.job_id for annotation in seeded} == {parent_job.id}
    assert {annotation.schema_version for annotation in seeded} == {1}
    fixture.close()


def test_a_seeded_asset_starts_annotated_rather_than_claiming_to_be_empty(
    tmp_path: Path,
) -> None:
    """The lie this task was for: three boxes on screen, filed under 'Unannotated'."""
    fixture = Fixture(tmp_path)
    first, second = fixture.assets
    parent_job = fixture.open_batch("first", [first, second])
    fixture.annotations.add(parent_job.id, [_box(first)])
    parent = fixture.finish(parent_job)

    child_job = fixture.correction(parent, "fix", [first, second])

    assert fixture.progress_of(child_job, first) is ANNOTATED
    # And the one nobody labeled is still honestly empty — the rule reads the
    # asset, so it does not paint a whole correction batch as done.
    assert fixture.progress_of(child_job, second) is UNANNOTATED
    fixture.close()


def test_an_ordinary_batch_over_labeled_assets_is_seeded_the_same_way(
    tmp_path: Path,
) -> None:
    """Nothing consults the lineage: `parent_batch_id` is not an input to the rule.

    A batch cut by hand over assets somebody labeled elsewhere is the same
    situation as a correction, and a rule that answered differently would be
    wrong about whichever case it had not been written for.
    """
    fixture = Fixture(tmp_path)
    first, _ = fixture.assets
    parent_job = fixture.open_batch("first", [first])
    fixture.annotations.add(parent_job.id, [_box(first)])
    fixture.finish(parent_job)

    plain_job = fixture.open_batch("unrelated", [first])

    assert fixture.batches.get(fixture.batch_of(plain_job)).parent_batch_id is None
    assert fixture.progress_of(plain_job, first) is ANNOTATED
    fixture.close()


def test_a_seeded_correction_can_be_completed_without_any_edit(tmp_path: Path) -> None:
    """The honest side effect, asserted rather than left to be discovered.

    ``annotated`` is in ``SETTLED_PROGRESS``, so a correction whose every asset
    seeded that way blocks on nothing. That is the intended reading — a
    correction is opt-in per asset, and the alternative is making somebody
    re-declare work nobody disputed.
    """
    fixture = Fixture(tmp_path)
    first, _ = fixture.assets
    parent_job = fixture.open_batch("first", [first])
    fixture.annotations.add(parent_job.id, [_box(first)])
    parent = fixture.finish(parent_job)
    fixture.datasets.promote(parent)

    child_job = fixture.correction(parent, "fix", [first])
    fixture.jobs.complete(child_job.id)
    child = fixture.batch_of(child_job)
    fixture.batches.complete(child)

    assert fixture.datasets.promote(child) == []
    assert fixture.trunk_labels(first) == {"sign"}
    fixture.close()


# --- replacement: one set per asset, never one per round ----------------------


def test_a_correction_replaces_the_assets_labels_rather_than_adding_a_round(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    first, _ = fixture.assets
    fixture.schemas.create_version(
        fixture.project.id,
        [SIGN, LabelClass(name="lamp", geometries=(GeometryType.BBOX,))],
    )
    parent_job = fixture.open_batch("first", [first])
    fixture.annotations.add(parent_job.id, [_box(first)])
    parent = fixture.finish(parent_job)
    fixture.datasets.promote(parent)
    assert fixture.trunk_labels(first) == {"sign"}

    child_job = fixture.correction(parent, "fix", [first])
    (seeded,) = fixture.annotations.for_asset(child_job.id, first)
    fixture.annotations.update(child_job.id, [seeded.model_copy(update={"label_class": "lamp"})])
    child = fixture.finish(child_job)
    fixture.datasets.promote(child)

    # One label, the corrected one — not one of each round.
    assert fixture.trunk_labels(first) == {"lamp"}
    assert len(fixture.annotations.for_asset(child_job.id, first)) == 1
    fixture.close()


def test_deleting_a_box_in_a_correction_takes_it_out_of_the_trunk(tmp_path: Path) -> None:
    """What replacement buys that accumulation could not: removal is expressible."""
    fixture = Fixture(tmp_path)
    first, _ = fixture.assets
    parent_job = fixture.open_batch("first", [first])
    kept, doomed = fixture.annotations.add(parent_job.id, [_box(first, x=0), _box(first, x=20)])
    parent = fixture.finish(parent_job)
    fixture.datasets.promote(parent)

    child_job = fixture.correction(parent, "fix", [first])
    assert fixture.annotations.delete(child_job.id, [doomed.id]) == 1
    fixture.datasets.promote(fixture.finish(child_job))

    surviving = fixture.annotations.for_asset(child_job.id, first)
    assert [annotation.id for annotation in surviving] == [kept.id]
    fixture.close()


def test_an_asset_the_correction_left_alone_keeps_the_parents_labels(tmp_path: Path) -> None:
    """Replacement is per asset, so an untouched one is not collateral."""
    fixture = Fixture(tmp_path)
    first, second = fixture.assets
    parent_job = fixture.open_batch("first", [first, second])
    fixture.annotations.add(parent_job.id, [_box(first), _box(second)])
    parent = fixture.finish(parent_job)
    fixture.datasets.promote(parent)

    child_job = fixture.correction(parent, "fix", [first, second])
    (on_first,) = fixture.annotations.for_asset(child_job.id, first)
    fixture.annotations.delete(child_job.id, [on_first.id])
    fixture.datasets.promote(fixture.finish(child_job))

    assert fixture.trunk_labels(first) == set()
    assert fixture.trunk_labels(second) == {"sign"}
    fixture.close()


def test_a_skipped_asset_in_a_correction_leaves_its_trunk_labels_alone(
    tmp_path: Path,
) -> None:
    """Skipping is 'no statement', not 'delete': it produces no write at all.

    ``PROMOTABLE_PROGRESS`` leaves the asset out of the promotion, and because
    the asset is already a member with labels already on it, out means
    *untouched* rather than emptied.
    """
    fixture = Fixture(tmp_path)
    first, _ = fixture.assets
    parent_job = fixture.open_batch("first", [first])
    fixture.annotations.add(parent_job.id, [_box(first)])
    parent = fixture.finish(parent_job)
    fixture.datasets.promote(parent)

    child_job = fixture.correction(parent, "fix", [first])
    fixture.jobs.mark(child_job.id, first, SKIPPED)
    fixture.jobs.complete(child_job.id)
    child = fixture.batch_of(child_job)
    fixture.batches.complete(child)

    assert fixture.datasets.promote(child) == []
    assert fixture.trunk_labels(first) == {"sign"}
    fixture.close()


# --- two completed batches over one asset -------------------------------------


@pytest.mark.parametrize(
    "first_promoted", ["parent", "child"], ids=["parent-then-child", "child-then-parent"]
)
def test_whichever_batch_wrote_last_is_what_the_trunk_projects(
    tmp_path: Path, first_promoted: str
) -> None:
    """Order-dependent, and *defined* rather than a race — in both orders.

    Two completed batches over one asset do not accumulate two rounds, because
    there was only ever one set for them to write into. Promotion moves
    membership, so which one is promoted first cannot change the answer: the
    labels are whatever the last *writer* left, and both orders agree on that.
    """
    fixture = Fixture(tmp_path)
    first, _ = fixture.assets
    fixture.schemas.create_version(
        fixture.project.id,
        [SIGN, LabelClass(name="lamp", geometries=(GeometryType.BBOX,))],
    )
    parent_job = fixture.open_batch("first", [first])
    fixture.annotations.add(parent_job.id, [_box(first)])
    parent = fixture.finish(parent_job)

    child_job = fixture.correction(parent, "fix", [first])
    (seeded,) = fixture.annotations.for_asset(child_job.id, first)
    fixture.annotations.update(child_job.id, [seeded.model_copy(update={"label_class": "lamp"})])
    child = fixture.finish(child_job)

    order = [parent, child] if first_promoted == "parent" else [child, parent]
    promoted = [fixture.datasets.promote(batch_id) for batch_id in order]

    assert fixture.trunk_labels(first) == {"lamp"}
    # And the report says which press did the work: the first admits the asset,
    # the second finds it already there and says so by returning nothing.
    assert [len(added) for added in promoted] == [1, 0]
    fixture.close()


def test_promoting_the_same_batch_again_changes_nothing_and_logs_nothing(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    first, _ = fixture.assets
    parent_job = fixture.open_batch("first", [first])
    fixture.annotations.add(parent_job.id, [_box(first)])
    parent = fixture.finish(parent_job)

    assert len(fixture.datasets.promote(parent)) == 1
    entries = len(fixture.datasets.changes(fixture.dataset_id))

    assert fixture.datasets.promote(parent) == []
    assert len(fixture.datasets.changes(fixture.dataset_id)) == entries
    assert fixture.trunk_labels(first) == {"sign"}
    fixture.close()


# --- releases are content-immutable, and a correction does not reach back ------


def test_a_correction_after_a_release_does_not_move_that_releases_manifest(
    tmp_path: Path,
) -> None:
    """The top of the immutability hierarchy, exercised against the thing below it.

    A release is a snapshot in a blob and its hash is the contract; the trunk is
    the live set. A correction changes the second and must not be able to reach
    the first — including through ``verify``, which re-reads and re-hashes rather
    than trusting the row.
    """
    fixture = Fixture(tmp_path)
    first, second = fixture.assets
    parent_job = fixture.open_batch("first", [first, second])
    fixture.annotations.add(parent_job.id, [_box(first, x=0), _box(first, x=20), _box(second)])
    parent = fixture.finish(parent_job)
    fixture.datasets.promote(parent)

    release = fixture.releases.publish(fixture.dataset_id, "v1", split=ALL_TRAIN)

    child_job = fixture.correction(parent, "fix", [first])
    doomed = fixture.annotations.for_asset(child_job.id, first)
    fixture.annotations.delete(child_job.id, [annotation.id for annotation in doomed])
    fixture.datasets.promote(fixture.finish(child_job))

    assert fixture.trunk_labels(first) == set()
    after = fixture.releases.get(release.id)
    assert after.manifest_hash == release.manifest_hash
    assert after.annotation_count == 3
    verification = fixture.releases.verify(release.id)
    assert verification.manifest_intact
    assert verification.cache_mismatches == ()
    fixture.close()


# --- the boundary this module does not cross ----------------------------------


def test_an_asset_in_two_open_batches_still_has_two_independent_progresses(
    tmp_path: Path,
) -> None:
    """**F14 is still open**, and this pins today's behaviour rather than deciding it.

    Progress lives per job, so one asset in two batches has two of them, and
    nothing reconciles the pair. That is the sibling question to this module's,
    and it is deliberately not answered here: this policy governs what promotion
    *writes*, not how two ordinary batches coordinate. Written down so that a
    later session changing it does so on purpose.
    """
    fixture = Fixture(tmp_path)
    first, _ = fixture.assets
    left = fixture.open_batch("left", [first])
    right = fixture.open_batch("right", [first])

    fixture.annotations.add(left.id, [_box(first)])

    assert fixture.progress_of(left, first) is ANNOTATED
    # The other job saw the same asset gain a label and did not move: it was cut
    # before the label existed, and nothing tells it otherwise.
    assert fixture.progress_of(right, first) is UNANNOTATED
    fixture.close()


def test_a_correction_cannot_be_cut_over_an_asset_its_parent_never_carried(
    tmp_path: Path,
) -> None:
    """The seeding rule does not widen what a correction may be about."""
    fixture = Fixture(tmp_path)
    first, second = fixture.assets
    parent_job = fixture.open_batch("first", [first])
    fixture.annotations.add(parent_job.id, [_box(first)])
    parent = fixture.finish(parent_job)

    with pytest.raises(Exception, match="cannot include it"):
        fixture.batches.create_correction(parent, "fix", [second])
    fixture.close()


def test_seeding_reads_the_asset_and_not_some_other_projects_labels(
    tmp_path: Path,
) -> None:
    """A guard against the cheap wrong implementation: 'has any annotation anywhere'."""
    fixture = Fixture(tmp_path)
    first, second = fixture.assets
    labeled_job = fixture.open_batch("first", [first])
    fixture.annotations.add(labeled_job.id, [_box(first)])
    fixture.finish(labeled_job)

    fresh = fixture.open_batch("second", [second])

    assert fixture.progress_of(fresh, second) is UNANNOTATED
    assert uuid4() not in fixture.jobs.get(fresh.id).progress
    fixture.close()
