"""COCO RLE masks: both counts spellings, crowd regions, unioned parts and the round trip."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import CLASSES, IMAGE_SIZE, Fixture, _box

from visionset.formats.coco import ANNOTATIONS_DIRNAME, CocoExporter, CocoImporter, _annotation
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
    mask_bitmap,
    mask_union,
    rasterize_rings,
)
from visionset.kernel.domain.geometry import mask_runs
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.services import ImportService, ProjectService, WorkspaceService

WIDTH, HEIGHT = IMAGE_SIZE
ROAD = LabelClass(name="road", geometries=(GeometryType.MASK,))
CROWD = LabelClass(name="crowd", geometries=(GeometryType.MASK, GeometryType.POLYGON))

#: A square with a hole, an island inside the hole, and a second region apart from it.
HOLED = rasterize_rings(
    [
        [(4.0, 4.0), (24.0, 4.0), (24.0, 24.0), (4.0, 24.0)],
        [(8.0, 8.0), (20.0, 8.0), (20.0, 20.0), (8.0, 20.0)],
        [(12.0, 12.0), (16.0, 12.0), (16.0, 16.0), (12.0, 16.0)],
        [(40.0, 30.0), (60.0, 30.0), (60.0, 44.0), (40.0, 44.0)],
    ],
    height=HEIGHT,
    width=WIDTH,
)
CORNER = rasterize_rings([[(0.0, 0.0), (6.0, 0.0), (0.0, 6.0)]], height=HEIGHT, width=WIDTH)


def _document(annotations: list[dict[str, Any]], **image: Any) -> dict[str, Any]:
    return {
        "images": [{"id": 1, "file_name": "a.png", "width": WIDTH, "height": HEIGHT, **image}],
        "annotations": [{"id": i, "image_id": 1, **row} for i, row in enumerate(annotations, 1)],
        "categories": [{"id": 3, "name": "road"}, {"id": 90, "name": "car"}],
    }


def _write(src: Path, document: dict[str, Any]) -> Path:
    target = src / "annotations" / "instances_train.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document), encoding="utf-8")
    return src


def _rle(mask: MaskGeometry, *, compressed: bool = True) -> dict[str, Any]:
    counts: str | list[int] = mask.counts if compressed else list(mask_runs(mask))
    return {"size": list(mask.size), "counts": counts}


def _labels(src: Path) -> list[tuple[str, Any]]:
    dataset = CocoImporter().read(src)
    return [
        (label.class_name, label.geometry) for image in dataset.images for label in image.labels
    ]


@pytest.mark.parametrize("compressed", [True, False])
def test_an_rle_mask_reads_pixel_for_pixel(tmp_path: Path, compressed: bool) -> None:
    row = {"category_id": 3, "segmentation": _rle(HOLED, compressed=compressed), "iscrowd": 0}
    src = _write(tmp_path, _document([row]))
    dataset = CocoImporter().read(src)

    assert dataset.losses == ()
    assert _labels(src) == [("road", HOLED)]
    assert {one.name: one.geometries for one in dataset.classes}["road"] == (GeometryType.MASK,)


def test_an_uncompressed_run_list_may_start_with_foreground_and_carry_zero_runs(
    tmp_path: Path,
) -> None:
    expected = list(mask_runs(CORNER))
    assert expected[0] == 0
    spelled = [0, expected[1], 0, 0, *expected[2:]]
    row = {"category_id": 3, "segmentation": {"size": [HEIGHT, WIDTH], "counts": spelled}}

    assert _labels(_write(tmp_path, _document([row]))) == [("road", CORNER)]


def test_a_crowd_rle_is_a_mask_and_the_flag_is_an_attribute_loss(tmp_path: Path) -> None:
    rows = [
        {"category_id": 90, "segmentation": _rle(HOLED, compressed=False), "iscrowd": 1},
        {"category_id": 90, "segmentation": [[1, 1, 9, 1, 1, 9]], "iscrowd": 1},
    ]
    dataset = CocoImporter().read(_write(tmp_path, _document(rows)))

    (image,) = dataset.images
    assert [label.geometry for label in image.labels] == [
        HOLED,
        PolygonGeometry(points=[(1, 1), (9, 1), (1, 9)]),
    ]
    assert [(one.kind, one.subject, one.count) for one in dataset.losses] == [
        (ImportLossKind.ATTRIBUTE, "car", 2)
    ]
    assert "iscrowd" in dataset.losses[0].reason


def test_parts_are_unioned_not_cut_into_holes(tmp_path: Path) -> None:
    outer = [4, 4, 30, 4, 30, 30, 4, 30]
    inner = [10, 10, 20, 10, 20, 20, 10, 20]
    apart = [40, 30, 60, 30, 60, 44]
    row = {"category_id": 3, "segmentation": [outer, inner, apart], "bbox": [0, 0, 1, 1]}
    dataset = CocoImporter().read(_write(tmp_path, _document([row])))

    parts = [list(zip(ring[::2], ring[1::2], strict=True)) for ring in (outer, inner, apart)]
    expected = mask_union(
        [
            rasterize_rings([[(float(x), float(y)) for x, y in part]], height=HEIGHT, width=WIDTH)
            for part in parts
        ],
        height=HEIGHT,
        width=WIDTH,
    )
    ((label,),) = [image.labels for image in dataset.images]
    assert label.geometry == expected
    bitmap = mask_bitmap(expected)
    assert bitmap[15 * HEIGHT + 15] == 1
    assert [(one.kind, one.subject, one.count) for one in dataset.losses] == [
        (ImportLossKind.GEOMETRY, "road", 1)
    ]
    assert "several rings" in dataset.losses[0].reason


@pytest.mark.parametrize(
    ("segmentation", "image", "reason"),
    [
        ({"size": [WIDTH, HEIGHT], "counts": "PP"}, {}, "size is not its image's"),
        ({"size": [HEIGHT, WIDTH], "counts": "zz"}, {}, "malformed"),
        ({"size": [HEIGHT, WIDTH], "counts": [1, 2, 3]}, {}, "malformed"),
        ({"size": [HEIGHT, WIDTH], "counts": [3.0, WIDTH * HEIGHT - 3]}, {}, "malformed"),
        ({"size": [HEIGHT, WIDTH], "counts": 7}, {}, "malformed"),
        ({"size": [True, WIDTH], "counts": "PP"}, {}, "malformed"),
        ([[0, 0, 9, 0, 0, 9], [1, 1, 2, 2, 3, 3]], {"width": None}, "width and height"),
        ([[0, 0, 9, 0, 0, 9], [1, "x", 2, 2, 3, 3]], {}, "malformed"),
        ([[0.2, 0.2, 0.4, 0.2, 0.2, 0.4], [3, 3, 3.1, 3, 3, 3.1]], {}, "no pixel centre"),
        ([[0, 0, 4, 4, 8, 8], [1, 1]], {}, "encloses no area"),
    ],
)
def test_a_mask_that_cannot_be_read_loses_its_label(
    tmp_path: Path, segmentation: Any, image: dict[str, Any], reason: str
) -> None:
    document = _document([{"category_id": 3, "segmentation": segmentation}], **image)
    if image.get("width", WIDTH) is None:
        del document["images"][0]["width"]
    dataset = CocoImporter().read(_write(tmp_path, document))

    assert _labels(tmp_path) == []
    ((kind, subject, count, why),) = [
        (one.kind, one.subject, one.count, one.reason) for one in dataset.losses
    ]
    assert (kind, subject, count) == (ImportLossKind.LABEL, "road", 1)
    assert reason in why


def test_a_mask_of_the_wrong_size_for_an_unsized_entry_is_dropped_before_commit(
    tmp_path: Path,
) -> None:
    src = tmp_path / "src"
    write_image(src / "images" / "a.png", size=(WIDTH, HEIGHT))
    small = rasterize_rings([[(0.0, 0.0), (4.0, 0.0), (0.0, 4.0)]], height=8, width=8)
    document = _document(
        [
            {"category_id": 3, "segmentation": _rle(small)},
            {"category_id": 3, "segmentation": _rle(CORNER)},
        ]
    )
    del document["images"][0]["width"], document["images"][0]["height"]
    _write(src, document)
    workspace = WorkspaceService.init(tmp_path / "ws")
    project = ProjectService(workspace).create("p")
    imports = ImportService(workspace)

    plan = imports.inspect(project.id, CocoImporter(), src)
    run = imports.commit(
        project.id,
        CocoImporter(),
        src,
        consent=ImportConsent(kinds=frozenset({ImportLossKind.LABEL})),
    )
    workspace.close()

    assert [(one.kind, one.subject, one.count) for one in plan.losses] == [
        (ImportLossKind.LABEL, "road", 1)
    ]
    assert run.annotations_written == 1


# --- export and the round trip -------------------------------------------------------


def _mask(name: str, geometry: MaskGeometry) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=name,
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


def _content(workspace: WorkspaceService, project_id: Any) -> dict[str, list[tuple[str, str]]]:
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: sorted(
                (label.label_class, label.geometry.model_dump_json())
                for label in uow.annotations.list(asset.id)
            )
            for asset in uow.assets.list(project_id)
        }


@pytest.fixture
def exported(tmp_path: Path) -> tuple[Path, dict[str, list[tuple[str, str]]]]:
    fixture = Fixture(tmp_path / "origin", classes=(*CLASSES[:2], ROAD, CROWD))
    fixture.label(
        {
            0: [_mask("road", HOLED), _mask("crowd", CORNER), _box(x=8, y=6, width=20, height=22)],
            1: [_mask("road", CORNER), _mask("road", HOLED)],
        }
    )
    dest = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), CocoExporter(), dest)
    original = _content(fixture.workspace, fixture.project.id)
    fixture.close()
    return dest, original


def test_a_mask_is_written_as_compressed_rle_with_its_own_box_and_area(
    exported: tuple[Path, Any],
) -> None:
    dest, _ = exported
    document = json.loads((dest / ANNOTATIONS_DIRNAME / "instances_train.json").read_text())
    rows = [row for row in document["annotations"] if isinstance(row["segmentation"], dict)]

    assert len(rows) == 4
    holed = next(row for row in rows if row["segmentation"]["counts"] == HOLED.counts)
    assert holed["segmentation"] == {"size": [HEIGHT, WIDTH], "counts": HOLED.counts}
    assert holed["bbox"] == [4.0, 4.0, 56.0, 40.0]
    assert holed["area"] == float(sum(mask_bitmap(HOLED)))
    assert {row["iscrowd"] for row in rows} == {0}


def test_masks_round_trip_pixel_for_pixel_with_no_loss(
    tmp_path: Path, exported: tuple[Path, dict[str, list[tuple[str, str]]]]
) -> None:
    dest, original = exported
    workspace = WorkspaceService.init(tmp_path / "copy")
    project = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)

    plan = imports.inspect(project.id, CocoImporter(), dest)
    run = imports.commit(project.id, CocoImporter(), dest, consent=ImportConsent())
    copied = _content(workspace, project.id)
    workspace.close()

    assert plan.losses == ()
    assert run.losses == ()
    assert copied == original
    assert sum(1 for labels in copied.values() if not labels) == 1


def test_a_mask_not_the_size_of_its_picture_refuses_the_export() -> None:
    annotation = ManifestAnnotation(
        id=uuid4(), label_class="road", schema_version=1, geometry=CORNER, provenance="human"
    )
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="0" * 64,
        uri="/a.png",
        width=HEIGHT,
        height=WIDTH,
        annotations=(annotation,),
    )

    with pytest.raises(ExportSourceUnreadable, match="not the size of its picture"):
        _annotation(annotation, {"road": 1}, asset)
