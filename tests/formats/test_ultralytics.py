"""The ``ultralytics`` dialect, against a release built the way a project builds one.

Golden-file rather than assertion-by-field: the deliverable of a format plugin is
a directory somebody else's tool reads, so what is worth pinning is the bytes.
Every expectation here is written out in full and compared as a whole tree, which
is what makes a change to the layout, the class order or the arithmetic show up as
a diff rather than as one assertion quietly not running.

The workspace is built through the real services — schema, batch, job,
annotations, promote, publish — because the class order and the split are
properties of what the *kernel* froze, and a hand-built `Manifest` would let this
file agree with itself about something the rest of the system does differently.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from io import BytesIO
from pathlib import Path
from typing import BinaryIO
from uuid import UUID, uuid4

import pytest
from tests.fixtures.media import write_image

from visionset.formats.ultralytics import DATA_FILENAME, TARGETS, UltralyticsExporter
from visionset.kernel import ExportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    ClassificationGeometry,
    ExportTarget,
    GeometryType,
    LabelClass,
    PolygonGeometry,
    SplitRecipe,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    IngestService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    SourceService,
    WorkspaceService,
)

#: Two classes, and the second one is a polygon on purpose.
#:
#: The order is the *authored* schema order, not alphabetical, so a test that
#: happened to pass under sorting would fail here — which is the whole point of
#: The "classes come from the frozen schema" rule.
CLASSES = (
    LabelClass(name="sign", geometries=(GeometryType.BBOX,)),
    LabelClass(name="lane", geometries=(GeometryType.POLYGON,)),
    LabelClass(name="weather", geometries=(GeometryType.CLASSIFICATION_TAG,)),
)

IMAGE_SIZE = (64, 48)


class Fixture:
    """A project whose one batch can be labelled and promoted, then published."""

    def __init__(
        self,
        tmp_path: Path,
        *,
        images: int = 3,
        classes: Sequence[LabelClass] = CLASSES,
    ) -> None:
        self.root = tmp_path / "ws"
        self.workspace = WorkspaceService.init(self.root)
        self.projects = ProjectService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.sources = SourceService(self.workspace)
        self.ingest = IngestService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.datasets = DatasetService(self.workspace)
        self.releases = ReleaseService(self.workspace)

        self.project = self.projects.create("road-signs")
        self.schemas.create_version(self.project.id, list(classes))
        incoming = tmp_path / "incoming"
        incoming.mkdir()
        for index in range(images):
            write_image(incoming / f"still-{index}.png", size=IMAGE_SIZE, seed=index)
        source = self.sources.register_images(self.project.id, incoming)
        run = self.ingest.ingest(source.id, batch_name="first")
        assert run.failed == 0
        self.batch_id = run.batch_id
        assert self.batch_id is not None

    def label(self, drawing: dict[int, list[Annotation]]) -> None:
        """Open the batch, draw what the caller asked for, and close it."""
        self.batches.approve(self.batch_id)
        (job,) = self.batches.jobs(self.batch_id)
        self.batches.start(self.batch_id)
        self.jobs.start(job.id)
        assets = self.batches.assets(self.batch_id)
        for position, asset in enumerate(assets):
            written = [
                annotation.model_copy(update={"asset_id": asset.id})
                for annotation in drawing.get(position, [])
            ]
            if written:
                self.annotations.add(job.id, written)
            else:
                self.jobs.mark(job.id, asset.id, "annotated")
        self.jobs.complete(job.id)
        self.batches.complete(self.batch_id)
        self.datasets.promote(self.batch_id)

    def publish(self, tag: str = "v1", *, split: SplitRecipe | None = None) -> UUID:
        dataset_id = self.projects.get_dataset(self.project.id).id
        return self.releases.publish(dataset_id, tag, split=split).id

    def export(self, release_id: UUID, dest: Path, *, target: ExportTarget | None = None) -> Path:
        self.releases.export(
            release_id, UltralyticsExporter(), dest, allow_lossy=True, target=target
        )
        return dest

    def close(self) -> None:
        self.workspace.close()


def _box(**geometry: float) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="sign",
        schema_version=1,
        geometry=BboxGeometry(**geometry),
        provenance="human",
    )


def _tree(root: Path) -> dict[str, str]:
    """Every file under ``root`` that is text, keyed by its relative path.

    Images are excluded by suffix rather than by decoding: what a golden test can
    say about a copied blob is that it is byte-identical to the blob, which is
    asserted separately and directly.
    """
    return {
        str(path.relative_to(root)): path.read_text(encoding="utf-8")
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.suffix in {".txt", ".yaml", ".json"}
    }


# --- data.yaml ----------------------------------------------------------------


def test_the_class_index_is_the_schema_order_not_the_alphabet(tmp_path: Path) -> None:
    """v1 sorted the names it found; this is the release's own authored order."""
    fixture = Fixture(tmp_path)
    fixture.label({})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    assert (out / DATA_FILENAME).read_text(encoding="utf-8") == (
        "# Written by VisionSet. Class order is the release's frozen schema.\n"
        "path: .\n"
        "train: images/train\n"
        # No recipe means one undivided set, and `val` is required — so it names
        # the training images, which says "there is no held-out set" where an
        # omitted key would say "this file is malformed".
        "val: images/train\n"
        "names:\n"
        '  0: "sign"\n'
        '  1: "lane"\n'
        '  2: "weather"\n'
    )


def test_a_class_nobody_used_still_has_its_index(tmp_path: Path) -> None:
    """The reason the class index cannot drift.

    v1 built its map out of the annotations present, so drawing the first box of a
    new class *renumbered every other class* — and a model trained before that and
    evaluated after is wrong in a way nothing reports.
    """
    fixture = Fixture(tmp_path)
    fixture.label({0: [_box(x=1, y=2, width=10, height=8)]})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    written = (out / DATA_FILENAME).read_text(encoding="utf-8")
    assert "nc:" not in written
    assert '  1: "lane"' in written
    assert '  2: "weather"' in written


def test_a_class_name_that_would_break_yaml_is_quoted(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(
        fixture.project.id,
        [*CLASSES, LabelClass(name='odd: "name"', geometries=(GeometryType.BBOX,))],
    )
    fixture.label({})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    written = (out / DATA_FILENAME).read_text(encoding="utf-8")
    assert '  3: "odd: \\"name\\""' in written
    # Every scalar is a JSON string literal, which YAML 1.2 is a superset of, so
    # the file parses whatever a project called its classes.
    assert json.loads('"odd: \\"name\\""') == 'odd: "name"'


# --- the label files ----------------------------------------------------------


def test_a_box_is_written_as_its_centre_and_extent_over_the_image(tmp_path: Path) -> None:
    """The arithmetic, pinned exactly. 64x48, so the numbers are checkable by hand."""
    fixture = Fixture(tmp_path)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    release_id = fixture.publish()
    hashes = {asset.content_hash for asset in fixture.releases.manifest(release_id).assets}
    out = fixture.export(release_id, tmp_path / "out")
    fixture.close()

    labelled = [path for path in (out / "labels" / "train").iterdir() if path.read_text().strip()]
    assert len(labelled) == 1
    # centre (8 + 16/2)/64 = 0.25, (12 + 24/2)/48 = 0.5; extent 16/64, 24/48.
    assert labelled[0].read_text(encoding="utf-8") == "0 0.250000 0.500000 0.250000 0.500000\n"
    assert labelled[0].stem in hashes


def test_an_asset_with_nothing_on_it_gets_an_empty_file_not_no_file(tmp_path: Path) -> None:
    """Ultralytics reads a missing label file and an empty one as different things.

    Missing means "nobody looked"; empty means "somebody looked and there is
    nothing here", which is a training signal a detector needs.
    """
    fixture = Fixture(tmp_path, images=2)
    fixture.label({0: [_box(x=1, y=1, width=4, height=4)]})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    written = sorted((out / "labels" / "train").iterdir())
    assert len(written) == 2
    assert sorted(path.read_text(encoding="utf-8") for path in written) == [
        "",
        "0 0.046875 0.062500 0.062500 0.083333\n",
    ]


def test_a_polygon_selects_the_segment_layout_and_keeps_its_vertices(tmp_path: Path) -> None:
    """The task is derived: one polygon anywhere, and the whole export is a segment dataset.

    A box on the same release is then written as its four corners rather than
    as ``cx cy w h`` — the same rectangle, spelled the way a segment row is.
    """
    fixture = Fixture(tmp_path)
    lane = Annotation(
        asset_id=uuid4(),
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (16.0, 36.0)]),
        provenance="human",
    )
    fixture.label({0: [lane, _box(x=8, y=12, width=16, height=24)]})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    rows = [
        path.read_text(encoding="utf-8")
        for path in sorted((out / "labels" / "train").iterdir())
        if path.read_text(encoding="utf-8")
    ]
    (written,) = rows
    assert sorted(written.splitlines()) == [
        "0 0.125000 0.250000 0.375000 0.250000 0.375000 0.750000 0.125000 0.750000",
        "1 0.125000 0.250000 0.375000 0.250000 0.250000 0.750000",
    ]


def test_a_polygon_hanging_off_the_edge_is_clamped_vertex_by_vertex(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    lane = Annotation(
        asset_id=uuid4(),
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=[(-8.0, 12.0), (24.0, 12.0), (16.0, 60.0)]),
        provenance="human",
    )
    fixture.label({0: [lane]})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    rows = [
        path.read_text(encoding="utf-8")
        for path in sorted((out / "labels" / "train").iterdir())
        if path.read_text(encoding="utf-8")
    ]
    assert rows == ["1 0.000000 0.250000 0.375000 0.250000 0.250000 1.000000\n"]


def _tag() -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="weather",
        schema_version=1,
        geometry=ClassificationGeometry(),
        provenance="human",
    )


def test_a_tag_beside_a_box_produces_no_row_at_all(tmp_path: Path) -> None:
    """A detection dataset has nowhere to put a label with no location.

    Dropped rather than given an invented box covering the image, which would be
    a training target nobody drew. The box is what keeps this a detect export.
    """
    fixture = Fixture(tmp_path)
    fixture.label({0: [_tag()], 1: [_box(x=1, y=1, width=4, height=4)]})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    rows = [
        path.read_text(encoding="utf-8")
        for path in (out / "labels" / "train").iterdir()
        if path.read_text(encoding="utf-8")
    ]
    assert rows == ["0 0.046875 0.062500 0.062500 0.083333\n"]


def test_a_release_holding_only_tags_is_written_as_a_class_tree(tmp_path: Path) -> None:
    """The classify layout: ``<fold>/<class>/<image>``, no ``data.yaml``, no label files.

    Every tag-capable class gets a directory whether or not anything was tagged
    with it, so the class list a trainer reads off the tree is the schema's;
    a class that cannot carry a tag gets none. An image tagged twice is written
    once under each class.
    """
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(
        fixture.project.id,
        [*CLASSES, LabelClass(name="time-of-day", geometries=(GeometryType.CLASSIFICATION_TAG,))],
    )
    fixture.label(
        {0: [_tag(), _tag().model_copy(update={"label_class": "time-of-day"})], 1: [_tag()]}
    )
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    out = fixture.export(release_id, tmp_path / "out")
    fixture.close()

    assert not (out / DATA_FILENAME).exists()
    assert not (out / "labels").exists()
    assert sorted(path.name for path in (out / "train").iterdir()) == ["time-of-day", "weather"]
    tagged = {asset.content_hash for asset in manifest.assets if asset.annotations}
    assert {path.stem for path in (out / "train" / "weather").iterdir()} == tagged
    assert len(list((out / "train" / "time-of-day").iterdir())) == 1


def _target(name: str) -> ExportTarget:
    (found,) = (one for one in TARGETS if one.name == name)
    return found


def test_a_tags_only_release_addressed_to_a_detect_target_is_not_a_class_tree(
    tmp_path: Path,
) -> None:
    """The task follows the target, not the dialect.

    The dialect can lay out ``classify``, but ``yolov10`` has no such task and
    carries no tag, so the service hands the plugin a manifest with no tag in
    it and the export is the detect layout with nothing on its images.
    """
    fixture = Fixture(tmp_path)
    fixture.label({0: [_tag()], 1: [_tag()]})
    out = fixture.export(fixture.publish(), tmp_path / "out", target=_target("yolov10"))
    fixture.close()

    assert (out / DATA_FILENAME).exists()
    assert not (out / "train").exists()
    labels = sorted((out / "labels" / "train").iterdir())
    assert len(labels) == 3
    assert all(path.read_text(encoding="utf-8") == "" for path in labels)


def test_a_polygon_release_addressed_to_a_detect_target_is_written_as_detect(
    tmp_path: Path,
) -> None:
    """A polygon selects ``segment`` only when the target carries it; ``yolov10`` does not."""
    fixture = Fixture(tmp_path)
    lane = Annotation(
        asset_id=uuid4(),
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (16.0, 36.0)]),
        provenance="human",
    )
    fixture.label({0: [lane, _box(x=8, y=12, width=16, height=24)]})
    out = fixture.export(fixture.publish(), tmp_path / "out", target=_target("yolov10"))
    fixture.close()

    rows = [
        path.read_text(encoding="utf-8")
        for path in sorted((out / "labels" / "train").iterdir())
        if path.read_text(encoding="utf-8")
    ]
    (written,) = rows
    assert written.splitlines() == ["0 0.250000 0.500000 0.250000 0.500000"]


def test_a_polygon_release_addressed_to_a_segment_target_keeps_its_vertices(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    lane = Annotation(
        asset_id=uuid4(),
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (16.0, 36.0)]),
        provenance="human",
    )
    fixture.label({0: [lane]})
    out = fixture.export(fixture.publish(), tmp_path / "out", target=_target("yolov5"))
    fixture.close()

    rows = [
        path.read_text(encoding="utf-8")
        for path in sorted((out / "labels" / "train").iterdir())
        if path.read_text(encoding="utf-8")
    ]
    (written,) = rows
    assert written.splitlines() == ["1 0.125000 0.250000 0.375000 0.250000 0.250000 0.750000"]


def test_a_class_that_cannot_name_a_directory_is_refused_by_name(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(
        fixture.project.id,
        [*CLASSES, LabelClass(name="day/night", geometries=(GeometryType.CLASSIFICATION_TAG,))],
    )
    fixture.label({0: [_tag()]})
    release_id = fixture.publish()

    with pytest.raises(ExportSourceUnreadable, match="day/night"):
        fixture.export(release_id, tmp_path / "out")
    fixture.close()


def test_a_box_hanging_off_the_edge_is_clamped_into_the_image(tmp_path: Path) -> None:
    """The domain allows it; YOLO does not, and ultralytics refuses a file that breaks it."""
    fixture = Fixture(tmp_path)
    fixture.label({0: [_box(x=-10, y=-10, width=100, height=100)]})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    rows = [
        path.read_text(encoding="utf-8").strip()
        for path in (out / "labels" / "train").iterdir()
        if path.read_text(encoding="utf-8").strip()
    ]
    assert rows == ["0 0.500000 0.500000 1.000000 1.000000"]


# --- the images ---------------------------------------------------------------


def test_the_image_bytes_are_the_blob_bytes_under_the_hash_that_names_them(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    fixture.label({})
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    out = fixture.export(release_id, tmp_path / "out")

    for asset in manifest.assets:
        written = out / "images" / "train" / f"{asset.content_hash}.png"
        assert written.is_file()
        with fixture.workspace.blob_store.get(asset.content_hash) as stream:
            assert written.read_bytes() == stream.read()
    fixture.close()


def test_the_suffix_comes_from_the_bytes_and_not_from_the_uri(tmp_path: Path) -> None:
    """A frame's `uri` is `clip.mp4#frame=12`, which is not a filename at all."""
    fixture = Fixture(tmp_path)
    fixture.label({})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    assert {path.suffix for path in (out / "images" / "train").iterdir()} == {".png"}


def test_bytes_that_are_not_an_image_this_format_can_write_are_refused_by_name(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    fixture.label({})
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    fixture.close()

    def pretend(content_hash: str) -> BinaryIO:
        return BytesIO(b"not a picture at all")

    with pytest.raises(ExportSourceUnreadable, match=str(manifest.assets[0].asset_id)):
        UltralyticsExporter().export(
            _release_of(fixture, release_id), manifest, tmp_path / "out", content=pretend
        )


def test_a_missing_blob_aborts_rather_than_writing_a_dataset_that_is_short(
    tmp_path: Path,
) -> None:
    """v1 wrapped the read in `except Exception: pass`.

    The label file was written anyway, so a lost object produced a training set
    silently missing an image *and* carrying labels pointing at nothing.
    """
    fixture = Fixture(tmp_path)
    fixture.label({})
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    gone = fixture.workspace.blob_store
    path = _blob_path(fixture.root, manifest.assets[0].content_hash)
    path.unlink()
    del gone

    with pytest.raises(ExportSourceUnreadable, match=str(manifest.assets[0].asset_id)):
        fixture.releases.export(
            release_id, UltralyticsExporter(), tmp_path / "out", allow_lossy=True
        )
    fixture.close()


def test_an_undeclared_manifest_class_aborts_before_a_label_index_is_written(
    tmp_path: Path,
) -> None:
    """Archived or externally supplied manifests bypass the publication consistency gate."""
    fixture = Fixture(tmp_path)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
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
        UltralyticsExporter().export(
            fixture.releases.get(release_id),
            malformed,
            dest,
            content=fixture.workspace.blob_store.get,
        )
    fixture.close()

    assert not list((dest / "labels").rglob("*.txt"))
    assert not (dest / DATA_FILENAME).exists()


# --- splits -------------------------------------------------------------------


def test_a_release_with_no_recipe_is_one_undivided_training_set(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.label({})
    out = fixture.export(fixture.publish(), tmp_path / "out")
    fixture.close()

    assert sorted(path.name for path in (out / "images").iterdir()) == ["train"]
    # `val` is still declared, because ultralytics raises a SyntaxError naming the
    # missing key rather than defaulting — it just points at the same images.
    written = (out / DATA_FILENAME).read_text(encoding="utf-8")
    assert "val: images/train" in written
    assert "test:" not in written


def test_the_folds_are_the_release_s_own_and_agree_with_the_service(tmp_path: Path) -> None:
    """`assign_split` is pure, so the plugin computes the same folds the API reports.

    Worth asserting rather than assuming: an export whose split disagreed with
    `GET /releases/{id}/assignment` would make two answers to one question, and
    the one on disk is the one that gets trained on.
    """
    fixture = Fixture(tmp_path, images=6)
    fixture.label({})
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7))
    manifest = fixture.releases.manifest(release_id)
    assignment = fixture.releases.assignment(release_id)
    out = fixture.export(release_id, tmp_path / "out")
    fixture.close()

    hash_of = {asset.asset_id: asset.content_hash for asset in manifest.assets}
    for fold, members in (
        ("train", assignment.train),
        ("val", assignment.val),
        ("test", assignment.test),
    ):
        found = {path.stem for path in (out / "images" / fold).iterdir()}
        assert found == {hash_of[asset_id] for asset_id in members}, fold


def test_every_fold_a_release_has_is_named_in_data_yaml(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=6)
    fixture.label({})
    out = fixture.export(
        fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7)),
        tmp_path / "out",
    )
    fixture.close()

    written = (out / DATA_FILENAME).read_text(encoding="utf-8")
    for fold in ("train", "val", "test"):
        assert f"{fold}: images/{fold}" in written
    assert "path: .\n" in written


# --- the whole tree -----------------------------------------------------------


def test_a_known_release_produces_exactly_these_files(tmp_path: Path) -> None:
    """The golden file. One image, one box, no recipe — the smallest real export."""
    fixture = Fixture(tmp_path, images=1)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    out = fixture.export(release_id, tmp_path / "out")
    fixture.close()

    digest = manifest.assets[0].content_hash
    assert _tree(out) == {
        DATA_FILENAME: (
            "# Written by VisionSet. Class order is the release's frozen schema.\n"
            "path: .\n"
            "train: images/train\n"
            "val: images/train\n"
            "names:\n"
            '  0: "sign"\n'
            '  1: "lane"\n'
            '  2: "weather"\n'
        ),
        f"labels/train/{digest}.txt": "0 0.250000 0.500000 0.250000 0.500000\n",
        # The compatibility report, which every export carries and which is not
        # the format's.
        "visionset-export-report.json": _tree(out)["visionset-export-report.json"],
    }
    assert sorted(path.name for path in (out / "images" / "train").iterdir()) == [f"{digest}.png"]


def test_exporting_the_same_release_twice_writes_the_same_bytes(tmp_path: Path) -> None:
    """Nothing in the output depends on the clock, the machine or iteration order."""
    fixture = Fixture(tmp_path, images=4)
    fixture.label({0: [_box(x=8, y=12, width=16, height=24)]})
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=3))

    first = fixture.export(release_id, tmp_path / "first")
    second = fixture.export(release_id, tmp_path / "second")
    fixture.close()

    assert _tree(first) == _tree(second)


def _blob_path(root: Path, content_hash: str) -> Path:
    return root / "blobs" / content_hash[:2] / content_hash[2:4] / content_hash


def _release_of(fixture: Fixture, release_id: UUID) -> object:
    """The release row, re-read after the workspace was closed by its caller."""
    workspace = WorkspaceService.open(fixture.root)
    try:
        return ReleaseService(workspace).get(release_id)
    finally:
        workspace.close()
