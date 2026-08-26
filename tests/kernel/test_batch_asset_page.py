from __future__ import annotations

from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from visionset.kernel.domain import (
    Annotation,
    Asset,
    AssetProgress,
    AssetSort,
    BboxGeometry,
    BySize,
    GeometryType,
    LabelClass,
)
from visionset.kernel.errors import BatchNotFound, JobNotFound
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    JobService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)

SIGN = LabelClass(name="sign", geometries=(GeometryType.BBOX,))


class Fixture:
    def __init__(self, tmp_path: Path) -> None:
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        project = ProjectService(self.workspace).create("p")
        SchemaService(self.workspace).create_version(project.id, [SIGN])
        self.project = project.id
        self._seed = 0

    def assets(self, count: int) -> list[UUID]:
        made = []
        for _ in range(count):
            self._seed += 1
            seed = f"asset-{self._seed}"
            content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
            with self.workspace.unit_of_work() as uow:
                made.append(
                    uow.assets.add(
                        Asset(
                            project_id=self.project,
                            content_hash=content_hash,
                            uri=f"/tmp/{seed}.png",
                            ingested_at=datetime.now(UTC),
                        )
                    ).id
                )
        return made

    def open_batch(self, assets: list[UUID]) -> tuple[UUID, UUID]:
        batch = self.batches.create(self.project, "b", assets)
        self.batches.approve(batch.id)
        self.batches.start(batch.id)
        job = self.batches.jobs(batch.id)[0]
        self.jobs.start(job.id)
        return batch.id, job.id

    def pre_label(self, job: UUID, asset: UUID, *scores: float) -> None:
        self.annotations.enter_unreviewed(
            job,
            [
                Annotation(
                    asset_id=asset,
                    label_class="sign",
                    schema_version=1,
                    geometry=BboxGeometry(x=i, y=0, width=4, height=4),
                    provenance="model",
                    model_ref="stub@1",
                    confidence=score,
                )
                for i, score in enumerate(scores)
            ],
        )

    def close(self) -> None:
        self.workspace.close()


@pytest.fixture()
def fx(tmp_path: Path):  # noqa: ANN201
    fixture = Fixture(tmp_path)
    try:
        yield fixture
    finally:
        fixture.close()


def test_membership_order_with_placement_and_summary(fx: Fixture) -> None:
    a, b, c = fx.assets(3)
    batch, job = fx.open_batch([a, b, c])
    fx.pre_label(job, b, 0.7, 0.3)

    items, total = fx.batches.asset_page(batch)

    assert total == 3
    assert [one.asset.id for one in items] == [a, b, c]
    assert all(one.job_id == job for one in items)
    assert [one.progress for one in items] == [
        AssetProgress.UNANNOTATED,
        AssetProgress.PRE_LABELED,
        AssetProgress.UNANNOTATED,
    ]
    assert (items[1].summary.count, items[1].summary.min_model_confidence) == (2, 0.3)
    assert (items[0].summary.count, items[0].summary.min_model_confidence) == (0, None)


def test_progress_filter_narrows_items_and_total(fx: Fixture) -> None:
    a, b, c = fx.assets(3)
    batch, job = fx.open_batch([a, b, c])
    fx.pre_label(job, b, 0.5)
    fx.jobs.mark(job, c, AssetProgress.SKIPPED)

    items, total = fx.batches.asset_page(
        batch, progress=frozenset({AssetProgress.PRE_LABELED, AssetProgress.SKIPPED})
    )

    assert total == 2
    assert [one.asset.id for one in items] == [b, c]


def test_confidence_sort_puts_the_weakest_first_and_unscored_last(fx: Fixture) -> None:
    a, b, c, d = fx.assets(4)
    batch, job = fx.open_batch([a, b, c, d])
    fx.pre_label(job, a, 0.9)
    fx.pre_label(job, b, 0.8, 0.2)
    fx.pre_label(job, d, 0.2)

    items, _ = fx.batches.asset_page(batch, sort=AssetSort.CONFIDENCE)

    # b and d tie at 0.2; membership order breaks the tie. c has no score: last.
    assert [one.asset.id for one in items] == [b, d, a, c]


def test_window_hydrates_only_the_page_but_total_is_the_filtered_count(fx: Fixture) -> None:
    assets = fx.assets(5)
    batch, _ = fx.open_batch(assets)

    items, total = fx.batches.asset_page(batch, limit=2, offset=3)

    assert total == 5
    assert [one.asset.id for one in items] == assets[3:5]
    assert fx.batches.asset_page(batch, limit=2, offset=9) == ([], 5)


def test_a_draft_has_no_placement_and_a_progress_filter_over_it_is_empty(fx: Fixture) -> None:
    assets = fx.assets(2)
    batch = fx.batches.create(fx.project, "draft", assets)

    items, total = fx.batches.asset_page(batch.id)
    assert total == 2
    assert [(one.job_id, one.progress) for one in items] == [(None, None), (None, None)]

    assert fx.batches.asset_page(batch.id, progress=frozenset({AssetProgress.UNANNOTATED})) == (
        [],
        0,
    )


def test_unknown_batch_is_refused(fx: Fixture) -> None:
    with pytest.raises(BatchNotFound):
        fx.batches.asset_page(uuid4())


def test_a_job_filter_keeps_only_that_jobs_assets(fx: Fixture) -> None:
    assets = fx.assets(4)
    batch = fx.batches.create(fx.project, "b", assets)
    fx.batches.approve(batch.id, BySize(size=2))
    first, second = fx.batches.jobs(batch.id)

    placed, total = fx.batches.asset_page(batch.id, job=first.id)

    assert total == 2
    assert [one.asset.id for one in placed] == assets[:2]
    assert all(one.job_id == first.id for one in placed)


def test_a_job_filter_composes_with_progress(fx: Fixture) -> None:
    assets = fx.assets(4)
    batch = fx.batches.create(fx.project, "b", assets)
    fx.batches.approve(batch.id, BySize(size=2))
    first, _ = fx.batches.jobs(batch.id)
    fx.batches.start(batch.id)
    fx.jobs.mark(first.id, assets[0], AssetProgress.SKIPPED)

    placed, total = fx.batches.asset_page(
        batch.id, job=first.id, progress=frozenset({AssetProgress.UNANNOTATED})
    )

    assert total == 1 and placed[0].asset.id == assets[1]


def test_a_job_of_another_batch_is_refused(fx: Fixture) -> None:
    assets = fx.assets(2)
    batch = fx.batches.create(fx.project, "b", assets)
    other = fx.batches.create(fx.project, "o", fx.assets(1))
    fx.batches.approve(batch.id)
    fx.batches.approve(other.id)
    theirs = fx.batches.jobs(other.id)[0]

    with pytest.raises(JobNotFound):
        fx.batches.asset_page(batch.id, job=theirs.id)


def test_a_draft_with_a_job_filter_is_empty(fx: Fixture) -> None:
    batch = fx.batches.create(fx.project, "b", fx.assets(2))
    placed, total = fx.batches.asset_page(batch.id, job=uuid4())
    assert (placed, total) == ([], 0)
