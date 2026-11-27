"""Create ML object-detection JSON: what is read, refused and reported, and the round trip."""

from __future__ import annotations

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

import visionset.formats.createml.reader as createml_reader
from visionset.formats.createml import ANNOTATIONS_FILENAME, CreatemlExporter, CreatemlImporter
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
from visionset.kernel.ports import ContentReader
from visionset.kernel.services import ImportService, ProjectService, WorkspaceService

SIZE = (32, 24)

#: Known boxes on a 40x10 picture, top-left and centre-based, each pair worked by hand.
#: Off-centre, crossing the left and bottom borders, and fractional enough that
#: that unrounded float arithmetic lands an ulp away in both directions.
KNOWN: list[tuple[BboxGeometry, dict[str, float]]] = [
    (
        BboxGeometry(x=2, y=3, width=8, height=6),
        {"x": 6.0, "y": 6.0, "width": 8.0, "height": 6.0},
    ),
    (
        BboxGeometry(x=-4, y=6, width=10, height=8),
        {"x": 1.0, "y": 10.0, "width": 10.0, "height": 8.0},
    ),
    (
        BboxGeometry(x=31.5, y=0.25, width=12, height=2.5),
        {"x": 37.5, "y": 1.5, "width": 12.0, "height": 2.5},
    ),
    (
        BboxGeometry(x=10.3, y=2.7, width=4.1, height=1.9),
        {"x": 12.35, "y": 3.65, "width": 4.1, "height": 1.9},
    ),
]
WIDE = (40, 10)


def _box(label: str = "car", **coordinates: Any) -> dict[str, Any]:
    box: dict[str, Any] = {"x": 6, "y": 6, "width": 8, "height": 6}
    box.update(coordinates)
    return {"label": label, "coordinates": box}


def _write(
    src: Path,
    entries: list[dict[str, Any]],
    *,
    name: str = ANNOTATIONS_FILENAME,
    pictures: tuple[str, ...] = ("a.png",),
    size: tuple[int, int] = SIZE,
) -> Path:
    target = src / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(entries), encoding="utf-8")
    for picture in pictures:
        write_image(target.parent / picture, size=size)
    return src


def _losses(dataset: ImportedDataset) -> dict[tuple[ImportLossKind, str, str], int]:
    return {(loss.kind, loss.subject, loss.reason): loss.count for loss in dataset.losses}


# --- reading ------------------------------------------------------------------


def test_the_plugins_are_discovered_by_name() -> None:
    assert isinstance(importers()["createml"], CreatemlImporter)
    assert isinstance(exporters()["createml"], CreatemlExporter)


def test_known_centre_boxes_read_as_their_top_left_boxes(tmp_path: Path) -> None:
    entries = [
        {"image": "a.png", "annotations": [{"label": "car", "coordinates": centre}]}
        for _, centre in KNOWN
    ]
    for position, entry in enumerate(entries):
        entry["image"] = f"{position}.png"
    src = _write(tmp_path, entries, pictures=tuple(e["image"] for e in entries), size=WIDE)

    dataset = CreatemlImporter().read(src)

    by_name = {str(image.path): image for image in dataset.images}
    for position, (box, _) in enumerate(KNOWN):
        image = by_name[f"{position}.png"]
        assert (image.width, image.height) == WIDE
        assert [label.geometry for label in image.labels] == [box]
    assert [(c.name, c.geometries) for c in dataset.classes] == [("car", (GeometryType.BBOX,))]
    assert dataset.losses == ()


def test_an_entry_with_no_annotations_is_an_unlabelled_picture_of_its_size(
    tmp_path: Path,
) -> None:
    dataset = CreatemlImporter().read(_write(tmp_path, [{"image": "a.png", "annotations": []}]))

    (image,) = dataset.images
    assert (image.width, image.height, image.labels) == (*SIZE, ())
    assert dataset.classes == ()


def test_a_picture_no_entry_names_is_imported_unlabelled(tmp_path: Path) -> None:
    src = _write(tmp_path, [{"image": "a.png", "annotations": [_box()]}])
    write_image(tmp_path / "b.png", size=SIZE)

    dataset = CreatemlImporter().read(src)
    assert {str(image.path): len(image.labels) for image in dataset.images} == {
        "a.png": 1,
        "b.png": 0,
    }


def test_documents_in_fold_folders_read_their_own_pictures(tmp_path: Path) -> None:
    _write(tmp_path, [{"image": "a.png", "annotations": [_box()]}], name="train/annotations.json")
    _write(
        tmp_path,
        [{"image": "a.png", "annotations": [_box("bus")]}],
        name="val/annotations.json",
    )

    dataset = CreatemlImporter().read(tmp_path)
    assert {
        str(image.path): [label.class_name for label in image.labels] for image in dataset.images
    } == {"train/a.png": ["car"], "val/a.png": ["bus"]}


def test_losses_are_reported_never_dropped_silently(tmp_path: Path) -> None:
    entry = {
        "image": "a.png",
        "annotations": [
            _box(""),
            _box("car", x=100, y=100),
            {**_box("car"), "confidence": 0.9},
            _box("car", rotation=12),
        ],
        "notes": "hello",
    }
    dataset = CreatemlImporter().read(_write(tmp_path, [entry]))

    (image,) = dataset.images
    assert len(image.labels) == 2
    assert _losses(dataset) == {
        (ImportLossKind.LABEL, "annotation", "it has no label"): 1,
        (ImportLossKind.LABEL, "car", "it lies wholly outside its picture"): 1,
        (ImportLossKind.ATTRIBUTE, "car", "confidence is not imported"): 1,
        (
            ImportLossKind.GEOMETRY,
            "car",
            "coordinates.rotation is not imported; the box is kept",
        ): 1,
        (ImportLossKind.ATTRIBUTE, "notes", "it is not imported"): 1,
    }


def test_json_that_is_not_a_createml_document_is_not_read(tmp_path: Path) -> None:
    _write(tmp_path, [{"image": "a.png", "annotations": [_box()]}])
    (tmp_path / "report.json").write_text('{"images": []}', encoding="utf-8")
    (tmp_path / "list.json").write_text("[1, 2]", encoding="utf-8")

    (image,) = CreatemlImporter().read(tmp_path).images
    assert len(image.labels) == 1


def test_a_source_without_a_document_is_refused(tmp_path: Path) -> None:
    write_image(tmp_path / "a.png", size=SIZE)
    with pytest.raises(ImportSourceUnreadable, match="holds no Create ML"):
        CreatemlImporter().read(tmp_path)


@pytest.mark.parametrize(
    ("text", "match"),
    [
        ("[{not json", "not readable JSON"),
        ('[{"image": "a.png", "annotations": [], "x": NaN}]', "not readable JSON"),
        ('[{"image": "a.png"}, 7]', "entry is not an object"),
        ('[{"image": 3}]', "image is not a non-empty string"),
        ('[{"image": " "}]', "image is not a non-empty string"),
        ('[{"image": "a.png", "annotations": {}}]', "annotations is not a list"),
        ('[{"image": "a.png", "annotations": [7]}]', "annotations is not a list"),
        (
            '[{"image": "a.png", "annotations": [{"label": 3, "coordinates": {}}]}]',
            "label is not a string",
        ),
        (
            '[{"image": "a.png", "annotations": [{"label": "car"}]}]',
            "coordinates is not an object",
        ),
        (
            '[{"image": "a.png", "annotations": [{"label": "car", "coordinates": [1, 2, 3, 4]}]}]',
            "coordinates is not an object",
        ),
        (
            '[{"image": "a.png", "annotations": [{"label": "car", '
            '"coordinates": {"x": 1, "y": 1, "width": 2}}]}]',
            "coordinate 'height' is not a number",
        ),
        (
            '[{"image": "a.png", "annotations": [{"label": "car", '
            '"coordinates": {"x": "1", "y": 1, "width": 2, "height": 2}}]}]',
            "coordinate 'x' is not a number",
        ),
        (
            '[{"image": "a.png", "annotations": [{"label": "car", '
            '"coordinates": {"x": 1, "y": true, "width": 2, "height": 2}}]}]',
            "coordinate 'y' is not a number",
        ),
        (
            '[{"image": "a.png", "annotations": [{"label": "car", '
            '"coordinates": {"x": 1e999, "y": 1, "width": 2, "height": 2}}]}]',
            "non-finite",
        ),
        (
            '[{"image": "a.png", "annotations": [{"label": "car", '
            '"coordinates": {"x": 1, "y": 1, "width": 0, "height": 2}}]}]',
            "must be positive",
        ),
        (
            '[{"image": "a.png", "annotations": [{"label": "car", '
            '"coordinates": {"x": 1, "y": 1, "width": 2, "height": -3}}]}]',
            "must be positive",
        ),
        (
            '[{"image": "a.png", "annotations": [{"label": "", '
            '"coordinates": {"x": 1, "y": 1, "width": 2, "height": -3}}]}]',
            "must be positive",
        ),
    ],
)
def test_a_malformed_document_is_refused_by_name(tmp_path: Path, text: str, match: str) -> None:
    write_image(tmp_path / "a.png", size=SIZE)
    (tmp_path / ANNOTATIONS_FILENAME).write_text(text, encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match=match) as refusal:
        CreatemlImporter().read(tmp_path)
    assert ANNOTATIONS_FILENAME in str(refusal.value)


def test_a_picture_named_twice_is_refused(tmp_path: Path) -> None:
    entry = {"image": "a.png", "annotations": [_box()]}
    with pytest.raises(ImportSourceUnreadable, match="named more than once"):
        CreatemlImporter().read(_write(tmp_path, [entry, entry]))


def test_an_oversized_document_is_refused_before_it_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(createml_reader, "MAX_DOCUMENT_BYTES", 16)
    with pytest.raises(ImportSourceUnreadable, match="over the 16"):
        CreatemlImporter().read(_write(tmp_path, [{"image": "a.png", "annotations": [_box()]}]))


# --- paths and pictures ---------------------------------------------------------


@pytest.mark.parametrize(
    "image",
    ["../outside.png", "sub/../../outside.png", "/etc/passwd", "C:\\data\\a.png", "..\\a.png"],
)
def test_an_image_name_leaving_the_source_is_refused(tmp_path: Path, image: str) -> None:
    src = _write(tmp_path / "src", [{"image": image, "annotations": []}], pictures=())
    with pytest.raises(ImportSourceUnreadable, match="image"):
        CreatemlImporter().read(src)


def test_an_image_name_is_read_from_the_document_s_directory(tmp_path: Path) -> None:
    write_image(tmp_path / "images" / "a.png", size=SIZE)
    src = _write(
        tmp_path,
        [{"image": "..\\images\\a.png", "annotations": [_box()]}],
        name="json/annotations.json",
        pictures=(),
    )

    (image,) = CreatemlImporter().read(src).images
    assert str(image.path) == "images/a.png"
    assert len(image.labels) == 1


def test_a_link_resolving_outside_the_source_is_refused(tmp_path: Path) -> None:
    outside = write_image(tmp_path / "outside.png", size=SIZE)
    src = _write(tmp_path / "src", [{"image": "link.png", "annotations": [_box()]}], pictures=())
    (src / "link.png").symlink_to(outside)
    with pytest.raises(ImportSourceUnreadable, match="resolves outside the source"):
        CreatemlImporter().read(src)


def test_a_missing_picture_is_refused_because_its_size_cannot_be_known(tmp_path: Path) -> None:
    src = _write(tmp_path, [{"image": "a.png", "annotations": [_box()]}], pictures=())
    with pytest.raises(ImportSourceUnreadable, match="'a.png' is not in the source"):
        CreatemlImporter().read(src)


def test_an_unreadable_picture_is_refused(tmp_path: Path) -> None:
    src = _write(tmp_path, [{"image": "a.png", "annotations": [_box()]}], pictures=())
    (src / "a.png").write_bytes(b"not a picture")
    with pytest.raises(ImportSourceUnreadable, match="not a readable picture"):
        CreatemlImporter().read(src)


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


CAR = LabelClass(name="car", geometries=(GeometryType.BBOX, GeometryType.POLYGON))


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


def _png(size: tuple[int, int]) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size).save(buffer, format="PNG")
    return buffer.getvalue()


def _content(blob: bytes) -> ContentReader:
    def content(content_hash: str) -> BinaryIO:
        return BytesIO(blob)

    return content


def test_known_top_left_boxes_are_written_as_their_centres_and_read_back(
    tmp_path: Path,
) -> None:
    annotations = (
        *(_annotation(box) for box, _ in KNOWN),
        _annotation(PolygonGeometry(points=[(1, 1), (9.5, 1), (9.5, 7.25)])),
    )
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/a.png",
        width=WIDE[0],
        height=WIDE[1],
        annotations=annotations,
    )
    empty = ManifestAsset(
        asset_id=uuid4(), content_hash="b" * 64, uri="/b.png", width=WIDE[0], height=WIDE[1]
    )
    manifest = Manifest(schema_version=1, classes=(CAR,), assets=(asset, empty))
    CreatemlExporter().export(
        _release(), manifest, tmp_path, content=_content(_png(WIDE)), assignment=None
    )

    assert sorted(path.name for path in tmp_path.iterdir()) == [
        f"{'a' * 64}.png",
        ANNOTATIONS_FILENAME,
        f"{'b' * 64}.png",
    ]
    document = json.loads((tmp_path / ANNOTATIONS_FILENAME).read_text(encoding="utf-8"))
    assert [entry["image"] for entry in document] == [f"{'a' * 64}.png", f"{'b' * 64}.png"]
    assert sorted(document[0]["annotations"], key=lambda one: one["coordinates"]["x"]) == sorted(
        ({"label": "car", "coordinates": centre} for _, centre in KNOWN),
        key=lambda one: one["coordinates"]["x"],
    )
    assert document[1]["annotations"] == []

    dataset = CreatemlImporter().read(tmp_path)
    assert dataset.losses == ()
    labelled = next(image for image in dataset.images if str(image.path).startswith("a"))
    assert (labelled.width, labelled.height) == WIDE
    assert {label.geometry for label in labelled.labels} == {box for box, _ in KNOWN}


def _stored(workspace: WorkspaceService, project_id: Any) -> dict[str, Counter[tuple[str, str]]]:
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: Counter(
                (label.label_class, label.geometry.model_dump_json())
                for label in uow.annotations.list(asset.id)
            )
            for asset in uow.assets.list(project_id)
        }


def _drawn(label_class: str, geometry: BboxGeometry) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


def test_boxes_round_trip_through_a_release_with_a_split(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path / "origin", classes=CLASSES[:1])
    fixture.label(
        {
            0: [_drawn("sign", BboxGeometry(x=8, y=12, width=16, height=24))],
            1: [
                _drawn("sign", BboxGeometry(x=10.3, y=2.7, width=4.1, height=1.9)),
                _drawn("sign", BboxGeometry(x=1.5, y=2.25, width=10, height=8)),
            ],
        }
    )
    exported = tmp_path / "exported"
    fixture.releases.export(
        fixture.publish(split=SplitRecipe(train=0.5, val=0.5, test=0.0, seed=1)),
        CreatemlExporter(),
        exported,
        allow_lossy=True,
    )
    original = _stored(fixture.workspace, fixture.project.id)
    fixture.close()

    folds = {path.name for path in exported.iterdir() if path.is_dir()}
    assert folds and folds <= {"train", "val"}
    for fold in folds:
        assert (exported / fold / ANNOTATIONS_FILENAME).is_file()
    workspace = WorkspaceService.init(tmp_path / "copy")
    project = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    plan = imports.inspect(project.id, CreatemlImporter(), exported)
    run = imports.commit(project.id, CreatemlImporter(), exported, consent=ImportConsent())

    assert plan.losses == ()
    assert run.losses == ()
    assert _stored(workspace, project.id) == original
    workspace.close()
