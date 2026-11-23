"""ProjectService.digests: each project's listing numbers, and the stage they imply.

The stage is the subject of most of this file, because it is a first-match-wins
rule over several derived facts and each rung is invisible to tests of the others:
a project that is both waiting on review and holding an unpromoted batch must read
``in_review``, and only a test that builds both can tell the order from a reorder.

Everything walks the real services, for ``test_summary_service.py``'s reason: the
rule reads exactly the fields a planted fixture would fake.
"""

from __future__ import annotations

from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from uuid import UUID

from visionset.kernel.domain import (
    Annotation,
    Asset,
    AssetProgress,
    BboxGeometry,
    GeometryType,
    LabelClass,
    ProjectDigest,
    ProjectStage,
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
LANE = LabelClass(name="lane", geometries=(GeometryType.BBOX,))


class Fixture:
    """A workspace to hang projects, batches and releases off."""

    def __init__(self, tmp_path: Path) -> None:
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        self.projects = ProjectService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.datasets = DatasetService(self.workspace)
        self._seed = 0

    def project(self, name: str, *, classes: tuple[LabelClass, ...] = (SIGN,)) -> UUID:
        project = self.projects.create(name)
        if classes:
            SchemaService(self.workspace).create_version(project.id, list(classes))
        return project.id

    def assets(self, project_id: UUID, count: int) -> list[UUID]:
        made = []
        for _ in range(count):
            self._seed += 1
            seed = f"asset-{self._seed}"
            content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
            with self.workspace.unit_of_work() as uow:
                added = uow.assets.add(
                    Asset(
                        project_id=project_id,
                        content_hash=content_hash,
                        uri=f"/tmp/{seed}.png",
                        ingested_at=datetime.now(UTC),
                    )
                )
            made.append(added.id)
        return made

    def open_batch(self, project_id: UUID, name: str, assets: list[UUID]) -> tuple[UUID, UUID]:
        """A batch approved and started. Returns ``(batch_id, job_id)``."""
        batch = self.batches.create(project_id, name, assets)
        self.batches.approve(batch.id)
        self.batches.start(batch.id)
        job = self.batches.jobs(batch.id)[0]
        self.jobs.start(job.id)
        return batch.id, job.id

    def annotate(self, job_id: UUID, asset_ids: list[UUID]) -> None:
        for asset_id in asset_ids:
            self.jobs.mark(job_id, asset_id, AssetProgress.ANNOTATED)

    def draw(self, job_id: UUID, asset_id: UUID) -> None:
        """Put one label on an asset, which is what makes it count as annotated."""
        self.annotations.add(
            job_id,
            [
                Annotation(
                    asset_id=asset_id,
                    label_class="sign",
                    geometry=BboxGeometry(x=1.0, y=1.0, width=2.0, height=2.0),
                    schema_version=1,
                    provenance="human",
                )
            ],
        )

    def completed_batch(self, project_id: UUID, name: str, count: int) -> tuple[UUID, list[UUID]]:
        """A batch labeled, finished and completed, but not promoted."""
        assets = self.assets(project_id, count)
        batch, job = self.open_batch(project_id, name, assets)
        self.annotate(job, assets)
        self.jobs.complete(job)
        self.batches.complete(batch)
        return batch, assets

    def release(self, project_id: UUID, tag: str) -> None:
        dataset = self.projects.get_dataset(project_id)
        ReleaseService(self.workspace).publish(dataset.id, tag)

    def digest(self, project_id: UUID) -> ProjectDigest:
        return self.projects.digests()[project_id]

    def close(self) -> None:
        self.workspace.close()


def test_a_workspace_with_no_projects_has_no_digests(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        assert fixture.projects.digests() == {}
    finally:
        fixture.close()


def test_every_project_gets_a_digest_keyed_by_its_id(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        first = fixture.project("a")
        second = fixture.project("b")

        assert set(fixture.projects.digests()) == {first, second}
    finally:
        fixture.close()


# --- the stage, rung by rung -------------------------------------------------


def test_a_project_with_no_assets_is_empty_and_all_zero(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p", classes=())

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.EMPTY
        assert digest.asset_count == 0
        assert digest.annotated_fraction == 0.0
        assert digest.class_count == 0
        assert digest.batch_count == 0
        assert digest.latest_release is None
        assert digest.last_activity_at is None
    finally:
        fixture.close()


def test_assets_that_no_batch_has_started_are_not_started(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        fixture.batches.create(project, "draft", assets)

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.NOT_STARTED
        assert digest.batch_count == 1
        assert digest.frames_left == 0
        assert digest.dataset_asset_count == 0
    finally:
        fixture.close()


def test_frames_still_to_label_are_annotating(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 4)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, assets[:1])

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.ANNOTATING
        assert digest.frames_left == 3
        assert digest.frames_in_review == 0
    finally:
        fixture.close()


def test_a_skipped_frame_is_not_left_to_do(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 2)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, assets[:1])
        fixture.jobs.mark(job, assets[1], AssetProgress.SKIPPED)

        assert fixture.digest(project).frames_left == 0
    finally:
        fixture.close()


def test_a_frame_a_model_labeled_and_nobody_read_is_still_to_do(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 2)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, assets[:1])
        fixture.annotations.enter_unreviewed(
            job,
            [
                Annotation(
                    asset_id=assets[1],
                    label_class="sign",
                    geometry=BboxGeometry(x=1.0, y=1.0, width=2.0, height=2.0),
                    schema_version=1,
                    provenance="model",
                    model_ref="acme/detector@abc123",
                )
            ],
        )

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.ANNOTATING
        assert digest.frames_left == 1
    finally:
        fixture.close()


def test_review_outranks_labeling(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, assets[:2])
        fixture.jobs.mark(job, assets[1], AssetProgress.REVIEW_PENDING)

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.IN_REVIEW
        assert digest.frames_in_review == 1
        # The frame waiting on review is not also counted as work left to label.
        assert digest.frames_left == 1
    finally:
        fixture.close()


def test_labeling_outranks_an_unpromoted_completed_batch(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        fixture.completed_batch(project, "done", 2)
        _, job = fixture.open_batch(project, "open", fixture.assets(project, 2))

        assert fixture.digest(project).stage is ProjectStage.ANNOTATING
        assert job
    finally:
        fixture.close()


def test_a_completed_batch_not_in_the_dataset_is_to_promote(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        fixture.completed_batch(project, "done", 2)

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.TO_PROMOTE
        assert digest.frames_left == 0
        assert digest.dataset_asset_count == 0
    finally:
        fixture.close()


def test_a_completed_batch_of_only_skipped_frames_has_nothing_to_promote(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 2)
        batch, job = fixture.open_batch(project, "b", assets)
        for asset_id in assets:
            fixture.jobs.mark(job, asset_id, AssetProgress.SKIPPED)
        fixture.jobs.complete(job)
        fixture.batches.complete(batch)

        assert fixture.digest(project).stage is ProjectStage.NOT_STARTED
    finally:
        fixture.close()


def test_a_promoted_trunk_with_no_release_is_unreleased(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        batch, _ = fixture.completed_batch(project, "done", 2)
        fixture.datasets.promote(batch)

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.UNRELEASED
        assert digest.dataset_asset_count == 2
        assert digest.latest_release is None
    finally:
        fixture.close()


def test_a_trunk_matching_its_newest_release_is_up_to_date(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        batch, _ = fixture.completed_batch(project, "done", 2)
        fixture.datasets.promote(batch)
        fixture.release(project, "v1")

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.UP_TO_DATE
        assert digest.latest_release is not None
        assert digest.latest_release.tag == "v1"
        assert digest.latest_release.asset_count == 2
    finally:
        fixture.close()


def test_a_promotion_after_the_newest_release_makes_the_trunk_unreleased(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        first, _ = fixture.completed_batch(project, "one", 2)
        fixture.datasets.promote(first)
        fixture.release(project, "v1")
        second, _ = fixture.completed_batch(project, "two", 1)
        fixture.datasets.promote(second)

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.UNRELEASED
        assert digest.dataset_asset_count == 3
        # The release keeps naming what was frozen, not what the trunk holds now.
        assert digest.latest_release is not None
        assert digest.latest_release.asset_count == 2
    finally:
        fixture.close()


def test_the_newest_release_is_the_one_the_stage_compares_against(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        first, _ = fixture.completed_batch(project, "one", 2)
        fixture.datasets.promote(first)
        fixture.release(project, "v1")
        second, _ = fixture.completed_batch(project, "two", 1)
        fixture.datasets.promote(second)
        fixture.release(project, "v2")

        digest = fixture.digest(project)

        assert digest.stage is ProjectStage.UP_TO_DATE
        assert digest.latest_release is not None
        assert digest.latest_release.tag == "v2"
        assert digest.latest_release.asset_count == 3
    finally:
        fixture.close()


def test_an_asset_taken_out_of_the_trunk_is_promotable_again(tmp_path: Path) -> None:
    """``promote`` has no memory of removals, so the stage inherits that."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        batch, assets = fixture.completed_batch(project, "done", 2)
        fixture.datasets.promote(batch)
        fixture.release(project, "v1")
        dataset = fixture.projects.get_dataset(project)
        fixture.datasets.remove_asset(dataset.id, assets[0])

        assert fixture.digest(project).stage is ProjectStage.TO_PROMOTE
    finally:
        fixture.close()


# --- the numbers -------------------------------------------------------------


def test_the_counts_are_the_projects_own(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p", classes=(SIGN, LANE))
        other = fixture.project("other")
        fixture.assets(other, 5)
        assets = fixture.assets(project, 4)
        batch, job = fixture.open_batch(project, "b", assets[:3])
        fixture.draw(job, assets[0])
        fixture.draw(job, assets[1])
        fixture.batches.create(project, "draft", assets[3:])

        digest = fixture.digest(project)

        assert digest.asset_count == 4
        assert digest.annotated_asset_count == 2
        assert digest.annotated_fraction == 0.5
        assert digest.class_count == 2
        assert digest.batch_count == 2
        assert batch
    finally:
        fixture.close()


def test_class_count_follows_the_active_schema_version(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        SchemaService(fixture.workspace).create_version(project, [SIGN, LANE])

        assert fixture.digest(project).class_count == 2
    finally:
        fixture.close()


def test_last_activity_is_the_newest_thing_the_feed_would_date(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        batch, _ = fixture.completed_batch(project, "done", 2)
        fixture.datasets.promote(batch)
        before = datetime.now(UTC)
        fixture.release(project, "v1")

        digest = fixture.digest(project)

        assert digest.latest_release is not None
        assert digest.last_activity_at == digest.latest_release.published_at
        assert digest.last_activity_at >= before
    finally:
        fixture.close()


def test_a_project_with_only_a_schema_is_dated_by_it(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")

        assert fixture.digest(project).last_activity_at is not None
    finally:
        fixture.close()
