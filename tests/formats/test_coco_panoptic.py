"""COCO panoptic: segments in and out, every refusal and loss, and the pixel-exact round trip."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from PIL import Image
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import CLASSES, IMAGE_SIZE, Fixture, _box

from visionset.formats.coco_panoptic import (
    ISTHING,
    CocoPanopticExporter,
    CocoPanopticImporter,
    read_segment_map,
    rgb_of,
)
from visionset.formats.registry import exporters, importers
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    AssetProgress,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    LabelClass,
    MaskGeometry,
    PolygonGeometry,
    mask_area,
    mask_enclosing_box,
    rasterize_polygon,
    rasterize_rings,
    split_class_map,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import Exporter, Importer
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    ImportService,
    JobService,
    ProjectService,
    ReleaseService,
    WorkspaceService,
)

WIDTH, HEIGHT = 8, 6

#: Row-major segment ids: sky (7) and road (1) are stuff, road holding a hole that car 300
#: fills; car 70000 is a second car, its id in the blue channel; person 5 is a crowd; 0 is void.
MAP = [
    [7, 7, 7, 7, 7, 7, 7, 7],
    [1, 1, 1, 1, 1, 0, 0, 1],
    [1, 300, 300, 1, 1, 0, 0, 1],
    [1, 300, 300, 1, 70000, 70000, 5, 5],
    [1, 1, 1, 1, 70000, 70000, 5, 5],
    [1, 1, 1, 1, 1, 1, 1, 1],
]
FLAT = [value for row in MAP for value in row]
CATEGORIES = [
    {"id": 1, "name": "car", "supercategory": "car", "isthing": 1},
    {"id": 2, "name": "person", "supercategory": "person", "isthing": 1},
    {"id": 3, "name": "road", "supercategory": "road", "isthing": 0},
    {"id": 4, "name": "sky", "supercategory": "sky", "isthing": 0},
]
SEGMENTS = [
    {"id": 1, "category_id": 3, "iscrowd": 0},
    {"id": 7, "category_id": 4, "iscrowd": 0},
    {"id": 300, "category_id": 1, "iscrowd": 0},
    {"id": 70000, "category_id": 1, "iscrowd": 0},
    {"id": 5, "category_id": 2, "iscrowd": 1},
]
CLASS_OF = {1: "road", 7: "sky", 300: "car", 70000: "car", 5: "person"}


def _png(path: Path, values: list[int], size: tuple[int, int] = (WIDTH, HEIGHT)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rgb = b"".join(bytes((v & 0xFF, v >> 8 & 0xFF, v >> 16 & 0xFF)) for v in values)
    Image.frombytes("RGB", size, rgb).save(path, format="PNG")


def _document(**changes: Any) -> dict[str, Any]:
    document: dict[str, Any] = {
        "info": {},
        "images": [{"id": 139, "file_name": "a.png", "width": WIDTH, "height": HEIGHT}],
        "annotations": [
            {"image_id": 139, "file_name": "a.png", "segments_info": [dict(s) for s in SEGMENTS]}
        ],
        "categories": [dict(c) for c in CATEGORIES],
    }
    document.update(changes)
    return document


def _source(
    tmp_path: Path, document: dict[str, Any] | None = None, values: list[int] = FLAT
) -> Path:
    """The layout COCO itself ships: annotations/panoptic_val2017.json, its PNG directory
    beside it, and the pictures under val2017/."""
    src = tmp_path / "src"
    (src / "annotations").mkdir(parents=True)
    (src / "annotations" / "panoptic_val2017.json").write_text(
        json.dumps(document or _document()), encoding="utf-8"
    )
    write_image(src / "val2017" / "a.png", size=(WIDTH, HEIGHT))
    _png(src / "annotations" / "panoptic_val2017" / "a.png", values)
    return src


def _losses(src: Path) -> set[tuple[ImportLossKind, str, int]]:
    return {(one.kind, one.subject, one.count) for one in CocoPanopticImporter().read(src).losses}


def test_both_plugins_are_discovered_and_declare_what_they_write() -> None:
    exporter, importer = exporters()["coco-panoptic"], importers()["coco-panoptic"]
    assert isinstance(exporter, CocoPanopticExporter) and isinstance(exporter, Exporter)
    assert isinstance(importer, CocoPanopticImporter) and isinstance(importer, Importer)
    assert exporter.supported_geometries == {GeometryType.MASK}
    assert exporter.degraded_geometries == {GeometryType.POLYGON}
    assert exporter.lossy is True


# --- import ---------------------------------------------------------------------------


def test_each_segment_is_one_mask_of_its_category_with_stuff_crowd_and_void_reported(
    tmp_path: Path,
) -> None:
    dataset = CocoPanopticImporter().read(_source(tmp_path))

    (image,) = dataset.images
    assert (str(image.path), image.width, image.height) == ("val2017/a.png", WIDTH, HEIGHT)
    masks = split_class_map(FLAT, height=HEIGHT, width=WIDTH, ignore={0})
    assert [(label.class_name, label.geometry) for label in image.labels] == [
        (CLASS_OF[one["id"]], masks[one["id"]]) for one in SEGMENTS
    ]
    assert [(one.name, one.geometries) for one in dataset.classes] == [
        (name, (GeometryType.MASK,)) for name in ("car", "person", "road", "sky")
    ]
    assert {(one.kind, one.subject, one.count) for one in dataset.losses} == {
        (ImportLossKind.LABEL, "void", 1),
        (ImportLossKind.ATTRIBUTE, "person", 1),
        (ImportLossKind.ATTRIBUTE, "road", 1),
        (ImportLossKind.ATTRIBUTE, "sky", 1),
    }


def test_the_road_keeps_its_hole_and_the_car_in_it_owns_those_pixels(tmp_path: Path) -> None:
    (image,) = CocoPanopticImporter().read(_source(tmp_path)).images
    road, _, car, *_ = (label.geometry for label in image.labels)
    assert isinstance(road, MaskGeometry) and isinstance(car, MaskGeometry)

    assert mask_area(road) == FLAT.count(1)
    assert mask_area(car) == 4
    box = mask_enclosing_box(road)
    assert box is not None and (box.x, box.y, box.width, box.height) == (0, 1, 8, 5)


def test_an_unknown_category_is_a_label_loss_and_its_pixels_stay_unlabelled(
    tmp_path: Path,
) -> None:
    segments = [dict(one) for one in SEGMENTS]
    segments[4]["category_id"] = 99
    document = _document()
    document["annotations"][0]["segments_info"] = segments
    dataset = CocoPanopticImporter().read(_source(tmp_path, document))

    (image,) = dataset.images
    assert [label.class_name for label in image.labels] == ["road", "sky", "car", "car"]
    assert (ImportLossKind.LABEL, "segment", 1) in {
        (one.kind, one.subject, one.count) for one in dataset.losses
    }


def test_fields_with_no_home_are_attribute_losses(tmp_path: Path) -> None:
    categories = [
        {**CATEGORIES[0], "supercategory": "vehicle", "color": [220, 20, 60], "note": "x"},
        *CATEGORIES[1:],
    ]
    document = _document(categories=categories)
    document["annotations"][0]["segments_info"][2]["score"] = 0.9
    reasons = {
        one.reason
        for one in CocoPanopticImporter().read(_source(tmp_path, document)).losses
        if one.subject == "car"
    }

    assert reasons == {
        "its supercategory is not imported; a class has no parent",
        "its colour is not imported",
        "category field 'note' is not imported",
        "segment field 'score' is not imported",
    }


def test_a_segment_map_not_the_size_of_its_picture_is_a_label_loss(tmp_path: Path) -> None:
    document = _document(
        images=[{"id": 139, "file_name": "a.png", "width": WIDTH + 1, "height": HEIGHT}]
    )
    dataset = CocoPanopticImporter().read(_source(tmp_path, document))

    (image,) = dataset.images
    assert image.labels == () and (image.width, image.height) == (WIDTH + 1, HEIGHT)
    ((kind, reason),) = [
        (one.kind, one.reason)
        for one in dataset.losses
        if one.subject == "annotations/panoptic_val2017/a.png"
    ]
    assert kind is ImportLossKind.LABEL and "8 by 6 and its picture 9 by 6" in reason


def test_a_picture_with_no_annotation_is_imported_unlabelled(tmp_path: Path) -> None:
    images = [
        {"id": 139, "file_name": "a.png", "width": WIDTH, "height": HEIGHT},
        {"id": 140, "file_name": "b.png", "width": WIDTH, "height": HEIGHT},
    ]
    dataset = CocoPanopticImporter().read(_source(tmp_path, _document(images=images)))

    assert {str(one.path): len(one.labels) for one in dataset.images} == {
        "val2017/a.png": 5,
        "val2017/b.png": 0,
    }


def _without(document: dict[str, Any], segment_id: int) -> dict[str, Any]:
    document["annotations"][0]["segments_info"] = [
        one for one in document["annotations"][0]["segments_info"] if one["id"] != segment_id
    ]
    return document


def _with_segment(document: dict[str, Any], segment: dict[str, Any]) -> dict[str, Any]:
    document["annotations"][0]["segments_info"].append(segment)
    return document


@pytest.mark.parametrize(
    ("document", "match"),
    [
        (_without(_document(), 300), r"holds segment ids \[300\] that segments_info"),
        (
            _with_segment(_document(), {"id": 9, "category_id": 1}),
            r"lists segment ids \[9\] that PNG 'annotations/panoptic_val2017/a.png' does not",
        ),
        (_with_segment(_document(), {"id": 300, "category_id": 1}), "segment id 300 twice"),
        (_with_segment(_document(), {"id": 0, "category_id": 1}), "0 being void"),
        (
            _document(categories=[*CATEGORIES, {"id": 1, "name": "bus"}]),
            "category id 1 repeats",
        ),
        (
            _document(
                images=[
                    {"id": 139, "file_name": "a.png", "width": WIDTH, "height": HEIGHT},
                    {"id": 139, "file_name": "b.png", "width": WIDTH, "height": HEIGHT},
                ]
            ),
            "image id 139 repeats",
        ),
        (
            _document(annotations=[{"image_id": 1, "file_name": "a.png", "segments_info": []}]),
            "names image id 1, which its images do not list",
        ),
        (
            _document(
                annotations=[
                    {"image_id": 139, "file_name": "a.png", "segments_info": SEGMENTS},
                    {"image_id": 139, "file_name": "a.png", "segments_info": SEGMENTS},
                ]
            ),
            "has two annotations",
        ),
        (
            _document(
                annotations=[{"image_id": 139, "file_name": "gone.png", "segments_info": []}]
            ),
            "names the segment PNG 'annotations/panoptic_val2017/gone.png', which the source",
        ),
        (
            _document(
                annotations=[{"image_id": 139, "file_name": "../a.png", "segments_info": []}]
            ),
            "leaves the source directory",
        ),
    ],
)
def test_contradictory_or_malformed_metadata_is_refused(
    tmp_path: Path, document: dict[str, Any], match: str
) -> None:
    with pytest.raises(ImportSourceUnreadable, match=match):
        CocoPanopticImporter().read(_source(tmp_path, document))


def test_a_segment_map_that_is_not_an_rgb_png_is_refused(tmp_path: Path) -> None:
    src = _source(tmp_path)
    png = src / "annotations" / "panoptic_val2017" / "a.png"
    Image.new("L", (WIDTH, HEIGHT)).save(png, format="PNG")
    with pytest.raises(ImportSourceUnreadable, match="is a L PNG; a panoptic segment map is RGB"):
        CocoPanopticImporter().read(src)

    png.write_bytes(b"not a png at all")
    with pytest.raises(ImportSourceUnreadable, match="is not readable"):
        CocoPanopticImporter().read(src)


def test_a_source_with_no_panoptic_json_is_refused_and_coco_instances_are_not_read(
    tmp_path: Path,
) -> None:
    src = tmp_path / "src"
    (src / "annotations").mkdir(parents=True)
    (src / "annotations" / "instances_val2017.json").write_text("{}", encoding="utf-8")

    with pytest.raises(ImportSourceUnreadable, match=r"holds no panoptic_\*\.json"):
        CocoPanopticImporter().read(src)


def test_the_written_encoding_is_the_one_read_across_all_three_channels(tmp_path: Path) -> None:
    ids = [0, 1, 255, 256, 300, 65_535, 65_536, 70_000, 256**3 - 1]
    png = tmp_path / "map.png"
    Image.frombytes("RGB", (len(ids), 1), rgb_of(ids)).save(png, format="PNG")

    assert rgb_of([70_000]) == bytes((70_000 % 256, 70_000 // 256 % 256, 70_000 // 65_536))
    assert read_segment_map(png, "map.png") == (len(ids), 1, ids)


# --- export and the round trip ------------------------------------------------------

ROAD = LabelClass(name="road", geometries=(GeometryType.MASK,))
CAR = LabelClass(name="car", geometries=(GeometryType.MASK, GeometryType.POLYGON))
W, H = IMAGE_SIZE
HOLED = rasterize_rings(
    [
        [(4.0, 4.0), (24.0, 4.0), (24.0, 24.0), (4.0, 24.0)],
        [(8.0, 8.0), (20.0, 8.0), (20.0, 20.0), (8.0, 20.0)],
        [(40.0, 30.0), (60.0, 30.0), (60.0, 44.0), (40.0, 44.0)],
    ],
    height=H,
    width=W,
)
ISLAND = rasterize_rings(
    [[(10.0, 10.0), (18.0, 10.0), (18.0, 18.0), (10.0, 18.0)]], height=H, width=W
)
TRIANGLE = PolygonGeometry(points=[(30.0, 2.0), (44.0, 2.0), (30.0, 20.0)])


def _annotation(name: str, geometry: Any) -> Annotation:
    return Annotation(
        asset_id=uuid4(), label_class=name, schema_version=1, geometry=geometry, provenance="human"
    )


def _stored(workspace: WorkspaceService, project_id: UUID) -> dict[str, Counter[tuple[str, str]]]:
    """Each asset's labels as a panoptic map holds them: polygons rasterized, boxes gone."""
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: Counter(
                (label.label_class, _as_mask(label.geometry).model_dump_json())
                for label in uow.annotations.list(asset.id)
                if isinstance(label.geometry, MaskGeometry | PolygonGeometry)
            )
            for asset in uow.assets.list(project_id)
        }


def _as_mask(geometry: MaskGeometry | PolygonGeometry) -> MaskGeometry:
    if isinstance(geometry, PolygonGeometry):
        return rasterize_polygon(geometry, height=H, width=W)
    return geometry


def _segments_by_picture(src: Path) -> dict[bytes, Counter[tuple[str, str]]]:
    """Each picture's bytes, and the class and pixels of each segment it holds."""
    dataset = CocoPanopticImporter().read(src)
    return {
        (src / image.path).read_bytes(): Counter(
            (label.class_name, label.geometry.model_dump_json()) for label in image.labels
        )
        for image in dataset.images
    }


@pytest.fixture
def exported(tmp_path: Path) -> tuple[Path, dict[str, Counter[tuple[str, str]]]]:
    fixture = Fixture(tmp_path / "origin", classes=(*CLASSES, ROAD, CAR))
    fixture.label(
        {
            0: [
                _annotation("road", HOLED),
                _annotation("car", ISLAND),
                _annotation("car", TRIANGLE),
                _box(x=1, y=1, width=4, height=4),
            ],
            1: [_annotation("car", HOLED)],
        }
    )
    dest = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), CocoPanopticExporter(), dest, allow_lossy=True)
    original = _stored(fixture.workspace, fixture.project.id)
    fixture.close()
    return dest, original


def test_the_export_writes_categories_segments_and_an_rgb_png_per_picture(
    exported: tuple[Path, Any],
) -> None:
    dest, _ = exported
    document = json.loads((dest / "annotations" / "panoptic_train.json").read_text("utf-8"))

    assert document["categories"] == [
        {"id": index, "name": name, "supercategory": name, "isthing": ISTHING}
        for index, name in enumerate(("lane", "road", "car"), start=1)
    ]
    assert [image["id"] for image in document["images"]] == [1, 2, 3]
    assert [one["image_id"] for one in document["annotations"]] == [1, 2, 3]
    for image, annotation in zip(document["images"], document["annotations"], strict=True):
        assert (dest / "images" / "train" / image["file_name"]).is_file()
        png = dest / "annotations" / "panoptic_train" / annotation["file_name"]
        with Image.open(png) as opened:
            assert (opened.format, opened.mode, opened.size) == ("PNG", "RGB", (W, H))
        width, height, values = read_segment_map(png, png.name)
        segments = annotation["segments_info"]
        assert [one["id"] for one in segments] == list(range(1, len(segments) + 1))
        assert set(values) - {0} == {one["id"] for one in segments}
        for segment in segments:
            pixels = [i for i, value in enumerate(values) if value == segment["id"]]
            xs, ys = [i % width for i in pixels], [i // width for i in pixels]
            assert segment["area"] == len(pixels)
            assert segment["bbox"] == [
                min(xs),
                min(ys),
                max(xs) - min(xs) + 1,
                max(ys) - min(ys) + 1,
            ]
            assert segment["iscrowd"] == 0
        assert height == H
    assert sorted(len(one["segments_info"]) for one in document["annotations"]) == [0, 1, 3]


def test_the_export_reimports_with_every_pixel_owned_by_the_same_class(
    tmp_path: Path, exported: tuple[Path, dict[str, Counter[tuple[str, str]]]]
) -> None:
    dest, expected = exported

    workspace = WorkspaceService.init(tmp_path / "copy")
    project = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    consent = ImportConsent(kinds=frozenset({ImportLossKind.LABEL}))
    plan = imports.inspect(project.id, CocoPanopticImporter(), dest)
    imports.commit(project.id, CocoPanopticImporter(), dest, consent=consent)

    assert {(one.kind, one.subject) for one in plan.losses} == {(ImportLossKind.LABEL, "void")}
    assert _stored(workspace, project.id) == expected
    workspace.close()


def test_import_export_reimport_preserves_segment_classes_and_pixels(tmp_path: Path) -> None:
    src = _source(tmp_path)
    workspace = WorkspaceService.init(tmp_path / "ws")
    try:
        projects = ProjectService(workspace)
        project = projects.create("panoptic")
        consent = ImportConsent(kinds=frozenset({ImportLossKind.LABEL, ImportLossKind.ATTRIBUTE}))
        run = ImportService(workspace).commit(
            project.id, CocoPanopticImporter(), src, consent=consent
        )
        batch_id = run.batch_id
        assert batch_id is not None
        batches, jobs = BatchService(workspace), JobService(workspace)
        batches.start(batch_id)
        for job in batches.jobs(batch_id):
            jobs.start(job.id)
            for asset_id, progress in jobs.get(job.id).progress.items():
                if progress is not AssetProgress.ANNOTATED:
                    jobs.mark(job.id, asset_id, AssetProgress.ANNOTATED)
            jobs.complete(job.id)
        batches.complete(batch_id)
        DatasetService(workspace).promote(batch_id)
        releases = ReleaseService(workspace)
        release = releases.publish(projects.get_dataset(project.id).id, "v1")
        out = tmp_path / "out"
        releases.export(release.id, CocoPanopticExporter(), out, allow_lossy=True)
    finally:
        workspace.close()

    assert _segments_by_picture(out) == _segments_by_picture(src)
    (annotation,) = json.loads((out / "annotations" / "panoptic_train.json").read_text("utf-8"))[
        "annotations"
    ]
    assert len(annotation["segments_info"]) == len(SEGMENTS)


def test_two_overlapping_segments_refuse_the_export_naming_both(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path / "origin", images=1, classes=(ROAD, CAR))
    fixture.label({0: [_annotation("road", HOLED), _annotation("car", HOLED)]})
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    road, car = (one.id for one in manifest.assets[0].annotations)

    with pytest.raises(ExportSourceUnreadable, match="claim the same pixels") as refusal:
        fixture.releases.export(
            release_id, CocoPanopticExporter(), tmp_path / "out", allow_lossy=True
        )
    fixture.close()

    message = str(refusal.value)
    assert str(manifest.assets[0].asset_id) in message
    assert str(road) in message and str(car) in message


def test_the_report_degrades_polygons_and_drops_boxes(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path / "origin", classes=(*CLASSES, ROAD, CAR))
    fixture.label({0: [_annotation("car", TRIANGLE), _box(x=1, y=1, width=4, height=4)]})
    report = fixture.releases.check_export(fixture.publish(), CocoPanopticExporter())
    fixture.close()

    status = {(one.label_class, one.geometry): one.status.value for one in report.classes}
    assert status[("car", GeometryType.POLYGON)] == "degraded"
    assert status[("sign", GeometryType.BBOX)] == "dropped"
