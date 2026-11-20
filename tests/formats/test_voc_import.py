"""The VOC importer: 1-based boxes, the losses it reports, refusals, and the round trip."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import Fixture

from visionset.formats.registry import importer, importers
from visionset.formats.voc import VocExporter, VocImporter
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    LabelClass,
)
from visionset.kernel.ports import Importer
from visionset.kernel.services import ImportService, ProjectService, SchemaService, WorkspaceService


def _object(name: str = "car", box: tuple[Any, ...] = (9, 5, 24, 16), extra: str = "") -> str:
    xmin, ymin, xmax, ymax = box
    return (
        f"<object><name>{name}</name><pose>Unspecified</pose><truncated>0</truncated>"
        f"<difficult>0</difficult>{extra}<bndbox><xmin>{xmin}</xmin><ymin>{ymin}</ymin>"
        f"<xmax>{xmax}</xmax><ymax>{ymax}</ymax></bndbox></object>"
    )


def _write(
    src: Path, objects: list[str], *, filename: str = "a.png", head: str = "", name: str = "a"
) -> Path:
    target = src / "Annotations" / f"{name}.xml"
    target.parent.mkdir(parents=True, exist_ok=True)
    (src / "JPEGImages").mkdir(exist_ok=True)
    target.write_text(
        f'<?xml version="1.0"?>{head}<annotation><folder>JPEGImages</folder>'
        f"<filename>{filename}</filename><size><width>32</width><height>24</height>"
        f"<depth>3</depth></size><segmented>0</segmented>{''.join(objects)}</annotation>",
        encoding="utf-8",
    )
    return src


def _losses(src: Path) -> list[tuple[ImportLossKind, int]]:
    return [(loss.kind, loss.count) for loss in VocImporter().read(src).losses]


def test_the_importer_is_discovered_under_the_exporter_s_name() -> None:
    assert isinstance(importers()["voc"], VocImporter)
    assert isinstance(importer("voc"), Importer)


def test_a_one_based_inclusive_box_reads_back_as_the_domain_s_box(tmp_path: Path) -> None:
    dataset = VocImporter().read(_write(tmp_path, [_object(), _object("sign", (1, 1, 1.5, 3))]))

    (image,) = dataset.images
    assert str(image.path) == "JPEGImages/a.png"
    assert (image.width, image.height) == (32, 24)
    assert [label.geometry for label in image.labels] == [
        BboxGeometry(x=8, y=4, width=16, height=12),
        BboxGeometry(x=0, y=0, width=1.5, height=3),
    ]
    assert [(c.name, c.geometries) for c in dataset.classes] == [
        ("car", (GeometryType.BBOX,)),
        ("sign", (GeometryType.BBOX,)),
    ]
    assert dataset.losses == ()


@pytest.mark.parametrize(
    ("element", "kind"),
    [
        (_object(extra="<occluded>1</occluded>"), ImportLossKind.ATTRIBUTE),
        (_object().replace("<difficult>0", "<difficult>1"), ImportLossKind.ATTRIBUTE),
        (_object().replace("<truncated>0", "<truncated>1"), ImportLossKind.ATTRIBUTE),
        (_object().replace("Unspecified", "Left"), ImportLossKind.ATTRIBUTE),
        (_object(extra="<attributes><a>x</a></attributes>"), ImportLossKind.ATTRIBUTE),
        (
            _object(extra="<part><name>head</name><bndbox><xmin>1</xmin></bndbox></part>"),
            ImportLossKind.GEOMETRY,
        ),
    ],
)
def test_what_rides_beside_a_box_is_reported_and_the_box_is_kept(
    tmp_path: Path, element: str, kind: ImportLossKind
) -> None:
    src = _write(tmp_path, [element])

    assert _losses(src) == [(kind, 1)]
    assert len(VocImporter().read(src).images[0].labels) == 1


@pytest.mark.parametrize(
    "element",
    [
        _object(name=" "),
        "<object><name>car</name></object>",
        _object(box=(9, 5, "x", 16)),
        _object(box=(9, 5, "1e999", 16)),
        _object(box=(24, 5, 9, 16)),
        _object(box=(500, 500, 510, 510)),
    ],
)
def test_an_object_the_kernel_cannot_represent_is_a_label_loss(
    tmp_path: Path, element: str
) -> None:
    src = _write(tmp_path, [element, _object()])

    assert _losses(src) == [(ImportLossKind.LABEL, 1)]
    assert len(VocImporter().read(src).images[0].labels) == 1


def test_a_segmented_picture_s_masks_are_a_geometry_loss(tmp_path: Path) -> None:
    src = _write(tmp_path, [_object()])
    document = src / "Annotations" / "a.xml"
    document.write_text(document.read_text().replace("<segmented>0", "<segmented>1"))

    assert _losses(src) == [(ImportLossKind.GEOMETRY, 1)]


_BILLION_LAUGHS = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>'


@pytest.mark.parametrize(
    ("build", "match"),
    [
        (lambda src: _write(src, [_object()], head=_BILLION_LAUGHS), "DOCTYPE"),
        (lambda src: _write(src, [_object()], head='<!entity x "y">'), "not readable XML"),
        (lambda src: _write(src, ["<object>"]), "not readable XML"),
        (lambda src: _write(src, [_object()], filename=""), "no filename"),
        (lambda src: _write(src, [_object(box=("nan", 1, 2, 3))]), "non-finite"),
        (lambda src: src, "no Annotations/"),
        (lambda src: (src / "Annotations").mkdir() or src, "no XML"),
    ],
)
def test_an_unreadable_source_is_refused(tmp_path: Path, build: Any, match: str) -> None:
    with pytest.raises(ImportSourceUnreadable, match=match):
        VocImporter().read(build(tmp_path))


def test_a_document_that_is_not_an_annotation_is_refused(tmp_path: Path) -> None:
    (tmp_path / "Annotations").mkdir()
    (tmp_path / "Annotations" / "a.xml").write_text("<other/>")
    with pytest.raises(ImportSourceUnreadable, match="not a VOC annotation"):
        VocImporter().read(tmp_path)


def test_xml_nested_deeply_is_read_without_recursing(tmp_path: Path) -> None:
    (tmp_path / "Annotations").mkdir()
    (tmp_path / "Annotations" / "a.xml").write_text(
        "<annotation><filename>a.png</filename>"
        + "<x>" * 100000
        + "</x>" * 100000
        + "</annotation>"
    )
    (image,) = VocImporter().read(tmp_path).images
    assert (str(image.path), image.labels) == ("a.png", ())


def test_an_entity_declared_in_utf_16_is_refused(tmp_path: Path) -> None:
    document = (
        '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE annotation [<!ENTITY e "pwned">]>'
        "<annotation><filename>a.png</filename>" + _object(name="&e;") + "</annotation>"
    )
    (tmp_path / "Annotations").mkdir()
    (tmp_path / "Annotations" / "a.xml").write_bytes(document.encode("utf-16"))

    with pytest.raises(ImportSourceUnreadable, match="DOCTYPE"):
        VocImporter().read(tmp_path)


def test_a_size_too_long_to_be_a_number_is_no_size(tmp_path: Path) -> None:
    src = _write(tmp_path, [_object()])
    document = src / "Annotations" / "a.xml"
    document.write_text(document.read_text().replace("<width>32", "<width>" + "1" * 5000))

    (image,) = VocImporter().read(src).images
    assert image.width is None


def test_a_picture_no_document_names_is_imported_unlabelled(tmp_path: Path) -> None:
    src = _write(tmp_path, [_object()])
    write_image(src / "JPEGImages" / "b.png")

    images = VocImporter().read(src).images
    assert {str(image.path): len(image.labels) for image in images} == {
        "JPEGImages/a.png": 1,
        "JPEGImages/b.png": 0,
    }


@pytest.mark.parametrize("filename", ["../escape.png", "/etc/passwd", "a/../../b.png", "C:/x.png"])
def test_a_filename_leaving_the_source_refuses_the_whole_import(
    tmp_path: Path, filename: str
) -> None:
    with pytest.raises(ImportSourceUnreadable):
        VocImporter().read(_write(tmp_path, [], filename=filename))


def test_two_documents_naming_one_picture_are_refused(tmp_path: Path) -> None:
    _write(tmp_path, [])
    _write(tmp_path, [], name="b")
    with pytest.raises(ImportSourceUnreadable, match="more than one document"):
        VocImporter().read(tmp_path)


def test_a_symlinked_directory_under_annotations_is_refused(tmp_path: Path) -> None:
    src = _write(tmp_path / "src", [_object()])
    elsewhere = _write(tmp_path / "elsewhere", [_object()], filename="b.png")
    (src / "Annotations" / "more").symlink_to(elsewhere / "Annotations", True)

    with pytest.raises(ImportSourceUnreadable, match="symbolic link"):
        VocImporter().read(src)


def test_a_document_linked_from_outside_the_source_is_refused(tmp_path: Path) -> None:
    outside = _write(tmp_path / "outside", [_object()])
    src = tmp_path / "src"
    (src / "Annotations").mkdir(parents=True)
    (src / "Annotations" / "a.xml").symlink_to(outside / "Annotations" / "a.xml")

    with pytest.raises(ImportSourceUnreadable, match="outside the source"):
        VocImporter().read(src)


# --- the round trip -----------------------------------------------------------

CLASSES = (
    LabelClass(name="sign", geometries=(GeometryType.BBOX,)),
    LabelClass(name="car", geometries=(GeometryType.BBOX,)),
)


def _box(label_class: str, **geometry: float) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=BboxGeometry(**geometry),
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


def test_a_voc_export_of_whole_pixel_boxes_imports_back_without_loss(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path / "origin", classes=CLASSES)
    fixture.label(
        {
            0: [
                _box("sign", x=8, y=12, width=16, height=24),
                _box("car", x=0, y=0, width=64, height=48),
            ],
            1: [_box("car", x=63, y=47, width=1, height=1)],
        }
    )
    exported = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), VocExporter(), exported, allow_lossy=True)
    original = _content(fixture.workspace, fixture.project.id)
    fixture.close()

    workspace = WorkspaceService.init(tmp_path / "copy")
    created = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    plan = imports.inspect(created.id, VocImporter(), exported)
    run = imports.commit(created.id, VocImporter(), exported, consent=ImportConsent())

    assert plan.losses == ()
    assert run.losses == ()
    assert _content(workspace, created.id) == original
    (schema,) = SchemaService(workspace).list_versions(created.id)
    assert {(c.name, c.geometries) for c in schema.classes} == {
        (c.name, c.geometries) for c in CLASSES
    }
    workspace.close()
