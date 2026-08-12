"""SummaryService: the workspace read across every project at once.

The subject is the resume derivation. It is the one rule here that had to be
*chosen* rather than read off the rows — no timestamp exists on a batch, an
annotation or an asset's progress — so most of this file is the two-tier
comparison and the ways it can be got backwards.

Everything walks the real services. A planted batch state or a hand-written
progress map would let the tests agree with a fixture rather than with the
kernel, and the resume rule reads exactly the fields such a fixture would fake.
"""

from __future__ import annotations

from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

from visionset.kernel.domain import (
    ActivityKind,
    Annotation,
    Asset,
    AssetProgress,
    AttentionKind,
    BackgroundJob,
    BackgroundJobState,
    BboxGeometry,
    GeometryType,
    LabelClass,
)
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    SummaryService,
    WorkspaceService,
)

SIGN = LabelClass(name="sign", geometry=GeometryType.BBOX)


class Fixture:
    """A workspace to hang projects, batches and work off."""

    def __init__(self, tmp_path: Path) -> None:
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        self.projects = ProjectService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self._seed = 0

    def project(self, name: str) -> UUID:
        project = self.projects.create(name)
        self.schemas.create_version(project.id, [SIGN])
        return project.id

    def assets(self, project_id: UUID, count: int) -> list[UUID]:
        made = []
        for _ in range(count):
            self._seed += 1
            seed = f"asset-{self._seed}"
            content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
            with self.workspace.unit_of_work() as uow:
                made.append(
                    uow.assets.add(
                        Asset(
                            project_id=project_id,
                            content_hash=content_hash,
                            uri=f"/tmp/{seed}.png",
                            ingested_at=datetime.now(UTC),
                        )
                    ).id
                )
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

    def summary(self):  # noqa: ANN201 - the domain model, named at each call site
        return SummaryService(self.workspace).summary()

    def close(self) -> None:
        self.workspace.close()


# --- the empty workspace, which is the first-run state ---------------------


def test_an_empty_workspace_counts_zero_and_offers_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        summary = fixture.summary()

        assert summary.totals.projects == 0
        assert summary.totals.assets == 0
        assert summary.totals.annotations == 0
        assert summary.totals.releases == 0
        assert summary.resume is None
        assert summary.attention == ()
        assert summary.projects == ()
        assert summary.activity == ()
    finally:
        fixture.close()


def test_a_project_with_nothing_in_it_is_not_the_first_run_state(tmp_path: Path) -> None:
    """The count is what a caller reads, so it has to move on the first project."""
    fixture = Fixture(tmp_path)
    try:
        fixture.project("empty")

        summary = fixture.summary()

        assert summary.totals.projects == 1
        assert summary.totals.assets == 0
        assert summary.resume is None
    finally:
        fixture.close()


# --- totals ----------------------------------------------------------------


def test_totals_add_up_across_projects(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        first = fixture.project("first")
        second = fixture.project("second")
        one = fixture.assets(first, 3)
        fixture.assets(second, 2)
        _, job = fixture.open_batch(first, "b", one)
        with fixture.workspace.unit_of_work() as uow:
            uow.annotations.add(
                Annotation(
                    asset_id=one[0],
                    label_class="sign",
                    schema_version=1,
                    geometry=BboxGeometry(x=0, y=0, width=4, height=4),
                    provenance="human",
                    job_id=job,
                )
            )

        summary = fixture.summary()

        assert summary.totals.projects == 2
        assert summary.totals.assets == 5
        assert summary.totals.annotations == 1
    finally:
        fixture.close()


def test_a_projects_labeled_share_counts_assets_not_annotations(tmp_path: Path) -> None:
    """Two labels on one asset is one asset labeled, which is the share's numerator."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 4)
        _, job = fixture.open_batch(project, "b", assets)
        with fixture.workspace.unit_of_work() as uow:
            for _ in range(2):
                uow.annotations.add(
                    Annotation(
                        asset_id=assets[0],
                        label_class="sign",
                        schema_version=1,
                        geometry=BboxGeometry(x=0, y=0, width=4, height=4),
                        provenance="human",
                        job_id=job,
                    )
                )

        row = fixture.summary().projects[0]

        assert row.asset_count == 4
        assert row.annotated_fraction == 0.25
    finally:
        fixture.close()


def test_an_empty_project_has_a_zero_share_rather_than_a_division(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        fixture.project("p")

        assert fixture.summary().projects[0].annotated_fraction == 0.0
    finally:
        fixture.close()


def test_the_project_shortcut_is_capped(tmp_path: Path) -> None:
    """It is a shortcut to the project list, not a second copy of it."""
    fixture = Fixture(tmp_path)
    try:
        for index in range(7):
            fixture.project(f"p{index}")

        summary = fixture.summary()

        assert len(summary.projects) == 5
        assert summary.totals.projects == 7
    finally:
        fixture.close()


# --- the resume target -----------------------------------------------------


def test_no_open_batch_means_no_resume_target(tmp_path: Path) -> None:
    """A batch nobody has approved is not somewhere to carry on."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        fixture.batches.create(project, "draft", assets)

        assert fixture.summary().resume is None
    finally:
        fixture.close()


def test_one_open_batch_is_offered_whatever_its_progress(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        batch, job = fixture.open_batch(project, "only", assets)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_id == batch
        assert resume.job_id == job
        assert resume.batch_name == "only"
        assert resume.project_name == "p"
        assert resume.next_asset_id == assets[0]
        assert (resume.annotated, resume.total) == (0, 3)
    finally:
        fixture.close()


def test_the_landing_asset_is_the_first_unannotated_one_in_batch_order(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 4)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, [assets[0], assets[1]])

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.next_asset_id == assets[2]
        assert resume.annotated == 2
    finally:
        fixture.close()


def test_a_skipped_frame_counts_as_dealt_with(tmp_path: Path) -> None:
    """``annotated`` is settled work, and skipping is a decision, not an omission."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.jobs.mark(job, assets[0], AssetProgress.SKIPPED)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.annotated == 1
        assert resume.next_asset_id == assets[1]
    finally:
        fixture.close()


def test_the_batch_you_are_furthest_through_wins(tmp_path: Path) -> None:
    """The rank, in the tier where both batches still have labeling left."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        behind = fixture.assets(project, 5)
        ahead = fixture.assets(project, 5)
        fixture.open_batch(project, "behind", behind)
        further, ahead_job = fixture.open_batch(project, "ahead", ahead)
        fixture.annotate(ahead_job, ahead[:3])

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_id == further
        assert resume.batch_name == "ahead"
    finally:
        fixture.close()


def test_the_further_along_batch_wins_across_projects_too(tmp_path: Path) -> None:
    """The walk is workspace-wide, so the comparison must survive the project loop."""
    fixture = Fixture(tmp_path)
    try:
        first = fixture.project("first")
        second = fixture.project("second")
        one = fixture.assets(first, 5)
        two = fixture.assets(second, 5)
        _, first_job = fixture.open_batch(first, "in-first", one)
        fixture.annotate(first_job, one[:4])
        fixture.open_batch(second, "in-second", two)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.project_name == "first"
        assert resume.batch_name == "in-first"
    finally:
        fixture.close()


def test_a_batch_with_labeling_left_beats_a_finished_one_however_far_ahead(
    tmp_path: Path,
) -> None:
    """The tier, which is the half a plain "most settled" ranking would get wrong."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        done = fixture.assets(project, 6)
        started = fixture.assets(project, 3)
        _, done_job = fixture.open_batch(project, "all-done", done)
        fixture.annotate(done_job, done)
        started_batch, _ = fixture.open_batch(project, "barely-started", started)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_id == started_batch
        assert resume.next_asset_id == started[0]
    finally:
        fixture.close()


def test_a_batch_with_nothing_left_is_still_offered_as_somewhere_to_open(
    tmp_path: Path,
) -> None:
    """The fallback tier: no unannotated frame anywhere, so the card opens a gallery."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        batch, job = fixture.open_batch(project, "done", assets)
        fixture.annotate(job, assets)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_id == batch
        assert resume.next_asset_id is None
        assert (resume.annotated, resume.total) == (3, 3)
    finally:
        fixture.close()


def test_a_frame_waiting_on_review_is_not_something_to_carry_on_with(
    tmp_path: Path,
) -> None:
    """``review_pending`` is neither settled nor unannotated, and blocks the tier."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 2)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, assets)
        fixture.jobs.mark(job, assets[0], AssetProgress.REVIEW_PENDING)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.next_asset_id is None
        assert resume.annotated == 1
    finally:
        fixture.close()


def test_a_tie_goes_to_the_batch_created_later(tmp_path: Path) -> None:
    """Insertion order is the only recency the rows can offer, so it breaks ties."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        first = fixture.assets(project, 3)
        second = fixture.assets(project, 3)
        fixture.open_batch(project, "older", first)
        newer, _ = fixture.open_batch(project, "newer", second)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_id == newer
        assert resume.batch_name == "newer"
    finally:
        fixture.close()


def test_the_card_shows_the_frame_it_would_open(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, [assets[0]])

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.thumbnail_asset_id == assets[1] == resume.next_asset_id
    finally:
        fixture.close()


def test_a_finished_batch_still_shows_a_picture(tmp_path: Path) -> None:
    """With no next frame the batch's first is the card's picture."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, assets)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.next_asset_id is None
        assert resume.thumbnail_asset_id == assets[0]
    finally:
        fixture.close()


# --- attention -------------------------------------------------------------


def test_nothing_waiting_means_no_attention_rows(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 2)
        fixture.open_batch(project, "b", assets)

        assert fixture.summary().attention == ()
    finally:
        fixture.close()


def test_a_batch_holding_frames_for_review_asks_for_attention(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        batch, job = fixture.open_batch(project, "needs-review", assets)
        fixture.annotate(job, assets[:2])
        for asset_id in assets[:2]:
            fixture.jobs.mark(job, asset_id, AssetProgress.REVIEW_PENDING)

        rows = [
            row for row in fixture.summary().attention if row.kind is AttentionKind.REVIEW_PENDING
        ]

        assert len(rows) == 1
        assert rows[0].subject_id == batch
        assert rows[0].count == 2
        assert rows[0].label == "needs-review"
        assert rows[0].project_name == "p"
    finally:
        fixture.close()


def test_a_failed_background_job_asks_for_attention_and_names_the_cause(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    try:
        with fixture.workspace.unit_of_work() as uow:
            uow.jobs.add(
                BackgroundJob(
                    type="export.release",
                    state=BackgroundJobState.FAILED,
                    error="the exporter refused a polygon",
                )
            )

        rows = [row for row in fixture.summary().attention if row.kind is AttentionKind.JOB_FAILED]

        assert len(rows) == 1
        assert rows[0].label == "export.release"
        assert rows[0].detail == "the exporter refused a polygon"
        # No background-job screen exists, so the row describes rather than links.
        assert rows[0].project_id is None
    finally:
        fixture.close()


def test_a_running_background_job_carries_its_progress(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        with fixture.workspace.unit_of_work() as uow:
            uow.jobs.add(
                BackgroundJob(
                    type="ingest.resume",
                    state=BackgroundJobState.RUNNING,
                    processed=7,
                    total=20,
                )
            )

        rows = [row for row in fixture.summary().attention if row.kind is AttentionKind.JOB_RUNNING]

        assert len(rows) == 1
        assert (rows[0].processed, rows[0].total) == (7, 20)
    finally:
        fixture.close()


def test_a_queued_job_is_not_news(tmp_path: Path) -> None:
    """It becomes ``running`` on its own, so interrupting somebody about it is noise."""
    fixture = Fixture(tmp_path)
    try:
        with fixture.workspace.unit_of_work() as uow:
            uow.jobs.add(BackgroundJob(type="export.release", state=BackgroundJobState.QUEUED))

        assert fixture.summary().attention == ()
    finally:
        fixture.close()


def test_a_settled_job_is_not_news_either(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        with fixture.workspace.unit_of_work() as uow:
            uow.jobs.add(BackgroundJob(type="export.release", state=BackgroundJobState.SUCCEEDED))
            uow.jobs.add(BackgroundJob(type="export.release", state=BackgroundJobState.CANCELLED))

        assert fixture.summary().attention == ()
    finally:
        fixture.close()


# --- activity --------------------------------------------------------------


def test_a_schema_version_is_activity(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        fixture.project("p")

        rows = [
            row for row in fixture.summary().activity if row.kind is ActivityKind.SCHEMA_VERSION
        ]

        assert len(rows) == 1
        assert rows[0].label == "v1"
        assert rows[0].project_name == "p"
    finally:
        fixture.close()


def test_arriving_data_is_one_row_per_project(tmp_path: Path) -> None:
    """``IngestJob`` records no times, so the feed reports arrival, not runs."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        fixture.assets(project, 4)

        rows = [row for row in fixture.summary().activity if row.kind is ActivityKind.INGEST]

        assert len(rows) == 1
        assert rows[0].count == 4
        assert rows[0].subject_id == project
    finally:
        fixture.close()


def test_an_asset_with_no_recorded_arrival_produces_no_row(tmp_path: Path) -> None:
    """NULL means unknown, and a stand-in date would name a moment nobody chose."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        content_hash = fixture.workspace.blob_store.put(BytesIO(b"undated"))
        with fixture.workspace.unit_of_work() as uow:
            uow.assets.add(
                Asset(project_id=project, content_hash=content_hash, uri="/tmp/undated.png")
            )

        assert [row for row in fixture.summary().activity if row.kind is ActivityKind.INGEST] == []
    finally:
        fixture.close()


def test_a_promotion_names_the_batch_and_counts_what_it_contributed(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        batch, job = fixture.open_batch(project, "round-one", assets)
        fixture.annotate(job, assets)
        fixture.jobs.complete(job)
        fixture.batches.complete(batch)
        DatasetService(fixture.workspace).promote(batch)

        rows = [
            row for row in fixture.summary().activity if row.kind is ActivityKind.BATCH_PROMOTED
        ]

        assert len(rows) == 1
        assert rows[0].subject_id == batch
        assert rows[0].label == "round-one"
        assert rows[0].count == 3
    finally:
        fixture.close()


def test_a_published_release_is_activity_and_is_counted(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 2)
        batch, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, assets)
        fixture.jobs.complete(job)
        fixture.batches.complete(batch)
        datasets = DatasetService(fixture.workspace)
        datasets.promote(batch)
        dataset = ProjectService(fixture.workspace).get_dataset(project)
        ReleaseService(fixture.workspace).publish(dataset.id, "v1")

        summary = fixture.summary()
        rows = [row for row in summary.activity if row.kind is ActivityKind.RELEASE_PUBLISHED]

        assert len(rows) == 1
        assert rows[0].label == "v1"
        assert summary.totals.releases == 1
    finally:
        fixture.close()


def test_activity_is_newest_first_and_capped(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        for index in range(12):
            fixture.project(f"p{index}")

        activity = fixture.summary().activity

        assert len(activity) == 8
        moments = [row.occurred_at for row in activity]
        assert moments == sorted(moments, reverse=True)
    finally:
        fixture.close()


# --- the port method this service exists beside ----------------------------


def test_annotation_totals_answers_zero_for_a_project_with_no_labels(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        fixture.assets(project, 3)

        with fixture.workspace.unit_of_work() as uow:
            totals = uow.annotation_totals(project)

        assert (totals.annotations, totals.annotated_assets) == (0, 0)
    finally:
        fixture.close()


def test_annotation_totals_does_not_count_another_projects_labels(tmp_path: Path) -> None:
    """The join is scoped through the asset, which is the only thing that scopes it."""
    fixture = Fixture(tmp_path)
    try:
        mine = fixture.project("mine")
        theirs = fixture.project("theirs")
        here = fixture.assets(mine, 1)
        there = fixture.assets(theirs, 1)
        _, job = fixture.open_batch(mine, "b", here)
        with fixture.workspace.unit_of_work() as uow:
            for asset_id in (here[0], there[0]):
                uow.annotations.add(
                    Annotation(
                        asset_id=asset_id,
                        label_class="sign",
                        schema_version=1,
                        geometry=BboxGeometry(x=0, y=0, width=4, height=4),
                        provenance="human",
                        job_id=job,
                    )
                )

        with fixture.workspace.unit_of_work() as uow:
            totals = uow.annotation_totals(mine)

        assert (totals.annotations, totals.annotated_assets) == (1, 1)
    finally:
        fixture.close()


def test_annotation_totals_of_an_unknown_project_is_zero_rather_than_a_refusal(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    try:
        with fixture.workspace.unit_of_work() as uow:
            totals = uow.annotation_totals(uuid4())

        assert (totals.annotations, totals.annotated_assets) == (0, 0)
    finally:
        fixture.close()
