"""ImportService: an import is a labeled, approved batch, and nothing more.

See ``docs/content/architecture/decisions/an-import-is-a-labeled-batch.md``.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from tests.fixtures.media import write_image

from visionset.kernel import (
    AssetNotInBatch,
    AssetNotWritable,
    BatchNotEditable,
    DisallowedGeometry,
    DuplicateClassificationTag,
    ImportNotConsented,
    ImportSourceUnreadable,
    InvalidAnnotation,
    InvalidSchema,
    LabelClassNotInSchema,
    StaleWrite,
)
from visionset.kernel.domain import (
    Annotation,
    AssetProgress,
    BatchApproved,
    BatchState,
    BboxGeometry,
    ClassificationGeometry,
    GeometryType,
    ImportConsent,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLoss,
    ImportLossKind,
    LabelClass,
    PolygonGeometry,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    ImportService,
    IngestService,
    JobService,
    ProjectService,
    SchemaService,
    SourceService,
    WorkspaceService,
)

SIZE = (32, 24)
BOX = BboxGeometry(x=2, y=2, width=10, height=8)
TRIANGLE = PolygonGeometry(points=[(4, 4), (20, 4), (4, 18)])
CLASSES = (
    ImportedClass(name="car", geometries=(GeometryType.BBOX,)),
    ImportedClass(name="lane", geometries=(GeometryType.POLYGON,)),
)


class FakeImporter:
    format_name = "fake"

    def __init__(self, dataset: ImportedDataset) -> None:
        self.dataset = dataset

    def read(self, src: Path) -> ImportedDataset:
        return self.dataset


class World:
    def __init__(self, root: Path) -> None:
        self.workspace = WorkspaceService.init(root / "ws")
        self.projects = ProjectService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.datasets = DatasetService(self.workspace)
        self.ingest = IngestService(self.workspace)
        self.sources = SourceService(self.workspace)
        self.imports = ImportService(self.workspace)
        self.project = self.projects.create("imported")
        self.src = root / "src"
        for seed, name in enumerate(("a.png", "b.png", "c.png")):
            write_image(self.src / "images" / name, size=SIZE, seed=seed)

    def labels(self) -> list[Annotation]:
        return [
            label
            for asset in self.ingest.assets(self.project.id)
            for label in self.workspace_annotations(asset.id)
        ]

    def workspace_annotations(self, asset_id: UUID) -> list[Annotation]:
        with self.workspace.unit_of_work() as uow:
            return uow.annotations.list(asset_id)

    def nothing_written(self) -> bool:
        return (
            not self.ingest.assets(self.project.id)
            and not self.batches.list(self.project.id)
            and not self.schemas.list_versions(self.project.id)
        )


def _image(name: str, *labels: ImportedLabel, **size: int) -> ImportedImage:
    return ImportedImage(path=f"images/{name}", labels=labels, **size)


def _dataset(*images: ImportedImage, losses: tuple[ImportLoss, ...] = ()) -> ImportedDataset:
    return ImportedDataset(classes=CLASSES, images=images, losses=losses)


def _labeled() -> ImportedDataset:
    return _dataset(
        _image("a.png", ImportedLabel(class_name="car", geometry=BOX, confidence=0.75)),
        _image(
            "b.png",
            ImportedLabel(class_name="car", geometry=BOX),
            ImportedLabel(class_name="lane", geometry=TRIANGLE),
        ),
        _image("c.png"),
    )


def _loss(kind: ImportLossKind) -> ImportLoss:
    return ImportLoss(kind=kind, subject="car", count=1, reason="test")


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    built = World(tmp_path)
    yield built
    built.workspace.close()


# --- the lifecycle ------------------------------------------------------------


def test_an_import_is_an_approved_batch_seeded_annotated_and_never_further(world: World) -> None:
    run = world.imports.commit(world.project.id, FakeImporter(_labeled()), world.src)

    assert run.batch_id is not None
    batch = world.batches.get(run.batch_id)
    assert batch.state is BatchState.APPROVED
    assert batch.schema_version == run.schema_version == 1
    assert len(run.created_asset_ids) == 3
    assert run.annotations_written == 3

    (job,) = world.batches.jobs(batch.id)
    by_uri = {Path(a.uri).name: a.id for a in world.ingest.assets(world.project.id)}
    assert job.progress == {
        by_uri["a.png"]: AssetProgress.ANNOTATED,
        by_uri["b.png"]: AssetProgress.ANNOTATED,
        by_uri["c.png"]: AssetProgress.UNANNOTATED,
    }
    labels = world.labels()
    assert {label.provenance for label in labels} == {"import"}
    assert {label.job_id for label in labels} == {None}
    assert {label.schema_version for label in labels} == {1}
    assert sorted(label.confidence or 0 for label in labels) == [0, 0, 0.75]
    assert world.datasets.promoted_asset_ids(world.project.id) == frozenset()

    (schema,) = world.schemas.list_versions(world.project.id)
    assert {c.name: c.geometries for c in schema.classes} == {
        "car": (GeometryType.BBOX,),
        "lane": (GeometryType.POLYGON,),
    }


def test_inspect_reports_and_writes_nothing(world: World) -> None:
    dataset = _dataset(
        _image("a.png", ImportedLabel(class_name="car", geometry=BOX)),
        _image("gone.png", ImportedLabel(class_name="car", geometry=BOX)),
        losses=(_loss(ImportLossKind.GEOMETRY),),
    )
    plan = world.imports.inspect(world.project.id, FakeImporter(dataset), world.src)

    assert plan.creates_schema
    assert [str(path) for path in plan.missing_images] == ["images/gone.png"]
    assert {loss.kind for loss in plan.losses} == {ImportLossKind.GEOMETRY, ImportLossKind.IMAGE}
    assert [str(image.path) for image in plan.images] == ["images/a.png"]
    assert world.nothing_written()


# --- consent ------------------------------------------------------------------


def test_a_lossy_import_is_refused_without_consent_and_writes_nothing(world: World) -> None:
    dataset = _dataset(
        _image("a.png", ImportedLabel(class_name="car", geometry=BOX)),
        losses=(_loss(ImportLossKind.LABEL),),
    )
    with pytest.raises(ImportNotConsented, match="label") as refused:
        world.imports.commit(world.project.id, FakeImporter(dataset), world.src)

    assert refused.value.losses == dataset.losses
    assert world.nothing_written()


def test_consent_covers_exactly_the_kinds_it_names(world: World) -> None:
    dataset = _dataset(
        _image("a.png", ImportedLabel(class_name="car", geometry=BOX)),
        _image("gone.png"),
        losses=(_loss(ImportLossKind.LABEL),),
    )
    importer = FakeImporter(dataset)
    for partial in (
        {ImportLossKind.LABEL},
        {ImportLossKind.IMAGE},
        set(ImportLossKind) - {ImportLossKind.IMAGE},
    ):
        with pytest.raises(ImportNotConsented):
            world.imports.commit(
                world.project.id,
                importer,
                world.src,
                consent=ImportConsent(kinds=frozenset(partial)),
            )
        assert world.nothing_written()

    run = world.imports.commit(
        world.project.id,
        importer,
        world.src,
        consent=ImportConsent(kinds=frozenset({ImportLossKind.LABEL, ImportLossKind.IMAGE})),
    )
    assert run.annotations_written == 1
    assert len(run.created_asset_ids) == 1


# --- the schema ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("existing", "refusal"),
    [
        ((LabelClass(name="lane", geometries=(GeometryType.POLYGON,)),), LabelClassNotInSchema),
        (
            (
                LabelClass(name="car", geometries=(GeometryType.POLYGON,)),
                LabelClass(name="lane", geometries=(GeometryType.POLYGON,)),
            ),
            DisallowedGeometry,
        ),
    ],
)
def test_an_existing_schema_is_never_changed_and_an_incompatible_class_refuses(
    world: World, existing: tuple[LabelClass, ...], refusal: type[InvalidAnnotation]
) -> None:
    world.schemas.create_version(world.project.id, list(existing))

    plan = world.imports.inspect(world.project.id, FakeImporter(_labeled()), world.src)
    assert plan.conflicts
    assert not plan.creates_schema
    with pytest.raises(refusal):
        world.imports.commit(world.project.id, FakeImporter(_labeled()), world.src)

    assert [s.version for s in world.schemas.list_versions(world.project.id)] == [1]
    assert not world.ingest.assets(world.project.id)
    assert not world.batches.list(world.project.id)


def test_a_compatible_existing_schema_is_used_as_it_stands(world: World) -> None:
    world.schemas.create_version(
        world.project.id,
        [
            LabelClass(name="car", geometries=(GeometryType.BBOX, GeometryType.POLYGON)),
            LabelClass(name="lane", geometries=(GeometryType.POLYGON,)),
            LabelClass(name="sign", geometries=(GeometryType.BBOX,)),
        ],
    )
    run = world.imports.commit(world.project.id, FakeImporter(_labeled()), world.src)

    assert run.schema_version == 1
    assert [s.version for s in world.schemas.list_versions(world.project.id)] == [1]


def test_an_unused_class_the_schema_lacks_is_a_class_loss(world: World) -> None:
    world.schemas.create_version(
        world.project.id, [LabelClass(name="car", geometries=(GeometryType.BBOX,))]
    )
    dataset = _dataset(_image("a.png", ImportedLabel(class_name="car", geometry=BOX)))
    plan = world.imports.inspect(world.project.id, FakeImporter(dataset), world.src)

    assert [(loss.kind, loss.subject) for loss in plan.losses] == [(ImportLossKind.CLASS, "lane")]


# --- idempotency and atomicity -------------------------------------------------


def test_a_second_run_of_the_same_source_adds_nothing_and_makes_no_batch(world: World) -> None:
    importer = FakeImporter(_labeled())
    first = world.imports.commit(world.project.id, importer, world.src)
    labels_before = sorted(str(label.id) for label in world.labels())

    second = world.imports.commit(world.project.id, importer, world.src)

    assert second.batch_id is None
    assert second.created_asset_ids == ()
    assert second.annotations_written == 0
    assert second.annotations_already_present == 3
    assert len(world.ingest.assets(world.project.id)) == 3
    assert sorted(str(label.id) for label in world.labels()) == labels_before
    assert [batch.id for batch in world.batches.list(world.project.id)] == [first.batch_id]


def test_a_label_outside_its_decoded_image_is_a_reported_loss(world: World) -> None:
    outside = BboxGeometry(x=500, y=500, width=5, height=5)
    dataset = _dataset(
        _image("a.png", ImportedLabel(class_name="car", geometry=BOX)),
        _image("b.png", ImportedLabel(class_name="car", geometry=outside)),
    )
    plan = world.imports.inspect(world.project.id, FakeImporter(dataset), world.src)
    assert [(loss.kind, loss.count) for loss in plan.losses] == [(ImportLossKind.LABEL, 1)]
    with pytest.raises(ImportNotConsented):
        world.imports.commit(world.project.id, FakeImporter(dataset), world.src)
    assert world.nothing_written()

    run = world.imports.commit(
        world.project.id,
        FakeImporter(dataset),
        world.src,
        consent=ImportConsent(kinds=frozenset({ImportLossKind.LABEL})),
    )
    assert run.annotations_written == plan.new_annotations == 1
    assert len(run.created_asset_ids) == plan.new_assets == 2


def test_a_refusal_inside_the_transaction_rolls_back_every_row_and_announces_nothing(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    announced: list[BatchApproved] = []
    world.workspace.event_bus.subscribe(BatchApproved, announced.append)

    def refuse(*_: object, **__: object) -> None:
        raise StaleWrite("injected")

    monkeypatch.setattr(BatchService, "approve_in", refuse)
    with pytest.raises(StaleWrite):
        world.imports.commit(world.project.id, FakeImporter(_labeled()), world.src)

    assert world.nothing_written()
    assert announced == []


def test_a_committed_import_announces_its_approval_exactly_once(world: World) -> None:
    announced: list[BatchApproved] = []
    world.workspace.event_bus.subscribe(BatchApproved, announced.append)

    run = world.imports.commit(world.project.id, FakeImporter(_labeled()), world.src)

    assert [event.batch_id for event in announced] == [run.batch_id]


def test_inspect_predicts_exactly_what_commit_writes(world: World) -> None:
    plan = world.imports.inspect(world.project.id, FakeImporter(_labeled()), world.src)
    run = world.imports.commit(world.project.id, FakeImporter(_labeled()), world.src)

    assert (plan.new_assets, plan.new_annotations) == (3, 3)
    assert (len(run.created_asset_ids), run.annotations_written) == (3, 3)


def test_a_run_with_nothing_to_write_writes_no_schema(world: World) -> None:
    empty = world.imports.commit(world.project.id, FakeImporter(_dataset()), world.src)
    assert empty.batch_id is None
    assert world.nothing_written()

    gone = _dataset(_image("gone.png", ImportedLabel(class_name="car", geometry=BOX)))
    run = world.imports.commit(
        world.project.id,
        FakeImporter(gone),
        world.src,
        consent=ImportConsent(kinds=frozenset({ImportLossKind.IMAGE})),
    )
    assert run.batch_id is None
    assert run.schema_version is None
    assert world.nothing_written()


def test_two_paths_with_the_same_bytes_keep_the_first_and_report_the_rest(world: World) -> None:
    write_image(world.src / "images" / "z.png", size=SIZE, seed=0)
    dataset = _dataset(
        _image("z.png", ImportedLabel(class_name="lane", geometry=TRIANGLE)),
        _image("a.png", ImportedLabel(class_name="car", geometry=BOX)),
    )
    plan = world.imports.inspect(world.project.id, FakeImporter(dataset), world.src)
    assert [(loss.kind, loss.subject) for loss in plan.losses] == [
        (ImportLossKind.IMAGE, "images/z.png")
    ]
    with pytest.raises(ImportNotConsented, match="image"):
        world.imports.commit(world.project.id, FakeImporter(dataset), world.src)

    run = world.imports.commit(
        world.project.id,
        FakeImporter(dataset),
        world.src,
        consent=ImportConsent(kinds=frozenset({ImportLossKind.IMAGE})),
    )
    assert run.annotations_written == 1
    assert [(label.label_class, label.geometry) for label in world.labels()] == [("car", BOX)]


def test_a_re_run_after_a_reviewer_moved_a_box_refuses_rather_than_re_syncs(
    world: World,
) -> None:
    importer = FakeImporter(_labeled())
    first = world.imports.commit(world.project.id, importer, world.src)
    assert first.batch_id is not None
    world.batches.start(first.batch_id)
    (job,) = world.batches.jobs(first.batch_id)
    world.jobs.start(job.id)
    (moved, *_) = [label for label in world.labels() if label.confidence == 0.75]
    world.annotations.update(
        job.id, [moved.model_copy(update={"geometry": BOX.model_copy(update={"x": 3.0})})]
    )

    plan = world.imports.inspect(world.project.id, importer, world.src)
    assert plan.conflicts
    with pytest.raises(AssetNotWritable, match="one-shot"):
        world.imports.commit(world.project.id, importer, world.src)


def test_a_re_run_after_the_batch_was_deleted_returns_no_batch(world: World) -> None:
    importer = FakeImporter(_labeled())
    first = world.imports.commit(world.project.id, importer, world.src)
    assert first.batch_id is not None
    world.batches.delete(first.batch_id, confirm=True)

    second = world.imports.commit(world.project.id, importer, world.src)

    assert second.batch_id is None
    assert world.batches.list(world.project.id) == []


def test_case_colliding_classes_are_a_conflict_inspect_reports(world: World) -> None:
    dataset = ImportedDataset(
        classes=(
            ImportedClass(name="Car", geometries=(GeometryType.BBOX,)),
            ImportedClass(name="car", geometries=(GeometryType.BBOX,)),
        ),
        images=(_image("a.png", ImportedLabel(class_name="car", geometry=BOX)),),
    )
    plan = world.imports.inspect(world.project.id, FakeImporter(dataset), world.src)
    assert plan.conflicts
    with pytest.raises(InvalidSchema, match="collides"):
        world.imports.commit(world.project.id, FakeImporter(dataset), world.src)
    assert world.nothing_written()


def test_a_size_the_file_misstates_is_refused(world: World) -> None:
    dataset = _dataset(_image("a.png", width=SIZE[0] + 1, height=SIZE[1]))
    with pytest.raises(ImportSourceUnreadable, match="wrong frame"):
        world.imports.commit(world.project.id, FakeImporter(dataset), world.src)
    assert world.nothing_written()


def test_a_symbolic_link_out_of_the_source_is_refused(world: World, tmp_path: Path) -> None:
    secret = write_image(tmp_path / "outside" / "secret.png", size=SIZE, seed=9)
    (world.src / "images" / "link.png").symlink_to(secret)
    dataset = _dataset(_image("link.png"))

    with pytest.raises(ImportSourceUnreadable, match="outside the source"):
        world.imports.inspect(world.project.id, FakeImporter(dataset), world.src)
    with pytest.raises(ImportSourceUnreadable, match="outside the source"):
        world.imports.commit(world.project.id, FakeImporter(dataset), world.src)
    assert world.nothing_written()


def test_a_link_swapped_out_of_the_source_after_planning_is_refused_when_stored(
    world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = write_image(tmp_path / "outside" / "a.png", size=SIZE, seed=0)
    real_probe = ImportService._probe

    def probe_then_swap(self: ImportService, path: Path, image: ImportedImage) -> object:
        probed = real_probe(self, path, image)
        path.unlink()
        path.symlink_to(secret)
        return probed

    monkeypatch.setattr(ImportService, "_probe", probe_then_swap)
    dataset = _dataset(_image("a.png"))

    with pytest.raises(ImportSourceUnreadable, match="outside the source"):
        world.imports.commit(world.project.id, FakeImporter(dataset), world.src)
    assert world.nothing_written()


def test_a_source_that_is_not_a_directory_is_refused(world: World) -> None:
    with pytest.raises(ImportSourceUnreadable):
        world.imports.inspect(world.project.id, FakeImporter(_labeled()), world.src / "nope")


# --- add_imported, the narrow door --------------------------------------------


def _import_label(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="car",
        schema_version=1,
        geometry=BOX,
        provenance="import",
    )


def test_add_imported_is_refused_once_the_batch_is_approved(world: World) -> None:
    run = world.imports.commit(world.project.id, FakeImporter(_labeled()), world.src)
    assert run.batch_id is not None
    asset_id = run.created_asset_ids[0]
    before = len(world.labels())

    with pytest.raises(BatchNotEditable):
        world.annotations.add_imported(run.batch_id, [_import_label(asset_id)])
    world.batches.start(run.batch_id)
    with pytest.raises(BatchNotEditable):
        world.annotations.add_imported(run.batch_id, [_import_label(asset_id)])
    assert len(world.labels()) == before


def _draft_with_one_asset(world: World) -> tuple[UUID, UUID]:
    world.schemas.create_version(
        world.project.id, [LabelClass(name="car", geometries=(GeometryType.BBOX,))]
    )
    source = world.sources.register_images(world.project.id, world.src / "images")
    ingested = world.ingest.ingest(source.id, batch_name="draft")
    assert ingested.batch_id is not None
    return ingested.batch_id, ingested.assets[0].id


def test_add_imported_writes_into_a_draft_and_approval_seeds_it(world: World) -> None:
    batch_id, asset_id = _draft_with_one_asset(world)

    (stored,) = world.annotations.add_imported(batch_id, [_import_label(asset_id)])
    assert stored.job_id is None
    assert stored.schema_version == 1

    world.batches.approve(batch_id)
    (job,) = world.batches.jobs(batch_id)
    assert job.progress[asset_id] is AssetProgress.ANNOTATED


def test_add_imported_takes_only_import_provenance(world: World) -> None:
    batch_id, asset_id = _draft_with_one_asset(world)
    human = _import_label(asset_id).model_copy(update={"provenance": "human"})

    with pytest.raises(InvalidAnnotation, match="only an import"):
        world.annotations.add_imported(batch_id, [human])


def test_add_imported_refuses_an_asset_another_batch_holds(world: World) -> None:
    batch_id, asset_id = _draft_with_one_asset(world)
    other = world.batches.create(world.project.id, "other", [asset_id])

    with pytest.raises(AssetNotWritable, match="another batch"):
        world.annotations.add_imported(other.id, [_import_label(asset_id)])
    assert world.workspace_annotations(asset_id) == []
    assert world.batches.get(batch_id).state is BatchState.DRAFT


def test_add_imported_refuses_an_asset_the_batch_does_not_hold(world: World) -> None:
    batch_id, asset_id = _draft_with_one_asset(world)
    world.batches.remove_assets(batch_id, [asset_id])

    with pytest.raises(AssetNotInBatch):
        world.annotations.add_imported(batch_id, [_import_label(asset_id)])
    assert world.workspace_annotations(asset_id) == []


def test_add_imported_refuses_a_second_tag_of_one_class(world: World) -> None:
    world.schemas.create_version(
        world.project.id,
        [LabelClass(name="weather", geometries=(GeometryType.CLASSIFICATION_TAG,))],
    )
    source = world.sources.register_images(world.project.id, world.src / "images")
    ingested = world.ingest.ingest(source.id, batch_name="draft")
    assert ingested.batch_id is not None
    asset_id = ingested.assets[0].id
    tag = Annotation(
        asset_id=asset_id,
        label_class="weather",
        schema_version=1,
        geometry=ClassificationGeometry(),
        provenance="import",
    )

    with pytest.raises(DuplicateClassificationTag):
        world.annotations.add_imported(
            ingested.batch_id, [tag, tag.model_copy(update={"id": uuid4()})]
        )
    assert world.workspace_annotations(asset_id) == []


def test_add_imported_never_writes_into_the_trunk(world: World) -> None:
    batch_id, asset_id = _draft_with_one_asset(world)
    world.batches.approve(batch_id)
    world.batches.start(batch_id)
    (job,) = world.batches.jobs(batch_id)
    world.jobs.start(job.id)
    for member in job.progress:
        world.jobs.mark(
            job.id, member, AssetProgress.SKIPPED if member != asset_id else AssetProgress.ANNOTATED
        )
    world.jobs.complete(job.id)
    world.batches.complete(batch_id)
    world.datasets.promote(batch_id)
    assert asset_id in world.datasets.promoted_asset_ids(world.project.id)
    draft = world.batches.create(world.project.id, "again", [asset_id])

    with pytest.raises(AssetNotWritable, match="already in the dataset"):
        world.annotations.add_imported(draft.id, [_import_label(asset_id)])
