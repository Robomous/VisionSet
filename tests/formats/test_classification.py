"""The image-classification exporter: one CSV row per (image, tag).

Driven through the real services like every other format test — the class order
and the split are properties of what the kernel froze, and a hand-built
``Manifest`` would let this file agree with itself about something the rest of the
system does differently.

Every count here is read back out of the written artifact. Nothing asserts "the
exporter was called"; it asserts "the CSV holds these rows and every path in it
names a file that exists".
"""

from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from tests.formats.test_yolo import Fixture, _box

from visionset.formats._layout import IMAGES_DIRNAME
from visionset.formats.classification import (
    CLASSES_FILENAME,
    HEADER,
    LABELS_FILENAME,
    ClassificationExporter,
)
from visionset.kernel.domain import (
    Annotation,
    ClassificationGeometry,
    GeometryType,
    LabelClass,
    SplitRecipe,
)
from visionset.kernel.errors import ExportSourceUnreadable

#: Four classes in authored order, and three of them are tags.
#:
#: ``unused`` is never labelled, which is what proves the vocabulary comes from
#: the frozen schema rather than from the annotations present. ``sign`` is a box,
#: so it must appear in no row and in no vocabulary line.
CLASSES = (
    LabelClass(name="weather", geometries=(GeometryType.CLASSIFICATION_TAG,)),
    LabelClass(name="night", geometries=(GeometryType.CLASSIFICATION_TAG,)),
    LabelClass(name="sign", geometries=(GeometryType.BBOX,)),
    LabelClass(name="unused", geometries=(GeometryType.CLASSIFICATION_TAG,)),
)


def _tag(label_class: str) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=ClassificationGeometry(),
        provenance="human",
    )


#: One image with two tags, one with a single tag, one carrying only a box.
DRAWING: dict[int, list[Annotation]] = {
    0: [_tag("weather"), _tag("night")],
    1: [_tag("weather")],
    2: [_box(x=1, y=1, width=8, height=8)],
}


@pytest.fixture
def tagged(tmp_path: Path) -> Fixture:
    fixture = Fixture(tmp_path, classes=CLASSES)
    fixture.label(DRAWING)
    return fixture


def _export(fixture: Fixture, release_id: UUID, dest: Path) -> Path:
    fixture.releases.export(release_id, ClassificationExporter(), dest, allow_lossy=True)
    return dest


def _rows(dest: Path) -> list[dict[str, str]]:
    with (dest / LABELS_FILENAME).open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def test_an_image_with_two_tags_produces_two_rows(tmp_path: Path, tagged: Fixture) -> None:
    """The rule the whole format exists for, counted off the artifact.

    Three annotations that are tags become three rows over two images, and the
    image carrying two of them appears twice under one path — which is what
    "one entry per (image, tag)" means and what a per-image emitter would get
    wrong while still writing a plausible file.
    """
    dest = _export(tagged, tagged.publish(), tmp_path / "out")
    rows = _rows(dest)
    tagged.close()

    assert Counter(row["class"] for row in rows) == Counter({"weather": 2, "night": 1})
    assert sorted(Counter(row["image"] for row in rows).values()) == [1, 2]


def test_the_header_is_the_three_columns_a_reader_indexes(tmp_path: Path, tagged: Fixture) -> None:
    dest = _export(tagged, tagged.publish(), tmp_path / "out")
    first = (dest / LABELS_FILENAME).read_text(encoding="utf-8").splitlines()[0]
    tagged.close()

    assert first == ",".join(HEADER)


def test_a_box_contributes_no_row_and_its_image_is_still_written(
    tmp_path: Path, tagged: Fixture
) -> None:
    """Dropped means absent from the labels, never absent from the dataset.

    The third asset carries only a box. A classification format has nowhere to
    put it, so it earns no row — but the picture is part of the release and is
    written, because an export silently short of an image is the failure the
    layout helpers were built to prevent.
    """
    dest = _export(tagged, tagged.publish(), tmp_path / "out")
    rows = _rows(dest)
    written = sorted(path.name for path in (dest / IMAGES_DIRNAME).rglob("*.png"))
    tagged.close()

    assert "sign" not in {row["class"] for row in rows}
    assert len(written) == 3


def test_the_vocabulary_is_the_frozen_schema_order_including_a_class_nobody_used(
    tmp_path: Path, tagged: Fixture
) -> None:
    """Authored order, tags only, and a class with zero examples still listed.

    Sorting would pass here by accident, which is why the schema order is
    deliberately not alphabetical. ``sign`` is excluded because it is not a tag
    class, and ``unused`` is included because the label space is the schema's
    answer rather than the data's.
    """
    dest = _export(tagged, tagged.publish(), tmp_path / "out")
    vocabulary = (dest / CLASSES_FILENAME).read_text(encoding="utf-8").splitlines()
    tagged.close()

    assert vocabulary == ["weather", "night", "unused"]


def test_every_row_points_at_a_file_that_exists_under_its_own_fold(
    tmp_path: Path, tagged: Fixture
) -> None:
    """The two columns that can disagree, checked against the tree.

    ``image`` is relative to ``dest`` so the directory is movable to a training
    machine, and ``fold`` is redundant with the path on purpose — it saves a
    consumer parsing one. Redundant fields are worth having only while something
    proves they agree.
    """
    dest = _export(tagged, tagged.publish(), tmp_path / "out")
    rows = _rows(dest)
    tagged.close()

    for row in rows:
        assert (dest / row["image"]).is_file()
        assert row["image"].startswith(f"{IMAGES_DIRNAME}/{row['fold']}/")


def test_a_recipe_spreads_the_images_over_folds_and_the_rows_follow(
    tmp_path: Path, tagged: Fixture
) -> None:
    """The split is the release's, computed the way the API computes it.

    Which asset lands where is `assign_split`'s answer and not this test's, so
    what is asserted is the property: more than one fold is used, every picture
    is still present exactly once, and no row names a fold its image is not in.
    """
    release_id = tagged.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7))
    dest = _export(tagged, release_id, tmp_path / "out")
    rows = _rows(dest)
    folds = sorted(path.name for path in (dest / IMAGES_DIRNAME).iterdir() if path.is_dir())
    images = list((dest / IMAGES_DIRNAME).rglob("*.png"))
    tagged.close()

    assert len(folds) >= 2
    assert len(images) == 3
    for row in rows:
        assert (dest / row["image"]).is_file()


def test_a_class_name_holding_a_comma_survives_the_file(tmp_path: Path) -> None:
    """The reason this is written with ``csv`` and not with an f-string.

    A class name is normalized but not otherwise restricted — internal
    punctuation is left exactly as typed — so a comma in one shifts every later
    column of a hand-joined row, and the file still parses. It is the quiet kind
    of corruption: nothing raises, and a trainer reads the wrong label.
    """
    fixture = Fixture(
        tmp_path,
        classes=(LabelClass(name="rain, heavy", geometries=(GeometryType.CLASSIFICATION_TAG,)),),
    )
    fixture.label({0: [_tag("rain, heavy")]})
    dest = _export(fixture, fixture.publish(), tmp_path / "out")
    rows = _rows(dest)
    fixture.close()

    assert [row["class"] for row in rows] == ["rain, heavy"]


def test_a_class_name_holding_a_newline_is_refused(tmp_path: Path) -> None:
    """The sibling of the comma test: carried where it parses, refused where it forks.

    A comma survives ``labels.csv`` intact because that file is written through
    the ``csv`` module. ``classes.txt`` has no such module — it is one class per
    line with no escaping — so a class name holding a newline would silently
    fork into two vocabulary entries there while staying one entry in the CSV.
    The two files would disagree about the label space, so this is refused by
    name instead of being written.
    """
    fixture = Fixture(
        tmp_path,
        classes=(LabelClass(name="rain\nheavy", geometries=(GeometryType.CLASSIFICATION_TAG,)),),
    )
    fixture.label({0: [_tag("rain\nheavy")]})

    with pytest.raises(ExportSourceUnreadable):
        _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()


def test_an_undeclared_manifest_class_aborts_before_a_label_row_is_emitted(tmp_path: Path) -> None:
    """Archived or externally supplied manifests bypass the publication consistency gate."""
    fixture = Fixture(tmp_path, classes=CLASSES)
    fixture.label(DRAWING)
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    first = next(asset for asset in manifest.assets if asset.annotations)
    malformed = manifest.model_copy(
        update={
            "assets": (
                first.model_copy(
                    update={
                        "annotations": (
                            first.annotations[0].model_copy(update={"label_class": "undeclared"}),
                        )
                    }
                ),
                *manifest.assets[1:],
            )
        }
    )
    dest = tmp_path / "out"

    with pytest.raises(ExportSourceUnreadable, match="undeclared"):
        ClassificationExporter().export(
            fixture.releases.get(release_id),
            malformed,
            dest,
            content=fixture.workspace.blob_store.get,
        )
    fixture.close()

    assert not (dest / LABELS_FILENAME).exists()
    assert not (dest / CLASSES_FILENAME).exists()


def test_the_plugin_declares_tags_supported_and_reduces_nothing() -> None:
    """The capability facts the compatibility report is computed against."""
    plugin = ClassificationExporter()

    assert plugin.format_name == "classification"
    assert plugin.lossy is True
    assert plugin.supported_geometries == frozenset({GeometryType.CLASSIFICATION_TAG})
    assert plugin.degraded_geometries == frozenset()
    assert plugin.supported_modalities == frozenset({"image"})
