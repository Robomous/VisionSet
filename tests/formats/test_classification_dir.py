"""Class-directory classification: export, import, the round trip and a loader's reading of it."""

from __future__ import annotations

import hashlib
import os
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from PIL import Image
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import Fixture, _box

from visionset.formats.classification import ClassificationExporter
from visionset.formats.classification_dir import (
    ClassificationDirExporter,
    ClassificationDirImporter,
)
from visionset.formats.registry import exporters, importers
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    AssetProgress,
    ClassExportStatus,
    ClassificationGeometry,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    LabelClass,
    SplitRecipe,
)
from visionset.kernel.errors import ExportSourceUnreadable, LossyExportNotConsented
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

#: Authored out of name order, so a vocabulary in schema order would fail the sorted assertions.
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


#: Two tags, one tag, a box alone, nothing.
DRAWING: dict[int, list[Annotation]] = {
    0: [_tag("weather"), _tag("night")],
    1: [_tag("weather")],
    2: [_box(x=1, y=1, width=8, height=8)],
}


def _fixture(tmp_path: Path, drawing: dict[int, list[Annotation]] = DRAWING, **kw: Any) -> Fixture:
    fixture = Fixture(tmp_path / "origin", classes=kw.pop("classes", CLASSES), **kw)
    fixture.label(drawing)
    return fixture


def _export(fixture: Fixture, release_id: UUID, dest: Path) -> Path:
    fixture.releases.export(release_id, ClassificationDirExporter(), dest, allow_lossy=True)
    return dest


def _tree(root: Path) -> tuple[set[str], dict[str, str]]:
    """Every directory, and every file's sha256, by path relative to ``root``."""
    directories = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_dir()}
    files = {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file() and path.name != "visionset-export-report.json"
    }
    return directories, files


def _picture(path: Path, seed: int = 0) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    return write_image(path, size=(8, 6), seed=seed)


# --- export ---------------------------------------------------------------------


def test_each_picture_is_written_once_under_the_first_of_its_tags_by_name(
    tmp_path: Path,
) -> None:
    fixture = _fixture(tmp_path, images=4)
    release_id = fixture.publish()
    manifest = fixture.releases.manifest(release_id)
    dest = _export(fixture, release_id, tmp_path / "out")
    fixture.close()

    directories, files = _tree(dest)
    tagged = {
        asset.content_hash: sorted(
            one.label_class
            for one in asset.annotations
            if one.geometry.type == "classification_tag"
        )
        for asset in manifest.assets
    }
    expected = {
        f"train/{classes[0]}/{content_hash}.png": content_hash
        for content_hash, classes in tagged.items()
        if classes
    }
    assert files == expected
    assert directories == {"train", "train/night", "train/unused", "train/weather"}
    assert sorted(path.split("/")[1] for path in files) == ["night", "weather"]


def test_the_report_drops_the_extra_tag_and_counts_the_untagged_assets(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path, images=4)
    report = fixture.releases.check_export(fixture.publish(), ClassificationDirExporter())
    fixture.close()

    rows = {
        (one.label_class, one.geometry.value, one.status): (one.annotations, one.assets)
        for one in report.classes
    }
    assert rows[("night", "classification_tag", ClassExportStatus.SUPPORTED)] == (1, 1)
    assert rows[("weather", "classification_tag", ClassExportStatus.SUPPORTED)] == (1, 1)
    assert rows[("weather", "classification_tag", ClassExportStatus.DROPPED)] == (1, 1)
    assert rows[("sign", "bbox", ClassExportStatus.DROPPED)] == (1, 1)
    (surplus,) = [
        one
        for one in report.classes
        if one.label_class == "weather" and one.status is ClassExportStatus.DROPPED
    ]
    assert surplus.reason is not None and "first of its tags by name" in surplus.reason
    assert report.untagged_assets == 2
    assert report.excluded_annotations == 2
    assert not report.compatible and report.format_is_lossy


def test_the_report_agrees_with_the_pictures_written_for_mixed_tagging(tmp_path: Path) -> None:
    drawing = {
        0: [_tag("weather"), _tag("night"), _tag("unused")],
        1: [_tag("weather")],
        2: [_box(x=1, y=1, width=8, height=8)],
        3: [_tag("unused"), _tag("weather")],
    }
    fixture = _fixture(tmp_path, drawing, images=5)
    release_id = fixture.publish()
    result = fixture.releases.export(
        release_id, ClassificationDirExporter(), tmp_path / "out", allow_lossy=True
    )
    fixture.close()

    report = result.compatibility
    written = Counter(path.parent.name for path in (tmp_path / "out").glob("*/*/*"))
    kept: Counter[str] = Counter()
    for row in report.classes:
        if row.status is not ClassExportStatus.DROPPED:
            kept[row.label_class] += row.annotations
    assert written == kept
    assert report.untagged_assets == 5 - sum(written.values())
    assert report.excluded_annotations == sum(row.annotations for row in report.classes) - sum(
        written.values()
    )


def test_a_release_of_single_tags_on_every_asset_reports_nothing_left_out(
    tmp_path: Path,
) -> None:
    fixture = _fixture(tmp_path, {0: [_tag("night")], 1: [_tag("weather")], 2: [_tag("night")]})
    report = fixture.releases.check_export(fixture.publish(), ClassificationDirExporter())
    fixture.close()

    assert report.untagged_assets == 0
    assert report.excluded_annotations == 0
    assert report.compatible


def test_the_export_writes_nothing_without_consent(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path)
    release_id = fixture.publish()
    dest = tmp_path / "out"
    dest.mkdir()

    with pytest.raises(LossyExportNotConsented, match=r"1 asset\(s\) carry no tag"):
        fixture.releases.export(release_id, ClassificationDirExporter(), dest)
    fixture.close()

    assert list(dest.iterdir()) == []


def test_every_fold_holds_every_class_and_each_picture_sits_in_its_assigned_fold(
    tmp_path: Path,
) -> None:
    drawing = {index: [_tag(("night", "weather")[index % 2])] for index in range(8)}
    fixture = _fixture(tmp_path, drawing, images=8)
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=7))
    manifest = fixture.releases.manifest(release_id)
    assignment = fixture.releases.assignment(release_id)
    dest = _export(fixture, release_id, tmp_path / "out")
    fixture.close()

    fold_of = {
        asset_id: fold
        for fold, members in (
            ("train", assignment.train),
            ("val", assignment.val),
            ("test", assignment.test),
        )
        for asset_id in members
    }
    directories, files = _tree(dest)
    folds = {path for path in directories if "/" not in path}
    assert len(folds) >= 2
    assert directories == folds | {f"{fold}/{name}" for fold in folds for name in CLASS_DIRS}
    assert len(files) == len(manifest.assets)
    for asset in manifest.assets:
        (tag,) = asset.annotations
        assert files[f"{fold_of[asset.asset_id]}/{tag.label_class}/{asset.content_hash}.png"] == (
            asset.content_hash
        )


CLASS_DIRS = ("night", "unused", "weather")


@pytest.mark.parametrize(
    ("name", "problem"),
    [
        ("road/sign", "single directory name"),
        (".hidden", "starts with a dot"),
        ("cafe\u0301", "NFC"),
        ("tab\there", "control character"),
    ],
)
def test_a_class_that_cannot_name_a_directory_refuses_the_export(
    tmp_path: Path, name: str, problem: str
) -> None:
    classes = (LabelClass(name=name, geometries=(GeometryType.CLASSIFICATION_TAG,)),)
    fixture = _fixture(tmp_path, {0: [_tag(name)]}, classes=classes, images=1)
    release_id = fixture.publish()

    with pytest.raises(ExportSourceUnreadable, match=problem):
        _export(fixture, release_id, tmp_path / "out")
    fixture.close()


def test_two_classes_equal_ignoring_case_refuse_the_export(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path, {0: [_tag("night")]}, images=1)
    release_id = fixture.publish()
    release, manifest = fixture.releases.get(release_id), fixture.releases.manifest(release_id)
    fixture.close()
    clashing = manifest.model_copy(
        update={
            "classes": (
                *manifest.classes,
                LabelClass(name="Night", geometries=(GeometryType.CLASSIFICATION_TAG,)),
            )
        }
    )

    def unread(content_hash: str) -> Any:
        raise AssertionError(f"read {content_hash} before refusing")

    with pytest.raises(ExportSourceUnreadable, match="differ only in case"):
        ClassificationDirExporter().export(
            release,
            clashing,
            tmp_path / "out",
            content=unread,
            assignment=None,
        )


def test_the_plugin_declares_one_tag_per_picture_and_registers_both_directions() -> None:
    exporter, importer = ClassificationDirExporter(), ClassificationDirImporter()

    assert isinstance(exporter, Exporter) and isinstance(importer, Importer)
    assert exporter.lossy and exporter.single_tag
    assert exporter.supported_geometries == frozenset({GeometryType.CLASSIFICATION_TAG})
    assert exporter.degraded_geometries == frozenset()
    assert {one.name for one in exporter.targets} == {"classification-dir"}
    assert isinstance(exporters()["classification-dir"], ClassificationDirExporter)
    assert isinstance(importers()["classification-dir"], ClassificationDirImporter)


def test_the_multi_label_classification_format_still_writes_every_tag(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path)
    report = fixture.releases.check_export(fixture.publish(), ClassificationExporter())
    fixture.close()

    assert report.untagged_assets == 0
    assert {
        (one.label_class, one.status) for one in report.classes if one.geometry.value != "bbox"
    } == {
        ("night", ClassExportStatus.SUPPORTED),
        ("weather", ClassExportStatus.SUPPORTED),
        ("unused", ClassExportStatus.SUPPORTED),
    }


# --- import ---------------------------------------------------------------------


def _labels(dataset: Any) -> dict[str, str]:
    return {
        str(image.path): next(label.class_name for label in image.labels)
        for image in dataset.images
    }


def test_split_directories_give_each_picture_its_class_and_keep_an_empty_class(
    tmp_path: Path,
) -> None:
    src = tmp_path / "src"
    _picture(src / "train" / "dog" / "a.png", seed=1)
    _picture(src / "train" / "cat" / "b.jpg", seed=2)
    _picture(src / "valid" / "cat" / "c.png", seed=3)
    _picture(src / "test" / "dog" / "d.png", seed=4)
    (src / "train" / "empty").mkdir()

    dataset = ClassificationDirImporter().read(src)

    assert [one.name for one in dataset.classes] == ["cat", "dog", "empty"]
    assert all(one.geometries == (GeometryType.CLASSIFICATION_TAG,) for one in dataset.classes)
    assert _labels(dataset) == {
        "test/dog/d.png": "dog",
        "train/cat/b.jpg": "cat",
        "train/dog/a.png": "dog",
        "valid/cat/c.png": "cat",
    }
    assert all(len(image.labels) == 1 for image in dataset.images)
    assert dataset.losses == ()


def test_a_source_without_split_directories_is_read_as_flat_class_directories(
    tmp_path: Path,
) -> None:
    src = tmp_path / "src"
    _picture(src / "zebra" / "a.png", seed=1)
    _picture(src / "Ärger" / "b.png", seed=2)

    dataset = ClassificationDirImporter().read(src)

    assert [one.name for one in dataset.classes] == ["zebra", "Ärger"]
    assert _labels(dataset) == {"zebra/a.png": "zebra", "Ärger/b.png": "Ärger"}


@pytest.mark.parametrize(
    ("layout", "message"),
    [
        (["train/cat/deeper/a.png"], "inside the class directory 'train/cat'"),
        (["cat/deeper/a.png"], "inside the class directory 'cat'"),
        (["train/cat/a.png", "extra/cat/b.png"], "beside other directories"),
        (["val/cat/a.png", "validation/cat/b.png"], "all name the val split"),
        (["train/Cat/a.png", "val/cat/b.png"], "differ only in case"),
        (["train/cafe\u0301/a.png"], "NFC"),
        (["train/a.png"], "holds no class directory"),
    ],
)
def test_an_ambiguous_or_malformed_tree_is_refused(
    tmp_path: Path, layout: list[str], message: str
) -> None:
    src = tmp_path / "src"
    for seed, relative in enumerate(layout):
        _picture(src / relative, seed=seed)

    with pytest.raises(ImportSourceUnreadable, match=message):
        ClassificationDirImporter().read(src)


def test_a_symbolic_link_out_of_the_source_or_to_a_directory_is_refused(tmp_path: Path) -> None:
    outside = _picture(tmp_path / "elsewhere" / "x.png")
    src = tmp_path / "src"
    _picture(src / "train" / "cat" / "a.png")
    (src / "train" / "cat" / "x.png").symlink_to(outside)
    with pytest.raises(ImportSourceUnreadable, match="resolves outside the source"):
        ClassificationDirImporter().read(src)

    (src / "train" / "cat" / "x.png").unlink()
    (src / "train" / "dog").symlink_to(outside.parent, target_is_directory=True)
    with pytest.raises(ImportSourceUnreadable, match="symbolic link to a directory"):
        ClassificationDirImporter().read(src)


def test_a_link_to_a_picture_inside_the_source_is_read(tmp_path: Path) -> None:
    src = tmp_path / "src"
    original = _picture(src / "train" / "cat" / "a.png")
    (src / "train" / "cat" / "b.png").symlink_to(original)

    dataset = ClassificationDirImporter().read(src)

    assert _labels(dataset) == {"train/cat/a.png": "cat", "train/cat/b.png": "cat"}


def test_non_pictures_in_a_class_directory_and_stray_pictures_are_image_losses(
    tmp_path: Path,
) -> None:
    src = tmp_path / "src"
    _picture(src / "train" / "cat" / "a.png", seed=1)
    (src / "train" / "cat" / "notes.txt").write_text("not a picture")
    (src / "train" / "cat" / "anim.gif").write_bytes(b"GIF89a")
    (src / "train" / "cat" / "LICENSE").write_text("terms")
    (src / "train" / "cat" / ".DS_Store").write_bytes(b"\0")
    (src / "train" / ".ipynb_checkpoints").mkdir()
    _picture(src / "train" / "loose.png", seed=2)
    _picture(src / "top.png", seed=3)
    (src / "README.md").write_text("a dataset")

    dataset = ClassificationDirImporter().read(src)

    assert _labels(dataset) == {"train/cat/a.png": "cat"}
    assert {(one.kind, one.subject, one.reason, one.count) for one in dataset.losses} == {
        (ImportLossKind.IMAGE, "train/cat", "a .txt file is not a picture", 1),
        (ImportLossKind.IMAGE, "train/cat", "a .gif file is not a picture", 1),
        (ImportLossKind.IMAGE, "train/cat", "a suffixless file is not a picture", 1),
        (ImportLossKind.IMAGE, "train", "a picture outside every class directory", 1),
        (ImportLossKind.IMAGE, ".", "a picture outside every class directory", 1),
        (
            ImportLossKind.IMAGE,
            "train",
            "a directory whose name starts with a dot is skipped, with all it holds",
            1,
        ),
    }


def test_a_hidden_picture_or_class_directory_is_skipped_as_an_image_loss(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _picture(src / "train" / "cat" / "a.png", seed=1)
    _picture(src / "train" / "cat" / ".b.png", seed=2)
    _picture(src / "train" / ".dog" / "c.png", seed=3)
    _picture(src / "train" / "cat" / ".ipynb_checkpoints" / "a.png", seed=1)
    (src / ".git").mkdir()

    dataset = ClassificationDirImporter().read(src)

    assert [one.name for one in dataset.classes] == ["cat"]
    assert _labels(dataset) == {"train/cat/a.png": "cat"}
    assert {(one.subject, one.reason, one.count) for one in dataset.losses} == {
        ("train/cat", "a picture whose name starts with a dot is skipped", 1),
        ("train", "a directory whose name starts with a dot is skipped, with all it holds", 1),
    }


def test_an_undecodable_class_name_is_refused_and_a_dangling_link_is_an_image_loss(
    tmp_path: Path,
) -> None:
    src = tmp_path / "src"
    _picture(src / "train" / "cat" / "a.png")
    (src / "train" / "cat" / "gone.png").symlink_to(src / "train" / "cat" / "missing.png")
    dataset = ClassificationDirImporter().read(src)
    assert {(one.subject, one.reason) for one in dataset.losses} == {
        ("train/cat", "it is not a regular file")
    }

    os.mkdir(os.fsencode(src / "train") + b"/\xff")
    with pytest.raises(ImportSourceUnreadable, match="not valid UTF-8"):
        ClassificationDirImporter().read(src)


def test_the_same_picture_under_two_classes_is_refused_and_under_one_class_is_kept(
    tmp_path: Path,
) -> None:
    src = tmp_path / "src"
    _picture(src / "train" / "cat" / "a.png", seed=1)
    _picture(src / "val" / "cat" / "a.png", seed=1)
    assert len(ClassificationDirImporter().read(src).images) == 2

    _picture(src / "test" / "dog" / "z.png", seed=1)
    with pytest.raises(
        ImportSourceUnreadable, match="same picture under the classes 'dog' and 'cat'"
    ):
        ClassificationDirImporter().read(src)


# --- round trip -----------------------------------------------------------------


def _commit_and_publish(workspace: WorkspaceService, src: Path) -> tuple[ReleaseService, UUID]:
    projects = ProjectService(workspace)
    project = projects.create("reimported")
    run = ImportService(workspace).commit(
        project.id, ClassificationDirImporter(), src, consent=ImportConsent()
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
    return releases, releases.publish(projects.get_dataset(project.id).id, "v1").id


def test_export_import_export_keeps_classes_bytes_and_empty_classes(tmp_path: Path) -> None:
    drawing = {0: [_tag("night")], 1: [_tag("weather")], 2: [_tag("night")]}
    fixture = _fixture(tmp_path, drawing)
    first = _export(fixture, fixture.publish(), tmp_path / "first")
    fixture.close()

    dataset = ClassificationDirImporter().read(first)
    assert [one.name for one in dataset.classes] == ["night", "unused", "weather"]

    workspace = WorkspaceService.init(tmp_path / "again")
    try:
        releases, release_id = _commit_and_publish(workspace, first)
        second = tmp_path / "second"
        releases.export(release_id, ClassificationDirExporter(), second, allow_lossy=True)
    finally:
        workspace.close()

    assert _tree(second) == _tree(first)
    assert (second / "train" / "unused").is_dir()
    assert not any((second / "train" / "unused").iterdir())


def test_the_split_survives_the_export_and_the_import_reads_every_fold(tmp_path: Path) -> None:
    drawing = {index: [_tag(("night", "weather")[index % 2])] for index in range(8)}
    fixture = _fixture(tmp_path, drawing, images=8)
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=3))
    manifest = fixture.releases.manifest(release_id)
    assignment = fixture.releases.assignment(release_id)
    dest = _export(fixture, release_id, tmp_path / "out")
    fixture.close()

    by_hash = {asset.content_hash: asset for asset in manifest.assets}
    dataset = ClassificationDirImporter().read(dest)
    folds: dict[str, set[UUID]] = {"train": set(), "val": set(), "test": set()}
    for image in dataset.images:
        fold, name, file_name = image.path.parts
        content_hash = Path(file_name).stem
        assert hashlib.sha256((dest / image.path).read_bytes()).hexdigest() == content_hash
        (tag,) = by_hash[content_hash].annotations
        assert image.labels[0].class_name == tag.label_class == name
        folds[fold].add(by_hash[content_hash].asset_id)
    assert folds == {
        "train": set(assignment.train),
        "val": set(assignment.val),
        "test": set(assignment.test),
    }


# --- a standard loader ----------------------------------------------------------

#: torchvision's ``IMG_EXTENSIONS``.
_LOADER_EXTENSIONS = (".jpg", ".jpeg", ".png", ".ppm", ".bmp", ".pgm", ".tif", ".tiff", ".webp")


def _image_folder(
    root: Path, *, allow_empty: bool = False
) -> tuple[list[str], list[tuple[str, int]]]:
    """``torchvision.datasets.ImageFolder``'s discovery rules, restated: torchvision is not a
    dependency. Classes are the sorted subdirectory names, samples every file with an allowed
    extension below each, and a class with no sample is an error unless ``allow_empty``."""
    classes = sorted(entry.name for entry in os.scandir(root) if entry.is_dir())
    if not classes:
        raise FileNotFoundError(f"Couldn't find any class folder in {root}.")
    samples: list[tuple[str, int]] = []
    found: set[str] = set()
    for index, name in enumerate(classes):
        for parent, _, names in sorted(os.walk(root / name, followlinks=True)):
            for file_name in sorted(names):
                if file_name.lower().endswith(_LOADER_EXTENSIONS):
                    samples.append((os.path.join(parent, file_name), index))
                    found.add(name)
    empty = set(classes) - found
    if empty and not allow_empty:
        raise FileNotFoundError(f"Found no valid file for the classes {', '.join(sorted(empty))}.")
    for path, _ in samples:
        with Image.open(path) as image:
            image.convert("RGB")
    return classes, samples


def test_an_image_folder_loader_reads_every_fold_with_one_class_numbering(tmp_path: Path) -> None:
    classes = (
        LabelClass(name="night", geometries=(GeometryType.CLASSIFICATION_TAG,)),
        LabelClass(name="day", geometries=(GeometryType.CLASSIFICATION_TAG,)),
    )
    drawing = {index: [_tag(("night", "day")[index % 2])] for index in range(8)}
    fixture = _fixture(tmp_path, drawing, classes=classes, images=8)
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.5, test=0.0, seed=1))
    dest = _export(fixture, release_id, tmp_path / "out")
    fixture.close()

    loaded = {fold.name: _image_folder(fold) for fold in dest.iterdir() if fold.is_dir()}

    assert set(loaded) == {"train", "val"}
    assert {tuple(found) for found, _ in loaded.values()} == {("day", "night")}
    assert sum(len(samples) for _, samples in loaded.values()) == 8


def test_an_empty_class_loads_only_where_the_loader_allows_empty_classes(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path, {0: [_tag("night")], 1: [_tag("weather")], 2: [_tag("night")]})
    dest = _export(fixture, fixture.publish(), tmp_path / "out")
    fixture.close()

    with pytest.raises(FileNotFoundError, match="unused"):
        _image_folder(dest / "train")
    found, samples = _image_folder(dest / "train", allow_empty=True)
    assert found == ["night", "unused", "weather"]
    assert sorted(index for _, index in samples) == [0, 0, 2]
