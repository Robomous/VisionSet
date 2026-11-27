"""The ``yolo-obb`` dialect: rotated boxes as a class index and four normalized corners.

The layout and ``data.yaml`` are shared with ``ultralytics`` and pinned in
``test_ultralytics.py``; this file pins the rows, the losses on the way in, and
the round trip through a second workspace.
"""

from __future__ import annotations

import os
from collections import Counter
from math import hypot
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from tests.fixtures.media import write_image
from tests.formats.test_report_agreement import _yolo_counts
from tests.formats.test_ultralytics import CLASSES, IMAGE_SIZE, Fixture, _box

from visionset.formats._obb import ROUNDED
from visionset.formats.registry import exporters, importers
from visionset.formats.ultralytics import UltralyticsImporter
from visionset.formats.yolo_obb import YoloObbExporter, YoloObbImporter
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    ClassExportStatus,
    GeometryType,
    ImportConsent,
    ImportedDataset,
    ImportLossKind,
    LabelClass,
    ObbGeometry,
    PolygonGeometry,
    SplitRecipe,
    TargetFamily,
    obb_corners,
)
from visionset.kernel.ports import Exporter, Importer
from visionset.kernel.services import ImportService, ProjectService, WorkspaceService

SHIP = LabelClass(name="ship", geometries=(GeometryType.OBB,))
PLANE = LabelClass(name="plane", geometries=(GeometryType.OBB,))
OBB_CLASSES = (SHIP, PLANE)

#: Rotated boxes on a 64x48 picture: an ordinary turn, both steep extremes, an
#: axis-aligned box, one touching the frame and one crossing it.
BOXES = (
    ObbGeometry(cx=32.0, cy=24.0, width=20.0, height=8.0, angle=0.5),
    ObbGeometry(cx=20.0, cy=20.0, width=16.0, height=6.0, angle=1.5707),
    ObbGeometry(cx=40.0, cy=30.0, width=12.0, height=5.0, angle=-1.5707),
    ObbGeometry(cx=10.0, cy=10.0, width=8.0, height=4.0, angle=0.0),
    ObbGeometry(cx=58.0, cy=24.0, width=12.0, height=6.0, angle=0.0),
    ObbGeometry(cx=62.0, cy=44.0, width=10.0, height=4.0, angle=0.3),
)


def annotation(label_class: str, geometry: Any, **attributes: Any) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=geometry,
        provenance="human",
        attributes=attributes,
    )


def same_box(found: ObbGeometry, expected: ObbGeometry) -> bool:
    """The documented tolerance: every corner within 1e-6 of the longest side.

    Compared as a set of corners rather than field by field, so a box whose
    canonical angle lands on the other side of ``-pi/2`` still compares equal.
    """
    allowance = 1e-6 * max(expected.width, expected.height)
    return all(
        min(hypot(x - u, y - v) for u, v in obb_corners(found)) <= allowance
        for x, y in obb_corners(expected)
    )


def round_trip(
    tmp_path: Path,
    classes: Any,
    drawing: dict[int, list[Annotation]],
    exporter: Exporter,
    reader: Importer,
    consent: ImportConsent | None = None,
) -> tuple[list[tuple[str, ObbGeometry]], list[tuple[str, Any]], Any]:
    """Publish, export, import into a fresh workspace; answer both sides' labels and the plan."""
    fixture = Fixture(tmp_path / "origin", classes=classes)
    fixture.label(drawing)
    exported = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), exporter, exported, allow_lossy=True)
    with fixture.workspace.unit_of_work() as uow:
        original = [
            (label.label_class, label.geometry)
            for asset in uow.assets.list(fixture.project.id)
            for label in uow.annotations.list(asset.id)
        ]
    fixture.close()

    copy = WorkspaceService.init(tmp_path / "copy")
    created = ProjectService(copy).create("copy")
    imports = ImportService(copy)
    plan = imports.inspect(created.id, reader, exported)
    imports.commit(created.id, reader, exported, consent=consent or ImportConsent())
    with copy.unit_of_work() as uow:
        imported = [
            (label.label_class, label.geometry)
            for asset in uow.assets.list(created.id)
            for label in uow.annotations.list(asset.id)
        ]
    copy.close()
    return original, imported, plan


def assert_same_labels(
    original: list[tuple[str, ObbGeometry]], imported: list[tuple[str, Any]]
) -> None:
    assert len(imported) == len(original)
    unmatched = list(imported)
    for name, geometry in original:
        match = next(
            one
            for one in unmatched
            if one[0] == name and isinstance(one[1], ObbGeometry) and same_box(one[1], geometry)
        )
        unmatched.remove(match)


def _export(fixture: Fixture, release_id: UUID, dest: Path) -> Path:
    fixture.releases.export(release_id, YoloObbExporter(), dest, allow_lossy=True)
    return dest


def _rows(root: Path) -> list[list[str]]:
    return [
        line.split()
        for path in sorted((root / "labels").rglob("*.txt"))
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


# --- registration ---------------------------------------------------------------


def test_the_exporter_and_importer_are_discovered_under_one_name() -> None:
    assert isinstance(exporters()["yolo-obb"], YoloObbExporter)
    assert isinstance(importers()["yolo-obb"], YoloObbImporter)


def test_it_writes_rotated_boxes_only_and_is_its_own_target() -> None:
    assert YoloObbExporter.supported_geometries == {GeometryType.OBB}
    assert YoloObbExporter.degraded_geometries == frozenset()
    (target,) = YoloObbExporter.targets
    assert (target.name, target.family, target.supported_geometries) == (
        "yolo-obb",
        TargetFamily.OTHER,
        {GeometryType.OBB},
    )


# --- export ---------------------------------------------------------------------


def test_a_rotated_box_is_a_class_and_its_four_normalized_corners(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=1, classes=OBB_CLASSES)
    fixture.label({0: [annotation("plane", BOXES[0])]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (row,) = _rows(out)
    width, height = IMAGE_SIZE
    expected = [value for x, y in obb_corners(BOXES[0]) for value in (x / width, y / height)]
    assert row[0] == "1"
    assert [float(value) for value in row[1:]] == pytest.approx(expected, abs=1e-12)
    data = (out / "data.yaml").read_text(encoding="utf-8")
    assert "path: .\ntrain: images/train\nval: images/train\n" in data
    assert data.endswith('names:\n  0: "ship"\n  1: "plane"\n')


def test_corners_crossing_the_frame_are_written_unclamped(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=1, classes=OBB_CLASSES)
    fixture.label({0: [annotation("ship", BOXES[5])]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (row,) = _rows(out)
    values = [float(value) for value in row[1:]]
    assert max(values) > 1.0


def test_every_other_geometry_is_dropped_and_reported(tmp_path: Path) -> None:
    """A four-point polygon that is a rectangle is still a polygon: never converted."""
    rectangle = PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (24.0, 36.0), (8.0, 36.0)])
    fixture = Fixture(tmp_path, classes=(*CLASSES, SHIP))
    fixture.label(
        {
            0: [_box(x=8, y=6, width=20, height=22), annotation("ship", BOXES[0])],
            1: [annotation("lane", rectangle)],
        }
    )
    dest = tmp_path / "out"
    report = fixture.releases.export(
        fixture.publish(), YoloObbExporter(), dest, allow_lossy=True
    ).compatibility
    fixture.close()

    status = {one.label_class: one.status for one in report.classes}
    assert status["ship"] is ClassExportStatus.SUPPORTED
    assert status["sign"] is ClassExportStatus.DROPPED
    assert status["lane"] is ClassExportStatus.DROPPED
    assert report.excluded_annotations == 2
    assert not report.compatible
    assert _yolo_counts(dest) == Counter({"ship": 1})


def test_the_split_lays_out_every_fold_and_an_empty_file_per_unlabelled_picture(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, images=6, classes=OBB_CLASSES)
    fixture.label({0: [annotation("ship", BOXES[0])]})
    out = _export(
        fixture,
        fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7)),
        tmp_path / "out",
    )
    fixture.close()

    for fold in ("train", "val", "test"):
        pictures = sorted(path.stem for path in (out / "images" / fold).iterdir())
        labels = sorted(path.stem for path in (out / "labels" / fold).iterdir())
        assert pictures and pictures == labels
    assert sum(1 for row in _rows(out) if row) == 1
    data = (out / "data.yaml").read_text(encoding="utf-8")
    assert "train: images/train\nval: images/val\ntest: images/test\n" in data


# --- import ---------------------------------------------------------------------

NAMES = 'names:\n  0: "ship"\n  1: "plane"\n'
SIZE = (100, 50)
#: A 40x10 pixel rectangle turned by atan2(3, 4), as corners in pixels.
RECTANGLE = ((30.0, 10.0), (62.0, 34.0), (56.0, 42.0), (24.0, 18.0))


def _normalized(points: Any) -> str:
    return " ".join(f"{x / SIZE[0]!r} {y / SIZE[1]!r}" for x, y in points)


def _source(src: Path, rows: str, *, descriptor: str = NAMES) -> Path:
    write_image(src / "images" / "train" / "a.png", size=SIZE)
    label = src / "labels" / "train" / "a.txt"
    label.parent.mkdir(parents=True, exist_ok=True)
    label.write_text(rows, encoding="utf-8")
    (src / "data.yaml").write_text(descriptor, encoding="utf-8")
    return src


def _read(src: Path) -> ImportedDataset:
    return YoloObbImporter().read(src)


def _losses(dataset: ImportedDataset) -> list[tuple[ImportLossKind, str, str, int]]:
    return [(one.kind, one.subject, one.reason, one.count) for one in dataset.losses]


def _orderings(points: Any) -> list[tuple[tuple[float, float], ...]]:
    ring = list(points)
    turns = [tuple(ring[start:] + ring[:start]) for start in range(4)]
    return turns + [tuple(reversed(one)) for one in turns]


@pytest.mark.parametrize("ordering", range(8))
def test_any_start_corner_in_either_direction_is_the_same_canonical_box(
    tmp_path: Path, ordering: int
) -> None:
    points = _orderings(RECTANGLE)[ordering]
    dataset = _read(_source(tmp_path, f"0 {_normalized(points)}\n"))

    (image,) = dataset.images
    (label,) = image.labels
    assert dataset.losses == ()
    geometry = label.geometry
    assert isinstance(geometry, ObbGeometry)
    assert (geometry.cx, geometry.cy) == pytest.approx((43.0, 26.0))
    assert (geometry.width, geometry.height) == pytest.approx((40.0, 10.0))
    reference = _read(_source(tmp_path / "ref", f"0 {_normalized(RECTANGLE)}\n"))
    canonical = reference.images[0].labels[0].geometry
    assert isinstance(canonical, ObbGeometry)
    assert same_box(geometry, canonical)
    assert geometry.angle == pytest.approx(canonical.angle, abs=1e-9)
    assert [(c.name, c.geometries) for c in dataset.classes] == [
        ("ship", (GeometryType.OBB,)),
        ("plane", (GeometryType.OBB,)),
    ]


@pytest.mark.parametrize(
    ("points", "reason"),
    [
        (((30.0, 10.0), (62.0, 34.0), (50.0, 42.0), (24.0, 18.0)), "not a rectangle"),
        (((20.0, 10.0), (60.0, 10.0), (54.0, 20.0), (26.0, 20.0)), "not a rectangle"),
        (((20.0, 10.0), (60.0, 10.0), (66.0, 20.0), (26.0, 20.0)), "not a rectangle"),
        (((30.0, 10.0), (62.0, 34.0), (24.0, 18.0), (56.0, 42.0)), "not a rectangle"),
        (((10.0, 10.0), (20.0, 10.0), (30.0, 10.0), (40.0, 10.0)), "no area"),
        (((10.0, 10.0), (10.0, 10.0), (10.0, 10.0), (10.0, 10.0)), "no area"),
    ],
    ids=["skewed", "trapezoid", "parallelogram", "bow-tie", "collinear", "a-point"],
)
def test_a_quadrilateral_that_is_not_a_rectangle_is_a_label_loss(
    tmp_path: Path, points: Any, reason: str
) -> None:
    dataset = _read(_source(tmp_path, f"0 {_normalized(points)}\n1 {_normalized(RECTANGLE)}\n"))

    ((kind, subject, why, count),) = _losses(dataset)
    assert (kind, subject, count) == (ImportLossKind.LABEL, "ship", 1)
    assert reason in why
    assert [label.class_name for label in dataset.images[0].labels] == ["plane"]


@pytest.mark.parametrize("decimals", [6, 3])
@pytest.mark.parametrize(
    "truth",
    [
        ObbGeometry(cx=50.0, cy=25.0, width=40.0, height=12.0, angle=0.4),
        ObbGeometry(cx=50.0, cy=25.0, width=30.0, height=9.0, angle=-1.1),
    ],
)
def test_corners_rounded_to_the_rows_decimals_are_the_nearest_rectangle(
    tmp_path: Path, truth: ObbGeometry, decimals: int
) -> None:
    row = " ".join(
        f"{x / SIZE[0]:.{decimals}f} {y / SIZE[1]:.{decimals}f}" for x, y in obb_corners(truth)
    )
    dataset = _read(_source(tmp_path, f"0 {row}\n"))

    assert set(_losses(dataset)) <= {(ImportLossKind.GEOMETRY, "ship", ROUNDED, 1)}
    (label,) = dataset.images[0].labels
    fitted = label.geometry
    assert isinstance(fitted, ObbGeometry)
    unit = 10.0**-decimals
    for found, expected in zip(obb_corners(fitted), obb_corners(truth), strict=True):
        assert abs(found[0] - expected[0]) <= unit * SIZE[0]
        assert abs(found[1] - expected[1]) <= unit * SIZE[1]
    if decimals == 3:
        assert _losses(dataset) == [(ImportLossKind.GEOMETRY, "ship", ROUNDED, 1)]


@pytest.mark.parametrize(
    ("row", "subject"),
    [
        ("9 0.3 0.2 0.62 0.68 0.56 0.84 0.24 0.36", "class 9"),
        ("-1 0.3 0.2 0.62 0.68 0.56 0.84 0.24 0.36", "label row"),
        ("x 0.3 0.2 0.62 0.68 0.56 0.84 0.24 0.36", "label row"),
        ("0 0.5 0.5 0.1 0.1", "ship"),
        ("0 0.3 0.2 0.62 0.68 0.56 0.84", "ship"),
        ("0 0.3 0.2 0.62 0.68 0.56 0.84 0.24 0.36 0.1", "ship"),
        ("0 0.3 0.2 0.62 0.68 0.56 0.84 0.24 1e999", "ship"),
        ("0 0.3 0.2 0.62 0.68 0.56 0.84 0.24 abc", "ship"),
        ("0 5.3 5.2 5.62 5.68 5.56 5.84 5.24 5.36", "ship"),
    ],
    ids=[
        "unknown-class",
        "negative-class",
        "class-not-a-number",
        "a-detection-row",
        "three-corners",
        "an-odd-extra-value",
        "overflow",
        "not-a-number",
        "wholly-outside",
    ],
)
def test_a_row_the_format_cannot_hold_is_a_label_loss(
    tmp_path: Path, row: str, subject: str
) -> None:
    dataset = _read(_source(tmp_path, f"{row}\n1 {_normalized(RECTANGLE)}\n"))

    ((kind, found, _, count),) = _losses(dataset)
    assert (kind, found, count) == (ImportLossKind.LABEL, subject, 1)
    assert len(dataset.images[0].labels) == 1


@pytest.mark.parametrize("token", ["nan", "inf", "-Infinity"])
def test_a_spelled_out_non_finite_number_refuses_the_file(tmp_path: Path, token: str) -> None:
    with pytest.raises(ImportSourceUnreadable, match="non-finite"):
        _read(_source(tmp_path, f"0 {token} 0.2 0.62 0.68 0.56 0.84 0.24 0.36\n"))


def test_an_empty_label_file_is_a_picture_with_nothing_in_it(tmp_path: Path) -> None:
    dataset = _read(_source(tmp_path, ""))

    (image,) = dataset.images
    assert image.labels == ()
    assert dataset.losses == ()


def test_a_missing_label_file_is_an_unlabelled_picture_and_an_orphan_loses_its_rows(
    tmp_path: Path,
) -> None:
    src = _source(tmp_path, f"0 {_normalized(RECTANGLE)}\n")
    write_image(src / "images" / "val" / "b.png", size=SIZE, seed=1)
    orphan = src / "labels" / "val" / "ghost.txt"
    orphan.parent.mkdir(parents=True)
    orphan.write_text(f"0 {_normalized(RECTANGLE)}\n1 {_normalized(RECTANGLE)}\n")

    dataset = _read(src)
    assert {str(image.path): len(image.labels) for image in dataset.images} == {
        "images/train/a.png": 1,
        "images/val/b.png": 0,
    }
    assert _losses(dataset) == [
        (ImportLossKind.LABEL, "labels/val/ghost.txt", "a label file with no picture", 2)
    ]


def test_a_source_without_a_descriptor_or_pictures_is_refused(tmp_path: Path) -> None:
    (tmp_path / "images").mkdir()
    with pytest.raises(ImportSourceUnreadable, match="data.yaml"):
        _read(tmp_path)
    (tmp_path / "data.yaml").write_text(NAMES)
    with pytest.raises(ImportSourceUnreadable, match="no pictures"):
        _read(tmp_path)


def test_the_ultralytics_importer_reads_the_same_rows_as_four_point_polygons(
    tmp_path: Path,
) -> None:
    """Why OBB is a dialect of its own: the plain reader cannot tell a rotated box."""
    src = _source(tmp_path, f"0 {_normalized(RECTANGLE)}\n")

    (label,) = UltralyticsImporter().read(src).images[0].labels
    assert isinstance(label.geometry, PolygonGeometry)
    assert len(label.geometry.points) == 4


# --- the round trip -------------------------------------------------------------


def test_rotated_boxes_survive_export_and_import_within_the_documented_tolerance(
    tmp_path: Path,
) -> None:
    drawing = {
        0: [annotation("ship", box) for box in BOXES[:3]],
        1: [annotation("plane", box) for box in BOXES[3:]],
    }
    original, imported, plan = round_trip(
        tmp_path, OBB_CLASSES, drawing, YoloObbExporter(), YoloObbImporter()
    )

    assert plan.losses == ()
    assert_same_labels(original, imported)


# --- an external reader, opt in -------------------------------------------------


def test_ultralytics_own_label_parser_reads_the_export(tmp_path: Path) -> None:
    """Opt in: runs when ``ultralytics`` is importable, and is required under
    ``VISIONSET_EXTERNAL_READERS=1``. Never a dependency of this repository."""
    if os.environ.get("VISIONSET_EXTERNAL_READERS") == "1":
        from ultralytics.data import utils
    else:
        utils = pytest.importorskip("ultralytics.data.utils")
    import numpy as np

    inside = BOXES[:4]
    fixture = Fixture(tmp_path, images=1, classes=OBB_CLASSES)
    fixture.label({0: [annotation("ship", box) for box in inside]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (picture,) = (out / "images" / "train").iterdir()
    label = (out / "labels" / "train" / picture.name).with_suffix(".txt")
    arguments: tuple[Any, ...] = (str(picture), str(label), "", False, 2, 0, 0, False)
    try:
        result = utils.verify_image_label(arguments)
    except ValueError:
        result = utils.verify_image_label(arguments[:-1])
    _, boxes, _, segments, _, missing, found, empty, corrupt, message = result
    assert (missing, found, empty, corrupt) == (0, 1, 0, 0), message
    assert len(boxes) == len(segments) == len(inside)
    width, height = IMAGE_SIZE
    expected = [np.array([(x / width, y / height) for x, y in obb_corners(box)]) for box in inside]
    for segment in segments:
        # float32 inside ultralytics, so a looser bound than the round trip's.
        match = next(
            index for index, one in enumerate(expected) if np.allclose(segment, one, atol=1e-5)
        )
        expected.pop(match)
    assert expected == []
