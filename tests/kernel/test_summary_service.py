"""SummaryService: the workspace read across every project at once.

The subject is the resume derivation, which is three rules stacked: what a batch
is being offered *for*, then when it was last worked, then — for batches nobody
has worked since ``annotation_job_asset.touched_at`` existed — how far through it
is. Most of this file is those three and the ways each can be got backwards,
because each is invisible to tests of the other two.

Everything walks the real services. A planted batch state or a hand-written
progress map would let the tests agree with a fixture rather than with the
kernel, and the resume rule reads exactly the fields such a fixture would fake.
"""

from __future__ import annotations

from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

from sqlalchemy import text

from visionset.kernel.domain import (
    ActivityKind,
    Annotation,
    Asset,
    AssetProgress,
    AttentionKind,
    BackgroundJob,
    BackgroundJobState,
    BboxGeometry,
    BySize,
    GeometryType,
    LabelClass,
    ResumeKind,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    SummaryService,
    WorkspaceService,
)

SIGN = LabelClass(name="sign", geometries=(GeometryType.BBOX,))


class Fixture:
    """A workspace to hang projects, batches and work off."""

    def __init__(self, tmp_path: Path) -> None:
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        self.projects = ProjectService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
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

    def split_batch(self, project_id: UUID, name: str, assets: list[UUID]) -> list[UUID]:
        """A batch cut into one job per asset. Returns the job ids, in batch order."""
        batch = self.batches.create(project_id, name, assets)
        self.batches.approve(batch.id, BySize(size=1))
        self.batches.start(batch.id)
        jobs = self.batches.jobs(batch.id)
        # The caller indexes these against `assets`, so the pairing is asserted
        # here rather than assumed from the partition's own ordering.
        assert [next(iter(job.progress)) for job in jobs] == assets
        for job in jobs:
            self.jobs.start(job.id)
        return [job.id for job in jobs]

    def annotate(self, job_id: UUID, asset_ids: list[UUID]) -> None:
        for asset_id in asset_ids:
            self.jobs.mark(job_id, asset_id, AssetProgress.ANNOTATED)

    def forget_touches(self) -> None:
        """Make every frame look like one nobody has worked since the column existed.

        The only way to reach the ranking's second population, and it is not a
        contrivance: it is exactly the state of a workspace created before
        migration 8, where ``touched_at`` was added and deliberately not
        backfilled. Raw SQL rather than a service call, because no service can
        put a workspace back into that state and none should be able to.
        """
        store = self.workspace.metadata_store
        with store.engine.begin() as connection:  # type: ignore[attr-defined]
            connection.execute(text("update annotation_job_asset set touched_at = null"))

    def touched(self, job_id: UUID, asset_id: UUID) -> None:
        """Work a frame without changing where it is — the ordinary annotation edit."""
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


def test_the_batch_you_worked_last_wins(tmp_path: Path) -> None:
    """The rank, and the whole reason ``touched_at`` exists.

    The further-along batch is worked first and then left; the one behind it is
    worked afterwards. Under the ordering this replaced, the further-along one
    would win — which is the substitution the column removes.
    """
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        ahead = fixture.assets(project, 5)
        behind = fixture.assets(project, 5)
        _, ahead_job = fixture.open_batch(project, "ahead", ahead)
        fixture.annotate(ahead_job, ahead[:3])
        recent, behind_job = fixture.open_batch(project, "behind", behind)
        fixture.annotate(behind_job, behind[:1])

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_id == recent
        assert resume.batch_name == "behind"
    finally:
        fixture.close()


def test_a_split_batch_is_as_recent_as_its_newest_job(tmp_path: Path) -> None:
    """A partition cuts a batch into several jobs, and somebody works one at a time.

    The batch's recency is the newest of its jobs', never any single job's — and
    a batch with only one job, which is every other fixture in this file, cannot
    tell the two apart.
    """
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        # Three assets, so one is left unlabeled and both batches below stay in
        # the same kind — otherwise the priority decides this before recency is
        # ever consulted, and the test would pass without exercising anything.
        split = fixture.assets(project, 3)
        other = fixture.assets(project, 2)
        jobs = fixture.split_batch(project, "split", split)
        fixture.annotate(jobs[0], split[:1])

        _, plain_job = fixture.open_batch(project, "plain", other)
        fixture.annotate(plain_job, other[:1])

        # Back to the split batch, in a *different* job. Taking the oldest of its
        # jobs would leave the plain batch looking like the more recent one.
        fixture.annotate(jobs[1], split[1:2])

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_name == "split"
    finally:
        fixture.close()


def test_a_batch_somebody_has_worked_beats_one_nobody_has(tmp_path: Path) -> None:
    """The two populations, and which way round they go.

    The untouched batch is *further through*, so under the fallback ranking alone
    it would win. A stamp outranks no stamp whatever the progress says.
    """
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        stale = fixture.assets(project, 5)
        fresh = fixture.assets(project, 5)
        _, stale_job = fixture.open_batch(project, "further-through", stale)
        fixture.annotate(stale_job, stale[:4])
        fixture.forget_touches()

        recent, fresh_job = fixture.open_batch(project, "barely-begun", fresh)
        fixture.annotate(fresh_job, fresh[:1])

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_id == recent
    finally:
        fixture.close()


def test_the_batch_you_worked_last_wins_across_projects_too(tmp_path: Path) -> None:
    """The walk is workspace-wide, so the comparison must survive the project loop."""
    fixture = Fixture(tmp_path)
    try:
        first = fixture.project("first")
        second = fixture.project("second")
        one = fixture.assets(first, 5)
        two = fixture.assets(second, 5)
        _, second_job = fixture.open_batch(second, "in-second", two)
        fixture.annotate(second_job, two[:4])
        _, first_job = fixture.open_batch(first, "in-first", one)
        fixture.annotate(first_job, one[:1])

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.project_name == "first"
        assert resume.batch_name == "in-first"
    finally:
        fixture.close()


def test_an_edit_that_moves_no_progress_still_counts_as_working_the_batch(
    tmp_path: Path,
) -> None:
    """Drawing a second box on a labeled frame leaves progress alone and is still work.

    The case a stamp written only on a *transition* would miss, and the one an
    annotator spends most of their time in: the frame was already ``annotated``,
    so nothing about it changes except that somebody was there.
    """
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        one = fixture.assets(project, 4)
        two = fixture.assets(project, 4)
        first, first_job = fixture.open_batch(project, "first", one)
        fixture.annotate(first_job, one[:2])
        _, second_job = fixture.open_batch(project, "second", two)
        fixture.annotate(second_job, two[:2])
        before = fixture.summary().resume
        assert before is not None
        assert before.batch_name == "second"

        fixture.touched(first_job, one[0])

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_id == first
    finally:
        fixture.close()


def test_the_batch_you_are_furthest_through_wins_where_nobody_has_been(
    tmp_path: Path,
) -> None:
    """The fallback rank, reachable only in a workspace that predates the column.

    Every stamp is cleared, which is what such a workspace looks like: the
    ordering falls back to progress, and the further-along batch wins as it did
    before ``touched_at`` existed.
    """
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        behind = fixture.assets(project, 5)
        ahead = fixture.assets(project, 5)
        fixture.open_batch(project, "behind", behind)
        further, ahead_job = fixture.open_batch(project, "ahead", ahead)
        fixture.annotate(ahead_job, ahead[:3])
        fixture.forget_touches()

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.batch_id == further
        assert resume.batch_name == "ahead"
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
    """The last kind: nothing to label, nothing to review, so the card opens a gallery."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        batch, job = fixture.open_batch(project, "done", assets)
        fixture.annotate(job, assets)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.kind is ResumeKind.OPEN
        assert resume.batch_id == batch
        assert resume.next_asset_id is None
        assert (resume.annotated, resume.total) == (3, 3)
    finally:
        fixture.close()


def test_a_batch_of_only_pre_labeled_frames_is_still_something_to_carry_on_with(
    tmp_path: Path,
) -> None:
    """A model's unjudged guess is exactly as outstanding as a blank frame.

    Without this, a batch nobody has touched by hand but a model has fully
    covered would fall through both searches and read as ``open`` — nothing
    to land on — even though every frame in it still needs a person's edit
    before the batch can complete.
    """
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 2)
        batch, job = fixture.open_batch(project, "b", assets)
        fixture.jobs.mark(job, assets[0], AssetProgress.PRE_LABELED)
        fixture.jobs.mark(job, assets[1], AssetProgress.PRE_LABELED)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.kind is ResumeKind.ANNOTATE
        assert resume.batch_id == batch
        assert resume.next_asset_id == assets[0]
        assert (resume.annotated, resume.total) == (0, 2)
    finally:
        fixture.close()


def test_the_landing_asset_is_the_first_of_either_kind_in_batch_order(tmp_path: Path) -> None:
    """``unannotated`` and ``pre_labeled`` are one tier, searched together in order."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.jobs.mark(job, assets[0], AssetProgress.PRE_LABELED)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.kind is ResumeKind.ANNOTATE
        assert resume.next_asset_id == assets[0]
    finally:
        fixture.close()


def test_a_frame_waiting_on_review_is_something_to_carry_on_with(tmp_path: Path) -> None:
    """``review_pending`` is neither settled nor unannotated, and it is the second kind."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 2)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, assets)
        fixture.jobs.mark(job, assets[1], AssetProgress.REVIEW_PENDING)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.kind is ResumeKind.REVIEW
        # The frame awaiting review, not the batch's first — the search that
        # found it runs in batch order over one state, like the labeling one.
        assert resume.next_asset_id == assets[1]
        assert resume.review_pending == 1
        assert resume.annotated == 1
    finally:
        fixture.close()


def test_labeling_outranks_review_in_the_same_batch(tmp_path: Path) -> None:
    """Priority 1 beats priority 2 where a batch offers both, which is the ordinary case.

    A reviewer sends one frame back while others have never been drawn on. The
    card must not send somebody to review while labeling is outstanding: an
    unlabeled frame blocks the batch outright, where one awaiting review is
    already done and waiting on a second opinion.
    """
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        _, job = fixture.open_batch(project, "b", assets)
        fixture.annotate(job, assets[:1])
        fixture.jobs.mark(job, assets[0], AssetProgress.REVIEW_PENDING)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.kind is ResumeKind.ANNOTATE
        assert resume.next_asset_id == assets[1]
        # Reported all the same, so a surface can say what else is waiting.
        assert resume.review_pending == 1
    finally:
        fixture.close()


def test_labeling_in_one_batch_outranks_review_in_a_more_recent_one(tmp_path: Path) -> None:
    """The kind is consulted before recency, which is what makes it a tier at all."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        stale = fixture.assets(project, 2)
        fresh = fixture.assets(project, 2)
        older, older_job = fixture.open_batch(project, "older", stale)
        fixture.annotate(older_job, stale[:1])

        _, newer_job = fixture.open_batch(project, "newer", fresh)
        fixture.annotate(newer_job, fresh)
        fixture.jobs.mark(newer_job, fresh[0], AssetProgress.REVIEW_PENDING)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.kind is ResumeKind.ANNOTATE
        assert resume.batch_id == older
    finally:
        fixture.close()


def test_review_outranks_a_batch_with_neither(tmp_path: Path) -> None:
    """The second rung, which without a test would be indistinguishable from the third."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        waiting = fixture.assets(project, 2)
        settled = fixture.assets(project, 2)
        review, review_job = fixture.open_batch(project, "in-review", waiting)
        fixture.annotate(review_job, waiting)
        fixture.jobs.mark(review_job, waiting[0], AssetProgress.REVIEW_PENDING)

        # Later, and further through, and still not what the card offers.
        _, done_job = fixture.open_batch(project, "done", settled)
        fixture.annotate(done_job, settled)

        resume = fixture.summary().resume

        assert resume is not None
        assert resume.kind is ResumeKind.REVIEW
        assert resume.batch_id == review
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


def test_a_batch_a_model_labeled_and_nobody_has_read_asks_for_an_annotator(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        batch, job = fixture.open_batch(project, "pre-labeled", assets)
        for asset_id in assets[:2]:
            fixture.jobs.mark(job, asset_id, AssetProgress.PRE_LABELED)

        rows = [row for row in fixture.summary().attention if row.kind is AttentionKind.PRE_LABELED]

        assert len(rows) == 1
        assert rows[0].subject_id == batch
        assert rows[0].count == 2
        assert rows[0].label == "pre-labeled"
        assert rows[0].project_name == "p"
    finally:
        fixture.close()


def test_a_batch_waiting_on_both_gets_a_row_for_each(tmp_path: Path) -> None:
    """A reviewer and an annotator are two different people; one row cannot ask both."""
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        batch, job = fixture.open_batch(project, "both", assets)
        fixture.annotate(job, assets[:1])
        fixture.jobs.mark(job, assets[0], AssetProgress.REVIEW_PENDING)
        fixture.jobs.mark(job, assets[1], AssetProgress.PRE_LABELED)

        rows = [row for row in fixture.summary().attention if row.subject_id == batch]

        assert [(row.kind, row.count) for row in rows] == [
            (AttentionKind.REVIEW_PENDING, 1),
            (AttentionKind.PRE_LABELED, 1),
        ]
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


def _model_box(asset_id: UUID, job_id: UUID, confidence: float | None) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="sign",
        schema_version=1,
        geometry=BboxGeometry(x=0, y=0, width=4, height=4),
        provenance="model",
        model_ref="stub@1",
        confidence=confidence,
        job_id=job_id,
    )


def test_annotation_summary_counts_every_label_and_takes_the_model_minimum(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        assets = fixture.assets(project, 3)
        batch, job = fixture.open_batch(project, "b", assets)
        with fixture.workspace.unit_of_work() as uow:
            uow.annotations.add(_model_box(assets[0], job, 0.9))
            uow.annotations.add(_model_box(assets[0], job, 0.4))
            # A person's label with a score does not enter the minimum.
            uow.annotations.add(
                Annotation(
                    asset_id=assets[0],
                    label_class="sign",
                    schema_version=1,
                    geometry=BboxGeometry(x=1, y=1, width=2, height=2),
                    provenance="human",
                    confidence=0.1,
                    job_id=job,
                )
            )
            uow.annotations.add(_model_box(assets[1], job, None))

        with fixture.workspace.unit_of_work() as uow:
            summary = uow.annotation_summary(batch)

        assert summary[assets[0]].count == 3
        assert summary[assets[0]].min_model_confidence == 0.4
        assert summary[assets[1]].count == 1
        assert summary[assets[1]].min_model_confidence is None
        assert assets[2] not in summary
    finally:
        fixture.close()


def test_annotation_summary_is_scoped_to_the_batch(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    try:
        project = fixture.project("p")
        here, there = fixture.assets(project, 2)
        batch, job = fixture.open_batch(project, "b", [here])
        other, other_job = fixture.open_batch(project, "c", [there])
        with fixture.workspace.unit_of_work() as uow:
            uow.annotations.add(_model_box(here, job, 0.5))
            uow.annotations.add(_model_box(there, other_job, 0.2))

        with fixture.workspace.unit_of_work() as uow:
            assert set(uow.annotation_summary(batch)) == {here}
            assert set(uow.annotation_summary(other)) == {there}
            assert uow.annotation_summary(uuid4()) == {}
    finally:
        fixture.close()
