"""Ultralytics pose: the derived task, the rows, the refusals, the reader, and the round trip."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import CLASSES, Fixture, _box

from visionset.formats.registry import exporters
from visionset.formats.ultralytics import DATA_FILENAME, TARGETS, UltralyticsImporter
from visionset.formats.yolov5_yaml import Yolov5YamlImporter
from visionset.kernel import ExportSourceUnreadable, ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    ClassExportStatus,
    ClassificationGeometry,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    KeypointsGeometry,
    KeypointSpec,
    LabelClass,
    Task,
    VertexVisibility,
)
from visionset.kernel.services import ImportService, ProjectService, SchemaService, WorkspaceService

V = VertexVisibility
SPEC = KeypointSpec(names=("left_eye", "right_eye", "nose"), skeleton=((0, 1), (2, 0)))
FACE = LabelClass(name="face", geometries=(GeometryType.KEYPOINTS,), keypoints=SPEC)
HAND = LabelClass(
    name="hand", geometries=(GeometryType.KEYPOINTS,), keypoints=KeypointSpec(names=("a", "b"))
)
POSE_BOX = "its keypoints are kept; its box is not"

#: Normalized coordinates are written with six decimals and read back scaled by the
#: picture, so a point within the picture comes back within half a millionth of a
#: side; on the 64 by 48 fixture picture that is ``0.5e-6 * 64`` pixels.
TOLERANCE = 0.5e-6 * 64


def _keypoints(geometry: KeypointsGeometry, label_class: str = "face") -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


def _tag() -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="weather",
        schema_version=1,
        geometry=ClassificationGeometry(),
        provenance="human",
    )


def _fixture(
    tmp_path: Path,
    drawing: dict[int, list[Annotation]],
    classes: tuple[LabelClass, ...] = (*CLASSES, FACE),
) -> Fixture:
    fixture = Fixture(tmp_path / "ws", classes=classes)
    fixture.label(drawing)
    return fixture


def _label_lines(dest: Path) -> list[str]:
    return [
        line
        for path in sorted((dest / "labels").rglob("*.txt"))
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


# --- export ---------------------------------------------------------------------


def test_the_targets_with_a_pose_task_and_only_those_carry_keypoints() -> None:
    for target in TARGETS:
        carries = GeometryType.KEYPOINTS in target.supported_geometries
        assert carries is (Task.POSE in target.tasks), target.name


def test_a_keypoints_release_is_written_as_pose_rows_with_kpt_shape(tmp_path: Path) -> None:
    geometry = KeypointsGeometry(
        points=[(10.0, 8.0), (40.0, 40.0), (30.5, 20.25)],
        visibility=(V.VISIBLE, V.UNLABELED, V.OCCLUDED),
    )
    fixture = _fixture(tmp_path, {0: [_keypoints(geometry)]})
    dest = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    assert _label_lines(dest) == [
        "3 0.316406 0.294271 0.320312 0.255208 "
        "0.156250 0.166667 2 0.000000 0.000000 0 0.476562 0.421875 1"
    ]
    descriptor = (dest / DATA_FILENAME).read_text(encoding="utf-8")
    assert "kpt_shape: [3, 3]\n" in descriptor
    assert "flip_idx" not in descriptor
    assert '  3: "face"\n' in descriptor


def test_a_point_off_the_picture_is_clamped_and_unrecorded_visibility_is_visible(
    tmp_path: Path,
) -> None:
    geometry = KeypointsGeometry(points=[(-16.0, 12.0), (32.0, 96.0), (32.0, 24.0)])
    fixture = _fixture(tmp_path, {0: [_keypoints(geometry)]})
    dest = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    assert _label_lines(dest) == [
        "3 0.250000 0.625000 0.500000 0.750000 "
        "0.000000 0.250000 2 0.500000 1.000000 2 0.500000 0.500000 2"
    ]


def test_a_tag_beside_keypoints_is_dropped_and_reported(tmp_path: Path) -> None:
    geometry = KeypointsGeometry(points=[(10.0, 8.0)] * 3)
    fixture = _fixture(tmp_path, {0: [_keypoints(geometry), _tag()]})
    release_id = fixture.publish()
    dest = tmp_path / "out"
    report = fixture.releases.export(
        release_id, exporters()["ultralytics"], dest, allow_lossy=True
    ).compatibility
    fixture.close()

    assert len(_label_lines(dest)) == 1
    rows = {(one.label_class, one.geometry): one.status for one in report.classes}
    assert rows[("weather", GeometryType.CLASSIFICATION_TAG)] is ClassExportStatus.DROPPED
    assert rows[("face", GeometryType.KEYPOINTS)] is ClassExportStatus.SUPPORTED


def test_a_box_beside_keypoints_refuses_the_pose_export(tmp_path: Path) -> None:
    geometry = KeypointsGeometry(points=[(10.0, 8.0)] * 3)
    fixture = _fixture(tmp_path, {0: [_keypoints(geometry), _box(x=1, y=2, width=3, height=4)]})
    release_id = fixture.publish()
    dest = tmp_path / "out"

    with pytest.raises(ExportSourceUnreadable, match=r"labels of 'sign' \(bbox\)"):
        fixture.export(release_id, dest)
    fixture.close()
    assert not (dest / "labels").exists()


def test_two_keypoint_counts_refuse_the_pose_export(tmp_path: Path) -> None:
    fixture = _fixture(
        tmp_path,
        {
            0: [_keypoints(KeypointsGeometry(points=[(10.0, 8.0)] * 3))],
            1: [_keypoints(KeypointsGeometry(points=[(10.0, 8.0)] * 2), "hand")],
        },
        classes=(FACE, HAND),
    )
    release_id = fixture.publish()

    with pytest.raises(ExportSourceUnreadable, match="2 for 'hand'; 3 for 'face'"):
        fixture.export(release_id, tmp_path / "out")
    fixture.close()


def test_a_target_without_pose_drops_the_keypoints_and_writes_the_boxes(tmp_path: Path) -> None:
    geometry = KeypointsGeometry(points=[(10.0, 8.0)] * 3)
    fixture = _fixture(tmp_path, {0: [_keypoints(geometry), _box(x=8, y=6, width=16, height=12)]})
    (yolov5,) = [one for one in TARGETS if one.name == "yolov5"]
    dest = fixture.export(fixture.publish(), tmp_path / "out", target=yolov5)
    fixture.close()

    assert _label_lines(dest) == ["0 0.250000 0.250000 0.250000 0.250000"]
    assert "kpt_shape" not in (dest / DATA_FILENAME).read_text(encoding="utf-8")


# --- the round trip -------------------------------------------------------------


def test_a_pose_export_imports_back_within_tolerance(tmp_path: Path) -> None:
    """Class index, point order, coordinates and visibility survive; names, skeleton and box do not.

    The format names no keypoint, so the imported spec is ``kp1`` to ``kpN``.
    """
    drawn = [
        KeypointsGeometry(
            points=[(10.1234, 8.5), (0.0, 0.0), (30.75, 20.333)],
            visibility=(V.VISIBLE, V.UNLABELED, V.OCCLUDED),
        ),
        KeypointsGeometry(
            points=[(1.0, 47.0), (63.0, 2.5), (5.0, 6.0)],
            visibility=(V.OCCLUDED, V.VISIBLE, V.VISIBLE),
        ),
    ]
    fixture = _fixture(tmp_path, {0: [_keypoints(drawn[0])], 1: [_keypoints(drawn[1])]})
    exported = fixture.export(fixture.publish(), tmp_path / "exported")
    fixture.close()

    workspace = WorkspaceService.init(tmp_path / "copy")
    project = ProjectService(workspace).create("copy")
    consent = ImportConsent(kinds=frozenset({ImportLossKind.GEOMETRY}))
    run = ImportService(workspace).commit(
        project.id, UltralyticsImporter(), exported, consent=consent
    )
    (schema,) = SchemaService(workspace).list_versions(project.id)
    with workspace.unit_of_work() as uow:
        read = [
            label.geometry
            for asset in uow.assets.list(project.id)
            for label in uow.annotations.list(asset.id)
        ]
    workspace.close()

    assert [(loss.kind, loss.subject, loss.reason, loss.count) for loss in run.losses] == [
        (ImportLossKind.GEOMETRY, "face", POSE_BOX, 2)
    ]
    assert [one.name for one in schema.classes] == [one.name for one in (*CLASSES, FACE)]
    face = next(one for one in schema.classes if one.name == "face")
    assert face.keypoints == KeypointSpec(names=("kp1", "kp2", "kp3"))
    assert len(read) == 2
    for original in drawn:
        (match,) = [
            one
            for one in read
            if isinstance(one, KeypointsGeometry)
            and one.visibility == original.visibility
            and all(
                math.isclose(a, b, abs_tol=TOLERANCE)
                for got, want in zip(one.points, original.points, strict=True)
                for a, b in zip(got, want, strict=True)
            )
        ]
        assert match


# --- import ---------------------------------------------------------------------

NAMES = 'names:\n  0: "person"\n  1: "dog"\n'


def _source(
    src: Path,
    rows: str,
    *,
    shape: str = "[2, 3]",
    extra: str = "",
    size: tuple[int, int] = (32, 24),
) -> Path:
    write_image(src / "images" / "train" / "a.png", size=size)
    label = src / "labels" / "train" / "a.txt"
    label.parent.mkdir(parents=True, exist_ok=True)
    label.write_text(rows, encoding="utf-8")
    (src / "data.yaml").write_text(f"{NAMES}kpt_shape: {shape}\n{extra}", encoding="utf-8")
    return src


def _read(src: Path) -> tuple[list[Any], list[tuple[str, str, str, int]]]:
    dataset = UltralyticsImporter().read(src)
    labels = [
        (label.class_name, label.geometry) for image in dataset.images for label in image.labels
    ]
    losses = [(loss.kind.value, loss.subject, loss.reason, loss.count) for loss in dataset.losses]
    return labels, losses


def test_a_pose_row_is_one_keypoints_label_and_its_box_is_lost(tmp_path: Path) -> None:
    src = _source(tmp_path, "1 0.5 0.5 0.2 0.2 0.25 0.5 2 0 0 0\n0 .5 .5 .1 .1 0.5 0.25 1 1 1 2\n")

    labels, losses = _read(src)

    assert labels == [
        (
            "dog",
            KeypointsGeometry(
                points=[(8.0, 12.0), (0.0, 0.0)], visibility=(V.VISIBLE, V.UNLABELED)
            ),
        ),
        (
            "person",
            KeypointsGeometry(
                points=[(16.0, 6.0), (32.0, 24.0)], visibility=(V.OCCLUDED, V.VISIBLE)
            ),
        ),
    ]
    assert sorted(losses) == [
        ("geometry", "dog", POSE_BOX, 1),
        ("geometry", "person", POSE_BOX, 1),
    ]


def test_every_class_of_a_pose_dataset_is_a_keypoints_class_named_kp1_to_kpn(
    tmp_path: Path,
) -> None:
    dataset = UltralyticsImporter().read(_source(tmp_path, "0 .5 .5 .1 .1 .5 .5 2 .5 .5 2\n"))

    assert [(one.name, one.geometries, one.keypoints) for one in dataset.classes] == [
        (name, (GeometryType.KEYPOINTS,), KeypointSpec(names=("kp1", "kp2")))
        for name in ("person", "dog")
    ]


def test_two_values_per_point_carry_no_visibility(tmp_path: Path) -> None:
    labels, _ = _read(_source(tmp_path, "0 .5 .5 .1 .1 .25 .5 .5 .25\n", shape="[2, 2]"))

    assert labels == [("person", KeypointsGeometry(points=[(8.0, 12.0), (16.0, 6.0)]))]


def test_an_empty_label_file_is_a_picture_with_no_labels(tmp_path: Path) -> None:
    dataset = UltralyticsImporter().read(_source(tmp_path, ""))

    (image,) = dataset.images
    assert (image.labels, dataset.losses) == ((), ())


@pytest.mark.parametrize(
    ("row", "subject", "reason"),
    [
        ("0 .5 .5 .1 .1 .5 .5 2 .5 .5", "person", "its row is not a box and 2 keypoints"),
        ("0 .5 .5 .1 .1 .5 .5 2 .5 .5 2 1", "person", "its row is not a box and 2 keypoints"),
        ("0 .5 .5 .1 .1 .5 x 2 .5 .5 2", "person", "its coordinates are not finite numbers"),
        ("0 .5 .5 .1 .1 .5 .5 3 .5 .5 2", "person", "a keypoint visibility is not 0, 1 or 2"),
        ("0 .5 .5 .1 .1 .5 .5 0.5 .5 .5 2", "person", "a keypoint visibility is not 0, 1 or 2"),
        ("0 .5 .5 .1 .1 2 2 2 3 3 2", "person", "it lies wholly outside its picture"),
        ("7 .5 .5 .1 .1 .5 .5 2 .5 .5 2", "class 7", "the descriptor names no such class"),
        ("x .5 .5 .1 .1 .5 .5 2 .5 .5 2", "label row", "its class is not a whole number"),
    ],
    ids=["truncated", "too-long", "not-a-number", "v3", "v-fraction", "outside", "class", "index"],
)
def test_a_malformed_pose_row_loses_its_label_and_the_rest_are_read(
    tmp_path: Path, row: str, subject: str, reason: str
) -> None:
    good = "0 .5 .5 .1 .1 .5 .5 2 .5 .5 2\n"
    labels, losses = _read(_source(tmp_path, good * 2 + row + "\n"))

    assert len(labels) == 2
    assert ("label", subject, reason, 1) in losses


def test_a_missing_keypoint_keeps_its_slot_as_unlabeled(tmp_path: Path) -> None:
    labels, _ = _read(_source(tmp_path, "0 .5 .5 .1 .1 0 0 0 .5 .5 2\n"))

    ((_, geometry),) = labels
    assert geometry.visibility == (V.UNLABELED, V.VISIBLE)
    assert geometry.points[0] == (0.0, 0.0)


def test_a_kpt_shape_most_rows_disagree_with_refuses_the_source(tmp_path: Path) -> None:
    rows = "0 .5 .5 .1 .1 .5 .5 2 .5 .5 2\n" + "0 .5 .5 .1 .1 .5 .5 2\n" * 2

    with pytest.raises(ImportSourceUnreadable, match=r"kpt_shape \[2, 3\].*2 of the 3"):
        UltralyticsImporter().read(_source(tmp_path, rows))


def test_half_the_rows_of_the_wrong_length_are_losses_not_a_refusal(tmp_path: Path) -> None:
    rows = "0 .5 .5 .1 .1 .5 .5 2 .5 .5 2\n" + "0 .5 .5 .1 .1 .5 .5 2\n"

    labels, losses = _read(_source(tmp_path, rows))

    assert len(labels) == 1
    assert ("label", "person", "its row is not a box and 2 keypoints", 1) in losses


def test_a_kpt_shape_naming_no_keypoint_refuses_the_source(tmp_path: Path) -> None:
    with pytest.raises(ImportSourceUnreadable, match="names no keypoint"):
        UltralyticsImporter().read(_source(tmp_path, "", shape="[0, 3]"))


@pytest.mark.parametrize("shape", ["[2, 4]", "[2]", "[two, 3]"])
def test_a_malformed_kpt_shape_refuses_the_source(tmp_path: Path, shape: str) -> None:
    with pytest.raises(ImportSourceUnreadable, match="kpt_shape is not"):
        UltralyticsImporter().read(_source(tmp_path, "", shape=shape))


def test_flip_idx_is_reported_unread_once(tmp_path: Path) -> None:
    src = _source(tmp_path, "0 .5 .5 .1 .1 .5 .5 2 .5 .5 2\n", extra="flip_idx: [1, 0]\n")

    _, losses = _read(src)

    assert (
        "attribute",
        "flip_idx",
        "flip_idx is not imported; a keypoint spec records no left-right pairs",
        1,
    ) in losses


def test_the_yolov5_dialect_still_keeps_the_box_of_a_pose_row(tmp_path: Path) -> None:
    dataset = Yolov5YamlImporter().read(_source(tmp_path, "0 .5 .5 .25 .5 .5 .5 2 .5 .5 2\n"))

    assert [label.geometry.type for image in dataset.images for label in image.labels] == [
        GeometryType.BBOX
    ]
