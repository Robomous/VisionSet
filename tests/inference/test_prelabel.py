"""Pre-labeling: what a run touches, what it writes, and what it refuses."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from io import BytesIO
from pathlib import Path
from typing import Final
from uuid import UUID, uuid4

import pytest

from visionset.inference.prelabel import (
    DEFAULT_MINIMUM_CONFIDENCE,
    PreLabelExcludedClass,
    PreLabelExclusionReason,
    PreLabelPlan,
    detectable_classes,
    no_detectable_class_message,
    planned,
    pre_label,
    prompt_plan,
    select_pre_labelable,
    served_for,
)
from visionset.kernel import (
    BatchNotFound,
    BatchNotInAnnotation,
    ProjectNotFound,
    SchemaHasNoDetectableClass,
    UnsupportedPrompt,
)
from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationSchema,
    Asset,
    AssetPrediction,
    AssetProgress,
    Attribute,
    BboxGeometry,
    ConnectionType,
    GeometryType,
    InferenceConnection,
    LabelClass,
    ModelCapability,
    PolygonGeometry,
    PredictedRegion,
    PredictionRequest,
    Prompt,
    ServedFamily,
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

#: The kernel suite's own ``SIGN`` shape: a bbox class carrying a required
#: attribute. A bare model prediction has no attribute values to give it, so
#: this is the class ``detectable_classes`` must exclude even though it admits
#: bbox — that it is the real suite's own shape is the point.
SIGN = LabelClass(
    name="sign",
    geometries=(GeometryType.BBOX,),
    attributes=(Attribute(name="occluded", kind="boolean", required=True),),
)
#: A bbox class with no required attribute — what a bare prediction can
#: actually satisfy, and the one name the phrase-derivation test expects back.
POST = LabelClass(name="post", geometries=(GeometryType.BBOX,))
#: A class no box could ever satisfy, so a schema built only from this refuses
#: pre-labeling before anything runs.
LANE = LabelClass(name="lane", geometries=(GeometryType.POLYGON,))

#: The real schema the bug report was filed against: five classes, each
#: declaring both ``bbox`` and ``polygon`` and no attributes. Multi-geometry on
#: purpose — ``detectable_classes`` intersects a class's geometries with what
#: the model produces rather than comparing them, and this is the shape that
#: actually reached the failing run.
CAR = LabelClass(name="car", geometries=(GeometryType.BBOX, GeometryType.POLYGON))
TRUCK = LabelClass(name="truck", geometries=(GeometryType.BBOX, GeometryType.POLYGON))
MOTORCYCLE = LabelClass(name="motorcycle", geometries=(GeometryType.BBOX, GeometryType.POLYGON))
PEDESTRIAN = LabelClass(name="pedestrian", geometries=(GeometryType.BBOX, GeometryType.POLYGON))
BUS = LabelClass(name="bus", geometries=(GeometryType.BBOX, GeometryType.POLYGON))
VEHICLE_CLASSES: Final = (CAR, TRUCK, MOTORCYCLE, PEDESTRIAN, BUS)

#: The shapes a model declares it answers in, which is what a plan is derived
#: against — a detector that draws boxes, one that traces polygons, one that does
#: both.
BOXES: Final = frozenset({GeometryType.BBOX})
POLYGONS: Final = frozenset({GeometryType.POLYGON})
EITHER: Final = BOXES | POLYGONS

DEFAULT_REGIONS: Final = (
    PredictedRegion(
        label="post", confidence=0.62, geometry=BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0)
    ),
)


def _region(label: str, confidence: float = 0.9) -> PredictedRegion:
    """A predicted box under ``label``, the shape a text-prompted detector answers with."""
    return PredictedRegion(
        label=label,
        confidence=confidence,
        geometry=BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
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
            if self._pool.on_asset is not None:
                # Runs between the run reading this asset and it writing the
                # answer — exactly where a concurrent annotator's edit would
                # land in a real run, which is what makes this the seam a
                # mid-run race test hooks into.
                self._pool.on_asset(target.asset_id)
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
        on_asset: Callable[[UUID], None] | None = None,
        produces: frozenset[GeometryType] = BOXES,
    ) -> None:
        self.calls = 0
        self.produces = produces
        self.last_prompt: Prompt | None = None
        self.model_ref = model_ref
        self.regions = regions
        self._kind = kind
        #: Called with each asset's id right before its answer is yielded, so a
        #: test can move an asset underneath a run in flight the same moment a
        #: real concurrent annotator would.
        self.on_asset = on_asset

    def get(self, connection: InferenceConnection, *, workspace_root: Path) -> object:
        if self._kind == "segmenter":
            return FakeSegmenter()
        return FakeModelProvider(self)

    def served(self, connection: InferenceConnection, *, workspace_root: Path) -> ServedFamily:
        if self._kind == "segmenter":
            return ServedFamily(
                capability=ModelCapability.POINT_SUGGEST,
                produces=frozenset({GeometryType.POLYGON, GeometryType.BBOX}),
            )
        return ServedFamily(capability=ModelCapability.TEXT_DETECT, produces=self.produces)


def _box(asset_id: UUID, **overrides: object) -> Annotation:
    """A valid ``sign``, drawn by hand: a bbox carrying its required attribute.

    Human provenance, so filling the attribute in is exactly what a person
    does and a model does not — the fact this whole fix round is about.
    """
    fields: dict[str, object] = {
        "asset_id": asset_id,
        "label_class": "sign",
        "schema_version": 1,
        "geometry": BboxGeometry(x=1.0, y=2.0, width=30.0, height=40.0),
        "attributes": {"occluded": False},
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
        classes: tuple[LabelClass, ...] = (SIGN, POST, LANE),
        pool_kind: str = "detector",
        regions: tuple[PredictedRegion, ...] = DEFAULT_REGIONS,
        asset_count: int = 3,
        asset_size: tuple[int, int] | None = None,
        produces: frozenset[GeometryType] = BOXES,
    ) -> None:
        self.workspace = WorkspaceService.init(tmp_path / name)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.connections = InferenceConnectionService(self.workspace)
        self.project = ProjectService(self.workspace).create(f"{name}-project")
        self.schemas.create_version(self.project.id, list(classes))
        self.assets = [
            self._asset(
                f"{name}-{index}",
                width=None if asset_size is None else asset_size[0],
                height=None if asset_size is None else asset_size[1],
            )
            for index in range(asset_count)
        ]
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
        self.pool = FakeProviderPool(kind=pool_kind, regions=regions, produces=produces)

    def _asset(self, seed: str, *, width: int | None = None, height: int | None = None) -> UUID:
        content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
        with self.workspace.unit_of_work() as uow:
            return uow.assets.add(
                Asset(
                    project_id=self.project.id,
                    content_hash=content_hash,
                    uri=f"/tmp/{seed}.png",
                    width=width,
                    height=height,
                )
            ).id

    def job(self) -> AnnotationJob:
        return self.jobs.get(self._job_id)

    def label_by_hand(self, asset_id: UUID) -> None:
        self.annotations.add(self._job_id, [_box(asset_id)])

    def mark(self, asset_id: UUID, progress: AssetProgress) -> None:
        self.jobs.mark(self._job_id, asset_id, progress)

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
def required_attribute_fixture(tmp_path: Path) -> Iterator[Fixture]:
    """A batch whose only bbox class is exactly the excluded shape."""
    fixture = Fixture(tmp_path, "required-attribute", classes=(SIGN,))
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


@pytest.fixture
def merged_span_fixture(tmp_path: Path) -> Iterator[Fixture]:
    """The bug report, reproduced: a mappable region beside the exact merged
    span observed in the wild — two adjacent phrases the model answered as one."""
    fixture = Fixture(
        tmp_path,
        "merged-span",
        classes=VEHICLE_CLASSES,
        regions=(_region("car"), _region("truck bus")),
    )
    yield fixture
    fixture.close()


@pytest.fixture
def only_unmappable_fixture(tmp_path: Path) -> Iterator[Fixture]:
    """Every region the model answered with is unmappable — nothing to write."""
    fixture = Fixture(
        tmp_path, "only-unmappable", classes=VEHICLE_CLASSES, regions=(_region("truck bus"),)
    )
    yield fixture
    fixture.close()


@pytest.fixture
def partly_off_frame_fixture(tmp_path: Path) -> Iterator[Fixture]:
    fixture = Fixture(
        tmp_path,
        "partly-off-frame",
        asset_count=1,
        asset_size=(100, 80),
        regions=(
            *DEFAULT_REGIONS,
            PredictedRegion(
                label="post",
                confidence=0.9,
                geometry=BboxGeometry(x=101.0, y=10.0, width=5.0, height=5.0),
            ),
        ),
    )
    yield fixture
    fixture.close()


@pytest.fixture
def only_off_frame_fixture(tmp_path: Path) -> Iterator[Fixture]:
    fixture = Fixture(
        tmp_path,
        "only-off-frame",
        asset_count=1,
        asset_size=(100, 80),
        regions=(
            PredictedRegion(
                label="post",
                confidence=0.9,
                geometry=BboxGeometry(x=101.0, y=10.0, width=5.0, height=5.0),
            ),
        ),
    )
    yield fixture
    fixture.close()


@pytest.fixture
def early_stop_off_frame_fixture(tmp_path: Path) -> Iterator[Fixture]:
    fixture = Fixture(
        tmp_path,
        "early-stop-off-frame",
        asset_count=2,
        asset_size=(100, 80),
        regions=(
            *DEFAULT_REGIONS,
            PredictedRegion(
                label="post",
                confidence=0.9,
                geometry=BboxGeometry(x=101.0, y=10.0, width=5.0, height=5.0),
            ),
        ),
    )
    yield fixture
    fixture.close()


@pytest.fixture
def capitalized_class_fixture(tmp_path: Path) -> Iterator[Fixture]:
    """A schema class spelled with a capital, against the casefolded answer a
    prompt built from it would actually receive back."""
    fixture = Fixture(
        tmp_path,
        "capitalized-class",
        classes=(LabelClass(name="Car", geometries=(GeometryType.BBOX, GeometryType.POLYGON)),),
        regions=(_region("car"),),
    )
    yield fixture
    fixture.close()


# --- the tests themselves -------------------------------------------------


def test_the_default_floor_sits_below_the_observed_detection_range() -> None:
    """Text detection scores prompt affinity, observed 37-78%."""
    assert DEFAULT_MINIMUM_CONFIDENCE == 0.35


def test_every_untouched_asset_is_labeled_and_enters_pre_labeled(prelabel_fixture: Fixture) -> None:
    """Unattended labels enter their own editable state, not the human-review
    queue: a model's guess never claims to be work a person has already judged."""
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
        assert job.progress[asset_id] is AssetProgress.PRE_LABELED


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


def test_a_skipped_and_restored_asset_is_passed_over_silently(prelabel_fixture: Fixture) -> None:
    """``annotated -> skipped -> unannotated`` deletes no labels, so the asset
    reads ``unannotated`` again while a person's boxes still sit on it. The run
    must pass it over the same way it passes over any touched asset, rather
    than reaching the kernel's refusal for it."""
    asset_id = prelabel_fixture.assets[0]
    prelabel_fixture.label_by_hand(asset_id)
    prelabel_fixture.mark(asset_id, AssetProgress.SKIPPED)
    prelabel_fixture.mark(asset_id, AssetProgress.UNANNOTATED)

    outcome = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    assert outcome.assets_considered == 2
    assert len(prelabel_fixture.annotations_on(asset_id)) == 1
    assert prelabel_fixture.job().progress[asset_id] is AssetProgress.UNANNOTATED


def test_an_asset_that_moves_mid_run_is_skipped_and_the_run_completes(
    prelabel_fixture: Fixture,
) -> None:
    """The batch is `in_annotation`, so somebody working in it while a run is
    mid-flight is the normal case, not a race to fail the whole run over. The
    asset that moved is skipped; the rest are entered; the outcome says so."""
    moved_asset = prelabel_fixture.assets[1]

    def move_it(asset_id: UUID) -> None:
        if asset_id == moved_asset:
            prelabel_fixture.mark(asset_id, AssetProgress.SKIPPED)

    prelabel_fixture.pool.on_asset = move_it

    outcome = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    assert outcome.assets_considered == 3
    assert outcome.assets_labeled == 2
    assert outcome.assets_skipped == 1
    job = prelabel_fixture.job()
    assert job.progress[moved_asset] is AssetProgress.SKIPPED
    for asset_id in prelabel_fixture.assets:
        if asset_id != moved_asset:
            assert job.progress[asset_id] is AssetProgress.PRE_LABELED


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


def test_the_phrases_are_the_schema_s_askable_classes(prelabel_fixture: Fixture) -> None:
    """The schema is the prompt, so nothing comes back that cannot be written."""
    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    assert prelabel_fixture.pool.last_prompt.phrases == ("post",)


def test_a_schema_with_no_producible_class_is_refused_before_anything_loads(
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


def test_the_filter_excludes_a_class_a_prediction_cannot_satisfy() -> None:
    """A required attribute excludes a class exactly as missing bbox does.

    ``SIGN`` admits bbox and would pass a geometry-only filter; it is excluded
    because a bare prediction has no attribute values to give its required
    ``occluded``. ``POST`` admits bbox and declares nothing required, so it is
    the one name that survives. ``LANE`` never admitted bbox at all.
    """
    schema = AnnotationSchema(project_id=uuid4(), version=1, classes=(SIGN, POST, LANE))
    assert detectable_classes(schema, BOXES) == ("post",)


def test_the_plan_names_every_left_out_class_with_its_reason() -> None:
    """The two halves are one derivation, so a class lands in exactly one.

    ``SIGN`` is excluded for its required attribute alone — it admits bbox —
    and ``LANE`` for its geometry alone, which is what makes the two reasons
    distinguishable rather than a single "not askable" verdict.
    """
    schema = AnnotationSchema(project_id=uuid4(), version=1, classes=(SIGN, POST, LANE))

    plan = prompt_plan(schema, BOXES)

    assert plan.asked == ("post",)
    assert plan.excluded == (
        PreLabelExcludedClass(name="sign", reasons=(PreLabelExclusionReason.REQUIRED_ATTRIBUTE,)),
        PreLabelExcludedClass(
            name="lane", reasons=(PreLabelExclusionReason.NO_PRODUCIBLE_GEOMETRY,)
        ),
    )


def test_a_class_failing_both_tests_reports_both_reasons() -> None:
    """One reason would read as the whole answer.

    Told only that ``crossing`` admits no box, somebody adds bbox to it and
    watches it stay silently absent — which is the exact shape of the confusion
    the plan exists to end.
    """
    crossing = LabelClass(
        name="crossing",
        geometries=(GeometryType.POLYGON,),
        attributes=(Attribute(name="painted", kind="boolean", required=True),),
    )
    schema = AnnotationSchema(project_id=uuid4(), version=1, classes=(POST, crossing))

    plan = prompt_plan(schema, BOXES)

    assert plan.asked == ("post",)
    assert plan.excluded == (
        PreLabelExcludedClass(
            name="crossing",
            reasons=(
                PreLabelExclusionReason.NO_PRODUCIBLE_GEOMETRY,
                PreLabelExclusionReason.REQUIRED_ATTRIBUTE,
            ),
        ),
    )


def test_the_prompt_is_the_plan_and_not_a_second_derivation() -> None:
    """``detectable_classes`` reads the plan, so the two cannot disagree."""
    schema = AnnotationSchema(
        project_id=uuid4(), version=1, classes=(SIGN, POST, LANE, *VEHICLE_CLASSES)
    )

    assert detectable_classes(schema, BOXES) == prompt_plan(schema, BOXES).asked


def test_a_run_announces_the_plan_it_is_about_to_prompt_with(
    prelabel_fixture: Fixture,
) -> None:
    """What a terminal prints before the first forward pass.

    Announced once, after the refusals and before any model runs, and carrying
    the same phrases the provider is then asked for — a plan derived beside the
    run rather than inside it could differ from what the run does.
    """
    seen: list[object] = []

    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        on_plan=seen.append,
        pool=prelabel_fixture.pool,
    )

    assert len(seen) == 1
    plan = seen[0]
    assert isinstance(plan, PreLabelPlan)
    assert plan.asked == prelabel_fixture.pool.last_prompt.phrases


def test_a_refused_run_announces_no_plan(polygon_only_fixture: Fixture) -> None:
    """The positive path above is what makes this absence mean anything.

    A schema with nothing askable never reaches the announcement, so a surface
    cannot print a prompt for a run that will not happen.
    """
    seen: list[object] = []

    with pytest.raises(SchemaHasNoDetectableClass):
        pre_label(
            polygon_only_fixture.workspace,
            batch_id=polygon_only_fixture.batch.id,
            connection_id=polygon_only_fixture.connection.id,
            on_plan=seen.append,
            pool=polygon_only_fixture.pool,
        )

    assert seen == []


def test_a_bbox_class_with_a_required_attribute_is_refused_before_anything_loads(
    required_attribute_fixture: Fixture,
) -> None:
    """The whole-run consequence of the filter above: a schema whose only bbox
    class demands an attribute a model cannot supply is refused up front,
    exactly like a schema with no bbox class at all — never accepted and then
    failed inside a run.
    """
    with pytest.raises(SchemaHasNoDetectableClass):
        pre_label(
            required_attribute_fixture.workspace,
            batch_id=required_attribute_fixture.batch.id,
            connection_id=required_attribute_fixture.connection.id,
            pool=required_attribute_fixture.pool,
        )

    assert required_attribute_fixture.pool.calls == 0


def test_a_point_prompt_connection_is_refused(segmenter_fixture: Fixture) -> None:
    """A segmenter has no predict to be asked, and guessing is not the alternative."""
    with pytest.raises(UnsupportedPrompt):
        pre_label(
            segmenter_fixture.workspace,
            batch_id=segmenter_fixture.batch.id,
            connection_id=segmenter_fixture.connection.id,
            pool=segmenter_fixture.pool,
        )


def test_a_batch_that_is_not_in_annotation_is_refused_before_anything_loads(
    tmp_path: Path,
) -> None:
    """The connection resolves first — its own docstring's order — but the
    model is never asked: the batch-state gate stops the run before the loop
    that would ask it anything, exactly like the two schema refusals above."""
    workspace = WorkspaceService.init(tmp_path / "draft-ws")
    try:
        batches = BatchService(workspace)
        connections = InferenceConnectionService(workspace)
        project = ProjectService(workspace).create("draft-project")
        SchemaService(workspace).create_version(project.id, [POST])
        content_hash = workspace.blob_store.put(BytesIO(b"draft"))
        with workspace.unit_of_work() as uow:
            asset_id = uow.assets.add(
                Asset(project_id=project.id, content_hash=content_hash, uri="/draft.png")
            ).id
        # A draft, never approved: `require_pre_labelable` refuses every state
        # but `in_annotation`, and a draft is the one furthest from it.
        batch = batches.create(project.id, "first", [asset_id])
        connection = connections.create(
            "draft-connection",
            connection_type=ConnectionType.HTTP,
            model_id="acme/detector",
            model_revision="abc123",
            endpoint_url="http://localhost:9",
        )
        pool = FakeProviderPool()

        with pytest.raises(BatchNotInAnnotation):
            pre_label(workspace, batch_id=batch.id, connection_id=connection.id, pool=pool)

        assert pool.calls == 0
    finally:
        workspace.close()


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
    pre_labeled = [
        asset_id
        for asset_id in prelabel_fixture.assets
        if job.progress[asset_id] is AssetProgress.PRE_LABELED
    ]
    assert len(pre_labeled) == 1


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


def test_a_merged_span_is_discarded_and_the_run_completes(
    merged_span_fixture: Fixture,
) -> None:
    """The bug: a text-prompted detector can answer with text that was never one
    of the phrases asked for. ``truck bus`` — the exact merged span observed
    against a real model — must not fail the run; it is discarded and counted,
    while the mappable region beside it is entered normally."""
    outcome = pre_label(
        merged_span_fixture.workspace,
        batch_id=merged_span_fixture.batch.id,
        connection_id=merged_span_fixture.connection.id,
        pool=merged_span_fixture.pool,
    )

    assert outcome.assets_considered == 3
    assert outcome.assets_labeled == 3
    assert outcome.annotations_written == 3
    assert outcome.regions_discarded == 3
    job = merged_span_fixture.job()
    for asset_id in merged_span_fixture.assets:
        assert job.progress[asset_id] is AssetProgress.PRE_LABELED
        written = merged_span_fixture.annotations_on(asset_id)
        assert [annotation.label_class for annotation in written] == ["car"]


def test_a_capitalized_class_receives_the_casefolded_answer(
    capitalized_class_fixture: Fixture,
) -> None:
    """The prompt casefolds every phrase (``transformers_provider.prompt_text``),
    so a class spelled ``Car`` sends ``car.`` and the model answers ``car``. The
    match must fold case, and the annotation must carry the schema's own
    spelling rather than the model's."""
    pre_label(
        capitalized_class_fixture.workspace,
        batch_id=capitalized_class_fixture.batch.id,
        connection_id=capitalized_class_fixture.connection.id,
        pool=capitalized_class_fixture.pool,
    )

    written = capitalized_class_fixture.annotations_on(capitalized_class_fixture.assets[0])
    assert [annotation.label_class for annotation in written] == ["Car"]


def test_an_asset_whose_only_regions_are_unmappable_stays_unannotated(
    only_unmappable_fixture: Fixture,
) -> None:
    """ "Found nothing writable" and "reviewed and found empty" are different
    facts: an asset whose only answer is a merged span nobody could attribute
    is left untouched, not entered with zero annotations."""
    outcome = pre_label(
        only_unmappable_fixture.workspace,
        batch_id=only_unmappable_fixture.batch.id,
        connection_id=only_unmappable_fixture.connection.id,
        pool=only_unmappable_fixture.pool,
    )

    assert outcome.assets_labeled == 0
    assert outcome.regions_discarded == 3
    job = only_unmappable_fixture.job()
    for asset_id in only_unmappable_fixture.assets:
        assert job.progress[asset_id] is AssetProgress.UNANNOTATED
        assert only_unmappable_fixture.annotations_on(asset_id) == []


def test_a_region_wholly_outside_a_measured_asset_is_discarded(
    partly_off_frame_fixture: Fixture,
) -> None:
    outcome = pre_label(
        partly_off_frame_fixture.workspace,
        batch_id=partly_off_frame_fixture.batch.id,
        connection_id=partly_off_frame_fixture.connection.id,
        pool=partly_off_frame_fixture.pool,
    )

    assert outcome.annotations_written == 1
    assert outcome.regions_discarded == 0
    assert outcome.regions_out_of_bounds == 1
    assert [
        annotation.geometry
        for annotation in partly_off_frame_fixture.annotations_on(
            partly_off_frame_fixture.assets[0]
        )
    ] == [BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0)]


def test_an_asset_whose_only_regions_are_off_frame_stays_unannotated(
    only_off_frame_fixture: Fixture,
) -> None:
    outcome = pre_label(
        only_off_frame_fixture.workspace,
        batch_id=only_off_frame_fixture.batch.id,
        connection_id=only_off_frame_fixture.connection.id,
        pool=only_off_frame_fixture.pool,
    )

    assert outcome.assets_labeled == 0
    assert outcome.regions_discarded == 0
    assert outcome.regions_out_of_bounds == 1
    job = only_off_frame_fixture.job()
    assert job.progress[only_off_frame_fixture.assets[0]] is AssetProgress.UNANNOTATED
    assert only_off_frame_fixture.annotations_on(only_off_frame_fixture.assets[0]) == []


def test_stopping_after_an_off_frame_region_keeps_its_count(
    early_stop_off_frame_fixture: Fixture,
) -> None:
    seen = iter([False, True])

    outcome = pre_label(
        early_stop_off_frame_fixture.workspace,
        batch_id=early_stop_off_frame_fixture.batch.id,
        connection_id=early_stop_off_frame_fixture.connection.id,
        should_stop=lambda: next(seen),
        pool=early_stop_off_frame_fixture.pool,
    )

    assert outcome.stopped_early is True
    assert outcome.annotations_written == 1
    assert outcome.regions_discarded == 0
    assert outcome.regions_out_of_bounds == 1
    job = early_stop_off_frame_fixture.job()
    assert job.progress[early_stop_off_frame_fixture.assets[0]] is AssetProgress.PRE_LABELED
    assert job.progress[early_stop_off_frame_fixture.assets[1]] is AssetProgress.UNANNOTATED


def test_a_polygon_class_is_asked_of_a_model_that_answers_polygons() -> None:
    """A schema is not a box schema; the model's declaration is what narrows it."""
    schema = AnnotationSchema(project_id=uuid4(), version=1, classes=(POST, LANE))
    assert detectable_classes(schema, POLYGONS) == ("lane",)
    assert prompt_plan(schema, POLYGONS).excluded == (
        PreLabelExcludedClass(
            name="post", reasons=(PreLabelExclusionReason.NO_PRODUCIBLE_GEOMETRY,)
        ),
    )


def test_a_class_admitting_either_shape_is_asked_whichever_the_model_produces() -> None:
    schema = AnnotationSchema(project_id=uuid4(), version=1, classes=(CAR,))
    assert detectable_classes(schema, BOXES) == ("car",)
    assert detectable_classes(schema, POLYGONS) == ("car",)


def test_the_plan_carries_the_shapes_it_was_derived_against() -> None:
    schema = AnnotationSchema(project_id=uuid4(), version=1, classes=(POST,))
    assert prompt_plan(schema, EITHER).produces == EITHER


def test_the_refusal_names_the_shapes_the_model_produces() -> None:
    assert "a box or a polygon can be written as" in no_detectable_class_message(3, EITHER)
    assert "a polygon can be written as" in no_detectable_class_message(3, POLYGONS)


def test_a_polygon_only_schema_runs_against_a_polygon_producing_model(tmp_path: Path) -> None:
    """The bug this round closes: the schema that used to be refused outright."""
    fixture = Fixture(
        tmp_path,
        "polygons",
        classes=(LANE,),
        produces=POLYGONS,
        regions=(
            PredictedRegion(
                label="lane",
                confidence=0.9,
                geometry=PolygonGeometry(points=[(1.0, 1.0), (5.0, 1.0), (5.0, 5.0)]),
            ),
        ),
    )
    try:
        outcome = pre_label(
            fixture.workspace,
            batch_id=fixture.batch.id,
            connection_id=fixture.connection.id,
            pool=fixture.pool,
        )

        assert outcome.annotations_written == 3
        assert fixture.pool.last_prompt.phrases == ("lane",)
    finally:
        fixture.close()


def test_a_region_in_a_shape_its_class_does_not_admit_is_discarded(tmp_path: Path) -> None:
    """The model declares both shapes, the class admits one; the other shape is
    dropped before the atomic write and counted, so one wrong region cannot
    refuse the whole asset."""
    fixture = Fixture(
        tmp_path,
        "mixed",
        classes=(POST,),
        produces=EITHER,
        regions=(
            _region("post"),
            PredictedRegion(
                label="post",
                confidence=0.8,
                geometry=PolygonGeometry(points=[(1.0, 1.0), (5.0, 1.0), (5.0, 5.0)]),
            ),
        ),
    )
    try:
        outcome = pre_label(
            fixture.workspace,
            batch_id=fixture.batch.id,
            connection_id=fixture.connection.id,
            pool=fixture.pool,
        )

        assert outcome.annotations_written == 3
        assert outcome.regions_discarded == 3
    finally:
        fixture.close()


def test_a_region_in_a_shape_the_model_never_declared_is_discarded(tmp_path: Path) -> None:
    """The class admits both shapes, the model declares only one; the shape it
    never declared is dropped before the atomic write and counted, exactly as
    a shape the class does not admit is."""
    fixture = Fixture(
        tmp_path,
        "undeclared",
        classes=(CAR,),
        produces=BOXES,
        regions=(
            _region("car"),
            PredictedRegion(
                label="car",
                confidence=0.8,
                geometry=PolygonGeometry(points=[(1.0, 1.0), (5.0, 1.0), (5.0, 5.0)]),
            ),
        ),
    )
    try:
        outcome = pre_label(
            fixture.workspace,
            batch_id=fixture.batch.id,
            connection_id=fixture.connection.id,
            pool=fixture.pool,
        )

        assert outcome.annotations_written == 3
        assert outcome.regions_discarded == 3
    finally:
        fixture.close()


def test_served_for_returns_the_connections_declared_family(prelabel_fixture: Fixture) -> None:
    declared = served_for(
        prelabel_fixture.workspace, prelabel_fixture.connection.id, pool=prelabel_fixture.pool
    )

    assert declared == ServedFamily(capability=ModelCapability.TEXT_DETECT, produces=BOXES)


def test_served_for_refuses_a_point_prompt_connection(segmenter_fixture: Fixture) -> None:
    with pytest.raises(UnsupportedPrompt):
        served_for(
            segmenter_fixture.workspace,
            segmenter_fixture.connection.id,
            pool=segmenter_fixture.pool,
        )


def test_planned_answers_the_plan_a_run_would_prompt_with(prelabel_fixture: Fixture) -> None:
    plan = planned(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )

    assert plan.asked == ("post",)
    assert plan.produces == BOXES
    assert prelabel_fixture.pool.calls == 0


def test_planned_refuses_a_point_prompt_connection(segmenter_fixture: Fixture) -> None:
    """The same refusal, in the same order, as a run of that connection."""
    with pytest.raises(UnsupportedPrompt):
        planned(
            segmenter_fixture.workspace,
            batch_id=segmenter_fixture.batch.id,
            connection_id=segmenter_fixture.connection.id,
            pool=segmenter_fixture.pool,
        )


# --- selecting a project's batches -------------------------------------------


def _second_open_batch(fixture: Fixture, name: str, *, seeds: range) -> UUID:
    """Another batch of ``fixture.project``, approved and started, over fresh assets."""
    assets = [fixture._asset(f"{name}-{seed}") for seed in seeds]
    batch = fixture.batches.create(fixture.project.id, name, assets)
    fixture.batches.approve(batch.id)
    fixture.batches.start(batch.id)
    return batch.id


def test_the_default_selection_is_every_open_batch_in_listing_order(
    prelabel_fixture: Fixture,
) -> None:
    second = _second_open_batch(prelabel_fixture, "second", seeds=range(10, 12))
    draft = prelabel_fixture.batches.create(prelabel_fixture.project.id, "draft", [])

    selected = select_pre_labelable(prelabel_fixture.workspace, prelabel_fixture.project.id, BOXES)

    assert [one.id for one in selected] == [prelabel_fixture.batch.id, second]
    assert draft.id not in {one.id for one in selected}


def test_a_named_selection_keeps_its_order_and_collapses_duplicates(
    prelabel_fixture: Fixture,
) -> None:
    second = _second_open_batch(prelabel_fixture, "second", seeds=range(10, 12))

    selected = select_pre_labelable(
        prelabel_fixture.workspace,
        prelabel_fixture.project.id,
        BOXES,
        [second, prelabel_fixture.batch.id, second],
    )

    assert [one.id for one in selected] == [second, prelabel_fixture.batch.id]


def _asset_for(fixture: Fixture, project_id: UUID, seed: str) -> UUID:
    """An asset seeded like ``Fixture._asset``, but owned by a different project."""
    content_hash = fixture.workspace.blob_store.put(BytesIO(seed.encode()))
    with fixture.workspace.unit_of_work() as uow:
        return uow.assets.add(
            Asset(project_id=project_id, content_hash=content_hash, uri=f"/tmp/{seed}.png")
        ).id


def test_a_named_batch_of_another_project_is_not_found(prelabel_fixture: Fixture) -> None:
    other = ProjectService(prelabel_fixture.workspace).create("other-project")
    asset = _asset_for(prelabel_fixture, other.id, "other-0")
    theirs = prelabel_fixture.batches.create(other.id, "theirs", [asset])

    with pytest.raises(BatchNotFound, match="in project"):
        select_pre_labelable(
            prelabel_fixture.workspace, prelabel_fixture.project.id, BOXES, [theirs.id]
        )


def test_a_named_batch_that_is_not_open_is_refused(prelabel_fixture: Fixture) -> None:
    draft = prelabel_fixture.batches.create(prelabel_fixture.project.id, "draft", [])

    with pytest.raises(BatchNotInAnnotation, match="draft"):
        select_pre_labelable(
            prelabel_fixture.workspace, prelabel_fixture.project.id, BOXES, [draft.id]
        )


def test_a_project_with_no_open_batch_is_refused_by_name(prelabel_fixture: Fixture) -> None:
    for job in prelabel_fixture.batches.jobs(prelabel_fixture.batch.id):
        for asset_id in job.progress:
            prelabel_fixture.jobs.mark(job.id, asset_id, AssetProgress.SKIPPED)
        prelabel_fixture.jobs.complete(job.id)
    prelabel_fixture.batches.complete(prelabel_fixture.batch.id)

    with pytest.raises(BatchNotInAnnotation, match="has no batch open for annotation"):
        select_pre_labelable(prelabel_fixture.workspace, prelabel_fixture.project.id, BOXES)


def test_an_explicitly_empty_selection_is_refused_by_its_own_sentence(
    prelabel_fixture: Fixture,
) -> None:
    with pytest.raises(BatchNotInAnnotation, match="no batch named"):
        select_pre_labelable(prelabel_fixture.workspace, prelabel_fixture.project.id, BOXES, [])


def test_an_unknown_project_is_not_found(prelabel_fixture: Fixture) -> None:
    with pytest.raises(ProjectNotFound):
        select_pre_labelable(prelabel_fixture.workspace, uuid4(), BOXES)


def test_a_selected_batch_with_no_detectable_class_is_refused_by_name(
    prelabel_fixture: Fixture,
) -> None:
    """The refusal names the batch, because a project-wide request cannot otherwise
    say which pin to exclude by name."""
    prelabel_fixture.schemas.create_version(
        prelabel_fixture.project.id, [LANE], allow_destructive=True
    )
    _second_open_batch(prelabel_fixture, "lanes", seeds=range(20, 22))

    with pytest.raises(SchemaHasNoDetectableClass, match="batch 'lanes'"):
        select_pre_labelable(prelabel_fixture.workspace, prelabel_fixture.project.id, BOXES)


def test_a_polygon_only_schema_is_selected_for_a_model_that_produces_polygons(
    polygon_only_fixture: Fixture,
) -> None:
    selected = select_pre_labelable(
        polygon_only_fixture.workspace, polygon_only_fixture.project.id, POLYGONS
    )

    assert [one.id for one in selected] == [polygon_only_fixture.batch.id]


def test_a_replacing_run_rewrites_every_pre_labeled_frame_and_counts_what_it_replaced(
    prelabel_fixture: Fixture,
) -> None:
    first = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )
    before = {
        a: [x.id for x in prelabel_fixture.annotations_on(a)] for a in prelabel_fixture.assets
    }

    again = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        replace_model_labels=True,
        pool=prelabel_fixture.pool,
    )

    assert again.assets_considered == 3
    assert again.assets_labeled == 3
    assert again.annotations_written == first.annotations_written == 3
    assert again.annotations_replaced == 3
    job = prelabel_fixture.job()
    for asset_id in prelabel_fixture.assets:
        now = [x.id for x in prelabel_fixture.annotations_on(asset_id)]
        assert len(now) == 1 and now != before[asset_id]
        assert job.progress[asset_id] is AssetProgress.PRE_LABELED


def test_a_replacing_run_leaves_a_persons_frame_alone(prelabel_fixture: Fixture) -> None:
    """Confirmed means judged: `pre_labeled -> annotated` by `mark`, labels untouched."""
    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )
    confirmed = prelabel_fixture.assets[0]
    prelabel_fixture.mark(confirmed, AssetProgress.ANNOTATED)
    kept = [x.id for x in prelabel_fixture.annotations_on(confirmed)]

    again = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        replace_model_labels=True,
        pool=prelabel_fixture.pool,
    )

    assert again.assets_considered == 2
    assert again.annotations_replaced == 2
    assert [x.id for x in prelabel_fixture.annotations_on(confirmed)] == kept
    assert prelabel_fixture.job().progress[confirmed] is AssetProgress.ANNOTATED


def test_a_replacing_run_also_enters_frames_still_untouched(prelabel_fixture: Fixture) -> None:
    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )
    # Discard one frame's model labels by hand: back to untouched.
    discarded = prelabel_fixture.assets[1]
    ids = [x.id for x in prelabel_fixture.annotations_on(discarded)]
    prelabel_fixture.annotations.delete(prelabel_fixture.job().id, ids)
    assert prelabel_fixture.job().progress[discarded] is AssetProgress.UNANNOTATED

    again = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        replace_model_labels=True,
        pool=prelabel_fixture.pool,
    )

    assert again.assets_considered == 3
    assert again.assets_labeled == 3
    assert again.annotations_replaced == 2
    assert prelabel_fixture.job().progress[discarded] is AssetProgress.PRE_LABELED


def test_a_replacing_run_that_finds_nothing_now_returns_the_frame_to_unannotated(
    prelabel_fixture: Fixture,
) -> None:
    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )
    prelabel_fixture.pool.regions = ()

    again = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        replace_model_labels=True,
        pool=prelabel_fixture.pool,
    )

    assert again.assets_considered == 3
    assert again.assets_labeled == 0
    assert again.annotations_written == 0
    assert again.annotations_replaced == 3
    for asset_id in prelabel_fixture.assets:
        assert prelabel_fixture.annotations_on(asset_id) == []
        assert prelabel_fixture.job().progress[asset_id] is AssetProgress.UNANNOTATED


def test_a_pre_labeled_frame_taken_over_mid_run_is_skipped_by_a_replacing_run(
    prelabel_fixture: Fixture,
) -> None:
    pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        pool=prelabel_fixture.pool,
    )
    moved = prelabel_fixture.assets[1]

    def confirm_it(asset_id: UUID) -> None:
        if asset_id == moved:
            prelabel_fixture.mark(asset_id, AssetProgress.ANNOTATED)

    prelabel_fixture.pool.on_asset = confirm_it

    again = pre_label(
        prelabel_fixture.workspace,
        batch_id=prelabel_fixture.batch.id,
        connection_id=prelabel_fixture.connection.id,
        replace_model_labels=True,
        pool=prelabel_fixture.pool,
    )

    assert again.assets_skipped == 1
    assert again.annotations_replaced == 2
    assert prelabel_fixture.job().progress[moved] is AssetProgress.ANNOTATED


def test_an_unflagged_second_run_still_never_touches_a_pre_labeled_frame(
    prelabel_fixture: Fixture,
) -> None:
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
    assert again.annotations_replaced == 0
