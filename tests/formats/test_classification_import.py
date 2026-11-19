"""The classification importer: rows as tags, the vocabulary, losses, and the round trip."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import Fixture

from visionset.formats.classification import ClassificationExporter, ClassificationImporter
from visionset.formats.registry import importer, importers
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    ClassificationGeometry,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    LabelClass,
)
from visionset.kernel.ports import Importer
from visionset.kernel.services import ImportService, ProjectService, SchemaService, WorkspaceService

TAG = (GeometryType.CLASSIFICATION_TAG,)


def _write(src: Path, rows: str, *, classes: str | None = "rain\nnight\nsnow\n") -> Path:
    src.mkdir(parents=True, exist_ok=True)
    (src / "labels.csv").write_text("image,fold,class\n" + rows, encoding="utf-8")
    if classes is not None:
        (src / "classes.txt").write_text(classes, encoding="utf-8")
    return src


def _tags(src: Path) -> dict[str, list[str]]:
    return {
        str(image.path): [label.class_name for label in image.labels]
        for image in ClassificationImporter().read(src).images
    }


def test_the_importer_is_discovered_under_the_exporter_s_name() -> None:
    assert isinstance(importers()["classification"], ClassificationImporter)
    assert isinstance(importer("classification"), Importer)


def test_each_row_is_one_tag_and_the_vocabulary_declares_every_class(tmp_path: Path) -> None:
    src = _write(
        tmp_path,
        "images/train/a.png,train,rain\nimages/train/a.png,train,night\n"
        "images/val/b.png,val,rain\n",
    )
    dataset = ClassificationImporter().read(src)

    assert [(c.name, c.geometries) for c in dataset.classes] == [
        ("rain", TAG),
        ("night", TAG),
        ("snow", TAG),
    ]
    assert _tags(src) == {"images/train/a.png": ["rain", "night"], "images/val/b.png": ["rain"]}
    assert all(
        label.geometry == ClassificationGeometry()
        for image in dataset.images
        for label in image.labels
    )
    assert dataset.losses == ()


def test_a_repeated_tag_of_one_class_on_one_picture_is_a_label_loss(tmp_path: Path) -> None:
    src = _write(tmp_path, "a.png,train,rain\na.png,train,rain\na.png,train,night\n")

    losses = ClassificationImporter().read(src).losses
    assert [(loss.kind, loss.subject, loss.count) for loss in losses] == [
        (ImportLossKind.LABEL, "rain", 1)
    ]
    assert _tags(src) == {"a.png": ["rain", "night"]}


def test_without_a_vocabulary_the_rows_name_the_classes(tmp_path: Path) -> None:
    src = _write(tmp_path, "a.png,train,night\nb.png,train,rain\n", classes=None)

    assert [c.name for c in ClassificationImporter().read(src).classes] == ["night", "rain"]


def test_a_picture_no_row_names_is_imported_untagged(tmp_path: Path) -> None:
    src = _write(tmp_path, "images/train/a.png,train,rain\n")
    write_image(src / "images" / "train" / "a.png")
    write_image(src / "images" / "val" / "b.png", seed=1)

    assert _tags(src) == {"images/train/a.png": ["rain"], "images/val/b.png": []}


@pytest.mark.parametrize(
    "row",
    ["a.png,train,hail", "a.png,train", "a.png,train,rain,extra", "a.png,train,", ",train,rain"],
)
def test_a_row_the_import_cannot_carry_is_a_label_loss(tmp_path: Path, row: str) -> None:
    src = _write(tmp_path, f"{row}\na.png,train,rain\n")

    losses = ClassificationImporter().read(src).losses
    assert [(loss.kind, loss.count) for loss in losses] == [(ImportLossKind.LABEL, 1)]
    assert _tags(src) == {"a.png": ["rain"]}


@pytest.mark.parametrize("image", ["../escape.png", "/etc/passwd", "a/../../b.png", "C:/x.png"])
def test_a_path_leaving_the_source_refuses_the_whole_import(tmp_path: Path, image: str) -> None:
    with pytest.raises(ImportSourceUnreadable):
        ClassificationImporter().read(_write(tmp_path, f"{image},train,rain\n"))


def test_an_unreadable_source_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ImportSourceUnreadable, match="not a directory"):
        ClassificationImporter().read(tmp_path / "missing")
    with pytest.raises(ImportSourceUnreadable, match="holds no labels.csv"):
        ClassificationImporter().read(tmp_path)
    (tmp_path / "labels.csv").write_text("path,label\na.png,rain\n")
    with pytest.raises(ImportSourceUnreadable, match="header names no"):
        ClassificationImporter().read(tmp_path)
    (tmp_path / "labels.csv").write_text("")
    with pytest.raises(ImportSourceUnreadable, match="no header"):
        ClassificationImporter().read(tmp_path)
    (tmp_path / "labels.csv").write_bytes(b"image,class\n\xff\xfe,rain\n")
    with pytest.raises(ImportSourceUnreadable, match="UTF-8"):
        ClassificationImporter().read(tmp_path)


@pytest.mark.parametrize("linked", ["labels.csv", "classes.txt"])
def test_a_file_linked_from_outside_the_source_is_refused(tmp_path: Path, linked: str) -> None:
    outside = _write(tmp_path / "outside", "a.png,train,rain\n")
    src = _write(tmp_path / "src", "a.png,train,rain\n")
    (src / linked).unlink()
    (src / linked).symlink_to(outside / linked)

    with pytest.raises(ImportSourceUnreadable, match="outside the source"):
        ClassificationImporter().read(src)


def test_a_symlinked_images_directory_is_refused(tmp_path: Path) -> None:
    write_image(tmp_path / "elsewhere" / "a.png")
    src = _write(tmp_path / "src", "")
    (src / "images").symlink_to(tmp_path / "elsewhere", True)

    with pytest.raises(ImportSourceUnreadable, match="symbolic link"):
        ClassificationImporter().read(src)


# --- the round trip -----------------------------------------------------------

CLASSES = (
    LabelClass(name="weather", geometries=TAG),
    LabelClass(name="night", geometries=TAG),
    LabelClass(name="season", geometries=TAG),
)


def _tag(label_class: str) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=ClassificationGeometry(),
        provenance="human",
    )


def _content(workspace: WorkspaceService, project_id: Any) -> dict[str, Counter[tuple[str, str]]]:
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: Counter(
                (label.label_class, label.geometry.model_dump_json())
                for label in uow.annotations.list(asset.id)
            )
            for asset in uow.assets.list(project_id)
        }


def test_a_classification_export_imports_back_without_loss(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path / "origin", classes=CLASSES)
    fixture.label({0: [_tag("weather"), _tag("night")], 1: [_tag("weather")]})
    exported = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), ClassificationExporter(), exported, allow_lossy=True)
    original = _content(fixture.workspace, fixture.project.id)
    fixture.close()

    workspace = WorkspaceService.init(tmp_path / "copy")
    created = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    plan = imports.inspect(created.id, ClassificationImporter(), exported)
    run = imports.commit(created.id, ClassificationImporter(), exported, consent=ImportConsent())

    assert plan.losses == ()
    assert run.losses == ()
    assert _content(workspace, created.id) == original
    assert any(not labels for labels in original.values())
    (schema,) = SchemaService(workspace).list_versions(created.id)
    assert [(c.name, c.geometries) for c in schema.classes] == [
        (c.name, c.geometries) for c in CLASSES
    ]
    workspace.close()
