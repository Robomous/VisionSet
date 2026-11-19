"""The COCO importer: what it reads, what it reports as lost, and the round trip."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import CLASSES, Fixture, _box

from visionset.formats.coco import CocoExporter, CocoImporter
from visionset.formats.registry import importers
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    PolygonGeometry,
)
from visionset.kernel.ports import Importer
from visionset.kernel.services import ImportService, ProjectService, SchemaService, WorkspaceService


def _write(src: Path, document: dict[str, Any], *, name: str = "instances_train.json") -> Path:
    target = src / "annotations" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document), encoding="utf-8")
    return src


def _document(annotations: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {
        "images": [{"id": 1, "file_name": "a.png", "width": 32, "height": 24}],
        "annotations": [{"id": i, "image_id": 1, **row} for i, row in enumerate(annotations, 1)],
        "categories": [{"id": 1, "name": "car"}, {"id": 2, "name": "lane"}],
        **extra,
    }


def test_the_importer_is_discovered_through_the_entry_point_group() -> None:
    found = importers()
    assert isinstance(found["coco"], CocoImporter)
    assert isinstance(found["coco"], Importer)


def test_boxes_and_single_ring_polygons_are_read_without_loss(tmp_path: Path) -> None:
    src = _write(
        tmp_path,
        _document(
            [
                {"category_id": 1, "bbox": [1, 2, 10, 8], "segmentation": [], "iscrowd": 0},
                {
                    "category_id": 2,
                    "bbox": [4, 4, 16, 14],
                    "segmentation": [[4, 4, 20, 4, 4, 18]],
                    "score": 0.5,
                },
            ]
        ),
    )
    dataset = CocoImporter().read(src)

    assert dataset.losses == ()
    assert {c.name: c.geometries for c in dataset.classes} == {
        "car": (GeometryType.BBOX,),
        "lane": (GeometryType.POLYGON,),
    }
    (image,) = dataset.images
    assert str(image.path) == "a.png"
    assert (image.width, image.height) == (32, 24)
    assert [label.geometry for label in image.labels] == [
        BboxGeometry(x=1, y=2, width=10, height=8),
        PolygonGeometry(points=[(4, 4), (20, 4), (4, 18)]),
    ]
    assert [label.confidence for label in image.labels] == [None, 0.5]


@pytest.mark.parametrize(
    ("row", "kind", "kept"),
    [
        ({"category_id": 1, "segmentation": {"counts": "x", "size": [24, 32]}}, "label", 0),
        ({"category_id": 1, "bbox": [1, 1, 4, 4], "iscrowd": 1}, "label", 0),
        ({"category_id": 2, "segmentation": [[0, 0, 4, 0, 0, 4], [8, 8, 9, 8, 8, 9]]}, "label", 0),
        ({"category_id": 2, "segmentation": [[0, 0, 4, 0]]}, "label", 0),
        ({"category_id": 1, "bbox": [1, 1, 0, 4]}, "label", 0),
        ({"category_id": 9, "bbox": [1, 1, 4, 4]}, "label", 0),
        ({"category_id": 1, "bbox": [500, 500, 4, 4]}, "label", 0),
        (
            {"category_id": 1, "bbox": [1, 1, 4, 4], "keypoints": [2, 2, 2], "num_keypoints": 1},
            "geometry",
            1,
        ),
        (
            {"category_id": 1, "bbox": [1, 1, 4, 4], "attributes": {"occluded": True}},
            "attribute",
            1,
        ),
        ({"category_id": 1, "bbox": [1, 1, 4, 4], "score": 7}, "attribute", 1),
    ],
)
def test_what_the_kernel_cannot_represent_is_reported_by_kind(
    tmp_path: Path, row: dict[str, Any], kind: str, kept: int
) -> None:
    dataset = CocoImporter().read(_write(tmp_path, _document([row])))

    assert [(loss.kind.value, loss.count) for loss in dataset.losses] == [(kind, 1)]
    assert sum(len(image.labels) for image in dataset.images) == kept


def test_an_annotation_on_an_unlisted_image_is_a_label_loss(tmp_path: Path) -> None:
    document = _document([])
    document["annotations"] = [{"id": 1, "image_id": 99, "category_id": 1, "bbox": [1, 1, 4, 4]}]
    dataset = CocoImporter().read(_write(tmp_path, document))

    assert [(loss.kind, loss.subject) for loss in dataset.losses] == [(ImportLossKind.LABEL, "car")]


@pytest.mark.parametrize("file_name", ["../escape.png", "/etc/passwd", "a/../../b.png", "C:/x.png"])
def test_an_image_path_leaving_the_source_refuses_the_whole_import(
    tmp_path: Path, file_name: str
) -> None:
    document = _document([])
    document["images"][0]["file_name"] = file_name

    with pytest.raises(ImportSourceUnreadable):
        CocoImporter().read(_write(tmp_path, document))


def test_a_source_without_instances_or_with_broken_json_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ImportSourceUnreadable, match="no instances JSON"):
        CocoImporter().read(tmp_path)
    (tmp_path / "instances.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match="not readable JSON"):
        CocoImporter().read(tmp_path)


def test_images_are_found_under_the_folds_directory(tmp_path: Path) -> None:
    write_image(tmp_path / "images" / "val" / "a.png", size=(32, 24))
    dataset = CocoImporter().read(_write(tmp_path, _document([]), name="instances_val.json"))

    assert [str(image.path) for image in dataset.images] == ["images/val/a.png"]


def test_an_image_the_file_names_but_the_source_lacks_is_an_image_loss(tmp_path: Path) -> None:
    workspace = WorkspaceService.init(tmp_path / "ws")
    project = ProjectService(workspace).create("p")
    src = _write(tmp_path / "src", _document([{"category_id": 1, "bbox": [1, 1, 4, 4]}]))

    plan = ImportService(workspace).inspect(project.id, CocoImporter(), src)
    workspace.close()

    assert [(loss.kind, loss.subject) for loss in plan.losses] == [(ImportLossKind.IMAGE, "a.png")]


# --- the round trip -----------------------------------------------------------


def _polygon() -> Annotation:
    return Annotation(
        asset_id=_box(x=0, y=0, width=1, height=1).asset_id,
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (8.0, 36.0)]),
        provenance="human",
    )


def _content(workspace: WorkspaceService, project_id: Any) -> dict[str, Counter[tuple[str, str]]]:
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: Counter(
                (label.label_class, label.geometry.model_dump_json())
                for label in uow.annotations.list(asset.id)
            )
            for asset in uow.assets.list(project_id)
        }


def test_a_coco_export_of_boxes_and_polygons_imports_back_without_loss(tmp_path: Path) -> None:
    classes = CLASSES[:2]
    fixture = Fixture(tmp_path / "origin", classes=classes)
    fixture.label(
        {
            0: [_box(x=8, y=12, width=16, height=24)],
            1: [_polygon(), _box(x=1.5, y=2.25, width=10, height=8)],
        }
    )
    exported = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), CocoExporter(), exported)
    original = _content(fixture.workspace, fixture.project.id)
    fixture.close()

    workspace = WorkspaceService.init(tmp_path / "copy")
    project = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    plan = imports.inspect(project.id, CocoImporter(), exported)
    run = imports.commit(project.id, CocoImporter(), exported, consent=ImportConsent())

    assert plan.losses == ()
    assert run.losses == ()
    assert _content(workspace, project.id) == original
    (schema,) = SchemaService(workspace).list_versions(project.id)
    assert [(c.name, c.geometries) for c in schema.classes] == [
        (c.name, c.geometries) for c in classes
    ]
    workspace.close()
