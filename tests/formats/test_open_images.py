"""Open Images box CSVs: what is read, refused and reported, read independently, round-tripped."""

from __future__ import annotations

import csv
from collections import Counter
from io import BytesIO
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4

import pytest
from PIL import Image
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import CLASSES, Fixture

from visionset.formats.open_images import (
    DESCRIPTIONS_FILENAME,
    OpenImagesExporter,
    OpenImagesImporter,
)
from visionset.formats.open_images.reader import COLUMNS
from visionset.formats.registry import exporters, importers
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    Attribute,
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
WIDE = (40, 10)
TALL = (64, 48)

#: Known pixel boxes and their Open Images corners, each pair worked by hand,
#: on pictures of two sizes: off-centre, crossing the left and bottom borders,
#: and fractional enough that unrounded float arithmetic lands an ulp away.
KNOWN: list[tuple[tuple[int, int], BboxGeometry, tuple[str, str, str, str]]] = [
    (WIDE, BboxGeometry(x=2, y=3, width=8, height=6), ("0.05", "0.25", "0.3", "0.9")),
    (WIDE, BboxGeometry(x=-4, y=6, width=10, height=8), ("-0.1", "0.15", "0.6", "1.4")),
    (TALL, BboxGeometry(x=16, y=12, width=32, height=24), ("0.25", "0.75", "0.25", "0.75")),
    (
        TALL,
        BboxGeometry(x=10.3, y=2.4, width=4.1, height=2.4),
        ("0.1609375", "0.225", "0.05", "0.1"),
    ),
]

DESCRIBED = [("/m/0k4j", "Car"), ("/m/01g317", "Person"), ("/m/09j2d", "Clothing")]


def _row(image_id: str = "a", label: str = "/m/0k4j", **columns: str) -> dict[str, str]:
    row = {
        "ImageID": image_id,
        "Source": "",
        "LabelName": label,
        "Confidence": "1",
        "XMin": "0.25",
        "XMax": "0.5",
        "YMin": "0.25",
        "YMax": "0.5",
        "IsOccluded": "-1",
        "IsTruncated": "-1",
        "IsGroupOf": "-1",
        "IsDepiction": "-1",
        "IsInside": "-1",
    }
    row.update(columns)
    return row


def _write(
    src: Path,
    rows: list[dict[str, str]],
    *,
    split: str = "train",
    pictures: tuple[str, ...] = ("a.png",),
    size: tuple[int, int] = SIZE,
    described: list[tuple[str, str]] | None = None,
    name: str | None = None,
) -> Path:
    src.mkdir(parents=True, exist_ok=True)
    descriptions = src / DESCRIPTIONS_FILENAME
    if not descriptions.exists():
        with descriptions.open("w", encoding="utf-8", newline="") as handle:
            csv.writer(handle).writerows(DESCRIBED if described is None else described)
    header = list(rows[0]) if rows else list(COLUMNS)
    with (src / (name or f"{split}-annotations-bbox.csv")).open(
        "w", encoding="utf-8", newline=""
    ) as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)
    for picture in pictures:
        write_image(src / split / picture, size=size)
    return src


def _losses(dataset: ImportedDataset) -> dict[tuple[ImportLossKind, str, str], int]:
    return {(loss.kind, loss.subject, loss.reason): loss.count for loss in dataset.losses}


# --- reading ------------------------------------------------------------------


def test_the_plugins_are_discovered_by_name() -> None:
    assert isinstance(importers()["open-images"], OpenImagesImporter)
    assert isinstance(exporters()["open-images"], OpenImagesExporter)


def test_known_normalized_boxes_read_as_pixels_on_pictures_of_two_sizes(tmp_path: Path) -> None:
    rows = [
        _row(f"p{position}", XMin=x_min, XMax=x_max, YMin=y_min, YMax=y_max)
        for position, (_, _, (x_min, x_max, y_min, y_max)) in enumerate(KNOWN)
    ]
    _write(tmp_path, rows, pictures=())
    for position, (size, _, _) in enumerate(KNOWN):
        write_image(tmp_path / "train" / f"p{position}.png", size=size)

    dataset = OpenImagesImporter().read(tmp_path)

    by_name = {str(image.path): image for image in dataset.images}
    for position, (size, box, _) in enumerate(KNOWN):
        image = by_name[f"train/p{position}.png"]
        assert (image.width, image.height) == size
        assert [label.geometry for label in image.labels] == [box]
    assert [(c.name, c.geometries, c.attributes) for c in dataset.classes] == [
        ("Car", (GeometryType.BBOX,), ())
    ]


def test_noncontiguous_mids_map_to_display_names_and_unused_classes_stay_out(
    tmp_path: Path,
) -> None:
    described = [
        ("LabelName", "DisplayName"),
        ("/m/0k4j", "Car"),
        ("/m/0zzz", "Unused"),
        ("/m/01g317", "Person"),
    ]
    rows = [_row(label="/m/01g317"), _row(label="/m/0k4j"), _row(label="/m/01g317")]
    dataset = OpenImagesImporter().read(_write(tmp_path, rows, described=described))

    assert [c.name for c in dataset.classes] == ["Car", "Person"]
    assert [label.class_name for label in dataset.images[0].labels] == ["Person", "Car", "Person"]
    assert _losses(dataset) == {
        (
            ImportLossKind.ATTRIBUTE,
            "Person",
            "LabelName /m/01g317 is not kept; the class is its DisplayName",
        ): 2,
        (
            ImportLossKind.ATTRIBUTE,
            "Car",
            "LabelName /m/0k4j is not kept; the class is its DisplayName",
        ): 1,
    }


def test_optional_flags_become_boolean_attributes_and_confidence_is_kept(tmp_path: Path) -> None:
    rows = [
        _row(IsOccluded="1", IsTruncated="0", IsGroupOf="1", IsDepiction="0", IsInside="1"),
        _row(Confidence="0.75", IsOccluded="0", IsTruncated="", IsGroupOf="-1"),
        _row(Confidence="1.0"),
    ]
    dataset = OpenImagesImporter().read(_write(tmp_path, rows))

    (car,) = dataset.classes
    assert [(one.name, one.kind) for one in car.attributes] == [
        ("IsOccluded", "boolean"),
        ("IsTruncated", "boolean"),
        ("IsGroupOf", "boolean"),
        ("IsDepiction", "boolean"),
        ("IsInside", "boolean"),
    ]
    first, second, third = dataset.images[0].labels
    assert first.attributes == {
        "IsOccluded": True,
        "IsTruncated": False,
        "IsGroupOf": True,
        "IsDepiction": False,
        "IsInside": True,
    }
    assert (first.confidence, second.confidence, third.confidence) == (None, 0.75, None)
    assert second.attributes == {"IsOccluded": False}
    assert third.attributes == {}


def test_losses_are_reported_never_dropped_silently(tmp_path: Path) -> None:
    described = [("Car", "Car")]
    rows = [
        _row(label="Car", Source="xclick", XClick1X="0.3", XClick1Y="-1", Note=""),
        _row(label="Car", XMin="2", XMax="3", XClick1X="-1", XClick1Y="-1", Note="x"),
        _row(label="Car", XClick1X="-1", XClick1Y="-1", Note=""),
    ]
    dataset = OpenImagesImporter().read(_write(tmp_path, rows, described=described))

    assert len(dataset.images[0].labels) == 2
    assert _losses(dataset) == {
        (ImportLossKind.ATTRIBUTE, "Car", "Source is not imported"): 1,
        (
            ImportLossKind.GEOMETRY,
            "Car",
            "extreme-click points are not imported; the box is kept",
        ): 1,
        (ImportLossKind.ATTRIBUTE, "Car", "Note is not imported"): 1,
        (ImportLossKind.LABEL, "Car", "it lies wholly outside its picture"): 1,
    }


def test_absent_pictures_are_image_and_label_losses(tmp_path: Path) -> None:
    rows = [_row(image_id, label="Car") for image_id in ("a", "gone", "gone", "lost")]
    src = _write(tmp_path, rows, described=[("Car", "Car")])
    write_image(src / "train" / "spare.png", size=SIZE)

    dataset = OpenImagesImporter().read(src)

    assert {str(image.path): len(image.labels) for image in dataset.images} == {
        "train/a.png": 1,
        "train/spare.png": 0,
    }
    assert _losses(dataset) == {
        (
            ImportLossKind.LABEL,
            "train-annotations-bbox.csv",
            "a box on an ImageID with no picture",
        ): 3,
        (
            ImportLossKind.IMAGE,
            "train-annotations-bbox.csv",
            "an ImageID with no picture under train/; its boxes are not imported",
        ): 2,
    }


def test_splits_and_versioned_file_names_read_their_own_pictures(tmp_path: Path) -> None:
    _write(tmp_path, [_row("a")], name="oidv6-train-annotations-bbox.csv")
    _write(tmp_path, [_row("b", label="/m/01g317")], split="validation", pictures=("b.jpg",))

    dataset = OpenImagesImporter().read(tmp_path)
    assert {
        str(image.path): [label.class_name for label in image.labels] for image in dataset.images
    } == {"train/a.png": ["Car"], "validation/b.jpg": ["Person"]}


# --- refusals -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("columns", "match"),
    [
        ({"XMin": "left"}, "XMin 'left' is not a number"),
        ({"YMax": ""}, "YMax '' is not a number"),
        ({"XMin": "nan"}, "non-finite"),
        ({"YMin": "inf"}, "non-finite"),
        ({"XMin": "0.5", "XMax": "0.5"}, "maximum must exceed its minimum"),
        ({"YMin": "0.6", "YMax": "0.4"}, "maximum must exceed its minimum"),
        ({"ImageID": ""}, "is not an id"),
        ({"ImageID": "../a"}, "is not an id"),
        ({"ImageID": "a.png"}, "is not an id"),
        ({"LabelName": ""}, "LabelName is blank"),
        ({"LabelName": "/m/unknown"}, "not in the class descriptions"),
        ({"Confidence": "1.5"}, "Confidence '1.5'"),
        ({"Confidence": "high"}, "Confidence 'high'"),
        ({"IsOccluded": "yes"}, "IsOccluded 'yes' is not 1, 0 or -1"),
        ({"IsGroupOf": "2"}, "IsGroupOf '2'"),
    ],
)
def test_a_malformed_row_is_refused_by_file_and_line(
    tmp_path: Path, columns: dict[str, str], match: str
) -> None:
    src = _write(tmp_path, [_row(), _row(**columns)])
    with pytest.raises(ImportSourceUnreadable, match=match) as refusal:
        OpenImagesImporter().read(src)
    assert "train-annotations-bbox.csv line 3" in str(refusal.value)


@pytest.mark.parametrize(
    ("text", "match"),
    [
        ("ImageID,LabelName,XMin,XMax,YMin\n", "lacks YMax"),
        ("ImageID,LabelName,XMin,XMax,YMin,YMax,XMin\n", "names a column twice"),
        ("ImageID,LabelName,XMin,XMax,YMin,YMax\na,/m/0k4j,0.1,0.2,0.1\n", "5 fields"),
        ("ImageID,LabelName,XMin,XMax,YMin,YMax\na,/m/0k4j,0.1,0.2,0.1,0.2,7\n", "7 fields"),
        ('ImageID,LabelName,XMin,XMax,YMin,YMax\n"a,/m/0k4j\n', "not readable CSV"),
        ("", "has no header"),
    ],
)
def test_a_malformed_box_file_is_refused(tmp_path: Path, text: str, match: str) -> None:
    _write(tmp_path, [_row()])
    (tmp_path / "train-annotations-bbox.csv").write_text(text, encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match=match):
        OpenImagesImporter().read(tmp_path)


def test_two_mids_sharing_a_display_name_are_refused_as_ambiguous(tmp_path: Path) -> None:
    described = [("/m/a", "Car"), ("/m/b", "Car"), ("/m/c", "Car")]
    rows = [_row(label="/m/a"), _row(label="/m/b")]
    with pytest.raises(ImportSourceUnreadable, match="'/m/a' and '/m/b' are both named 'Car'"):
        OpenImagesImporter().read(_write(tmp_path, rows, described=described))


def test_an_unused_shared_display_name_is_not_ambiguous(tmp_path: Path) -> None:
    described = [("/m/a", "Car"), ("/m/b", "Car")]
    dataset = OpenImagesImporter().read(_write(tmp_path, [_row(label="/m/a")], described=described))
    assert [c.name for c in dataset.classes] == ["Car"]


@pytest.mark.parametrize(
    ("described", "match"),
    [
        ([("/m/a", "Car"), ("/m/a", "Auto")], "'/m/a' is described twice"),
        ([("/m/a", "Car", "extra")], "not LabelName,DisplayName"),
        ([(" ", "Car")], "LabelName is blank"),
    ],
)
def test_a_malformed_class_file_is_refused(
    tmp_path: Path, described: list[tuple[str, ...]], match: str
) -> None:
    src = tmp_path
    src.mkdir(exist_ok=True)
    with (src / DESCRIPTIONS_FILENAME).open("w", encoding="utf-8", newline="") as handle:
        csv.writer(handle).writerows(described)
    _write(src, [_row(label="/m/a")])
    with pytest.raises(ImportSourceUnreadable, match=match):
        OpenImagesImporter().read(src)


def test_a_blank_display_name_in_use_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ImportSourceUnreadable, match="blank DisplayName"):
        OpenImagesImporter().read(_write(tmp_path, [_row(label="/m/a")], described=[("/m/a", " ")]))


def test_an_image_id_in_two_splits_is_refused(tmp_path: Path) -> None:
    _write(tmp_path, [_row("a")])
    _write(tmp_path, [_row("a")], split="validation")
    with pytest.raises(ImportSourceUnreadable, match="'a' is in both 'train' and 'validation'"):
        OpenImagesImporter().read(tmp_path)


def test_an_image_id_matching_two_pictures_is_refused(tmp_path: Path) -> None:
    src = _write(tmp_path, [_row("a")], pictures=("a.png", "a.jpg"))
    with pytest.raises(
        ImportSourceUnreadable, match="ImageID 'a' matches train/a.jpg, train/a.png"
    ):
        OpenImagesImporter().read(src)


def test_two_files_for_one_split_are_refused(tmp_path: Path) -> None:
    _write(tmp_path, [_row("a")])
    _write(tmp_path, [_row("b")], name="oidv6-train-annotations-bbox.csv", pictures=("b.png",))
    with pytest.raises(ImportSourceUnreadable, match="both annotate the 'train' split"):
        OpenImagesImporter().read(tmp_path)


def test_two_class_files_are_refused(tmp_path: Path) -> None:
    _write(tmp_path, [_row()])
    (tmp_path / "oidv7-class-descriptions.csv").write_text("/m/0k4j,Car\n", encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match="keep one class file"):
        OpenImagesImporter().read(tmp_path)


def test_a_source_without_a_class_file_or_a_box_file_is_refused(tmp_path: Path) -> None:
    write_image(tmp_path / "train" / "a.png", size=SIZE)
    with pytest.raises(ImportSourceUnreadable, match="holds no class-descriptions"):
        OpenImagesImporter().read(tmp_path)
    (tmp_path / DESCRIPTIONS_FILENAME).write_text("/m/0k4j,Car\n", encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match="holds no <split>-annotations-bbox.csv"):
        OpenImagesImporter().read(tmp_path)


def test_an_unreadable_picture_is_refused(tmp_path: Path) -> None:
    src = _write(tmp_path, [_row("a")], pictures=())
    (src / "train").mkdir()
    (src / "train" / "a.png").write_bytes(b"not a picture")
    with pytest.raises(ImportSourceUnreadable, match="not a readable picture"):
        OpenImagesImporter().read(src)


def test_a_link_resolving_outside_the_source_is_refused(tmp_path: Path) -> None:
    outside = write_image(tmp_path / "outside.png", size=SIZE)
    src = _write(tmp_path / "src", [_row("a")], pictures=())
    (src / "train").mkdir()
    (src / "train" / "a.png").symlink_to(outside)
    with pytest.raises(ImportSourceUnreadable, match="resolves outside the source"):
        OpenImagesImporter().read(src)


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
        Attribute(name="IsOccluded", kind="boolean"),
        Attribute(name="IsGroupOf", kind="boolean"),
        Attribute(name="colour", kind="string"),
    ),
)


def _annotation(
    geometry: object, *, confidence: float | None = None, **attributes: object
) -> ManifestAnnotation:
    return ManifestAnnotation.model_validate(
        {
            "id": uuid4(),
            "label_class": "car",
            "schema_version": 1,
            "geometry": geometry,
            "attributes": attributes,
            "provenance": "human" if confidence is None else "model",
            "confidence": confidence,
        }
    )


def _png(size: tuple[int, int]) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size).save(buffer, format="PNG")
    return buffer.getvalue()


def _content(blobs: dict[str, bytes]) -> ContentReader:
    def content(content_hash: str) -> BinaryIO:
        return BytesIO(blobs[content_hash])

    return content


def _known_release(tmp_path: Path) -> tuple[Manifest, dict[str, BboxGeometry]]:
    """Every ``KNOWN`` box on its own picture, plus a polygon and an empty picture."""
    assets: list[ManifestAsset] = []
    blobs: dict[str, bytes] = {}
    expected: dict[str, BboxGeometry] = {}
    for position, (size, box, _) in enumerate(KNOWN):
        content_hash = f"{position:x}" * 64
        expected[content_hash] = box
        blobs[content_hash] = _png(size)
        annotations = (
            _annotation(box, IsOccluded=True, IsGroupOf=False, colour="red")
            if position == 0
            else _annotation(box, confidence=0.5)
            if position == 1
            else _annotation(box),
            _annotation(PolygonGeometry(points=[(1, 1), (9.5, 1), (9.5, 7.25)])),
        )
        assets.append(
            ManifestAsset(
                asset_id=uuid4(),
                content_hash=content_hash,
                uri=f"/{position}.png",
                width=size[0],
                height=size[1],
                annotations=annotations,
            )
        )
    blobs["e" * 64] = _png(SIZE)
    assets.append(
        ManifestAsset(
            asset_id=uuid4(), content_hash="e" * 64, uri="/e.png", width=SIZE[0], height=SIZE[1]
        )
    )
    manifest = Manifest(schema_version=1, classes=(CAR,), assets=tuple(assets))
    OpenImagesExporter().export(
        _release(), manifest, tmp_path, content=_content(blobs), assignment=None
    )
    return manifest, expected


def test_known_pixel_boxes_are_written_normalized_and_read_back_on_two_sizes(
    tmp_path: Path,
) -> None:
    _, expected = _known_release(tmp_path)

    assert sorted(path.name for path in tmp_path.iterdir()) == [
        DESCRIPTIONS_FILENAME,
        "train",
        "train-annotations-bbox.csv",
    ]
    lines = (tmp_path / "train-annotations-bbox.csv").read_text(encoding="utf-8").splitlines()
    assert lines[0] == ",".join(COLUMNS)
    rows = [line.split(",") for line in lines[1:]]
    assert [row[0] for row in rows] == [f"{position:x}" * 64 for position in range(len(KNOWN))]
    for row, (_, _, corners) in zip(rows, KNOWN, strict=True):
        assert [float(value) for value in row[4:8]] == pytest.approx(
            [float(value) for value in corners], abs=1e-15
        )
    assert rows[0][1:4] == ["", "car", "1"]
    assert rows[0][8:] == ["1", "-1", "0", "-1", "-1"]
    assert rows[1][3] == "0.5"
    assert rows[2][8:] == ["-1"] * 5
    assert (tmp_path / DESCRIPTIONS_FILENAME).read_text(encoding="utf-8") == (
        "LabelName,DisplayName\ncar,car\n"
    )

    dataset = OpenImagesImporter().read(tmp_path)
    assert dataset.losses == ()
    by_hash = {image.path.stem: image for image in dataset.images}
    assert set(by_hash) == {*expected, "e" * 64}
    for content_hash, box in expected.items():
        assert [label.geometry for label in by_hash[content_hash].labels] == [box]
    first = by_hash["0" * 64].labels[0]
    assert first.attributes == {"IsOccluded": True, "IsGroupOf": False}
    assert by_hash["1" * 64].labels[0].confidence == 0.5


def test_an_independent_csv_reader_takes_the_published_columns(tmp_path: Path) -> None:
    """Read the export with ``csv`` and Pillow alone, by the Open Images column spec."""
    _, expected = _known_release(tmp_path)

    with (tmp_path / "class-descriptions-boxable.csv").open(newline="", encoding="utf-8") as f:
        described = list(csv.reader(f))
    assert described[0] == ["LabelName", "DisplayName"]
    display = dict((row[0], row[1]) for row in described[1:])

    with (tmp_path / "train-annotations-bbox.csv").open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames == [
            "ImageID",
            "Source",
            "LabelName",
            "Confidence",
            "XMin",
            "XMax",
            "YMin",
            "YMax",
            "IsOccluded",
            "IsTruncated",
            "IsGroupOf",
            "IsDepiction",
            "IsInside",
        ]
        rows = list(reader)

    seen: dict[str, tuple[str, float, float, float, float]] = {}
    for row in rows:
        (picture,) = (tmp_path / "train").glob(f"{row['ImageID']}.*")
        with Image.open(picture) as image:
            width, height = image.size
        x_min, x_max = float(row["XMin"]) * width, float(row["XMax"]) * width
        y_min, y_max = float(row["YMin"]) * height, float(row["YMax"]) * height
        assert 0.0 <= float(row["Confidence"]) <= 1.0
        assert all(row[flag] in {"-1", "0", "1"} for flag in reader.fieldnames[8:])
        seen[row["ImageID"]] = (display[row["LabelName"]], x_min, x_max, y_min, y_max)

    assert set(seen) == set(expected)
    for image_id, box in expected.items():
        name, x_min, x_max, y_min, y_max = seen[image_id]
        assert name == "car"
        assert (x_min, y_min, x_max - x_min, y_max - y_min) == pytest.approx(
            (box.x, box.y, box.width, box.height), abs=1e-9
        )


def _stored(
    workspace: WorkspaceService, project_id: Any
) -> dict[str, Counter[tuple[str, str, str]]]:
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: Counter(
                (
                    label.label_class,
                    label.geometry.model_dump_json(),
                    repr(sorted(label.attributes.items())),
                )
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
        OpenImagesExporter(),
        exported,
        allow_lossy=True,
    )
    original = _stored(fixture.workspace, fixture.project.id)
    fixture.close()

    splits = {path.name for path in exported.iterdir() if path.is_dir()}
    assert splits == {"train", "validation"}
    for split in splits:
        assert (exported / f"{split}-annotations-bbox.csv").is_file()
    workspace = WorkspaceService.init(tmp_path / "copy")
    project = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    plan = imports.inspect(project.id, OpenImagesImporter(), exported)
    run = imports.commit(project.id, OpenImagesImporter(), exported, consent=ImportConsent())

    assert plan.losses == ()
    assert run.losses == ()
    assert _stored(workspace, project.id) == original
    workspace.close()
