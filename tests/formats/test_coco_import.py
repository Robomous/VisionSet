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
    LabelClass,
    PolygonGeometry,
)
from visionset.kernel.domain.schema import Attribute
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
        ({"category_id": 1, "bbox": [1, 1, 4, 4], "iscrowd": 1}, "attribute", 1),
        (
            {"category_id": 2, "segmentation": [[0, 0, 4, 0, 0, 4], [8, 8, 9, 8, 8, 9]]},
            "geometry",
            1,
        ),
        ({"category_id": 1, "segmentation": {"counts": [3, 1], "size": [2, 3]}}, "label", 0),
        ({"category_id": 1, "segmentation": {"counts": [700, 69], "size": [24, 32]}}, "label", 0),
        ({"category_id": 1, "segmentation": {"counts": "PP", "size": [24]}}, "label", 0),
        ({"category_id": 2, "segmentation": [[0, 0, 4, 0, 0, 4], [8, 8, 9]]}, "label", 0),
        ({"category_id": 2, "segmentation": [[0, 0, 4, 0]]}, "label", 0),
        ({"category_id": 1, "bbox": [1, 1, 0, 4]}, "label", 0),
        ({"category_id": 2, "segmentation": [[0, 0, 4, 4, 8, 8]]}, "label", 0),
        ({"category_id": 2, "segmentation": [[3, 3, 3, 3, 3, 3]]}, "label", 0),
        ({"category_id": 2, "segmentation": [[0, 0, 4, 0, 8, 0, 2, 0]]}, "label", 0),
        ({"category_id": 9, "bbox": [1, 1, 4, 4]}, "label", 0),
        ({"category_id": 1, "bbox": [500, 500, 4, 4]}, "label", 0),
        (
            {"category_id": 1, "bbox": [1, 1, 4, 4], "keypoints": [2, 2, 2], "num_keypoints": 1},
            "geometry",
            1,
        ),
        (
            {"category_id": 1, "bbox": [1, 1, 4, 4], "attributes": {"occluded": [True]}},
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
    with pytest.raises(ImportSourceUnreadable, match="holds no instances_"):
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


def test_attribute_values_are_carried_and_define_their_class(tmp_path: Path) -> None:
    box = [1, 1, 4, 4]
    dataset = CocoImporter().read(
        _write(
            tmp_path,
            _document(
                [
                    {
                        "category_id": 1,
                        "bbox": box,
                        "visionset": {"attributes": {"speed": 3, "lit": True, " note ": "x"}},
                    },
                    {"category_id": 1, "bbox": box, "attributes": {"occluded": False, "Speed": 2}},
                    {
                        "category_id": 1,
                        "bbox": box,
                        "attributes": {"occluded": True},
                        "visionset": {"attributes": {"speed": "fast", "gone": None}},
                    },
                ]
            ),
        )
    )

    car = next(one for one in dataset.classes if one.name == "car")
    assert car.attributes == (
        Attribute(name="speed", kind="number"),
        Attribute(name="lit", kind="boolean"),
        Attribute(name="note", kind="string"),
        Attribute(name="occluded", kind="boolean"),
    )
    ((first, second, third),) = [image.labels for image in dataset.images]
    assert first.attributes == {"speed": 3.0, "lit": True, "note": "x"}
    assert second.attributes == {"occluded": False, "Speed": 2.0}
    assert third.attributes == {"speed": "fast"}
    assert {(one.subject, one.reason) for one in dataset.losses} == {
        ("car", "the row's own attributes are not imported beside the visionset ones"),
        ("car", "attribute 'gone' is not a string, a boolean or a number; it is not imported"),
    }


def test_attribute_values_round_trip_through_a_coco_export(tmp_path: Path) -> None:
    sign = LabelClass(
        name="sign",
        geometries=(GeometryType.BBOX,),
        attributes=(
            Attribute(name="shape", kind="select", options=("round", "square")),
            Attribute(name="lit", kind="boolean"),
            Attribute(name="height", kind="number"),
        ),
    )
    fixture = Fixture(tmp_path / "origin", classes=(sign,))
    values = [{"shape": "round", "lit": True, "height": 2.5}, {"lit": False}]
    fixture.label(
        {
            0: [_box(x=8, y=12, width=16, height=24).model_copy(update={"attributes": values[0]})],
            1: [_box(x=1, y=2, width=10, height=8).model_copy(update={"attributes": values[1]})],
        }
    )
    exported = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), CocoExporter(), exported)
    fixture.close()

    workspace = WorkspaceService.init(tmp_path / "copy")
    projects = ProjectService(workspace)
    inferred = projects.create("inferred")
    matching = projects.create("matching")
    SchemaService(workspace).create_version(matching.id, [sign])
    imports = ImportService(workspace)
    for project in (inferred, matching):
        run = imports.commit(project.id, CocoImporter(), exported, consent=ImportConsent())
        assert run.losses == ()
        with workspace.unit_of_work() as uow:
            written = [
                label.attributes
                for asset in uow.assets.list(project.id)
                for label in uow.annotations.list(asset.id)
            ]
        assert sorted(written, key=len) == sorted(values, key=len)
    (schema,) = SchemaService(workspace).list_versions(inferred.id)
    assert {one.name: one.kind for one in schema.classes[0].attributes} == {
        "shape": "string",
        "lit": "boolean",
        "height": "number",
    }
    workspace.close()


# --- defects found in review ----------------------------------------------------


def _with_cats(names: list[str], annotations: list[dict[str, Any]]) -> dict[str, Any]:
    document = _document(annotations)
    document["categories"] = [{"id": i, "name": n} for i, n in enumerate(names, 1)]
    return document


def test_only_instances_files_are_read_and_the_others_are_reported(tmp_path: Path) -> None:
    box = {"category_id": 1, "bbox": [1, 1, 4, 4]}
    _write(tmp_path, _with_cats(["person"], [box]), name="instances_val.json")
    _write(
        tmp_path,
        _with_cats(["person"], [{**box, "keypoints": [2, 2, 2], "num_keypoints": 1}]),
        name="person_keypoints_val.json",
    )
    _write(
        tmp_path,
        {"images": [], "annotations": [{"id": 1, "image_id": 1, "caption": "x"}]},
        name="captions_val.json",
    )
    dataset = CocoImporter().read(tmp_path)

    assert sum(len(image.labels) for image in dataset.images) == 1
    assert sorted((loss.kind.value, loss.subject) for loss in dataset.losses) == [
        ("geometry", "person_keypoints_val.json"),
        ("label", "captions_val.json"),
    ]


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_a_non_finite_number_refuses_the_file(tmp_path: Path, constant: str) -> None:
    raw = json.dumps(_document([{"category_id": 1, "bbox": [1, 1, 4, 4]}]))
    target = tmp_path / "annotations" / "instances_x.json"
    target.parent.mkdir(parents=True)
    target.write_text(raw.replace("[1, 1, 4, 4]", f"[{constant}, 1, 4, 4]"), encoding="utf-8")

    with pytest.raises(ImportSourceUnreadable, match="non-finite"):
        CocoImporter().read(tmp_path)


def test_an_exponent_that_overflows_to_infinity_loses_the_label(tmp_path: Path) -> None:
    raw = json.dumps(_document([{"category_id": 1, "bbox": [1, 1, 4, 4]}]))
    target = tmp_path / "annotations" / "instances_x.json"
    target.parent.mkdir(parents=True)
    target.write_text(raw.replace("[1, 1, 4, 4]", "[1e999, 1, 4, 4]"), encoding="utf-8")

    dataset = CocoImporter().read(tmp_path)

    assert [(loss.kind, loss.count) for loss in dataset.losses] == [(ImportLossKind.LABEL, 1)]
    assert sum(len(image.labels) for image in dataset.images) == 0


def test_a_coordinate_too_large_for_a_float_refuses_the_file(tmp_path: Path) -> None:
    src = _write(tmp_path, _document([{"category_id": 1, "bbox": [10**400, 1, 4, 4]}]))

    with pytest.raises(ImportSourceUnreadable, match="too large"):
        CocoImporter().read(src)


def _project(tmp_path: Path) -> tuple[WorkspaceService, Any]:
    workspace = WorkspaceService.init(tmp_path / "ws")
    return workspace, ProjectService(workspace).create("p")


def test_duplicate_image_content_is_an_image_loss_and_keeps_the_first_path(tmp_path: Path) -> None:
    src = tmp_path / "src"
    write_image(src / "images" / "a.png", size=(32, 24), seed=0)
    write_image(src / "images" / "b.png", size=(32, 24), seed=0)
    document = _document(
        [
            {"category_id": 1, "bbox": [1, 1, 4, 4]},
            {"image_id": 2, "category_id": 1, "bbox": [2, 2, 4, 4]},
        ]
    )
    document["images"].append({"id": 2, "file_name": "b.png", "width": 32, "height": 24})
    document["annotations"][1]["image_id"] = 2
    _write(src, document)
    workspace, project = _project(tmp_path)
    imports = ImportService(workspace)

    plan = imports.inspect(project.id, CocoImporter(), src)
    run = imports.commit(
        project.id,
        CocoImporter(),
        src,
        consent=ImportConsent(kinds=frozenset({ImportLossKind.IMAGE})),
    )
    workspace.close()

    assert [(loss.kind, loss.subject) for loss in plan.losses] == [
        (ImportLossKind.IMAGE, "images/b.png")
    ]
    assert run.annotations_written == 1
    assert len(run.created_asset_ids) == 1


def test_case_colliding_categories_conflict_at_inspect(tmp_path: Path) -> None:
    src = tmp_path / "src"
    write_image(src / "images" / "a.png", size=(32, 24))
    _write(
        src,
        _with_cats(
            ["Car", "car"],
            [{"category_id": 1, "bbox": [1, 1, 4, 4]}, {"category_id": 2, "bbox": [2, 2, 4, 4]}],
        ),
    )
    workspace, project = _project(tmp_path)

    plan = ImportService(workspace).inspect(project.id, CocoImporter(), src)
    workspace.close()

    assert plan.conflicts and "collides" in plan.conflicts[0]


def test_a_label_outside_an_image_with_no_stated_size_is_a_label_loss(tmp_path: Path) -> None:
    src = tmp_path / "src"
    write_image(src / "images" / "a.png", size=(32, 24))
    document = _document(
        [{"category_id": 1, "bbox": [500, 500, 4, 4]}, {"category_id": 1, "bbox": [1, 1, 4, 4]}]
    )
    del document["images"][0]["width"], document["images"][0]["height"]
    _write(src, document)
    workspace, project = _project(tmp_path)
    imports = ImportService(workspace)

    plan = imports.inspect(project.id, CocoImporter(), src)
    run = imports.commit(
        project.id,
        CocoImporter(),
        src,
        consent=ImportConsent(kinds=frozenset({ImportLossKind.LABEL})),
    )
    workspace.close()

    assert [(loss.kind, loss.count) for loss in plan.losses] == [(ImportLossKind.LABEL, 1)]
    assert run.annotations_written == 1


def test_json_nested_too_deep_to_parse_is_refused(tmp_path: Path) -> None:
    (tmp_path / "instances.json").write_text("[" * 100000 + "]" * 100000, encoding="utf-8")

    with pytest.raises(ImportSourceUnreadable, match="not readable JSON|not a COCO"):
        CocoImporter().read(tmp_path)


def test_a_too_deep_file_beside_the_instances_is_reported_not_raised(tmp_path: Path) -> None:
    _write(tmp_path, _document([]))
    deep = tmp_path / "annotations" / "captions_train.json"
    deep.write_text("[" * 100000 + "]" * 100000, encoding="utf-8")

    losses = CocoImporter().read(tmp_path).losses
    assert [(loss.kind, loss.subject) for loss in losses] == [
        (ImportLossKind.LABEL, "captions_train.json")
    ]
