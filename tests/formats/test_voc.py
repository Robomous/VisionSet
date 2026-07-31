"""The VOC exporter, against a release built the way a project builds one.

Golden-file, for the reason its two siblings give. There is no third-party reader
smoke test here and that is deliberate: unlike ``ultralytics`` and
``pycocotools``, VOC has no reference loader worth pinning a CI job to — the
devkit is MATLAB, and every Python consumer parses the XML itself. So the
document *is* the contract, and it is asserted as text.

The fixture comes from ``test_yolo`` — the three formats want exactly the same
release, and this file runs in the ordinary environment where that import works.
"""

from __future__ import annotations

import xml.etree.ElementTree as ElementTree
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from tests.formats.test_yolo import Fixture, _box

from visionset.formats.voc import (
    ANNOTATIONS_DIRNAME,
    IMAGE_SETS_DIRNAME,
    IMAGE_SETS_TASK,
    IMAGES_DIRNAME,
    VocExporter,
)
from visionset.kernel import ExportSourceUnreadable, LossyExportNotConsented
from visionset.kernel.domain import (
    Annotation,
    ClassificationGeometry,
    PolygonGeometry,
    SplitRecipe,
)


def _polygon() -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="lane",
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


def _export(fixture: Fixture, release_id: UUID, dest: Path, *, allow_lossy: bool = True) -> Path:
    fixture.releases.export(release_id, VocExporter(), dest, allow_lossy=allow_lossy)
    return dest


def _documents(root: Path) -> list[ElementTree.Element]:
    return [
        ElementTree.parse(path).getroot() for path in sorted((root / ANNOTATIONS_DIRNAME).iterdir())
    ]


def _boxes(document: ElementTree.Element) -> list[tuple[str, tuple[int, ...]]]:
    found = []
    for element in document.findall("object"):
        name = element.findtext("name")
        bounds = element.find("bndbox")
        assert name is not None and bounds is not None
        found.append(
            (
                name,
                tuple(
                    int(bounds.findtext(edge) or "") for edge in ("xmin", "ymin", "xmax", "ymax")
                ),
            )
        )
    return found


def _sets(root: Path, fold: str) -> list[str]:
    return (
        (root / IMAGE_SETS_DIRNAME / IMAGE_SETS_TASK / f"{fold}.txt")
        .read_text(encoding="utf-8")
        .split()
    )


# --- the document -------------------------------------------------------------


def test_one_xml_per_image_beside_one_flat_image_directory(tmp_path: Path) -> None:
    """VOC splits by *listing*, not by layout, so every image is in one directory.

    Two assets in different folds living in different directories would make every
    path in `ImageSets/Main/*.txt` wrong — those files name stems, and a reader
    resolves each against the one `JPEGImages`.
    """
    fixture = Fixture(tmp_path, images=4)
    fixture.label({})
    out = _export(
        fixture,
        fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=3)),
        tmp_path / "out",
    )
    fixture.close()

    stems = {path.stem for path in (out / IMAGES_DIRNAME).iterdir()}
    assert len(stems) == 4
    assert {path.stem for path in (out / ANNOTATIONS_DIRNAME).iterdir()} == stems
    # …and every stem named in a fold's listing is one of them.
    listed = [stem for fold in ("train", "val", "test") for stem in _sets(out, fold)]
    assert sorted(listed) == sorted(stems)


def test_the_size_block_is_the_recorded_pixels_and_a_declared_depth(tmp_path: Path) -> None:
    """`depth` is a constant, not a measurement — VisionSet records no channel count."""
    fixture = Fixture(tmp_path, images=1)
    fixture.label({})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (document,) = _documents(out)
    size = document.find("size")
    assert size is not None
    assert (size.findtext("width"), size.findtext("height"), size.findtext("depth")) == (
        "64",
        "48",
        "3",
    )
    assert document.findtext("segmented") == "0"
    assert document.findtext("folder") == IMAGES_DIRNAME


def test_the_path_is_relative_because_an_absolute_one_names_nobody_s_machine(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, images=1)
    fixture.label({})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (document,) = _documents(out)
    path = document.findtext("path")
    assert path is not None
    assert not Path(path).is_absolute()
    assert path == f"{IMAGES_DIRNAME}/{document.findtext('filename')}"


def test_the_source_block_names_the_release(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=1)
    fixture.label({})
    out = _export(fixture, fixture.publish("v2.1"), tmp_path / "out")
    fixture.close()

    (document,) = _documents(out)
    source = document.find("source")
    assert source is not None
    assert source.findtext("database") == "VisionSet release v2.1"


# --- the coordinates ----------------------------------------------------------


def test_a_box_is_written_one_based_and_inclusive(tmp_path: Path) -> None:
    """The conversion that is invisible when it is wrong.

    `x=8, width=16` covers 0-based pixels 8..23. VOC indexes from 1 and its
    `xmax` is inclusive, so that is `xmin=9, xmax=24` — sixteen pixels, counted
    the way the format counts them. Writing 8 and 24 would be off by one against
    every consumer that assumes the devkit, and detectron2's VOC loader subtracts
    one with a comment saying so.
    """
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (document,) = _documents(out)
    assert _boxes(document) == [("sign", (9, 13, 24, 36))]


def test_a_fractional_box_is_rounded_outwards_so_no_pixel_is_lost(
    tmp_path: Path,
) -> None:
    """Rounding to nearest would shrink a box by up to a pixel on each side.

    That matters most for the small objects a detector is already worst at.
    """
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_box(x=8.6, y=12.2, width=4.1, height=4.9)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    # 0-based the box spans x in [8.6, 12.7) and y in [12.2, 17.1): floor the near
    # edge, ceil the far one, then shift to 1-based.
    (document,) = _documents(out)
    assert _boxes(document) == [("sign", (9, 13, 13, 18))]


def test_a_box_hanging_off_the_edge_is_clamped_into_the_image(tmp_path: Path) -> None:
    """A VOC reader given `xmax` beyond `width` crops or crashes; neither is what was drawn."""
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_box(x=-10, y=-10, width=200, height=200)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (document,) = _documents(out)
    assert _boxes(document) == [("sign", (1, 1, 64, 48))]


def test_a_box_that_rounds_away_still_leaves_xmax_at_or_above_xmin(
    tmp_path: Path,
) -> None:
    """An inverted box gives a reader a negative area and unpredictable behaviour."""
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_box(x=63.9, y=47.9, width=0.05, height=0.05)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (document,) = _documents(out)
    ((_, (xmin, ymin, xmax, ymax)),) = _boxes(document)
    assert xmax >= xmin and ymax >= ymin


def test_every_object_carries_the_children_the_devkit_parser_requires(
    tmp_path: Path,
) -> None:
    """`difficult` matters more than it looks.

    VOC's evaluation *excludes* objects marked `1` from both the ground truth and
    the false positives, so writing one anywhere silently changes what a score
    means.
    """
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (document,) = _documents(out)
    (element,) = document.findall("object")
    assert element.findtext("pose") == "Unspecified"
    assert element.findtext("truncated") == "0"
    assert element.findtext("difficult") == "0"


# --- geometry that is not a box -----------------------------------------------


def test_a_polygon_is_written_as_its_bounding_box(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_polygon()]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (document,) = _documents(out)
    # x in [8, 24], y in [12, 36], then 1-based inclusive.
    assert _boxes(document) == [("lane", (9, 13, 24, 36))]


def test_a_classification_tag_produces_no_object_at_all(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_tag()]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    (document,) = _documents(out)
    assert document.findall("object") == []


def test_an_image_with_nothing_on_it_still_gets_its_document(tmp_path: Path) -> None:
    """A VOC reader iterates `ImageSets`, so a missing XML is a crash, not an empty image."""
    fixture = Fixture(tmp_path, images=2)
    fixture.label({0: [_box(x=1, y=1, width=4, height=4)]})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    documents = _documents(out)
    assert len(documents) == 2
    assert sorted(len(document.findall("object")) for document in documents) == [0, 1]


# --- consent and refusals -----------------------------------------------------


def test_the_format_asks_for_consent_because_it_is_lossy(tmp_path: Path) -> None:
    """A VOC `<object>` has nowhere to put an attribute, a confidence or a provenance."""
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_box(x=1, y=1, width=4, height=4)]})
    release_id = fixture.publish()

    with pytest.raises(LossyExportNotConsented):
        fixture.releases.export(release_id, VocExporter(), tmp_path / "out")

    assert not (tmp_path / "out").exists()
    fixture.close()


def test_the_report_names_the_classes_a_polygon_will_be_flattened_from(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, images=2)
    fixture.label({0: [_box(x=1, y=1, width=4, height=4)], 1: [_polygon()]})
    result = fixture.releases.export(
        fixture.publish(), VocExporter(), tmp_path / "out", allow_lossy=True
    )
    fixture.close()

    assert [one.label_class for one in result.compatibility.excluded] == ["lane"]


def test_a_missing_blob_aborts_rather_than_writing_a_dataset_that_is_short(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, images=1)
    fixture.label({})
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    digest = manifest.assets[0].content_hash
    (fixture.root / "blobs" / digest[:2] / digest[2:4] / digest).unlink()

    with pytest.raises(ExportSourceUnreadable, match=str(manifest.assets[0].asset_id)):
        fixture.releases.export(release_id, VocExporter(), tmp_path / "out", allow_lossy=True)
    fixture.close()


# --- splits and repeatability -------------------------------------------------


def test_the_listings_are_the_release_s_own_folds(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=6)
    fixture.label({})
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7))
    manifest = fixture.releases.manifest(release_id)
    assignment = fixture.releases.assignment(release_id)
    out = _export(fixture, release_id, tmp_path / "out")
    fixture.close()

    hash_of = {asset.asset_id: asset.content_hash for asset in manifest.assets}
    for fold, members in (
        ("train", assignment.train),
        ("val", assignment.val),
        ("test", assignment.test),
    ):
        assert _sets(out, fold) == sorted(hash_of[asset_id] for asset_id in members), fold


def test_a_release_with_no_recipe_writes_one_listing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=2)
    fixture.label({})
    out = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    listings = sorted(path.name for path in (out / IMAGE_SETS_DIRNAME / IMAGE_SETS_TASK).iterdir())
    assert listings == ["train.txt"]


def test_exporting_the_same_release_twice_writes_the_same_bytes(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=4)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)], 1: [_polygon()]})
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=3))

    first = _export(fixture, release_id, tmp_path / "first")
    second = _export(fixture, release_id, tmp_path / "second")
    fixture.close()

    for path in sorted((first / ANNOTATIONS_DIRNAME).iterdir()):
        assert path.read_bytes() == (second / ANNOTATIONS_DIRNAME / path.name).read_bytes()
    for fold in ("train", "val", "test"):
        assert _sets(first, fold) == _sets(second, fold)
