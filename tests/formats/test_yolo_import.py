"""The YOLO importers: ultralytics, yolov5-yaml and darknet, their losses, and the round trips."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.cli._flow import ok, project, workspace
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import CLASSES, Fixture, _box

from visionset.formats.darknet import DarknetExporter, DarknetImporter
from visionset.formats.registry import importer, importers, pick_importer
from visionset.formats.ultralytics import UltralyticsExporter, UltralyticsImporter
from visionset.formats.yolov5_yaml import Yolov5YamlExporter, Yolov5YamlImporter
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    ClassificationGeometry,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    LabelClass,
    PolygonGeometry,
)
from visionset.kernel.ports import Importer
from visionset.kernel.services import ImportService, ProjectService, SchemaService, WorkspaceService

NAMES = 'names:\n  0: "car"\n  1: "lane"\n'


def _source(
    src: Path,
    rows: str,
    *,
    descriptor: str = NAMES,
    size: tuple[int, int] = (32, 24),
    orientation: int | None = None,
    suffix: str = ".png",
) -> Path:
    write_image(src / "images" / "train" / f"a{suffix}", size=size, orientation=orientation)
    label = src / "labels" / "train" / "a.txt"
    label.parent.mkdir(parents=True, exist_ok=True)
    label.write_text(rows, encoding="utf-8")
    (src / "data.yaml").write_text(descriptor, encoding="utf-8")
    return src


def _labels(src: Path) -> list[Any]:
    return [
        label.geometry for image in UltralyticsImporter().read(src).images for label in image.labels
    ]


def _losses(src: Path) -> list[tuple[str, int]]:
    return [(loss.kind.value, loss.count) for loss in UltralyticsImporter().read(src).losses]


@pytest.mark.parametrize(
    ("name", "plugin"),
    [
        ("ultralytics", UltralyticsImporter),
        ("yolov5-yaml", Yolov5YamlImporter),
        ("darknet", DarknetImporter),
    ],
)
def test_each_importer_is_discovered_under_the_exporter_s_name(name: str, plugin: type) -> None:
    found = importers()
    assert isinstance(found[name], plugin)
    assert isinstance(found[name], Importer)
    assert isinstance(importer(name), plugin)


def test_the_existing_yolo_alias_reaches_the_ultralytics_importer() -> None:
    plugin, alias = pick_importer(importers(), "yolo")
    assert isinstance(plugin, UltralyticsImporter)
    assert alias == "yolo"


def test_a_box_row_is_scaled_out_of_the_picture_s_size(tmp_path: Path) -> None:
    dataset = UltralyticsImporter().read(_source(tmp_path, "0 0.5 0.5 0.25 0.5\n"))

    (image,) = dataset.images
    assert str(image.path) == "images/train/a.png"
    assert (image.width, image.height) == (32, 24)
    assert image.labels[0].geometry == BboxGeometry(x=12, y=6, width=8, height=12)
    assert dataset.losses == ()
    assert [(c.name, c.geometries) for c in dataset.classes] == [
        ("car", (GeometryType.BBOX,)),
        ("lane", (GeometryType.BBOX,)),
    ]


def test_a_polygon_row_is_read_as_a_polygon(tmp_path: Path) -> None:
    src = _source(tmp_path, "1 0.25 0.25 0.75 0.25 0.25 0.75\n")

    assert _labels(src) == [PolygonGeometry(points=[(8, 6), (24, 6), (8, 18)])]
    lane = next(c for c in UltralyticsImporter().read(src).classes if c.name == "lane")
    assert lane.geometries == (GeometryType.POLYGON,)


def test_the_exif_quarter_turn_is_applied_before_scaling(tmp_path: Path) -> None:
    src = _source(tmp_path, "0 0.5 0.5 0.5 0.5\n", orientation=6, suffix=".jpg")
    (image,) = UltralyticsImporter().read(src).images

    assert (image.width, image.height) == (24, 32)
    assert image.labels[0].geometry == BboxGeometry(x=6, y=8, width=12, height=16)


@pytest.mark.parametrize(
    "row",
    [
        "x 0.5 0.5 0.1 0.1",
        "-1 0.5 0.5 0.1 0.1",
        "9 0.5 0.5 0.1 0.1",
        "0 0.5 0.5 0 0.1",
        "0 0.5 0.5 -0.1 0.1",
        "0 0.5 0.5 abc 0.1",
        "0 0.5 0.5 1_0 0.1",
        "0 0.5 0.5 1e999 0.1",
        "0 0.5 0.5 0.1",
        "1" * 5000 + " 0.5 0.5 0.1 0.1",
        "0 0.1 0.1 0.2 0.2 0.3",
        "1 0.1 0.1 0.2 0.2 0.3 0.3",
        "0 5 5 0.1 0.1",
        "0",
    ],
)
def test_a_row_the_kernel_cannot_represent_is_a_label_loss(tmp_path: Path, row: str) -> None:
    src = _source(tmp_path, f"{row}\n0 0.5 0.5 0.25 0.5\n")

    assert _losses(src) == [("label", 1)]
    assert len(_labels(src)) == 1


@pytest.mark.parametrize("token", ["nan", "NaN", "inf", "-Infinity"])
def test_a_spelled_out_non_finite_number_refuses_the_file(tmp_path: Path, token: str) -> None:
    with pytest.raises(ImportSourceUnreadable, match="non-finite"):
        UltralyticsImporter().read(_source(tmp_path, f"0 {token} 0.5 0.1 0.1\n"))


def test_a_label_file_with_no_picture_is_a_label_loss_per_row(tmp_path: Path) -> None:
    src = _source(tmp_path, "0 0.5 0.5 0.1 0.1\n")
    (src / "labels" / "train" / "ghost.txt").write_text("0 .5 .5 .1 .1\n1 .5 .5 .1 .1\n")

    losses = UltralyticsImporter().read(src).losses
    assert [(loss.kind, loss.subject, loss.count) for loss in losses] == [
        (ImportLossKind.LABEL, "labels/train/ghost.txt", 2)
    ]


def test_a_picture_with_no_label_file_is_imported_unlabelled(tmp_path: Path) -> None:
    src = _source(tmp_path, "0 0.5 0.5 0.1 0.1\n")
    write_image(src / "images" / "val" / "b.png", size=(32, 24), seed=1)

    dataset = UltralyticsImporter().read(src)
    assert {str(image.path): len(image.labels) for image in dataset.images} == {
        "images/train/a.png": 1,
        "images/val/b.png": 0,
    }


def test_the_fold_first_variant_finds_its_labels(tmp_path: Path) -> None:
    write_image(tmp_path / "train" / "images" / "a.png", size=(32, 24))
    (tmp_path / "train" / "labels").mkdir(parents=True)
    (tmp_path / "train" / "labels" / "a.txt").write_text("1 0.5 0.5 0.25 0.5\n")
    (tmp_path / "data.yaml").write_text(NAMES)

    (image,) = UltralyticsImporter().read(tmp_path).images
    assert str(image.path) == "train/images/a.png"
    assert image.labels[0].class_name == "lane"


def test_a_picture_that_cannot_be_measured_loses_its_labels(tmp_path: Path) -> None:
    src = _source(tmp_path, "0 0.5 0.5 0.1 0.1\n")
    (src / "images" / "train" / "a.png").write_bytes(b"not a picture")

    assert _losses(src) == [("label", 1)]


def test_a_pose_row_keeps_its_box_and_reports_the_keypoints(tmp_path: Path) -> None:
    descriptor = NAMES + "kpt_shape: [2, 3]\n"
    rows = (
        "0 0.5 0.5 0.25 0.5 0.4 0.4 2 0.6 0.6 2\n0 0.5 0.5 0.25 0.5 0 0 0 0 0 0\n0 .5 .5 .1 .1 1\n"
    )
    src = _source(tmp_path, rows, descriptor=descriptor)

    assert sorted(_losses(src)) == [("geometry", 1), ("label", 1)]
    assert _labels(src) == [BboxGeometry(x=12, y=6, width=8, height=12)] * 2


# --- the descriptor -----------------------------------------------------------


@pytest.mark.parametrize(
    "descriptor",
    [
        NAMES,
        "# a comment\npath: .\ntrain: images/train\nnames: ['car', 'lane']  # two\n",
        'nc: 2\nnames: ["car", "lane"]\n',
        "names:\n- car\n- lane\n",
        "names:\n  - 'car'\n  - \"lane\"\n",
        "names: {0: car, 1: lane}\n",
        "names: [\n  car,\n  lane,\n]\n",
        "download: |\n  python fetch.py\nnames: [car, lane]\n",
    ],
)
def test_the_descriptor_grammars_both_dialects_write_and_read(
    tmp_path: Path, descriptor: str
) -> None:
    src = _source(tmp_path, "1 0.5 0.5 0.25 0.5\n", descriptor=descriptor)

    for plugin in (UltralyticsImporter(), Yolov5YamlImporter()):
        dataset = plugin.read(src)
        assert [c.name for c in dataset.classes] == ["car", "lane"]
        assert dataset.images[0].labels[0].class_name == "lane"


def test_a_quoted_name_keeps_its_comma_quote_and_hash(tmp_path: Path) -> None:
    descriptor = "names: [\"a, b\", 'don''t', \"c # d\"]\n"
    src = _source(tmp_path, "", descriptor=descriptor)

    assert [c.name for c in UltralyticsImporter().read(src).classes] == ["a, b", "don't", "c # d"]


@pytest.mark.parametrize(
    ("descriptor", "match"),
    [
        ("train: images/train\n", "no names"),
        ("nc: 3\nnames: [car, lane]\n", "nc is"),
        ("names: [[car], lane]\n", "nested"),
        ("names: [car, , lane]\n", "empty item"),
        ("names: car\n", "neither a list nor a mapping"),
        ("names:\n  car: 0\n", "not a class index"),
        ("names:\n  0: car\n  0: lane\n", "named twice"),
        ("names: [car]\nnames: [lane]\n", "given twice"),
        ('names: ["car]\n', "not closed"),
        ("names: [car, lane\n", "never closes"),
        ("names: [car, ' ']\n", "blank name"),
        ("names: [car, *alias]\n", "does not take"),
        ("names: [car]\nkpt_shape: [17, 4]\n", "kpt_shape"),
        ("names: {010: car, 1: lane}\n", "not a class index"),
        ("names: [car, car]\n", "two indices"),
        ('names: ["car", "car "]\n', "two indices"),
        ("names: [car, yes]\n", "does not take"),
        ("names: [car, ~]\n", "does not take"),
        (f"nc: {'1' * 5000}\nnames: [car]\n", "nc is"),
        ("  names: [car]\n", "belongs to no key"),
        ("just text\n", "not a key"),
    ],
)
def test_a_descriptor_outside_the_subset_is_refused(
    tmp_path: Path, descriptor: str, match: str
) -> None:
    with pytest.raises(ImportSourceUnreadable, match=match):
        UltralyticsImporter().read(_source(tmp_path, "", descriptor=descriptor))


def test_a_source_with_neither_a_descriptor_nor_a_class_tree_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ImportSourceUnreadable, match="neither"):
        UltralyticsImporter().read(tmp_path)
    with pytest.raises(ImportSourceUnreadable, match="no data.yaml"):
        Yolov5YamlImporter().read(tmp_path)
    with pytest.raises(ImportSourceUnreadable, match="not a directory"):
        UltralyticsImporter().read(tmp_path / "missing")


def test_a_descriptor_and_no_pictures_is_refused(tmp_path: Path) -> None:
    (tmp_path / "data.yaml").write_text(NAMES)
    with pytest.raises(ImportSourceUnreadable, match="no pictures"):
        UltralyticsImporter().read(tmp_path)


def test_two_pictures_claiming_one_label_file_are_refused(tmp_path: Path) -> None:
    src = _source(tmp_path, "0 0.5 0.5 0.1 0.1\n")
    write_image(src / "images" / "train" / "a.jpg", size=(32, 24), seed=1)
    with pytest.raises(ImportSourceUnreadable, match="more than one picture"):
        UltralyticsImporter().read(src)


# --- links ---------------------------------------------------------------------


def test_a_symlinked_directory_in_the_source_is_refused(tmp_path: Path) -> None:
    src = _source(tmp_path / "src", "0 0.5 0.5 0.1 0.1\n")
    elsewhere = _source(tmp_path / "elsewhere", "0 0.5 0.5 0.1 0.1\n")
    (src / "images" / "more").symlink_to(elsewhere / "images" / "train", target_is_directory=True)

    with pytest.raises(ImportSourceUnreadable, match="symbolic link"):
        UltralyticsImporter().read(src)


@pytest.mark.parametrize("linked", ["labels/train/a.txt", "images/train/a.png", "data.yaml"])
def test_a_file_linked_from_outside_the_source_is_refused(tmp_path: Path, linked: str) -> None:
    src = _source(tmp_path / "src", "0 0.5 0.5 0.1 0.1\n")
    outside = _source(tmp_path / "outside", "0 0.5 0.5 0.1 0.1\n")
    (src / linked).unlink()
    (src / linked).symlink_to(outside / linked)

    with pytest.raises(ImportSourceUnreadable, match="outside the source"):
        UltralyticsImporter().read(src)


# --- darknet ------------------------------------------------------------------


def _darknet(src: Path, rows: str, *, names: str = "car\nlane\n", data: str | None = None) -> Path:
    _source(src, rows)
    (src / "data.yaml").unlink()
    (src / "obj.names").write_text(names, encoding="utf-8")
    if data is not None:
        (src / "obj.data").write_text(data, encoding="utf-8")
    return src


def test_darknet_reads_its_names_file_and_the_label_layout(tmp_path: Path) -> None:
    src = _darknet(tmp_path, "1 0.5 0.5 0.25 0.5\n", data="classes = 2\nnames = data/obj.names\n")
    dataset = DarknetImporter().read(src)

    assert [c.name for c in dataset.classes] == ["car", "lane"]
    assert dataset.images[0].labels[0].geometry == BboxGeometry(x=12, y=6, width=8, height=12)


@pytest.mark.parametrize(
    ("names", "data", "match"),
    [
        ("car\nlane\n", "classes = 3\n", "classes is"),
        ("car\n\nlane\n", None, "names no class"),
        ("\n", None, "names no classes"),
        ("car\n", "classes 1\n", "not a key = value"),
    ],
)
def test_an_inconsistent_darknet_source_is_refused(
    tmp_path: Path, names: str, data: str | None, match: str
) -> None:
    with pytest.raises(ImportSourceUnreadable, match=match):
        DarknetImporter().read(_darknet(tmp_path, "", names=names, data=data))


def test_a_darknet_source_without_names_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ImportSourceUnreadable, match="obj.names"):
        DarknetImporter().read(tmp_path)


# --- the class tree ------------------------------------------------------------


def test_a_class_tree_reads_each_directory_as_a_tag_and_merges_copies(tmp_path: Path) -> None:
    write_image(tmp_path / "train" / "rain" / "x.png", seed=1)
    write_image(tmp_path / "train" / "night" / "x.png", seed=1)
    write_image(tmp_path / "val" / "rain" / "y.png", seed=2)
    (tmp_path / "train" / "snow").mkdir()

    dataset = UltralyticsImporter().read(tmp_path)

    assert [(c.name, c.geometries) for c in dataset.classes] == [
        (name, (GeometryType.CLASSIFICATION_TAG,)) for name in ("night", "rain", "snow")
    ]
    assert {str(i.path): [label.class_name for label in i.labels] for i in dataset.images} == {
        "train/night/x.png": ["night", "rain"],
        "val/rain/y.png": ["rain"],
    }
    assert all(
        label.geometry == ClassificationGeometry()
        for image in dataset.images
        for label in image.labels
    )


def test_the_same_picture_twice_under_one_class_is_a_repeated_tag(tmp_path: Path) -> None:
    write_image(tmp_path / "train" / "rain" / "x.png", seed=1)
    write_image(tmp_path / "train" / "rain" / "y.png", seed=1)

    dataset = UltralyticsImporter().read(tmp_path)
    assert [(loss.kind, loss.subject, loss.count) for loss in dataset.losses] == [
        (ImportLossKind.LABEL, "rain", 1)
    ]
    assert [len(image.labels) for image in dataset.images] == [1]


def test_a_symlinked_class_directory_is_refused(tmp_path: Path) -> None:
    write_image(tmp_path / "elsewhere" / "x.png")
    (tmp_path / "src" / "train").mkdir(parents=True)
    (tmp_path / "src" / "train" / "rain").symlink_to(tmp_path / "elsewhere", True)

    with pytest.raises(ImportSourceUnreadable, match="symbolic link"):
        UltralyticsImporter().read(tmp_path / "src")


# --- the round trips ----------------------------------------------------------

DETECT = (
    LabelClass(name="sign", geometries=(GeometryType.BBOX,)),
    LabelClass(name="car", geometries=(GeometryType.BBOX,)),
    LabelClass(name="truck", geometries=(GeometryType.BBOX,)),
)


def _annotation(label_class: str, geometry: Any) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=geometry,
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


def _round_trip(
    tmp_path: Path, classes: Any, drawing: dict[int, list[Annotation]], exporter: Any, reader: Any
) -> tuple[dict[str, Counter[tuple[str, str]]], dict[str, Counter[tuple[str, str]]], Any]:
    fixture = Fixture(tmp_path / "origin", classes=classes)
    fixture.label(drawing)
    exported = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), exporter, exported, allow_lossy=True)
    original = _content(fixture.workspace, fixture.project.id)
    fixture.close()

    copy = WorkspaceService.init(tmp_path / "copy")
    created = ProjectService(copy).create("copy")
    imports = ImportService(copy)
    plan = imports.inspect(created.id, reader, exported)
    run = imports.commit(created.id, reader, exported, consent=ImportConsent())
    assert plan.losses == ()
    assert run.losses == ()
    imported = _content(copy, created.id)
    (schema,) = SchemaService(copy).list_versions(created.id)
    copy.close()
    return original, imported, schema


DETECT_DRAWING = {
    0: [
        _box(x=8, y=12, width=16, height=24),
        _annotation("car", BboxGeometry(x=32, y=0, width=16, height=12)),
    ],
    1: [_annotation("car", BboxGeometry(x=0, y=24, width=64, height=24))],
}


@pytest.mark.parametrize(
    ("exporter", "reader"),
    [
        (UltralyticsExporter(), UltralyticsImporter()),
        (Yolov5YamlExporter(), Yolov5YamlImporter()),
        (DarknetExporter(), DarknetImporter()),
    ],
)
def test_a_detect_export_imports_back_without_loss(
    tmp_path: Path, exporter: Any, reader: Any
) -> None:
    original, imported, schema = _round_trip(tmp_path, DETECT, DETECT_DRAWING, exporter, reader)

    assert imported == original
    assert [(c.name, c.geometries) for c in schema.classes] == [
        (c.name, c.geometries) for c in DETECT
    ]


def test_a_segment_export_imports_its_polygons_back_and_its_boxes_as_four_corners(
    tmp_path: Path,
) -> None:
    triangle = PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (8.0, 36.0)])
    drawing = {0: [_annotation("lane", triangle), _box(x=8, y=12, width=16, height=24)]}
    original, imported, schema = _round_trip(
        tmp_path, CLASSES[:2], drawing, UltralyticsExporter(), UltralyticsImporter()
    )

    corners = PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (24.0, 36.0), (8.0, 36.0)])
    lane = ("lane", triangle.model_dump_json())
    assert imported == {
        key: Counter([lane, ("sign", corners.model_dump_json())]) if lane in value else Counter()
        for key, value in original.items()
    }
    assert [(c.name, c.geometries) for c in schema.classes] == [
        ("sign", (GeometryType.POLYGON,)),
        ("lane", (GeometryType.POLYGON,)),
    ]


def test_a_tags_only_export_imports_back_from_the_class_tree(tmp_path: Path) -> None:
    classes = (
        LabelClass(name="weather", geometries=(GeometryType.CLASSIFICATION_TAG,)),
        LabelClass(name="night", geometries=(GeometryType.CLASSIFICATION_TAG,)),
    )
    tag = ClassificationGeometry()
    drawing = {
        0: [_annotation("weather", tag), _annotation("night", tag)],
        1: [_annotation("weather", tag)],
    }
    original, imported, schema = _round_trip(
        tmp_path, classes, drawing, UltralyticsExporter(), UltralyticsImporter()
    )

    assert imported == {key: value for key, value in original.items() if value}
    assert [c.name for c in schema.classes] == ["night", "weather"]


# --- the CLI ------------------------------------------------------------------


def test_visionset_import_reads_an_ultralytics_source(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = _source(tmp_path / "src", "1 0.25 0.25 0.75 0.25 0.25 0.75\n")

    ok(root, "import", "ultralytics", str(src), "--project", name)
    with WorkspaceService.open(root) as service:
        found = ProjectService(service).resolve(name)
        with service.unit_of_work() as uow:
            (asset,) = uow.assets.list(found.id)
            (label,) = uow.annotations.list(asset.id)
    assert label.provenance == "import"
    assert json.loads(label.geometry.model_dump_json())["type"] == "polygon"


def test_a_quote_inside_a_plain_name_is_part_of_it_as_yaml_reads_it(tmp_path: Path) -> None:
    src = _source(tmp_path, "", descriptor="names: [a 'b, c', d]\n")

    assert [c.name for c in UltralyticsImporter().read(src).classes] == ["a 'b", "c'", "d"]


def test_a_long_flow_list_over_many_lines_is_read_in_linear_time(tmp_path: Path) -> None:
    lines = "".join(f"  c{position},\n" for position in range(20000))
    src = _source(tmp_path, "", descriptor=f"names: [\n{lines}]\n")

    assert len(UltralyticsImporter().read(src).classes) == 20000


def test_a_label_file_with_an_upper_case_suffix_is_an_orphan_not_ignored(tmp_path: Path) -> None:
    src = _source(tmp_path, "0 0.5 0.5 0.1 0.1\n")
    (src / "labels" / "train" / "b.TXT").write_text("0 .5 .5 .1 .1\n")

    assert sorted(_losses(src)) == [("label", 1)]


def test_a_picture_outside_every_class_directory_is_an_image_loss(tmp_path: Path) -> None:
    write_image(tmp_path / "train" / "rain" / "x.png", seed=1)
    write_image(tmp_path / "train" / "stray.png", seed=2)

    losses = UltralyticsImporter().read(tmp_path).losses
    assert [(loss.kind, loss.subject, loss.count) for loss in losses] == [
        (ImportLossKind.IMAGE, "train", 1)
    ]


def test_darknet_names_split_on_newlines_only(tmp_path: Path) -> None:
    src = _darknet(tmp_path, "1 0.5 0.5 0.25 0.5\n", names="cat\x0cdog\r\nbird\n")

    assert DarknetImporter().read(src).images[0].labels[0].class_name == "bird"


def test_a_repeated_darknet_name_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ImportSourceUnreadable, match="given twice"):
        DarknetImporter().read(_darknet(tmp_path, "", names="car\ncar\n"))


def test_an_exif_turned_picture_imports_through_the_service_in_its_own_frame(
    tmp_path: Path,
) -> None:
    src = _source(tmp_path / "src", "0 0.5 0.5 0.5 0.5\n", orientation=6, suffix=".jpg")
    copy = WorkspaceService.init(tmp_path / "ws")
    created = ProjectService(copy).create("p")

    plan = ImportService(copy).inspect(created.id, UltralyticsImporter(), src)
    copy.close()

    assert plan.conflicts == ()
    assert plan.losses == ()
    (image,) = plan.images
    assert image.labels[0].geometry == BboxGeometry(x=6, y=8, width=12, height=16)
