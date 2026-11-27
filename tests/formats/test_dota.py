"""The ``dota`` format: rotated boxes as pixel corners, a category and a difficulty flag."""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from tests.fixtures.media import write_image
from tests.formats.test_report_agreement import _dota_counts
from tests.formats.test_ultralytics import CLASSES, Fixture, _box
from tests.formats.test_yolo_obb import (
    BOXES,
    OBB_CLASSES,
    RECTANGLE,
    SHIP,
    annotation,
    assert_same_labels,
    round_trip,
    same_box,
)

from visionset.formats._obb import FITTED
from visionset.formats.dota import DotaExporter, DotaImporter, category_tokens
from visionset.formats.registry import exporters, importers
from visionset.kernel import ExportSourceUnreadable, ImportSourceUnreadable
from visionset.kernel.domain import (
    Attribute,
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


def _export(fixture: Fixture, dest: Path, *, split: SplitRecipe | None = None) -> Path:
    fixture.releases.export(fixture.publish(split=split), DotaExporter(), dest, allow_lossy=True)
    return dest


def _rows(root: Path) -> list[list[str]]:
    return [
        line.split()
        for path in sorted(root.glob("*/labelTxt/*.txt"))
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


# --- registration ---------------------------------------------------------------


def test_the_exporter_and_importer_are_discovered_under_one_name() -> None:
    assert isinstance(exporters()["dota"], DotaExporter)
    assert isinstance(importers()["dota"], DotaImporter)


def test_it_writes_rotated_boxes_only_and_is_its_own_target() -> None:
    assert DotaExporter.supported_geometries == {GeometryType.OBB}
    assert DotaExporter.degraded_geometries == frozenset()
    (target,) = DotaExporter.targets
    assert (target.name, target.family) == ("dota", TargetFamily.OTHER)


# --- export ---------------------------------------------------------------------


def test_a_rotated_box_is_its_pixel_corners_its_category_and_difficult_zero(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, images=1, classes=OBB_CLASSES)
    fixture.label({0: [annotation("plane", BOXES[0])]})
    out = _export(fixture, tmp_path / "out")
    fixture.close()

    (row,) = _rows(out)
    expected = [value for corner in obb_corners(BOXES[0]) for value in corner]
    assert [float(value) for value in row[:8]] == pytest.approx(expected, abs=1e-9)
    assert row[8:] == ["plane", "0"]
    (picture,) = (out / "train" / "images").iterdir()
    assert (out / "train" / "labelTxt" / picture.name).with_suffix(".txt").is_file()
    assert (
        not (out / "train" / "labelTxt" / picture.name)
        .with_suffix(".txt")
        .read_text(encoding="utf-8")
        .startswith(("imagesource", "gsd"))
    )


def test_the_split_lays_out_every_fold_with_a_label_file_per_picture(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=6, classes=OBB_CLASSES)
    fixture.label({0: [annotation("ship", BOXES[0])]})
    out = _export(fixture, tmp_path / "out", split=SplitRecipe(train=0.5, val=0.25, test=0.25))
    fixture.close()

    for fold in ("train", "val", "test"):
        pictures = sorted(path.stem for path in (out / fold / "images").iterdir())
        labels = sorted(path.stem for path in (out / fold / "labelTxt").iterdir())
        assert pictures and pictures == labels
    assert sum(1 for row in _rows(out) if row) == 1


def test_every_other_geometry_is_dropped_and_reported(tmp_path: Path) -> None:
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
        fixture.publish(), DotaExporter(), dest, allow_lossy=True
    ).compatibility
    fixture.close()

    status = {one.label_class: one.status for one in report.classes}
    assert status == {
        "ship": ClassExportStatus.SUPPORTED,
        "sign": ClassExportStatus.DROPPED,
        "lane": ClassExportStatus.DROPPED,
        "weather": ClassExportStatus.DROPPED,
    }
    assert report.excluded_annotations == 2
    assert _dota_counts(dest) == Counter({"ship": 1})


def test_whitespace_in_a_class_name_is_written_as_one_hyphen(tmp_path: Path) -> None:
    spaced = LabelClass(name="baseball  diamond", geometries=(GeometryType.OBB,))
    tabbed = LabelClass(name="small \t vehicle", geometries=(GeometryType.OBB,))
    fixture = Fixture(tmp_path, images=1, classes=(spaced, tabbed, SHIP))
    fixture.label(
        {
            0: [
                annotation("baseball  diamond", BOXES[0]),
                annotation("small \t vehicle", BOXES[1]),
                annotation("ship", BOXES[2]),
            ]
        }
    )
    out = _export(fixture, tmp_path / "out")
    fixture.close()

    assert sorted(row[8] for row in _rows(out)) == ["baseball-diamond", "ship", "small-vehicle"]
    assert all(len(row) == 10 for row in _rows(out))


def test_a_name_without_whitespace_is_its_own_category() -> None:
    assert category_tokens(["ship", "large-vehicle", "Car_2"]) == {
        "ship": "ship",
        "large-vehicle": "large-vehicle",
        "Car_2": "Car_2",
    }


def test_two_classes_that_would_share_a_category_refuse_the_export(tmp_path: Path) -> None:
    spaced = LabelClass(name="small vehicle", geometries=(GeometryType.OBB,))
    hyphened = LabelClass(name="small-vehicle", geometries=(GeometryType.OBB,))
    fixture = Fixture(tmp_path, images=1, classes=(spaced, hyphened))
    fixture.label(
        {0: [annotation("small vehicle", BOXES[0]), annotation("small-vehicle", BOXES[1])]}
    )
    with pytest.raises(
        ExportSourceUnreadable, match="'small vehicle' and 'small-vehicle'.*'small-vehicle'"
    ):
        _export(fixture, tmp_path / "out")
    fixture.close()


def test_a_name_that_is_only_whitespace_is_refused() -> None:
    with pytest.raises(ExportSourceUnreadable, match=re.escape(repr(" \t "))):
        category_tokens(["ship", " \t "])


# --- difficult ------------------------------------------------------------------

FLAGGED = LabelClass(
    name="ship",
    geometries=(GeometryType.OBB,),
    attributes=(Attribute(name="difficult", kind="boolean"),),
)


def test_the_difficult_attribute_is_written_back_and_its_import_is_a_declared_loss(
    tmp_path: Path,
) -> None:
    drawing = {
        0: [
            annotation("ship", BOXES[0], difficult=True),
            annotation("ship", BOXES[1], difficult=False),
            annotation("ship", BOXES[2]),
        ]
    }
    fixture = Fixture(tmp_path / "written", images=1, classes=(FLAGGED,))
    fixture.label(drawing)
    out = _export(fixture, tmp_path / "written" / "out")
    fixture.close()
    assert sorted(row[9] for row in _rows(out)) == ["0", "0", "1"]

    original, imported, plan = round_trip(
        tmp_path / "trip",
        (FLAGGED,),
        drawing,
        DotaExporter(),
        DotaImporter(),
        ImportConsent(kinds=frozenset({ImportLossKind.ATTRIBUTE})),
    )
    assert [(one.kind, one.subject, one.reason, one.count) for one in plan.losses] == [
        (ImportLossKind.ATTRIBUTE, "ship", "difficult is not imported", 1)
    ]
    assert_same_labels(original, imported)


# --- import ---------------------------------------------------------------------

SIZE = (100, 50)


def _corners(points: Any) -> str:
    return " ".join(f"{x!r} {y!r}" for x, y in points)


def _source(src: Path, rows: str) -> Path:
    write_image(src / "train" / "images" / "P0001.png", size=SIZE)
    label = src / "train" / "labelTxt" / "P0001.txt"
    label.parent.mkdir(parents=True, exist_ok=True)
    label.write_text(rows, encoding="utf-8")
    return src


def _read(src: Path) -> ImportedDataset:
    return DotaImporter().read(src)


def _losses(dataset: ImportedDataset) -> list[tuple[ImportLossKind, str, str, int]]:
    return [(one.kind, one.subject, one.reason, one.count) for one in dataset.losses]


def test_a_row_is_a_canonical_box_of_the_class_its_category_names(tmp_path: Path) -> None:
    rows = (
        "imagesource:GoogleEarth\ngsd:0.146343590398\n"
        f"{_corners(RECTANGLE)} large-vehicle 0\n{_corners(RECTANGLE[::-1])} plane\n"
    )
    dataset = _read(_source(tmp_path, rows))

    assert dataset.losses == ()
    (image,) = dataset.images
    assert str(image.path) == "train/images/P0001.png"
    assert (image.width, image.height) == SIZE
    first, second = (label.geometry for label in image.labels)
    assert isinstance(first, ObbGeometry) and isinstance(second, ObbGeometry)
    assert (first.cx, first.cy, first.width, first.height) == pytest.approx((43, 26, 40, 10))
    assert same_box(second, first)
    assert [(c.name, c.geometries) for c in dataset.classes] == [
        ("large-vehicle", (GeometryType.OBB,)),
        ("plane", (GeometryType.OBB,)),
    ]


@pytest.mark.parametrize(
    ("row", "subject", "reason"),
    [
        ("30 10 62 34 50 42 24 18 ship 0", "ship", "not a rectangle"),
        ("20 10 60 10 54 20 26 20 ship 0", "ship", "not a rectangle"),
        ("20 10 60 10 66 20 26 20 ship 0", "ship", "not a rectangle"),
        ("10 10 20 10 30 10 40 10 ship 0", "ship", "no area"),
        ("530 510 562 534 556 542 524 518 ship 0", "ship", "wholly outside"),
        ("30 10 62 34 56 42 24 abc ship 0", "ship", "not finite"),
        ("30 10 62 34 56 42 24 1e999 ship 0", "ship", "not finite"),
        ("30 10 62 34 56 42 ship 0", "label row", "not four corners"),
        ("30 10 62 34 56 42 24 18 ship 0 extra", "label row", "not four corners"),
    ],
    ids=[
        "skewed",
        "trapezoid",
        "parallelogram",
        "collinear",
        "wholly-outside",
        "not-a-number",
        "overflow",
        "short",
        "long",
    ],
)
def test_a_row_the_format_cannot_hold_is_a_label_loss(
    tmp_path: Path, row: str, subject: str, reason: str
) -> None:
    dataset = _read(_source(tmp_path, f"{row}\n{_corners(RECTANGLE)} plane 0\n"))

    ((kind, found, why, count),) = _losses(dataset)
    assert (kind, found, count) == (ImportLossKind.LABEL, subject, 1)
    assert reason in why
    assert [label.class_name for label in dataset.images[0].labels] == ["plane"]
    assert [c.name for c in dataset.classes] == ["plane"]


@pytest.mark.parametrize(
    "truth",
    [
        ObbGeometry(cx=50.0, cy=25.0, width=40.0, height=12.0, angle=0.4),
        ObbGeometry(cx=50.0, cy=25.0, width=30.0, height=9.0, angle=-1.1),
    ],
)
def test_whole_pixel_corners_off_a_rectangle_are_its_nearest_rectangle_and_degraded(
    tmp_path: Path, truth: ObbGeometry
) -> None:
    drawn = [(round(x), round(y)) for x, y in obb_corners(truth)]
    dataset = _read(_source(tmp_path, f"{_corners(drawn)} ship 0\n"))

    assert _losses(dataset) == [(ImportLossKind.GEOMETRY, "ship", FITTED, 1)]
    (label,) = dataset.images[0].labels
    fitted = label.geometry
    assert isinstance(fitted, ObbGeometry)
    assert fitted != ObbGeometry.model_validate(truth.model_dump())
    for x, y in drawn:
        assert min(max(abs(x - fx), abs(y - fy)) for fx, fy in obb_corners(fitted)) <= 1.0
    assert (fitted.cx, fitted.cy) == pytest.approx((truth.cx, truth.cy), abs=0.5)
    assert (fitted.width, fitted.height) == pytest.approx((truth.width, truth.height), abs=1.0)

    tenths = [(float(x), float(y)) for x, y in drawn]
    claimed = _read(_source(tmp_path / "tenths", f"{_corners(tenths)} ship 0\n"))
    assert _losses(claimed) == [(ImportLossKind.GEOMETRY, "ship", FITTED, 1)]
    assert claimed.images[0].labels[0].geometry == fitted


def test_a_box_too_small_to_judge_by_shape_is_judged_by_the_rows_precision(
    tmp_path: Path,
) -> None:
    whole = _read(_source(tmp_path, "20 10 24 10 24 12 21 12 ship 0\n"))
    tenths = _read(_source(tmp_path / "tenths", "20.0 10.0 24.0 10.0 24.0 12.0 21.0 12.0 ship 0\n"))

    assert _losses(whole) == [(ImportLossKind.GEOMETRY, "ship", FITTED, 1)]
    assert [(kind, why) for kind, _, why, _ in _losses(tenths)] == [
        (ImportLossKind.LABEL, "its four corners are not a rectangle")
    ]


def test_a_difficult_flag_other_than_0_or_1_is_an_attribute_loss(tmp_path: Path) -> None:
    dataset = _read(_source(tmp_path, f"{_corners(RECTANGLE)} ship 2\n"))

    assert _losses(dataset) == [
        (ImportLossKind.ATTRIBUTE, "ship", "its difficult flag is neither 0 nor 1", 1)
    ]
    assert len(dataset.images[0].labels) == 1


@pytest.mark.parametrize("token", ["nan", "inf"])
def test_a_spelled_out_non_finite_number_refuses_the_file(tmp_path: Path, token: str) -> None:
    with pytest.raises(ImportSourceUnreadable, match="non-finite"):
        _read(_source(tmp_path, f"{token} 10 62 34 56 42 24 18 ship 0\n"))


def test_empty_missing_and_orphaned_label_files(tmp_path: Path) -> None:
    src = _source(tmp_path, "imagesource:GoogleEarth\ngsd:null\n")
    write_image(src / "val" / "images" / "P0002.png", size=SIZE, seed=1)
    orphan = src / "val" / "labelTxt" / "P0003.txt"
    orphan.parent.mkdir(parents=True)
    orphan.write_text(f"{_corners(RECTANGLE)} ship 0\n{_corners(RECTANGLE)} ship 1\n")

    dataset = _read(src)
    assert {str(image.path): len(image.labels) for image in dataset.images} == {
        "train/images/P0001.png": 0,
        "val/images/P0002.png": 0,
    }
    assert dataset.classes == ()
    assert _losses(dataset) == [
        (ImportLossKind.LABEL, "val/labelTxt/P0003.txt", "a label file with no picture", 2)
    ]


def test_a_source_with_no_pictures_is_refused(tmp_path: Path) -> None:
    (tmp_path / "train" / "labelTxt").mkdir(parents=True)
    with pytest.raises(ImportSourceUnreadable, match="no pictures"):
        _read(tmp_path)


# --- the round trip -------------------------------------------------------------


def test_rotated_boxes_survive_export_and_import_within_the_documented_tolerance(
    tmp_path: Path,
) -> None:
    drawing = {
        0: [annotation("ship", box) for box in BOXES[:3]],
        1: [annotation("plane", box) for box in BOXES[3:]],
    }
    original, imported, plan = round_trip(
        tmp_path, OBB_CLASSES, drawing, DotaExporter(), DotaImporter()
    )

    assert plan.losses == ()
    assert_same_labels(original, imported)
