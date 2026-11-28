"""COCO keypoints: the category spec, the (x, y, v) rows, the derived box, and the round trip."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.formats.test_ultralytics import CLASSES, Fixture, _box

from visionset.formats.coco import ANNOTATIONS_DIRNAME, CocoExporter, CocoImporter
from visionset.kernel import ExportSourceUnreadable, ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    KeypointsGeometry,
    KeypointSpec,
    LabelClass,
    VertexVisibility,
)
from visionset.kernel.services import ImportService, ProjectService, SchemaService, WorkspaceService

V = VertexVisibility
SPEC = KeypointSpec(names=("left_eye", "right_eye", "nose"), skeleton=((0, 1), (2, 0)))
FACE = LabelClass(name="face", geometries=(GeometryType.KEYPOINTS,), keypoints=SPEC)
POSE_SHAPE = "its keypoints are kept; its box and any segmentation are not"


def _face(geometry: KeypointsGeometry, label_class: str = "face") -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


def _exported(
    tmp_path: Path,
    drawing: dict[int, list[Annotation]],
    classes: tuple[LabelClass, ...] = (*CLASSES, FACE),
) -> dict[str, Any]:
    fixture = Fixture(tmp_path / "ws-origin", classes=classes)
    fixture.label(drawing)
    dest = tmp_path / "out"
    fixture.releases.export(fixture.publish(), CocoExporter(), dest, allow_lossy=True)
    fixture.close()
    document = json.loads((dest / ANNOTATIONS_DIRNAME / "instances_train.json").read_text())
    assert isinstance(document, dict)
    return document


def _rows(document: dict[str, Any], category: str) -> list[dict[str, Any]]:
    (identifier,) = [one["id"] for one in document["categories"] if one["name"] == category]
    return [one for one in document["annotations"] if one["category_id"] == identifier]


# --- export ---------------------------------------------------------------------


def test_a_keypoints_class_carries_its_names_and_a_one_based_skeleton(tmp_path: Path) -> None:
    geometry = KeypointsGeometry(points=[(10.0, 8.0)] * 3)
    document = _exported(tmp_path, {0: [_face(geometry)]})

    categories = {one["name"]: one for one in document["categories"]}
    assert categories["face"]["keypoints"] == ["left_eye", "right_eye", "nose"]
    assert categories["face"]["skeleton"] == [[1, 2], [3, 1]]
    assert "keypoints" not in categories["sign"]


def test_a_keypoints_row_is_triplets_with_the_labeled_extent_as_its_box(tmp_path: Path) -> None:
    geometry = KeypointsGeometry(
        points=[(10.0, 8.0), (40.0, 40.0), (30.5, 20.25)],
        visibility=(V.VISIBLE, V.UNLABELED, V.OCCLUDED),
    )
    document = _exported(tmp_path, {0: [_box(x=1, y=2, width=3, height=4), _face(geometry)]})

    (row,) = _rows(document, "face")
    assert row["keypoints"] == [10.0, 8.0, 2, 0, 0, 0, 30.5, 20.25, 1]
    assert row["num_keypoints"] == 2
    assert row["bbox"] == [10.0, 8.0, 20.5, 12.25]
    assert row["area"] == 251.125
    assert row["segmentation"] == []
    assert row["iscrowd"] == 0
    (box,) = _rows(document, "sign")
    assert "keypoints" not in box


def test_the_derived_box_is_clamped_to_the_picture(tmp_path: Path) -> None:
    geometry = KeypointsGeometry(points=[(-5.0, 3.0), (70.0, 60.0), (20.0, 20.0)])
    document = _exported(tmp_path, {0: [_face(geometry)]})

    (row,) = _rows(document, "face")
    assert row["bbox"] == [0.0, 3.0, 64.0, 45.0]
    assert row["keypoints"][:6] == [-5.0, 3.0, 2, 70.0, 60.0, 2]


def test_a_label_recording_no_visibility_has_every_point_visible(tmp_path: Path) -> None:
    document = _exported(tmp_path, {0: [_face(KeypointsGeometry(points=[(1.0, 2.0)] * 3))]})

    (row,) = _rows(document, "face")
    assert row["keypoints"] == [1.0, 2.0, 2] * 3
    assert row["num_keypoints"] == 3


def test_a_label_with_no_labeled_point_has_an_empty_box(tmp_path: Path) -> None:
    geometry = KeypointsGeometry(points=[(4.0, 4.0)] * 3, visibility=(V.UNLABELED,) * 3)
    document = _exported(tmp_path, {0: [_face(geometry)]})

    (row,) = _rows(document, "face")
    assert row["keypoints"] == [0, 0, 0] * 3
    assert (row["num_keypoints"], row["bbox"], row["area"]) == (0, [0.0, 0.0, 0.0, 0.0], 0.0)


def test_a_class_without_a_spec_is_named_kp1_to_kpn(tmp_path: Path) -> None:
    loose = LabelClass(name="loose", geometries=(GeometryType.KEYPOINTS,))
    geometry = KeypointsGeometry(points=[(1.0, 1.0), (2.0, 2.0)])
    document = _exported(tmp_path, {0: [_face(geometry, "loose")]}, classes=(loose,))

    (category,) = document["categories"]
    assert (category["keypoints"], category["skeleton"]) == (["kp1", "kp2"], [])


def test_a_class_without_a_spec_whose_labels_disagree_is_refused(tmp_path: Path) -> None:
    loose = LabelClass(name="loose", geometries=(GeometryType.KEYPOINTS,))
    fixture = Fixture(tmp_path / "ws", classes=(loose,))
    fixture.label(
        {
            0: [_face(KeypointsGeometry(points=[(1.0, 1.0), (2.0, 2.0)]), "loose")],
            1: [_face(KeypointsGeometry(points=[(1.0, 1.0)] * 3), "loose")],
        }
    )
    release_id = fixture.publish()
    dest = tmp_path / "out"

    with pytest.raises(ExportSourceUnreadable, match="'loose' has keypoints labels of 2, 3"):
        fixture.releases.export(release_id, CocoExporter(), dest)
    fixture.close()
    assert not (dest / ANNOTATIONS_DIRNAME).exists()


def test_a_release_of_boxes_and_keypoints_exports_without_consent(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path / "ws", classes=(CLASSES[0], FACE))
    fixture.label(
        {0: [_box(x=1, y=2, width=3, height=4), _face(KeypointsGeometry(points=[(5.0, 5.0)] * 3))]}
    )

    result = fixture.releases.export(fixture.publish(), CocoExporter(), tmp_path / "out")
    fixture.close()

    assert result.compatibility.compatible


# --- the round trip -------------------------------------------------------------


def _content(workspace: WorkspaceService, project_id: Any) -> dict[str, Counter[tuple[str, str]]]:
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: Counter(
                (label.label_class, label.geometry.model_dump_json())
                for label in uow.annotations.list(asset.id)
            )
            for asset in uow.assets.list(project_id)
        }


def test_a_coco_export_of_keypoints_and_boxes_imports_back_with_only_the_boxes_lost(
    tmp_path: Path,
) -> None:
    """Class, order, coordinates, visibility and spec survive; the derived box does not.

    An unlabeled point is written ``0, 0, 0``, so the fixture puts its own there.
    """
    classes = (CLASSES[0], FACE)
    fixture = Fixture(tmp_path / "origin", classes=classes)
    fixture.label(
        {
            0: [
                _box(x=8, y=12, width=16, height=24),
                _face(
                    KeypointsGeometry(
                        points=[(10.5, 8.25), (0.0, 0.0), (30.1234, 20.0)],
                        visibility=(V.VISIBLE, V.UNLABELED, V.OCCLUDED),
                    )
                ),
            ],
            1: [
                _face(
                    KeypointsGeometry(
                        points=[(1.0, 2.0), (3.0, 4.0), (5.0, 6.0)],
                        visibility=(V.OCCLUDED, V.VISIBLE, V.VISIBLE),
                    )
                )
            ],
        }
    )
    exported = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), CocoExporter(), exported)
    original = _content(fixture.workspace, fixture.project.id)
    fixture.close()

    workspace = WorkspaceService.init(tmp_path / "copy")
    project = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    consent = ImportConsent(kinds=frozenset({ImportLossKind.GEOMETRY}))
    run = imports.commit(project.id, CocoImporter(), exported, consent=consent)

    assert [(loss.kind, loss.subject, loss.reason, loss.count) for loss in run.losses] == [
        (ImportLossKind.GEOMETRY, "face", POSE_SHAPE, 2)
    ]
    assert _content(workspace, project.id) == original
    (schema,) = SchemaService(workspace).list_versions(project.id)
    assert list(schema.classes) == list(classes)
    workspace.close()


# --- import ---------------------------------------------------------------------


def _document(
    annotations: list[dict[str, Any]], category: dict[str, Any] | None = None
) -> dict[str, Any]:
    face = {
        "id": 1,
        "name": "face",
        "keypoints": ["left_eye", "right_eye", "nose"],
        "skeleton": [[1, 2], [3, 1]],
    }
    return {
        "images": [{"id": 1, "file_name": "a.png", "width": 32, "height": 24}],
        "annotations": [{"id": i, "image_id": 1, **row} for i, row in enumerate(annotations, 1)],
        "categories": [face if category is None else category, {"id": 2, "name": "car"}],
    }


def _write(src: Path, document: dict[str, Any], name: str = "instances_train.json") -> Path:
    target = src / "annotations" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document), encoding="utf-8")
    return src


def _read(tmp_path: Path, *rows: dict[str, Any]) -> tuple[list[Any], list[tuple[str, str, int]]]:
    dataset = CocoImporter().read(_write(tmp_path, _document(list(rows))))
    labels = [label.geometry for image in dataset.images for label in image.labels]
    losses = [(loss.kind.value, loss.reason, loss.count) for loss in dataset.losses]
    return labels, losses


def test_a_category_s_keypoints_and_skeleton_become_its_zero_based_spec(tmp_path: Path) -> None:
    dataset = CocoImporter().read(_write(tmp_path, _document([])))

    face = next(one for one in dataset.classes if one.name == "face")
    assert face.keypoints == SPEC
    assert face.geometries == (GeometryType.KEYPOINTS,)
    car = next(one for one in dataset.classes if one.name == "car")
    assert car.keypoints is None


def test_a_keypoints_row_is_one_keypoints_label_and_its_box_is_lost(tmp_path: Path) -> None:
    row = {
        "category_id": 1,
        "bbox": [1, 1, 20, 20],
        "keypoints": [4, 5, 2, 0, 0, 0, 10.5, 6, 1],
        "num_keypoints": 2,
    }

    labels, losses = _read(tmp_path, row, row)

    assert (
        labels
        == [
            KeypointsGeometry(
                points=[(4.0, 5.0), (0.0, 0.0), (10.5, 6.0)],
                visibility=(V.VISIBLE, V.UNLABELED, V.OCCLUDED),
            )
        ]
        * 2
    )
    assert losses == [("geometry", POSE_SHAPE, 2)]


def test_a_row_with_no_labeled_keypoint_is_still_one_keypoints_label(tmp_path: Path) -> None:
    row = {"category_id": 1, "bbox": [1, 1, 20, 20], "keypoints": [0] * 9, "num_keypoints": 0}

    labels, losses = _read(tmp_path, row)

    assert labels == [KeypointsGeometry(points=[(0.0, 0.0)] * 3, visibility=(V.UNLABELED,) * 3)]
    assert losses == [("geometry", POSE_SHAPE, 1)]


def test_a_row_of_a_keypoints_category_without_keypoints_keeps_its_shape(tmp_path: Path) -> None:
    dataset = CocoImporter().read(
        _write(tmp_path, _document([{"category_id": 1, "bbox": [1, 1, 4, 4]}]))
    )

    (label,) = [label for image in dataset.images for label in image.labels]
    assert label.geometry == BboxGeometry(x=1, y=1, width=4, height=4)
    face = next(one for one in dataset.classes if one.name == "face")
    assert face.geometries == (GeometryType.BBOX, GeometryType.KEYPOINTS)
    assert dataset.losses == ()


@pytest.mark.parametrize(
    ("keypoints", "reason"),
    [
        ([4, 5, 2, 6, 7, 2], "its keypoints are not 3 (x, y, v) triplets of numbers"),
        ([4, 5, 2, 6, 7, 2, 8, 9, 2, 1], "its keypoints are not 3 (x, y, v) triplets of numbers"),
        ([4, 5, 2, 6, "x", 2, 8, 9, 2], "its keypoints are not 3 (x, y, v) triplets of numbers"),
        ("4 5 2", "its keypoints are not 3 (x, y, v) triplets of numbers"),
        ([4, 5, 3, 6, 7, 2, 8, 9, 2], "a keypoint visibility is not 0, 1 or 2"),
        ([4, 5, 1.5, 6, 7, 2, 8, 9, 2], "a keypoint visibility is not 0, 1 or 2"),
        ([400, 500, 2, 600, 700, 2, -8, 9, 2], "it lies wholly outside its image"),
    ],
    ids=["truncated", "too-long", "not-a-number", "not-a-list", "v3", "v-fraction", "outside"],
)
def test_a_malformed_keypoints_row_loses_its_label(
    tmp_path: Path, keypoints: object, reason: str
) -> None:
    labels, losses = _read(
        tmp_path, {"category_id": 1, "bbox": [1, 1, 4, 4], "keypoints": keypoints}
    )

    assert labels == []
    assert losses == [("label", reason, 1)]


@pytest.mark.parametrize(
    ("category", "message"),
    [
        ({"keypoints": "nose"}, "not a list of names"),
        ({"keypoints": ["a", 1]}, "not a list of names"),
        ({"keypoints": ["a", "A"]}, "share a name"),
        ({"keypoints": ["a", " "]}, "non-blank"),
        ({"keypoints": ["a", "b"], "skeleton": [[0, 1]]}, "1-based"),
        ({"keypoints": ["a", "b"], "skeleton": [[1, 3]]}, "names keypoint 2"),
        ({"keypoints": ["a", "b"], "skeleton": [[1, 1]]}, "to itself"),
        ({"keypoints": ["a", "b"], "skeleton": [[1, 2], [2, 1]]}, "appears twice"),
        ({"keypoints": ["a", "b"], "skeleton": [[1, 2, 3]]}, "1-based"),
    ],
)
def test_a_malformed_keypoint_spec_refuses_the_source(
    tmp_path: Path, category: dict[str, Any], message: str
) -> None:
    src = _write(tmp_path, _document([], {"id": 1, "name": "face", **category}))

    with pytest.raises(ImportSourceUnreadable, match=message):
        CocoImporter().read(src)


def test_two_files_giving_one_category_two_specs_refuse_the_source(tmp_path: Path) -> None:
    _write(tmp_path, _document([]), name="instances_train.json")
    other = {"id": 1, "name": "face", "keypoints": ["left_eye", "right_eye", "nose"]}
    _write(tmp_path, _document([], other), name="instances_val.json")

    with pytest.raises(ImportSourceUnreadable, match="another skeleton"):
        CocoImporter().read(tmp_path)


def test_a_person_keypoints_file_is_read_when_there_is_no_instances_file(tmp_path: Path) -> None:
    row = {"category_id": 1, "bbox": [1, 1, 4, 4], "keypoints": [4, 5, 2] * 3}
    _write(tmp_path, _document([row]), name="person_keypoints_val2017.json")
    (tmp_path / "images" / "val2017").mkdir(parents=True)

    dataset = CocoImporter().read(tmp_path)

    (image,) = dataset.images
    assert str(image.path) == "images/val2017/a.png"
    (label,) = image.labels
    assert isinstance(label.geometry, KeypointsGeometry)


def test_a_person_keypoints_file_beside_an_instances_file_is_reported_unread(
    tmp_path: Path,
) -> None:
    row = {"category_id": 1, "bbox": [1, 1, 4, 4], "keypoints": [4, 5, 2] * 3}
    _write(tmp_path, _document([row]), name="instances_val.json")
    _write(tmp_path, _document([row]), name="person_keypoints_val.json")

    dataset = CocoImporter().read(tmp_path)

    assert ("geometry", "person_keypoints_val.json", 1) in [
        (loss.kind.value, loss.subject, loss.count) for loss in dataset.losses
    ]
    assert sum(len(image.labels) for image in dataset.images) == 1
