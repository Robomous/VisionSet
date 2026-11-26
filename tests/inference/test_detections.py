"""Interactive detection: what becomes a candidate, in what order, and that nothing is written."""

from __future__ import annotations

from collections.abc import Iterator
from io import BytesIO
from pathlib import Path
from uuid import UUID

import pytest

from visionset.inference.detections import MAXIMUM_CANDIDATES, Detection, detect
from visionset.kernel import AssetNotFound, GeometryNotProduced, UnsupportedPrompt
from visionset.kernel.domain import (
    Asset,
    AssetPrediction,
    AssetProgress,
    BboxGeometry,
    ConnectionType,
    GeometryType,
    InferenceConnection,
    LabelClass,
    ModelCapability,
    PolygonGeometry,
    PredictedRegion,
    PredictionRequest,
    ServedFamily,
    TextPrompt,
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

CAR = LabelClass(name="car", geometries=(GeometryType.BBOX, GeometryType.POLYGON))
BOXES = frozenset({GeometryType.BBOX})
MODEL_REF = "acme/detector@abc123"


def box(x: float, y: float, *, label: str = "car", confidence: float = 0.9) -> PredictedRegion:
    return PredictedRegion(
        label=label,
        confidence=confidence,
        geometry=BboxGeometry(x=x, y=y, width=10.0, height=10.0),
    )


class FakeProvider:
    def __init__(self, pool: FakePool) -> None:
        self._pool = pool

    @property
    def model_ref(self) -> str:
        return MODEL_REF

    def predict(self, request: PredictionRequest) -> Iterator[AssetPrediction]:
        self._pool.requests.append(request)
        for target in request.targets:
            yield AssetPrediction(
                asset_id=target.asset_id, model_ref=MODEL_REF, regions=self._pool.regions
            )


class FakeSegmenter:
    def segment(self, request: object) -> None:
        raise AssertionError("detect must never ask a point segmenter")


class FakePool:
    def __init__(
        self,
        regions: tuple[PredictedRegion, ...] = (),
        *,
        produces: frozenset[GeometryType] = BOXES,
        segmenter: bool = False,
    ) -> None:
        self.regions = regions
        self.produces = produces
        self.segmenter = segmenter
        self.requests: list[PredictionRequest] = []

    def get(self, connection: InferenceConnection, *, workspace_root: Path) -> object:
        return FakeSegmenter() if self.segmenter else FakeProvider(self)

    def served(self, connection: InferenceConnection, *, workspace_root: Path) -> ServedFamily:
        return ServedFamily(capability=ModelCapability.TEXT_DETECT, produces=self.produces)


class World:
    def __init__(self, tmp_path: Path) -> None:
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        projects = ProjectService(self.workspace)
        self.project = projects.create("detecting")
        self.other = projects.create("elsewhere")
        SchemaService(self.workspace).create_version(self.project.id, [CAR])
        self.asset = self._asset(self.project.id, "one")
        self.foreign = self._asset(self.other.id, "two")
        batches = BatchService(self.workspace)
        batch = batches.create(self.project.id, "first", [self.asset])
        batches.approve(batch.id)
        self.job_id = batches.jobs(batch.id)[0].id
        batches.start(batch.id)
        JobService(self.workspace).start(self.job_id)
        self.connection = InferenceConnectionService(self.workspace).create(
            "detector",
            connection_type=ConnectionType.HTTP,
            model_id="acme/detector",
            model_revision="abc123",
            endpoint_url="http://localhost:9",
        )

    def _asset(self, project_id: UUID, seed: str) -> UUID:
        content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
        with self.workspace.unit_of_work() as uow:
            return uow.assets.add(
                Asset(
                    project_id=project_id,
                    content_hash=content_hash,
                    uri=f"/tmp/{seed}.png",
                    width=100,
                    height=80,
                )
            ).id

    def detect(self, pool: FakePool, **overrides: object) -> Detection:
        arguments: dict[str, object] = {
            "project_id": self.project.id,
            "asset_id": self.asset,
            "connection_id": self.connection.id,
            "label_class": "car",
            "allowed": (GeometryType.BBOX, GeometryType.POLYGON),
            "pool": pool,
            **overrides,
        }
        return detect(self.workspace, **arguments)  # type: ignore[arg-type]


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    made = World(tmp_path)
    yield made
    made.workspace.close()


def test_nothing_found_is_an_answer_with_no_candidates(world: World) -> None:
    answer = world.detect(FakePool())

    assert answer.candidates == ()
    assert answer.model_ref == MODEL_REF


def test_one_and_many_are_answered_faithfully_each_with_its_own_score(world: World) -> None:
    one = world.detect(FakePool((box(5, 5, confidence=0.7),)))
    many = world.detect(
        FakePool((box(5, 5, confidence=0.41), box(30, 5, confidence=0.88), box(60, 5)))
    )

    assert [candidate.confidence for candidate in one.candidates] == [0.7]
    assert [candidate.confidence for candidate in many.candidates] == [0.9, 0.88, 0.41]
    assert [candidate.id for candidate in many.candidates] == ["c0", "c1", "c2"]
    assert {candidate.label_class for candidate in many.candidates} == {"car"}


def test_the_class_name_is_the_phrase_unless_one_is_given(world: World) -> None:
    pool = FakePool((box(5, 5, label="Car"), box(30, 5, label="automobile")))

    by_name = world.detect(pool)
    by_phrase = world.detect(pool, phrase="automobile")

    assert [request.prompt for request in pool.requests] == [
        TextPrompt(phrases=("car",)),
        TextPrompt(phrases=("automobile",)),
    ]
    assert [(c.label, c.label_class) for c in by_name.candidates] == [("Car", "car")]
    assert by_name.discarded.unmapped_label == 1
    assert [(c.label, c.label_class) for c in by_phrase.candidates] == [("automobile", "car")]
    assert by_phrase.phrase == "automobile"


def test_a_shape_the_class_does_not_admit_is_dropped_never_widened(world: World) -> None:
    polygon = PredictedRegion(
        label="car",
        confidence=0.95,
        geometry=PolygonGeometry(points=[(1.0, 1.0), (9.0, 1.0), (5.0, 9.0)]),
    )
    pool = FakePool(
        (polygon, box(5, 5)), produces=frozenset({GeometryType.BBOX, GeometryType.POLYGON})
    )

    answer = world.detect(pool, allowed=(GeometryType.BBOX,))

    assert [c.geometry.type for c in answer.candidates] == ["bbox"]
    assert answer.discarded.incompatible_geometry == 1


def test_a_box_model_answers_boxes_for_a_class_that_also_admits_polygons(world: World) -> None:
    polygon = PredictedRegion(
        label="car",
        confidence=0.95,
        geometry=PolygonGeometry(points=[(1.0, 1.0), (9.0, 1.0), (5.0, 9.0)]),
    )
    answer = world.detect(FakePool((polygon, box(5, 5))))

    assert [c.geometry.type for c in answer.candidates] == ["bbox"]
    assert answer.discarded.incompatible_geometry == 1


def test_a_class_no_shape_of_the_model_fits_is_refused(world: World) -> None:
    pool = FakePool((box(5, 5),))

    with pytest.raises(GeometryNotProduced):
        world.detect(pool, allowed=(GeometryType.POLYGON,))
    assert pool.requests == []


def test_order_is_confidence_then_top_then_left(world: World) -> None:
    answer = world.detect(
        FakePool(
            (
                box(50, 20, confidence=0.5),
                box(10, 20, confidence=0.5),
                box(90, 5, confidence=0.5),
                box(70, 40, confidence=0.6),
            )
        )
    )

    assert [(c.geometry.x, c.geometry.y) for c in answer.candidates] == [  # type: ignore[union-attr]
        (70, 40),
        (90, 5),
        (10, 20),
        (50, 20),
    ]


def test_past_the_limit_the_least_confident_are_cut_and_counted(world: World) -> None:
    regions = tuple(
        box(float(index % 90), 5, confidence=round(0.99 - index * 0.001, 3))
        for index in range(MAXIMUM_CANDIDATES + 3)
    )

    answer = world.detect(FakePool(regions))

    assert len(answer.candidates) == MAXIMUM_CANDIDATES
    assert answer.discarded.over_limit == 3
    assert min(c.confidence for c in answer.candidates) > max(
        region.confidence for region in regions[MAXIMUM_CANDIDATES:]
    )


def test_the_floor_is_sent_and_held_to(world: World) -> None:
    pool = FakePool((box(5, 5, confidence=0.3), box(30, 5, confidence=0.6)))

    answer = world.detect(pool, minimum_confidence=0.5)

    assert pool.requests[0].minimum_confidence == 0.5
    assert [c.confidence for c in answer.candidates] == [0.6]
    assert answer.discarded.below_minimum_confidence == 1


def test_a_region_off_the_asset_is_dropped(world: World) -> None:
    answer = world.detect(FakePool((box(150, 5), box(5, 5))))

    assert len(answer.candidates) == 1
    assert answer.discarded.out_of_bounds == 1


def test_a_point_segmenter_is_refused_before_anything_is_asked(world: World) -> None:
    with pytest.raises(UnsupportedPrompt):
        world.detect(FakePool(segmenter=True))


def test_an_asset_of_another_project_is_not_found(world: World) -> None:
    pool = FakePool((box(5, 5),))

    with pytest.raises(AssetNotFound):
        world.detect(pool, asset_id=world.foreign)
    assert pool.requests == []


def test_nothing_is_written(world: World) -> None:
    annotations = AnnotationService(world.workspace)
    jobs = JobService(world.workspace)
    before = jobs.get(world.job_id).progress

    answer = world.detect(FakePool((box(5, 5), box(30, 5))))

    assert len(answer.candidates) == 2
    assert annotations.for_asset(world.job_id, world.asset) == []
    assert jobs.get(world.job_id).progress == before
    assert before[world.asset] is AssetProgress.UNANNOTATED
