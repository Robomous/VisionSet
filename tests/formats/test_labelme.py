"""LabelMe JSON: what the importer reads, refuses and reports, and the round trip."""

from __future__ import annotations

import base64
import json
from collections import Counter
from io import BytesIO
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4

import pytest
from PIL import Image
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import CLASSES, Fixture

import visionset.formats.labelme.reader as labelme_reader
from visionset.formats.labelme import LABELME_VERSION, LabelmeExporter, LabelmeImporter
from visionset.formats.registry import exporters, importers
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    GeometryType,
    ImportConsent,
    ImportedDataset,
    ImportLossKind,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    Release,
    SplitRecipe,
)
from visionset.kernel.domain.schema import Attribute
from visionset.kernel.ports import ContentReader
from visionset.kernel.services import ImportService, ProjectService, WorkspaceService

SIZE = (32, 24)


def _shape(
    label: str = "car",
    points: list[list[float]] | None = None,
    shape_type: str | None = "rectangle",
    **extra: Any,
) -> dict[str, Any]:
    shape: dict[str, Any] = {
        "label": label,
        "points": [[2, 3], [10, 9]] if points is None else points,
        "group_id": None,
        "description": "",
        "flags": {},
    }
    if shape_type is not None:
        shape["shape_type"] = shape_type
    shape.update(extra)
    return shape


def _write(
    src: Path,
    shapes: list[dict[str, Any]],
    *,
    image: str = "a.png",
    name: str = "a.json",
    picture: bool = True,
    **extra: Any,
) -> Path:
    document: dict[str, Any] = {
        "version": "5.5.0",
        "flags": {},
        "shapes": shapes,
        "imagePath": image,
        "imageData": None,
        "imageHeight": SIZE[1],
        "imageWidth": SIZE[0],
    }
    document.update(extra)
    target = src / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document), encoding="utf-8")
    if picture:
        write_image(target.parent / image, size=SIZE)
    return src


def _losses(dataset: ImportedDataset) -> dict[tuple[ImportLossKind, str, str], int]:
    return {(loss.kind, loss.subject, loss.reason): loss.count for loss in dataset.losses}


def _png(size: tuple[int, int] = SIZE) -> str:
    buffer = BytesIO()
    Image.new("RGB", size).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


# --- reading ------------------------------------------------------------------


def test_the_plugins_are_discovered_by_name() -> None:
    assert isinstance(importers()["labelme"], LabelmeImporter)
    assert isinstance(exporters()["labelme"], LabelmeExporter)


def test_rectangles_and_polygons_read_as_the_pixels_written(tmp_path: Path) -> None:
    dataset = LabelmeImporter().read(
        _write(
            tmp_path,
            [
                _shape(points=[[10.25, 9.5], [2.125, 3]]),
                _shape("lane", [[1.5, 1], [20.75, 1], [20.75, 12.333]], "polygon"),
                _shape("lane", [[0, 0], [5, 0], [5, 5]], None),
            ],
        )
    )

    (image,) = dataset.images
    assert (str(image.path), image.width, image.height) == ("a.png", *SIZE)
    assert [label.geometry for label in image.labels] == [
        BboxGeometry(x=2.125, y=3, width=8.125, height=6.5),
        PolygonGeometry(points=[(1.5, 1), (20.75, 1), (20.75, 12.333)]),
        PolygonGeometry(points=[(0, 0), (5, 0), (5, 5)]),
    ]
    assert [(c.name, c.geometries) for c in dataset.classes] == [
        ("car", (GeometryType.BBOX,)),
        ("lane", (GeometryType.POLYGON,)),
    ]
    assert dataset.losses == ()


def test_a_document_with_no_shapes_is_an_unlabelled_picture_of_its_size(tmp_path: Path) -> None:
    dataset = LabelmeImporter().read(_write(tmp_path, []))

    (image,) = dataset.images
    assert (image.width, image.height, image.labels) == (*SIZE, ())
    assert dataset.classes == ()


def test_a_picture_no_document_names_is_imported_unlabelled(tmp_path: Path) -> None:
    write_image(tmp_path / "b.png", size=SIZE)
    dataset = LabelmeImporter().read(_write(tmp_path, [_shape()]))

    assert sorted((str(i.path), len(i.labels)) for i in dataset.images) == [
        ("a.png", 1),
        ("b.png", 0),
    ]


def test_unsupported_shape_types_are_label_losses_never_converted(tmp_path: Path) -> None:
    shapes = [
        _shape("wire", [[0, 0], [4, 4]], "line"),
        _shape("wire", [[0, 0], [4, 4], [8, 2]], "linestrip"),
        _shape("ball", [[5, 5], [8, 8]], "circle"),
        _shape("dot", [[5, 5]], "point"),
        _shape("blob", [[1, 1], [4, 4]], "mask", mask="iVBORw0KGgo="),
        _shape("car"),
    ]
    dataset = LabelmeImporter().read(_write(tmp_path, shapes))

    assert _losses(dataset) == {
        (ImportLossKind.LABEL, "wire", "'line' shapes are not imported"): 1,
        (ImportLossKind.LABEL, "wire", "'linestrip' shapes are not imported"): 1,
        (ImportLossKind.LABEL, "ball", "'circle' shapes are not imported"): 1,
        (ImportLossKind.LABEL, "dot", "'point' shapes are not imported"): 1,
        (ImportLossKind.LABEL, "blob", "'mask' shapes are not imported"): 1,
    }
    assert [c.name for c in dataset.classes] == ["car"]
    (image,) = dataset.images
    assert [label.class_name for label in image.labels] == ["car"]


@pytest.mark.parametrize(
    ("shape", "reason"),
    [
        (_shape(points=[[1, 1], [1, 9]]), "its rectangle has no area"),
        (_shape(points=[[1, 1], [4, 4], [6, 6]]), "a rectangle is not two points"),
        (
            _shape(points=[[1, 1], [4, 4]], shape_type="polygon"),
            "a polygon has fewer than three points",
        ),
        (_shape(points=[[0, 0], [2, 2], [4, 4]], shape_type="polygon"), "its polygon has no area"),
        (_shape(points=[[100, 100], [120, 130]]), "it lies wholly outside its picture"),
    ],
)
def test_a_degenerate_shape_is_a_label_loss(
    tmp_path: Path, shape: dict[str, Any], reason: str
) -> None:
    dataset = LabelmeImporter().read(_write(tmp_path, [shape]))

    assert _losses(dataset) == {(ImportLossKind.LABEL, "car", reason): 1}
    assert dataset.images[0].labels == ()


def test_a_shape_without_a_label_is_a_label_loss(tmp_path: Path) -> None:
    dataset = LabelmeImporter().read(_write(tmp_path, [_shape("  ")]))

    assert _losses(dataset) == {(ImportLossKind.LABEL, "shape", "it has no label"): 1}


def test_flags_and_description_are_attributes_and_the_rest_is_reported(tmp_path: Path) -> None:
    shapes = [
        _shape(flags={"occluded": True, "truncated": False}, description="rear bumper"),
        _shape(flags={"score": 0.5, "description": True}, group_id=3, other_data={"a": 1}),
    ]
    dataset = LabelmeImporter().read(_write(tmp_path, shapes, flags={"night": True}, extra=None))

    (car,) = dataset.classes
    assert car.attributes == (
        Attribute(name="occluded", kind="boolean"),
        Attribute(name="truncated", kind="boolean"),
        Attribute(name="description", kind="string"),
    )
    assert [label.attributes for label in dataset.images[0].labels] == [
        {"occluded": True, "truncated": False, "description": "rear bumper"},
        {},
    ]
    assert _losses(dataset) == {
        (ImportLossKind.ATTRIBUTE, "flags", "picture flags are not imported"): 1,
        (ImportLossKind.ATTRIBUTE, "car", "a flag that is not imported"): 2,
        (ImportLossKind.ATTRIBUTE, "car", "group_id is not imported"): 1,
        (ImportLossKind.ATTRIBUTE, "car", "other_data is not imported"): 1,
    }


def test_json_that_is_not_a_labelme_document_is_not_read(tmp_path: Path) -> None:
    (tmp_path / "visionset-export-report.json").write_text('{"format": "labelme"}')
    dataset = LabelmeImporter().read(_write(tmp_path, [_shape()]))

    assert [str(image.path) for image in dataset.images] == ["a.png"]


def test_a_source_without_a_document_is_refused(tmp_path: Path) -> None:
    (tmp_path / "other.json").write_text("[]")
    with pytest.raises(ImportSourceUnreadable, match="holds no LabelMe JSON"):
        LabelmeImporter().read(tmp_path)


@pytest.mark.parametrize(
    ("text", "match"),
    [
        ("{not json", "not readable JSON"),
        ('{"shapes": [], "imagePath": "a.png", "imageWidth": NaN}', "not readable JSON"),
        (
            '{"shapes": [{"label": "car", "points": [[1e999, 1], [4, 4]]}], "imagePath": "a.png"}',
            "non-finite",
        ),
        ('{"shapes": {}, "imagePath": "a.png"}', "shapes is not a list"),
        ('{"shapes": [7], "imagePath": "a.png"}', "shapes is not a list"),
        ('{"shapes": [{"label": 3, "points": []}], "imagePath": "a.png"}', "label is not a string"),
        (
            '{"shapes": [{"label": "car", "points": [[1, "2"]]}], "imagePath": "a.png"}',
            "not a pair of numbers",
        ),
        (
            '{"shapes": [{"label": "car", "points": [[1, true]]}], "imagePath": "a.png"}',
            "not a pair of numbers",
        ),
        ('{"shapes": []}', "imagePath is not"),
        ('{"shapes": [], "imagePath": "a.png", "imageWidth": -4}', "imageWidth is not"),
        ('{"shapes": [], "imagePath": "a.png", "imageHeight": 2.5}', "imageHeight is not"),
    ],
)
def test_a_malformed_document_is_refused_by_name(tmp_path: Path, text: str, match: str) -> None:
    (tmp_path / "a.json").write_text(text, encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match=match) as refusal:
        LabelmeImporter().read(tmp_path)
    assert "a.json" in str(refusal.value)


def test_two_documents_naming_one_picture_are_refused(tmp_path: Path) -> None:
    _write(tmp_path, [_shape()])
    _write(tmp_path, [_shape()], name="b.json")
    with pytest.raises(ImportSourceUnreadable, match="more than one document"):
        LabelmeImporter().read(tmp_path)


# --- paths --------------------------------------------------------------------


@pytest.mark.parametrize(
    "image",
    ["../outside.png", "sub/../../outside.png", "/etc/passwd", "C:\\data\\a.png", "..\\a.png"],
)
def test_an_image_path_leaving_the_source_is_refused(tmp_path: Path, image: str) -> None:
    src = _write(tmp_path / "src", [_shape()], image=image, picture=False)
    with pytest.raises(ImportSourceUnreadable, match="imagePath"):
        LabelmeImporter().read(src)


def test_an_image_path_is_read_from_the_document_s_directory(tmp_path: Path) -> None:
    write_image(tmp_path / "images" / "a.png", size=SIZE)
    src = _write(tmp_path, [_shape()], image="..\\images\\a.png", name="json/a.json", picture=False)

    (image,) = LabelmeImporter().read(src).images
    assert str(image.path) == "images/a.png"
    assert len(image.labels) == 1


def test_a_link_resolving_outside_the_source_is_refused(tmp_path: Path) -> None:
    outside = write_image(tmp_path / "outside.png", size=SIZE)
    src = _write(tmp_path / "src", [_shape()], image="link.png", picture=False)
    (src / "link.png").symlink_to(outside)
    with pytest.raises(ImportSourceUnreadable, match="resolves outside the source"):
        LabelmeImporter().read(src)


def test_a_missing_linked_picture_is_an_image_loss_of_the_import(tmp_path: Path) -> None:
    workspace = WorkspaceService.init(tmp_path / "ws")
    project = ProjectService(workspace).create("p")
    src = _write(tmp_path / "src", [_shape()], picture=False)

    plan = ImportService(workspace).inspect(project.id, LabelmeImporter(), src)
    workspace.close()

    assert [(loss.kind, loss.subject) for loss in plan.losses] == [(ImportLossKind.IMAGE, "a.png")]


# --- embedded imageData ---------------------------------------------------------


def test_embedded_image_data_beside_its_linked_picture_is_checked_not_imported(
    tmp_path: Path,
) -> None:
    dataset = LabelmeImporter().read(
        _write(tmp_path, [_shape()], imageData=_png(), imageWidth=None, imageHeight=None)
    )

    (image,) = dataset.images
    assert (image.width, image.height, len(image.labels)) == (*SIZE, 1)
    assert dataset.losses == ()


def test_a_picture_held_only_as_image_data_is_an_image_loss(tmp_path: Path) -> None:
    dataset = LabelmeImporter().read(_write(tmp_path, [_shape()], imageData=_png(), picture=False))

    assert dataset.images == ()
    assert dataset.classes == ()
    ((kind, subject, reason),) = _losses(dataset)
    assert (kind, subject) == (ImportLossKind.IMAGE, "a.png")
    assert "1 label(s) would be lost" in reason


@pytest.mark.parametrize(
    ("data", "match"),
    [
        ("not base64!", "not valid base64"),
        (base64.b64encode(b"plain text, no picture").decode(), "not a picture"),
        (_png()[:40], "not valid base64|not a picture"),
        (_png((16, 16)), "imageData is 16x16"),
        (7, "not a base64 string"),
    ],
)
def test_bad_image_data_refuses_the_import(tmp_path: Path, data: object, match: str) -> None:
    with pytest.raises(ImportSourceUnreadable, match=match):
        LabelmeImporter().read(_write(tmp_path, [_shape()], imageData=data))


def test_oversized_image_data_is_refused_before_it_is_decoded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(labelme_reader, "MAX_IMAGE_DATA_CHARS", 16)
    with pytest.raises(ImportSourceUnreadable, match="over the 16"):
        LabelmeImporter().read(_write(tmp_path, [_shape()], imageData=_png()))


def test_an_oversized_document_is_refused_before_it_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(labelme_reader, "MAX_DOCUMENT_BYTES", 16)
    with pytest.raises(ImportSourceUnreadable, match="over the 16"):
        LabelmeImporter().read(_write(tmp_path, [_shape()]))


# --- writing --------------------------------------------------------------------


def _release() -> Release:
    return Release(
        dataset_id=uuid4(),
        tag="v1",
        manifest_hash="0" * 64,
        schema_version=1,
        asset_count=0,
        annotation_count=0,
    )


CAR = LabelClass(
    name="car",
    geometries=(GeometryType.BBOX, GeometryType.POLYGON),
    attributes=(
        Attribute(name="occluded", kind="boolean"),
        Attribute(name="description", kind="string"),
        Attribute(name="speed", kind="number"),
    ),
)


def _annotation(geometry: object, **attributes: object) -> ManifestAnnotation:
    return ManifestAnnotation.model_validate(
        {
            "id": uuid4(),
            "label_class": "car",
            "schema_version": 1,
            "geometry": geometry,
            "attributes": attributes,
            "provenance": "human",
        }
    )


def _content(blob: bytes) -> ContentReader:
    def content(content_hash: str) -> BinaryIO:
        return BytesIO(blob)

    return content


def test_the_written_document_carries_every_key_labelme_reads(tmp_path: Path) -> None:
    annotations = (
        _annotation(BboxGeometry(x=0.125, y=1, width=2, height=3), occluded=True, speed=2.5),
        _annotation(PolygonGeometry(points=[(1, 1), (9.5, 1), (9.5, 7.25)]), description="x"),
    )
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/a.png",
        width=SIZE[0],
        height=SIZE[1],
        annotations=annotations,
    )
    manifest = Manifest(schema_version=1, classes=(CAR,), assets=(asset,))
    LabelmeExporter().export(
        _release(),
        manifest,
        tmp_path,
        content=_content(base64.b64decode(_png())),
        assignment=None,
    )

    stem = "a" * 64
    assert sorted(path.name for path in tmp_path.iterdir()) == [f"{stem}.json", f"{stem}.png"]
    document = json.loads((tmp_path / f"{'a' * 64}.json").read_text(encoding="utf-8"))
    document["shapes"].sort(key=lambda shape: shape["shape_type"], reverse=True)
    assert document == {
        "version": LABELME_VERSION,
        "flags": {},
        "shapes": [
            {
                "label": "car",
                "points": [[0.125, 1.0], [2.125, 4.0]],
                "group_id": None,
                "description": "",
                "shape_type": "rectangle",
                "flags": {"occluded": True},
                "mask": None,
            },
            {
                "label": "car",
                "points": [[1.0, 1.0], [9.5, 1.0], [9.5, 7.25]],
                "group_id": None,
                "description": "x",
                "shape_type": "polygon",
                "flags": {},
                "mask": None,
            },
        ],
        "imagePath": f"{'a' * 64}.png",
        "imageData": None,
        "imageHeight": SIZE[1],
        "imageWidth": SIZE[0],
    }

    dataset = LabelmeImporter().read(tmp_path)
    assert dataset.losses == ()
    (image,) = dataset.images
    assert sorted(
        ((label.geometry, label.attributes) for label in image.labels),
        key=lambda pair: pair[0].type.value,
    ) == [
        (BboxGeometry(x=0.125, y=1, width=2, height=3), {"occluded": True}),
        (PolygonGeometry(points=[(1, 1), (9.5, 1), (9.5, 7.25)]), {"description": "x"}),
    ]


def _stored(workspace: WorkspaceService, project_id: Any) -> dict[str, Counter[tuple[str, str]]]:
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: Counter(
                (label.label_class, label.geometry.model_dump_json())
                for label in uow.annotations.list(asset.id)
            )
            for asset in uow.assets.list(project_id)
        }


def _drawn(label_class: str, geometry: BboxGeometry | PolygonGeometry) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


def test_rectangles_and_polygons_round_trip_through_a_release(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path / "origin", classes=CLASSES[:2])
    fixture.label(
        {
            0: [_drawn("sign", BboxGeometry(x=8, y=12, width=16, height=24))],
            1: [
                _drawn("lane", PolygonGeometry(points=[(8.0, 12.5), (24.25, 12.0), (8.0, 36.0)])),
                _drawn("sign", BboxGeometry(x=1.5, y=2.25, width=10, height=8)),
            ],
        }
    )
    exported = tmp_path / "exported"
    fixture.releases.export(
        fixture.publish(split=SplitRecipe(train=0.5, val=0.5, test=0.0, seed=1)),
        LabelmeExporter(),
        exported,
        allow_lossy=True,
    )
    original = _stored(fixture.workspace, fixture.project.id)
    fixture.close()

    assert {path.name for path in exported.iterdir() if path.is_dir()} <= {"train", "val"}
    workspace = WorkspaceService.init(tmp_path / "copy")
    project = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    plan = imports.inspect(project.id, LabelmeImporter(), exported)
    run = imports.commit(project.id, LabelmeImporter(), exported, consent=ImportConsent())

    assert plan.losses == ()
    assert run.losses == ()
    assert _stored(workspace, project.id) == original
    workspace.close()
