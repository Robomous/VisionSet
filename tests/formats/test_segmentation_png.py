"""Class-index PNG masks: the descriptor, every refusal and loss, and the pixel-exact round trip."""

from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from PIL import Image
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import CLASSES, IMAGE_SIZE, Fixture, _box

from visionset.formats.registry import exporters, importers
from visionset.formats.segmentation_png import (
    DESCRIPTOR_FILENAME,
    SegmentationPngExporter,
    SegmentationPngImporter,
    _write_mask,
)
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    LabelClass,
    ManifestAnnotation,
    ManifestAsset,
    MaskGeometry,
    PolygonGeometry,
    compose_class_map,
    mask_union,
    rasterize_polygon,
    rasterize_rings,
    split_class_map,
)
from visionset.kernel.errors import ExportSourceUnreadable, ImportNotConsented
from visionset.kernel.ports import Exporter, Importer
from visionset.kernel.services import ImportService, ProjectService, WorkspaceService

WIDTH, HEIGHT = 8, 6

#: Row-major ids: class 3 a ring with a hole and a second region apart; class 200 inside
#: the hole; 0 background; 255 ignore.
MAP = [
    [3, 3, 3, 3, 0, 0, 3, 3],
    [3, 200, 200, 3, 0, 0, 3, 3],
    [3, 200, 200, 3, 0, 0, 0, 0],
    [3, 3, 3, 3, 0, 255, 255, 0],
    [0, 0, 0, 0, 0, 255, 255, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
]
FLAT = [value for row in MAP for value in row]
INDEX = {
    "format": "segmentation-png",
    "version": 1,
    "encoding": "index",
    "classes": {"3": "road", "200": "car"},
    "background": [0],
    "ignore": [255],
    "images": "images",
    "masks": "masks",
    "splits": [],
}
COLOURS = {0: (0, 0, 0), 3: (128, 64, 128), 200: (0, 0, 142), 255: (224, 224, 192)}
PALETTE = {
    **INDEX,
    "encoding": "palette",
    "palette": {str(key): list(value) for key, value in COLOURS.items()},
}


def _descriptor(src: Path, document: dict[str, Any]) -> None:
    src.mkdir(parents=True, exist_ok=True)
    (src / DESCRIPTOR_FILENAME).write_text(json.dumps(document), encoding="utf-8")


def _mask(
    path: Path, values: list[int], *, mode: str = "L", size: tuple[int, int] = (WIDTH, HEIGHT)
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if mode == "L":
        image = Image.frombytes("L", size, bytes(values))
    elif mode == "I;16":
        image = Image.frombytes("I;16", size, b"".join(v.to_bytes(2, "little") for v in values))
    elif mode == "P":
        order = sorted(COLOURS)
        image = Image.frombytes("P", size, bytes(order.index(v) for v in values))
        image.putpalette([channel for key in order for channel in COLOURS[key]])
    else:
        image = Image.frombytes(
            mode, size, b"".join(bytes(COLOURS[v]) + b"\xff" * (len(mode) - 3) for v in values)
        )
    image.save(path, format="PNG")


def _source(tmp_path: Path, document: dict[str, Any] = INDEX, *, mode: str = "L") -> Path:
    src = tmp_path / "src"
    _descriptor(src, document)
    write_image(src / "images" / "a.jpg", size=(WIDTH, HEIGHT))
    _mask(src / "masks" / "a.png", FLAT, mode=mode)
    return src


def _expected() -> dict[str, MaskGeometry]:
    masks = split_class_map(FLAT, height=HEIGHT, width=WIDTH, ignore={0, 255})
    return {"road": masks[3], "car": masks[200]}


def _read(src: Path) -> tuple[dict[str, Any], list[tuple[ImportLossKind, str, int]]]:
    dataset = SegmentationPngImporter().read(src)
    labels = {
        label.class_name: label.geometry for image in dataset.images for label in image.labels
    }
    return labels, [(one.kind, one.subject, one.count) for one in dataset.losses]


def test_both_plugins_are_discovered_and_declare_what_they_write() -> None:
    exporter, importer = exporters()["segmentation-png"], importers()["segmentation-png"]
    assert isinstance(exporter, SegmentationPngExporter) and isinstance(exporter, Exporter)
    assert isinstance(importer, SegmentationPngImporter) and isinstance(importer, Importer)
    assert exporter.supported_geometries == {GeometryType.MASK}
    assert exporter.degraded_geometries == {GeometryType.POLYGON}
    assert exporter.lossy is True


# --- import ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("document", "mode"),
    [(INDEX, "L"), (INDEX, "I;16"), (PALETTE, "P"), (PALETTE, "RGB")],
)
def test_each_class_present_is_one_mask_and_ignore_is_a_label_loss(
    tmp_path: Path, document: dict[str, Any], mode: str
) -> None:
    src = _source(tmp_path, document, mode=mode)
    dataset = SegmentationPngImporter().read(src)
    labels, losses = _read(src)

    assert labels == _expected()
    assert [(one.name, one.geometries) for one in dataset.classes] == [
        ("road", (GeometryType.MASK,)),
        ("car", (GeometryType.MASK,)),
    ]
    assert losses == [(ImportLossKind.LABEL, "ignore", 1)]
    (image,) = dataset.images
    assert (str(image.path), image.width, image.height) == ("images/a.jpg", WIDTH, HEIGHT)


def test_background_is_a_class_only_when_the_descriptor_says_so(tmp_path: Path) -> None:
    document = {**INDEX, "classes": {"0": "sky", "3": "road", "200": "car"}, "background": []}
    labels, _ = _read(_source(tmp_path, document))

    assert set(labels) == {"sky", "road", "car"}
    assert (
        mask_union(labels.values(), height=HEIGHT, width=WIDTH)
        == split_class_map(
            [1 if value != 255 else 0 for value in FLAT], height=HEIGHT, width=WIDTH, ignore={0}
        )[1]
    )


def test_a_sixteen_bit_id_beyond_255_reads(tmp_path: Path) -> None:
    document = {**INDEX, "classes": {"3": "road", "200": "car", "4000": "sign"}}
    src = _source(tmp_path, document, mode="I;16")
    _mask(src / "masks" / "a.png", [4000 if v == 200 else v for v in FLAT], mode="I;16")
    labels, _ = _read(src)

    assert labels["sign"] == _expected()["car"]


def test_a_class_nobody_used_is_still_declared(tmp_path: Path) -> None:
    document = {**INDEX, "classes": {"3": "road", "200": "car", "9": "rail"}}
    dataset = SegmentationPngImporter().read(_source(tmp_path, document))

    assert [one.name for one in dataset.classes] == ["road", "rail", "car"]


@pytest.mark.parametrize(
    ("document", "mode", "message"),
    [
        (INDEX, "P", "is a P PNG"),
        (INDEX, "RGB", "is a RGB PNG"),
        (PALETTE, "L", "is a L PNG"),
        (PALETTE, "RGBA", "is a RGBA PNG"),
    ],
)
def test_a_png_mode_the_encoding_does_not_read_is_refused(
    tmp_path: Path, document: dict[str, Any], mode: str, message: str
) -> None:
    with pytest.raises(ImportSourceUnreadable, match=message):
        SegmentationPngImporter().read(_source(tmp_path, document, mode=mode))


def test_an_undeclared_id_is_refused(tmp_path: Path) -> None:
    document = {**INDEX, "classes": {"3": "road"}}
    with pytest.raises(ImportSourceUnreadable, match=r"ids \[200\]"):
        SegmentationPngImporter().read(_source(tmp_path, document))


@pytest.mark.parametrize("mode", ["P", "RGB"])
def test_a_colour_outside_the_palette_is_refused(tmp_path: Path, mode: str) -> None:
    palette = {key: value for key, value in PALETTE["palette"].items() if key != "200"}
    with pytest.raises(ImportSourceUnreadable, match="not in the segmentation.json palette"):
        SegmentationPngImporter().read(
            _source(tmp_path, {**PALETTE, "palette": palette}, mode=mode)
        )


def test_no_descriptor_is_refused_with_how_to_write_one(tmp_path: Path) -> None:
    src = _source(tmp_path)
    (src / DESCRIPTOR_FILENAME).unlink()

    with pytest.raises(ImportSourceUnreadable) as refusal:
        SegmentationPngImporter().read(src)
    message = str(refusal.value)
    assert "has no segmentation.json" in message
    assert '"encoding": "index"' in message and '"ignore": [255]' in message


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"background": [3]}, "more than one of classes"),
        ({"encoding": "palette"}, "palette is given exactly"),
        ({"palette": PALETTE["palette"]}, "palette is given exactly"),
        ({"classes": {"3": "road", "4": "Road"}}, "share a name"),
        ({"classes": {"3": " "}}, "needs a name"),
        ({"classes": {"70000": "road"}}, "classes"),
        ({"masks": "images"}, "different directories"),
        ({"images": "../out"}, "leaves the source"),
        ({"splits": ["train/a"]}, "single directory"),
        ({"version": 2}, "version"),
        ({"layout": "voc"}, "layout"),
        ({"ignore": ["255"]}, "ignore"),
    ],
)
def test_an_invalid_descriptor_is_refused_by_field(
    tmp_path: Path, change: dict[str, Any], message: str
) -> None:
    with pytest.raises(ImportSourceUnreadable, match="not a valid descriptor") as refusal:
        SegmentationPngImporter().read(_source(tmp_path, {**INDEX, **change}))
    assert message in str(refusal.value)


def test_unmatched_pictures_and_masks_and_a_size_mismatch_are_reported(tmp_path: Path) -> None:
    src = _source(tmp_path)
    write_image(src / "images" / "lonely.png", size=(WIDTH, HEIGHT), seed=1)
    _mask(src / "masks" / "orphan.png", FLAT)
    write_image(src / "images" / "wide.png", size=(WIDTH + 1, HEIGHT), seed=2)
    _mask(src / "masks" / "wide.png", FLAT)
    dataset = SegmentationPngImporter().read(src)

    assert sorted(str(image.path) for image in dataset.images) == [
        "images/a.jpg",
        "images/wide.png",
    ]
    wide = next(image for image in dataset.images if image.path.name == "wide.png")
    assert wide.labels == () and (wide.width, wide.height) == (WIDTH + 1, HEIGHT)
    losses = {(one.kind, one.subject): (one.count, one.reason) for one in dataset.losses}
    assert losses[(ImportLossKind.IMAGE, "images")][0] == 1
    assert losses[(ImportLossKind.LABEL, "masks")] == (1, "a mask file with no picture")
    count, reason = losses[(ImportLossKind.LABEL, "masks/wide.png")]
    assert count == 1 and "8 by 6 and its picture 9 by 6" in reason


def test_the_size_mismatch_is_in_the_plan_before_any_commit(tmp_path: Path) -> None:
    src = _source(tmp_path)
    write_image(src / "images" / "wide.png", size=(WIDTH + 1, HEIGHT), seed=2)
    _mask(src / "masks" / "wide.png", FLAT)
    workspace = WorkspaceService.init(tmp_path / "ws")
    project = ProjectService(workspace).create("p")
    imports = ImportService(workspace)

    plan = imports.inspect(project.id, SegmentationPngImporter(), src)
    with pytest.raises(ImportNotConsented):
        imports.commit(project.id, SegmentationPngImporter(), src, consent=ImportConsent())
    workspace.close()

    assert {one.kind for one in plan.losses} == {ImportLossKind.LABEL}


def test_splits_and_the_voc_layout_with_a_mask_suffix(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _descriptor(src, {**INDEX, "splits": ["train", "val"]})
    for split, seed in (("train", 0), ("val", 1)):
        write_image(src / "images" / split / "nested" / "a.png", size=(WIDTH, HEIGHT), seed=seed)
        _mask(src / "masks" / split / "nested" / "a.png", FLAT)
    dataset = SegmentationPngImporter().read(src)
    assert sorted(str(image.path) for image in dataset.images) == [
        "images/train/nested/a.png",
        "images/val/nested/a.png",
    ]

    voc = tmp_path / "voc"
    _descriptor(
        voc,
        {**PALETTE, "images": "JPEGImages", "masks": "SegmentationClass", "mask_suffix": "_mask"},
    )
    write_image(voc / "JPEGImages" / "2007_000032.jpg", size=(WIDTH, HEIGHT))
    _mask(voc / "SegmentationClass" / "2007_000032_mask.png", FLAT, mode="P")
    labels, losses = _read(voc)
    assert labels == _expected()
    assert losses == [(ImportLossKind.LABEL, "ignore", 1)]


def test_a_split_the_descriptor_names_but_the_source_lacks_is_refused(tmp_path: Path) -> None:
    src = _source(tmp_path, {**INDEX, "splits": ["train"]})
    with pytest.raises(ImportSourceUnreadable, match="images/train"):
        SegmentationPngImporter().read(src)


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


def _content(workspace: WorkspaceService, project_id: Any) -> dict[str, dict[str, Any]]:
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: {
                label.label_class: label.geometry for label in uow.annotations.list(asset.id)
            }
            for asset in uow.assets.list(project_id)
        }


def _import(tmp_path: Path, src: Path, name: str) -> dict[str, dict[str, Any]]:
    workspace = WorkspaceService.init(tmp_path / name)
    project = ProjectService(workspace).create(name)
    imports = ImportService(workspace)
    plan = imports.inspect(project.id, SegmentationPngImporter(), src)
    assert plan.losses == ()
    imports.commit(project.id, SegmentationPngImporter(), src, consent=ImportConsent())
    content = _content(workspace, project.id)
    workspace.close()
    return content


@pytest.fixture
def exported(tmp_path: Path) -> Path:
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
    fixture.releases.export(fixture.publish(), SegmentationPngExporter(), dest, allow_lossy=True)
    fixture.close()
    return dest


def test_the_export_writes_a_descriptor_and_an_eight_bit_mask_per_picture(exported: Path) -> None:
    descriptor = json.loads((exported / DESCRIPTOR_FILENAME).read_text(encoding="utf-8"))

    assert descriptor["classes"] == {"1": "lane", "2": "road", "3": "car"}
    assert (descriptor["encoding"], descriptor["background"], descriptor["ignore"]) == (
        "index",
        [0],
        [],
    )
    assert descriptor["splits"] == ["train"]
    assert descriptor["visionset"]["overlaps"] == []
    masks = sorted((exported / "masks" / "train").iterdir())
    assert len(masks) == 3
    for path in masks:
        with Image.open(path) as image:
            assert (image.format, image.mode, image.size) == ("PNG", "L", (W, H))


def test_the_export_reimports_pixel_for_pixel_with_no_loss(tmp_path: Path, exported: Path) -> None:
    first = _import(tmp_path, exported, "first")
    expected_car = mask_union(
        [ISLAND, rasterize_polygon(TRIANGLE, height=H, width=W)], height=H, width=W
    )
    assert sorted(map(sorted, first.values())) == [[], ["car"], ["car", "road"]]
    labelled = next(labels for labels in first.values() if "road" in labels)
    assert labelled == {"road": HOLED, "car": expected_car}
    assert next(labels for labels in first.values() if list(labels) == ["car"]) == {"car": HOLED}


def test_an_independent_png_reader_sees_the_ids_the_composition_wrote(exported: Path) -> None:
    descriptor = json.loads((exported / DESCRIPTOR_FILENAME).read_text(encoding="utf-8"))
    ids = {name: int(key) for key, name in descriptor["classes"].items()}
    car = mask_union([ISLAND, rasterize_polygon(TRIANGLE, height=H, width=W)], height=H, width=W)
    expected = compose_class_map(
        [(ids["road"], HOLED), (ids["car"], car)], height=H, width=W, fill=0
    ).values

    decoded = [
        _decode_grey_png(path.read_bytes()) for path in (exported / "masks" / "train").iterdir()
    ]

    assert ((W, H), expected) in decoded
    assert ((W, H), [0] * (W * H)) in decoded


def test_overlapping_classes_keep_the_lower_id_and_are_recorded(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path / "origin", images=1, classes=(ROAD, CAR))
    fixture.label({0: [_annotation("road", HOLED), _annotation("car", HOLED)]})
    dest = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), SegmentationPngExporter(), dest, allow_lossy=True)
    fixture.close()

    descriptor = json.loads((dest / DESCRIPTOR_FILENAME).read_text(encoding="utf-8"))
    ((mask, overlap),) = [
        (path, one) for one in descriptor["visionset"]["overlaps"] for path in [dest / one["mask"]]
    ]
    assert overlap["classes"] == ["road", "car"]
    assert overlap["pixels"] == sum(1 for value in _decode_grey_png(mask.read_bytes())[1] if value)
    assert {value for value in _decode_grey_png(mask.read_bytes())[1]} == {0, 1}


def test_the_report_degrades_polygons_and_drops_boxes(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path / "origin", classes=(*CLASSES, ROAD, CAR))
    fixture.label({0: [_annotation("car", TRIANGLE), _box(x=1, y=1, width=4, height=4)]})
    report = fixture.releases.check_export(fixture.publish(), SegmentationPngExporter())
    fixture.close()

    status = {(one.label_class, one.geometry): one.status.value for one in report.classes}
    assert status[("car", GeometryType.POLYGON)] == "degraded"
    assert status[("sign", GeometryType.BBOX)] == "dropped"


def test_more_than_255_ids_are_written_sixteen_bit(tmp_path: Path) -> None:
    annotation = ManifestAnnotation(
        id=uuid4(), label_class="sign", schema_version=1, geometry=ISLAND, provenance="human"
    )
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="0" * 64,
        uri="/a.png",
        width=W,
        height=H,
        annotations=(annotation,),
    )
    target = tmp_path / "a.png"

    assert _write_mask(asset, {"sign": 300}, {"sign"}, "I;16", target) is None
    with Image.open(target) as image:
        assert image.mode == "I;16"
    document = {**INDEX, "classes": {"300": "sign"}, "ignore": []}
    src = tmp_path / "src"
    _descriptor(src, document)
    write_image(src / "images" / "a.png", size=(W, H))
    (src / "masks").mkdir()
    target.rename(src / "masks" / "a.png")
    labels, losses = _read(src)
    assert labels == {"sign": ISLAND} and losses == []


def test_a_mask_not_the_size_of_its_picture_refuses_the_export(tmp_path: Path) -> None:
    annotation = ManifestAnnotation(
        id=uuid4(), label_class="road", schema_version=1, geometry=ISLAND, provenance="human"
    )
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="0" * 64,
        uri="/a.png",
        width=H,
        height=W,
        annotations=(annotation,),
    )
    with pytest.raises(ExportSourceUnreadable, match="not the size of its picture"):
        _write_mask(asset, {"road": 1}, {"road"}, "L", tmp_path / "a.png")


def _decode_grey_png(data: bytes) -> tuple[tuple[int, int], list[int]]:
    """An 8-bit greyscale PNG decoded with ``zlib`` and the PNG filters alone, no Pillow."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    position, idat, header = 8, b"", b""
    while position < len(data):
        (length,) = struct.unpack(">I", data[position : position + 4])
        kind = data[position + 4 : position + 8]
        body = data[position + 8 : position + 8 + length]
        if kind == b"IHDR":
            header = body
        elif kind == b"IDAT":
            idat += body
        position += 12 + length
    width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", header)
    assert (depth, colour, interlace) == (8, 0, 0)
    raw = zlib.decompress(idat)
    rows: list[bytearray] = []
    previous = bytearray(width)
    for y in range(height):
        start = y * (width + 1)
        kind, line = raw[start], bytearray(raw[start + 1 : start + 1 + width])
        for x in range(width):
            left = line[x - 1] if x else 0
            up = previous[x]
            corner = previous[x - 1] if x else 0
            if kind == 1:
                line[x] = (line[x] + left) & 0xFF
            elif kind == 2:
                line[x] = (line[x] + up) & 0xFF
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 0xFF
            elif kind == 4:
                guess = left + up - corner
                distances = (abs(guess - left), abs(guess - up), abs(guess - corner))
                line[x] = (line[x] + (left, up, corner)[distances.index(min(distances))]) & 0xFF
        rows.append(line)
        previous = line
    return (width, height), [value for row in rows for value in row]
