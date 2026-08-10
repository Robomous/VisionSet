"""The COCO exporter, against a release built the way a project builds one.

Golden-file, for the reason ``test_yolo.py`` gives: the deliverable of a format
plugin is a document somebody else's tool reads, so what is worth pinning is the
bytes. The workspace is built through the real services, because the category
order, the split and the manifest hash in `info` are all properties of what the
kernel froze.

The fixture is imported from ``test_yolo`` rather than duplicated — the two
formats want exactly the same release, and this file runs in the ordinary
environment where that import works. (The *smoke* tests cannot, because the
``ultralytics`` wheel shadows this repository's ``tests`` package; see
``test_yolo_smoke.py``.)
"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from tests.formats.test_yolo import CLASSES, Fixture, _box

from visionset.formats.coco import ANNOTATIONS_DIRNAME, CocoExporter
from visionset.kernel import ExportSourceUnreadable, LossyExportNotConsented
from visionset.kernel.domain import (
    Annotation,
    ClassificationGeometry,
    PolygonGeometry,
    SplitRecipe,
)


def _polygon(label_class: str = "lane") -> Annotation:
    """A right triangle: 16 wide, 24 tall, so its area is unmistakably not 384."""
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (8.0, 36.0)]),
        provenance="human",
    )


def _tag() -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="weather",
        schema_version=1,
        geometry=ClassificationGeometry(),
        provenance="human",
    )


def _export(fixture: Fixture, release_id: UUID, dest: Path, *, allow_lossy: bool = False) -> Path:
    fixture.releases.export(release_id, CocoExporter(), dest, allow_lossy=allow_lossy)
    return dest


def _instances(root: Path, fold: str = "train") -> dict:
    return json.loads(
        (root / ANNOTATIONS_DIRNAME / f"instances_{fold}.json").read_text(encoding="utf-8")
    )


# --- the shape of the document ------------------------------------------------


def test_categories_are_the_frozen_schema_one_based_and_in_authored_order(
    tmp_path: Path,
) -> None:
    """v1 sorted the names it found in the annotations; this is the release's own order.

    1-based because that is COCO's convention rather than ours: id 0 is
    conventionally background, and `pycocotools` treats a missing category id as
    an error rather than as a default.
    """
    fixture = Fixture(tmp_path)
    fixture.label({})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    assert _instances(out)["categories"] == [
        {"id": 1, "name": "sign", "supercategory": "sign"},
        {"id": 2, "name": "lane", "supercategory": "lane"},
        {"id": 3, "name": "weather", "supercategory": "weather"},
    ]


def test_a_class_nobody_used_is_still_a_category(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    document = _instances(out)
    assert [category["name"] for category in document["categories"]] == [
        declared.name for declared in CLASSES
    ]
    assert {row["category_id"] for row in document["annotations"]} == {1}


def test_the_info_block_names_the_release_it_was_cut_from(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.label({})
    release_id = fixture.publish()
    release = fixture.releases.get(release_id)
    out = _export(fixture, release_id, tmp_path / "out")
    fixture.close()

    info = _instances(out)["info"]
    assert info["version"] == release.tag
    assert info["date_created"] == release.created_at.isoformat()
    assert info["visionset"] == {
        "release_id": str(release.id),
        # The important one: it names the exact frozen document, so an export can
        # be traced back to a release that can be re-verified.
        "manifest_hash": release.manifest_hash,
        "manifest_version": 1,
        "schema_version": 1,
    }


def test_the_licenses_block_says_what_is_known_rather_than_inventing_terms(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    fixture.label({})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    document = _instances(out)
    assert document["licenses"] == [{"id": 1, "name": "unspecified", "url": ""}]
    assert {image["license"] for image in document["images"]} == {1}


# --- geometry -----------------------------------------------------------------


def test_a_box_and_a_polygon_land_in_the_same_document(tmp_path: Path) -> None:
    """v1 needed two exporters and neither described a dataset holding both."""
    fixture = Fixture(tmp_path, images=2)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)], 1: [_polygon()]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    rows = _instances(out)["annotations"]
    assert len(rows) == 2
    assert {row["category_id"] for row in rows} == {1, 2}
    assert sum(1 for row in rows if row["segmentation"]) == 1


def test_a_polygons_area_is_its_own_and_not_its_bounding_box_s(tmp_path: Path) -> None:
    """The bug that silently corrupts every evaluation run against the file.

    `pycocotools` buckets detections into small/medium/large by `area`, so writing
    the bounding box's area — which v1 did — overstates a triangle by exactly two
    and reports a breakdown nobody can see is wrong.
    """
    fixture = Fixture(tmp_path)
    fixture.label({0: [_polygon()]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (row,) = _instances(out)["annotations"]
    assert row["bbox"] == [8.0, 12.0, 16.0, 24.0]
    # Half of 16 x 24, because it is a right triangle. v1 would have written 384.
    assert row["area"] == 192.0
    assert row["segmentation"] == [[8.0, 12.0, 24.0, 12.0, 8.0, 36.0]]


def test_a_box_gets_an_empty_segmentation_rather_than_its_own_rectangle(
    tmp_path: Path,
) -> None:
    """A box says where something is, not what shape it is.

    Writing the rectangle would claim the object fills its bounding box, which a
    mask consumer takes literally.
    """
    fixture = Fixture(tmp_path)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (row,) = _instances(out)["annotations"]
    assert row["segmentation"] == []
    assert row["area"] == 384.0
    assert row["iscrowd"] == 0


def test_everything_coco_has_no_field_for_rides_in_one_visionset_object(
    tmp_path: Path,
) -> None:
    """Which is what makes this format lossless, and the contrast with `yolo`.

    One nested object rather than four top-level keys, because a future COCO
    field could collide with any of them and cannot collide with this.
    """
    fixture = Fixture(tmp_path)
    labelled = _box(x=8, y=12, width=16, height=24).model_copy(
        update={"provenance": "model", "model_ref": "detector-v3", "confidence": 0.75}
    )
    fixture.label({0: [labelled]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (row,) = _instances(out)["annotations"]
    carried = row["visionset"]
    assert (carried["provenance"], carried["model_ref"], carried["confidence"]) == (
        "model",
        "detector-v3",
        0.75,
    )
    assert carried["schema_version"] == 1
    assert UUID(carried["annotation_id"])


# --- what it refuses ----------------------------------------------------------


def test_a_release_of_boxes_and_polygons_exports_with_no_consent_at_all(
    tmp_path: Path,
) -> None:
    """The point of having a second format: `coco` is not lossy."""
    fixture = Fixture(tmp_path, images=2)
    fixture.label({0: [_box(x=1, y=1, width=4, height=4)], 1: [_polygon()]})
    result = fixture.releases.export(
        fixture.publish(), CocoExporter(), tmp_path / "out", allow_lossy=False
    )
    fixture.close()

    assert result.compatibility.compatible
    assert result.compatibility.format_is_lossy is False


def test_a_classification_tag_makes_the_release_need_consent(tmp_path: Path) -> None:
    """COCO instances have nowhere to put a label that is about the whole image."""
    fixture = Fixture(tmp_path)
    fixture.label({0: [_tag()]})
    release_id = fixture.publish()

    with pytest.raises(LossyExportNotConsented) as refusal:
        fixture.releases.export(release_id, CocoExporter(), tmp_path / "out")

    carried = refusal.value.compatibility
    assert carried is not None
    excluded = [one.label_class for one in carried.excluded]  # type: ignore[attr-defined]
    assert excluded == ["weather"]
    assert not (tmp_path / "out").exists()
    fixture.close()


def test_under_consent_the_tag_is_dropped_and_the_report_enumerates_it(
    tmp_path: Path,
) -> None:
    """The excluded annotations are named."""
    fixture = Fixture(tmp_path, images=2)
    fixture.label({0: [_box(x=1, y=1, width=4, height=4)], 1: [_tag()]})
    out = _export(fixture, fixture.publish(), tmp_path / "out", allow_lossy=True)
    fixture.close()

    written = json.loads((out / "visionset-export-report.json").read_text(encoding="utf-8"))
    assert written["compatible"] is False
    assert written["excluded_annotations"] == 1
    (weather,) = [one for one in written["classes"] if one["status"] == "dropped"]
    assert (weather["label_class"], weather["annotations"], weather["assets"]) == (
        "weather",
        1,
        1,
    )
    # …and the tag is genuinely absent from the document rather than written with
    # an invented geometry.
    assert len(_instances(out)["annotations"]) == 1


def test_a_missing_blob_aborts_rather_than_writing_a_document_that_is_short(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    fixture.label({})
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    digest = manifest.assets[0].content_hash
    (fixture.root / "blobs" / digest[:2] / digest[2:4] / digest).unlink()

    with pytest.raises(ExportSourceUnreadable, match=str(manifest.assets[0].asset_id)):
        fixture.releases.export(release_id, CocoExporter(), tmp_path / "out")
    fixture.close()


# --- splits and the whole tree ------------------------------------------------


def test_there_is_one_instances_file_per_fold_and_the_images_match_it(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, images=6)
    fixture.label({})
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7))
    assignment = fixture.releases.assignment(release_id)
    out = _export(fixture, release_id, tmp_path / "out")
    fixture.close()

    for fold, members in (
        ("train", assignment.train),
        ("val", assignment.val),
        ("test", assignment.test),
    ):
        document = _instances(out, fold)
        assert len(document["images"]) == len(members), fold
        on_disk = {path.name for path in (out / "images" / fold).iterdir()}
        assert {image["file_name"] for image in document["images"]} == on_disk, fold


def test_ids_restart_at_one_in_every_fold_because_each_file_is_its_own_dataset(
    tmp_path: Path,
) -> None:
    """Deliberate, and worth pinning: `pycocotools` loads one file at a time.

    Ids continuing across folds would leave `instances_val.json` starting at some
    arbitrary number, which reads as a file with rows missing.
    """
    fixture = Fixture(tmp_path, images=6)
    fixture.label({})
    out = _export(
        fixture,
        fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7)),
        tmp_path / "out",
    )
    fixture.close()

    for fold in ("train", "val", "test"):
        identifiers = [image["id"] for image in _instances(out, fold)["images"]]
        assert identifiers == list(range(1, len(identifiers) + 1)), fold


def test_a_release_with_no_recipe_writes_exactly_one_instances_file(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    fixture.label({})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    assert sorted(path.name for path in (out / ANNOTATIONS_DIRNAME).iterdir()) == [
        "instances_train.json"
    ]


def test_exporting_the_same_release_twice_writes_the_same_bytes(tmp_path: Path) -> None:
    """Nothing in the document reads the clock — `date_created` is the release's."""
    fixture = Fixture(tmp_path, images=4)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)], 1: [_polygon()]})
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=3))

    first = _export(fixture, release_id, tmp_path / "first")
    second = _export(fixture, release_id, tmp_path / "second")
    fixture.close()

    for fold in ("train", "val", "test"):
        name = f"{ANNOTATIONS_DIRNAME}/instances_{fold}.json"
        assert (first / name).read_bytes() == (second / name).read_bytes(), fold
