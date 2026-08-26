"""The ``yolov5-yaml`` dialect: the same label layout under the YOLOv5 descriptor grammar.

The layout and the arithmetic are shared with the ``ultralytics`` dialect and
pinned in ``test_ultralytics.py``; what this file pins is the descriptor — a
golden file, and a tiny parser written against the grammar the YOLOv5 README
documents (``nc`` an integer, ``names`` a list, split paths starting ``./``)
that reads the file back the way a trainer of that generation would.
"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID, uuid4

from tests.formats.test_ultralytics import CLASSES, Fixture, _box

from visionset.formats.yolov5_yaml import DATA_FILENAME, Yolov5YamlExporter
from visionset.kernel.domain import (
    Annotation,
    GeometryType,
    PolygonGeometry,
    SplitRecipe,
    TargetFamily,
    Task,
)


def _export(fixture: Fixture, release_id: UUID, dest: Path) -> Path:
    fixture.releases.export(release_id, Yolov5YamlExporter(), dest, allow_lossy=True)
    return dest


def parse_descriptor(text: str) -> dict[str, object]:
    """The YOLOv5 ``data.yaml`` grammar, and nothing wider.

    ``nc`` is an integer, ``names`` is a flow-sequence list of strings, and
    every split value is a path. Anything else in the file is a defect this
    parser refuses rather than skips, so a key the exporter should not write
    fails here instead of being ignored.
    """
    parsed: dict[str, object] = {}
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        if key == "nc":
            parsed[key] = int(value)
        elif key == "names":
            assert value.startswith("[") and value.endswith("]"), value
            parsed[key] = json.loads(value)
        elif key in {"train", "val", "test"}:
            assert value.startswith("./"), value
            parsed[key] = value
        else:
            raise AssertionError(f"key {key!r} is not in the YOLOv5 descriptor grammar")
    return parsed


def test_the_descriptor_is_the_yolov5_grammar(tmp_path: Path) -> None:
    """The golden file: ``./`` paths, ``nc``, a ``names`` list, and no ``path`` key."""
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    assert (out / DATA_FILENAME).read_text(encoding="utf-8") == (
        "# Written by VisionSet. Class order is the release's frozen schema.\n"
        "train: ./images/train\n"
        "val: ./images/train\n"
        "nc: 3\n"
        'names: ["sign", "lane", "weather"]\n'
    )


def test_a_reader_of_the_grammar_finds_nc_equal_to_the_names(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=6)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    out = _export(
        fixture,
        fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7)),
        tmp_path / "out",
    )
    fixture.close()

    parsed = parse_descriptor((out / DATA_FILENAME).read_text(encoding="utf-8"))
    assert parsed["nc"] == len(parsed["names"]) == len(CLASSES)  # type: ignore[arg-type]
    assert parsed["names"] == [declared.name for declared in CLASSES]
    assert (parsed["train"], parsed["val"], parsed["test"]) == (
        "./images/train",
        "./images/val",
        "./images/test",
    )
    for fold in ("train", "val", "test"):
        assert (out / str(parsed[fold])[2:]).is_dir()


def test_a_polygon_is_written_as_its_bounding_box(tmp_path: Path) -> None:
    """Detection only, always: a polygon is reduced, which is what ``degraded`` declares."""
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
    assert GeometryType.POLYGON in Yolov5YamlExporter.degraded_geometries


def test_yolov7_is_the_one_target_and_it_detects_boxes() -> None:
    (target,) = Yolov5YamlExporter.targets

    assert (target.name, target.label, target.family) == (
        "yolov7",
        "YOLOv7",
        TargetFamily.COMMUNITY_YOLO,
    )
    assert target.tasks == {Task.DETECT}
    assert target.supported_geometries == {GeometryType.BBOX}
    assert target.hints.recommended_size == (640, 640)
    assert target.hints.trainer_resizes and target.hints.augmentation_common
