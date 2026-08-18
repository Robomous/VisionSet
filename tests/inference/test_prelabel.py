"""Pre-labeling: what a run touches, what it writes, and what it refuses."""

from __future__ import annotations

from collections.abc import Iterator
from io import BytesIO
from pathlib import Path
from typing import Final
from uuid import UUID

import pytest

from visionset.inference.prelabel import DEFAULT_MINIMUM_CONFIDENCE, pre_label
from visionset.kernel import SchemaHasNoDetectableClass, UnsupportedPrompt
from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    Asset,
    AssetPrediction,
    AssetProgress,
    BboxGeometry,
    ConnectionType,
    GeometryType,
    InferenceConnection,
    LabelClass,
    PredictedRegion,
    PredictionRequest,
    Prompt,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    InferenceConnectionService,
    JobService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)

#: The one bbox class, which is what makes the phrase-derivation test expect
#: ``("sign",)``. No required attribute — unlike its namesake in
#: ``tests/kernel/test_annotation_service.py`` — because a model's answer never
#: fills one in, and this file is about what a model can write, not what a person
#: fills in afterward.
SIGN = LabelClass(name="sign", geometries=(GeometryType.BBOX,))
#: A class no box could ever satisfy, so a schema built only from this refuses
#: pre-labeling before anything runs.
LANE = LabelClass(name="lane", geometries=(GeometryType.POLYGON,))

DEFAULT_REGIONS: Final = (
    PredictedRegion(
        label="sign", confidence=0.62, geometry=BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0)
    ),
)


class FakeModelProvider:
    """A ``ModelProvider`` that answers from a script, structurally conforming
    to the port ``pre_label`` narrows to."""

    def __init__(self, pool: FakeProviderPool) -> None:
        self._pool = pool

    @property
    def model_ref(self) -> str:
        return self._pool.model_ref

    def predict(self, request: PredictionRequest) -> Iterator[AssetPrediction]:
        self._pool.calls += 1
        self._pool.last_prompt = request.prompt
        for target in request.targets:
            yield AssetPrediction(
                asset_id=target.asset_id, model_ref=self._pool.model_ref, regions=self._pool.regions
            )


class FakeSegmenter:
    """Structurally a ``PointSegmenter`` and nothing a text prompt could reach.

    No ``predict`` method at all, which is what makes
    ``isinstance(runner, ModelProvider)`` false and lets ``pre_label`` refuse it
    before this is ever asked anything.
    """

    def segment(self, request: object) -> None:
        raise AssertionError("pre_label must never ask a point segmenter for anything")


class FakeProviderPool:
    """A ``ProviderPool`` stand-in: resolves to a scripted answer, never a real one."""

    def __init__(
        self,
        *,
        kind: str = "detector",
        model_ref: str = "acme/detector@abc123",
        regions: tuple[PredictedRegion, ...] = DEFAULT_REGIONS,
    ) -> None:
        self.calls = 0
        self.last_prompt: Prompt | None = None
        self.model_ref = model_ref
        self.regions = regions
        self._kind = kind

    def get(self, connection: InferenceConnection, *, workspace_root: Path) -> object:
        if self._kind == "segmenter":
            return FakeSegmenter()
        return FakeModelProvider(self)


def _box(asset_id: UUID, **overrides: object) -> Annotation:
    fields: dict[str, object] = {
        "asset_id": asset_id,
        "label_class": "sign",
        "schema_version": 1,
        "geometry": BboxGeometry(x=1.0, y=2.0, width=30.0, height=40.0),
        "provenance": "human",
    }
    return Annotation(**{**fields, **overrides})


class Fixture:
    """A workspace with a three-asset batch open for annotation, and a scripted
    connection ready to pre-label it. Modeled on ``Fixture`` in
    ``tests/kernel/test_annotation_service.py``."""

    def __init__(
        self,
        tmp_path: Path,
        name: str = "ws",
        *,
        classes: tuple[LabelClass, ...] = (SIGN, LANE),
        pool_kind: str = "detector",
        regions: tuple[PredictedRegion, ...] = DEFAULT_REGIONS,
    ) -> None:
        self.workspace = WorkspaceService.init(tmp_path / name)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.connections = InferenceConnectionService(self.workspace)
        self.project = ProjectService(self.workspace).create(f"{name}-project")
        self.schemas.create_version(self.project.id, list(classes))
        self.assets = [self._asset(f"{name}-{index}") for index in range(3)]
        self.batch = self.batches.create(self.project.id, "first", self.assets)
        self.batches.approve(self.batch.id)
        self._job_id = self.batches.jobs(self.batch.id)[0].id
        self.batches.start(self.batch.id)
        self.jobs.start(self._job_id)
        self.connection = self.connections.create(
            f"{name}-connection",
            connection_type=ConnectionType.HTTP,
            model_id="acme/detector",
            model_revision="abc123",
            endpoint_url="http://localhost:9",
        )
        self.pool = FakeProviderPool(kind=pool_kind, regions=regions)

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

    def job(self) -> AnnotationJob:
        return self.jobs.get(self._job_id)

    def label_by_hand(self, asset_id: UUID) -> None:
        self.annotations.add(self._job_id, [_box(asset_id)])

    def annotations_on(self, asset_id: UUID) -> list[Annotation]:
        return self.annotations.for_asset(self._job_id, asset_id)

    def close(self) -> None:
        self.workspace.close()


@pytest.fixture
def prelabel_fixture(tmp_path: Path) -> Iterator[Fixture]:
    fixture = Fixture(tmp_path)
    yield fixture
    fixture.close()


@pytest.fixture
def polygon_only_fixture(tmp_path: Path) -> Iterator[Fixture]:
    fixture = Fixture(tmp_path, "polygon-only", classes=(LANE,))
    yield fixture
    fixture.close()


@pytest.fixture
def segmenter_fixture(tmp_path: Path) -> Iterator[Fixture]:
    fixture = Fixture(tmp_path, "segmenter", pool_kind="segmenter")
    yield fixture
    fixture.close()


@pytest.fixture
def empty_answer_fixture(tmp_path: Path) -> Iterator[Fixture]:
    fixture = Fixture(tmp_path, "empty-answer", regions=())
    yield fixture
    fixture.close()


# --- the tests themselves -------------------------------------------------


def test_the_default_floor_sits_below_the_observed_detection_range() -> None:
    """Text detection scores prompt affinity, observed 37-78%."""
    assert DEFAULT_MINIMUM_CONFIDENCE == 0.35


def test_every_untouched_asset_is_labeled_and_awaits_review(prelabel_fixture: Fixture) -> None:
    outcome = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    assert outcome.assets_considered == 3
    assert outcome.assets_labeled == 3
    job = prelabel_fixture.job()
    for asset_id in prelabel_fixture.assets:
        assert job.progress[asset_id] is AssetProgress.REVIEW_PENDING


def test_an_asset_somebody_worked_is_passed_over_silently(prelabel_fixture: Fixture) -> None:
    """Passing over is what the caller asked for, not an error anybody made."""
    prelabel_fixture.label_by_hand(prelabel_fixture.assets[0])

    outcome = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    assert outcome.assets_considered == 2
    job = prelabel_fixture.job()
    assert job.progress[prelabel_fixture.assets[0]] is AssetProgress.ANNOTATED


def test_a_second_run_picks_up_only_what_is_still_untouched(prelabel_fixture: Fixture) -> None:
    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    again = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    assert again.assets_considered == 0
    assert again.annotations_written == 0


def test_every_written_label_carries_its_provenance(prelabel_fixture: Fixture) -> None:
    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    written = prelabel_fixture.annotations_on(prelabel_fixture.assets[0])
    assert written
    for annotation in written:
        assert annotation.provenance == "model"
        assert annotation.model_ref
        assert annotation.confidence is not None


def test_the_phrases_are_the_schema_s_box_classes(prelabel_fixture: Fixture) -> None:
    """The schema is the prompt, so nothing comes back that cannot be written."""
    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    assert prelabel_fixture.pool.last_prompt.phrases == ("sign",)


def test_a_schema_with_no_box_class_is_refused_before_anything_loads(
    polygon_only_fixture: Fixture,
) -> None:
    with pytest.raises(SchemaHasNoDetectableClass):
        pre_label(
            polygon_only_fixture.workspace,
            batch_id=polygon_only_fixture.batch.id,
            connection_id=polygon_only_fixture.connection.id,
            pool=polygon_only_fixture.pool,
        )

    assert polygon_only_fixture.pool.calls == 0


def test_a_point_prompt_connection_is_refused(segmenter_fixture: Fixture) -> None:
    """A segmenter has no predict to be asked, and guessing is not the alternative."""
    with pytest.raises(UnsupportedPrompt):
        pre_label(
            segmenter_fixture.workspace,
            batch_id=segmenter_fixture.batch.id,
            connection_id=segmenter_fixture.connection.id,
            pool=segmenter_fixture.pool,
        )


def test_an_asset_the_model_found_nothing_on_stays_untouched(
    empty_answer_fixture: Fixture,
) -> None:
    """ "Found nothing" and "reviewed and found empty" are different facts."""
    outcome = pre_label(
        empty_answer_fixture.workspace,
        batch_id=empty_answer_fixture.batch.id,
        connection_id=empty_answer_fixture.connection.id,
        pool=empty_answer_fixture.pool,
    )

    assert outcome.assets_labeled == 0
    job = empty_answer_fixture.job()
    assert job.progress[empty_answer_fixture.assets[0]] is AssetProgress.UNANNOTATED


def test_stopping_leaves_what_was_entered_entered(prelabel_fixture: Fixture) -> None:
    """Cancellation is between assets, so nothing is half-written."""
    seen = iter([False, True, True, True])

    outcome = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        should_stop=lambda: next(seen),
        pool=prelabel_fixture.pool,
    )

    assert outcome.stopped_early is True
    assert outcome.assets_labeled == 1
    job = prelabel_fixture.job()
    at_review = [
        asset_id
        for asset_id in prelabel_fixture.assets
        if job.progress[asset_id] is AssetProgress.REVIEW_PENDING
    ]
    assert len(at_review) == 1


def test_progress_is_reported_in_assets(prelabel_fixture: Fixture) -> None:
    reported: list[tuple[int, int]] = []

    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        on_progress=lambda done, total: reported.append((done, total)),
        pool=prelabel_fixture.pool,
    )

    assert reported[-1] == (3, 3)
