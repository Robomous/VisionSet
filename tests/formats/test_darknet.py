"""The ``darknet`` dialect: ``obj.data``, ``obj.names`` and the image lists.

Layout and label arithmetic are shared with ``ultralytics`` and pinned in
``test_ultralytics.py``; this file pins the descriptor files, read back by a
parser written against the grammar Darknet's ``read_data_cfg`` accepts.
"""

from __future__ import annotations

from pathlib import Path
from typing import NamedTuple
from uuid import UUID, uuid4

from tests.formats.test_ultralytics import CLASSES, Fixture, _box

from visionset.formats.darknet import DarknetExporter
from visionset.kernel.domain import (
    Annotation,
    GeometryType,
    PolygonGeometry,
    SplitRecipe,
    TargetFamily,
    Task,
)


def _export(fixture: Fixture, release_id: UUID, dest: Path) -> Path:
    fixture.releases.export(release_id, DarknetExporter(), dest, allow_lossy=True)
    return dest


class Spec(NamedTuple):
    names: list[str]
    train: list[str]
    valid: list[str]
    backup: str


def parse_spec(root: Path) -> Spec:
    """``obj.data`` as ``key = value`` lines, with the names and image lists read through it."""
    options: dict[str, str] = {}
    for line in (root / "obj.data").read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        assert separator, line
        options[key.strip()] = value.strip()
    assert set(options) == {"classes", "train", "valid", "names", "backup"}
    names = (root / options["names"]).read_text(encoding="utf-8").splitlines()
    assert int(options["classes"]) == len(names)
    return Spec(
        names,
        (root / options["train"]).read_text(encoding="utf-8").splitlines(),
        (root / options["valid"]).read_text(encoding="utf-8").splitlines(),
        options["backup"],
    )


def test_the_descriptor_is_the_darknet_grammar(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    assert (out / "obj.data").read_text(encoding="utf-8") == (
        "classes = 3\ntrain = train.txt\nvalid = valid.txt\nnames = obj.names\nbackup = backup/\n"
    )
    assert (out / "obj.names").read_text(encoding="utf-8") == "sign\nlane\nweather\n"


def test_the_lists_name_every_image_of_their_fold_and_each_has_a_label(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=6)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    out = _export(
        fixture,
        fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7)),
        tmp_path / "out",
    )
    fixture.close()

    spec = parse_spec(out)
    assert spec.names == [declared.name for declared in CLASSES]
    train, valid = spec.train, spec.valid
    assert train and valid and not set(train) & set(valid)
    assert all(line.startswith("images/train/") for line in train)
    assert all(line.startswith("images/val/") for line in valid)
    for line in [*train, *valid]:
        assert (out / line).is_file()
        label = (out / line.replace("images/", "labels/", 1)).with_suffix(".txt")
        assert label.is_file()
    listed = len(train) + len(valid)
    assert listed + len(list((out / "images" / "test").iterdir())) == 6


def test_without_a_validation_fold_valid_is_the_training_list(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=3)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    spec = parse_spec(out)
    assert len(spec.train) == 3
    assert spec.valid == spec.train
    assert spec.backup == "backup/"


def test_a_polygon_is_written_as_its_bounding_box(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    lane = Annotation(
        asset_id=uuid4(),
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (16.0, 36.0)]),
        provenance="human",
    )
    fixture.label({0: [lane]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    rows = [
        path.read_text(encoding="utf-8")
        for path in sorted((out / "labels" / "train").iterdir())
        if path.read_text(encoding="utf-8")
    ]
    assert rows == ["1 0.250000 0.500000 0.250000 0.500000\n"]
    assert GeometryType.POLYGON in DarknetExporter.degraded_geometries


def test_yolov4_is_the_one_target_and_it_detects_boxes() -> None:
    (target,) = DarknetExporter.targets

    assert (target.name, target.label, target.family) == (
        "yolov4",
        "YOLOv4",
        TargetFamily.COMMUNITY_YOLO,
    )
    assert target.tasks == {Task.DETECT}
    assert target.supported_geometries == {GeometryType.BBOX}
    assert target.hints.recommended_size == (416, 416)
