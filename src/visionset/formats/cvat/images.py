# usage: from visionset.formats.cvat.images import CvatImagesExporter, CvatImagesImporter
"""CVAT for images 1.1: one ``<image>`` element per picture, each holding its shapes.

**In.** Every ``annotations.xml`` under the source is one CVAT task export, its
pictures under ``images/`` beside it, named by each ``<image name>``, the layout
CVAT writes when a dataset is exported with its images; a project export keeps
each subset under ``images/<subset>/``. A shape with an empty ``label`` is a
``label`` loss. Coordinates are pixels
from the picture's top-left corner as CVAT writes them, so a ``<box>`` is
``x = xtl``, ``width = xbr - xtl``. ``<box>``, ``<polygon>`` and ``<polyline>``
become the geometry of the same name, and an image-level ``<tag>`` a
classification tag. What the domain has no geometry for (``<points>``,
``<ellipse>``, ``<cuboid>``, ``<mask>``, ``<skeleton>``, a rotated box) is a
``label`` loss; ``occluded``, a non-zero ``z_order``, a ``group_id`` and a
``subset`` other than ``default`` are ``attribute`` losses, the shape kept. A
label's ``<meta>`` attributes are its class's definitions and each shape's
``<attribute>`` values its label's, read as their definition's kind. Every
label becomes ``import`` provenance, whatever its ``source``.
A document holding ``<track>`` elements is CVAT for video and is refused here.

**Out.** ``annotations.xml`` and the pictures under ``images/``, named by content
hash, the layout the importer reads back. Each picture is an ``<image>`` whose
``subset`` is its fold, or ``default`` for a release without a split recipe;
boxes, polygons, polylines and tags are written whole with their attribute
values, and the release's classes and attribute definitions become ``<meta>``.
``lossy``: confidence, a polyline's per-vertex visibility, the model behind a
label, an attribute's ``required`` and an empty-string default have nowhere to
go, and provenance survives only as CVAT's ``source``. An option that is empty
or spans lines cannot be a line of ``<values>`` and refuses the export.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Final
from xml.etree import ElementTree

from visionset.formats._layout import (
    dimensions_of,
    folds_of,
    image_name,
    image_suffix,
    write_image,
)
from visionset.formats._reading import REPEATED_TAG, inside, relative, to_dataset
from visionset.formats._targets import self_target
from visionset.formats.cvat._document import (
    DOCUMENT_FILENAME,
    DRAWN,
    IMAGES_DIRNAME,
    SHAPES,
    SOURCES,
    Document,
    Losses,
    Meta,
    documents,
    extras,
    geometry,
    imported_classes,
    integer,
    label_of,
    meta,
    new_document,
    parse,
    require_writable,
    save,
    write_meta,
    write_shape,
    write_values,
)
from visionset.kernel.domain import (
    ClassificationGeometry,
    GeometryType,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLossKind,
    Manifest,
    Release,
    SplitAssignment,
)
from visionset.kernel.ports import ContentReader

FORMAT_NAME: Final = "cvat-images"
DEFAULT_SUBSET: Final = "default"

_LABEL: Final = "CVAT for images"
_SUBSET: Final = "the subset is not imported; the picture is kept"


class CvatImagesImporter:
    """Reads CVAT for images 1.1 task exports into an ``ImportedDataset``."""

    format_name = FORMAT_NAME

    def read(self, src: Path) -> ImportedDataset:
        images: dict[PurePosixPath, ImportedImage] = {}
        declared: list[Meta] = []
        used: dict[str, set[GeometryType]] = {}
        losses: Losses = Counter()
        for path in documents(src, _LABEL):
            document = parse(path, relative(src, path))
            labels = meta(document, losses)
            declared.append(labels)
            prefix = path.parent.relative_to(src).as_posix()
            base = (
                PurePosixPath(prefix, IMAGES_DIRNAME)
                if prefix != "."
                else PurePosixPath(IMAGES_DIRNAME)
            )
            ids: set[tuple[str, int]] = set()
            for element in document.root:
                if element.tag in ("version", "meta"):
                    continue
                if element.tag == "track":
                    raise document.refuse(
                        element,
                        "a <track> belongs to CVAT for video 1.1, which cvat-video reads",
                    )
                if element.tag != "image":
                    raise document.refuse(element, f"<{element.tag}> is not a CVAT image element")
                image = _image(document, element, base, labels, used, losses, ids)
                if image.path in images:
                    raise document.refuse(
                        element, f"picture {str(image.path)!r} is listed more than once"
                    )
                images[image.path] = image
        return to_dataset(imported_classes(declared, used, losses), images.values(), losses, _LABEL)


def _image(
    document: Document,
    element: ElementTree.Element,
    base: PurePosixPath,
    declared: Meta,
    used: dict[str, set[GeometryType]],
    losses: Losses,
    ids: set[tuple[str, int]],
) -> ImportedImage:
    identity = integer(document, element, "id")
    subset = element.get("subset", DEFAULT_SUBSET).strip()
    if (subset, identity) in ids:
        raise document.refuse(element, f"image id {identity} is given twice")
    ids.add((subset, identity))
    name = (element.get("name") or "").strip()
    if not name:
        raise document.refuse(element, "an <image> has no name")
    if declared.project:
        base = base / inside(subset, document.at(element))
    path = base / inside(name, document.at(element))
    width = integer(document, element, "width", minimum=1)
    height = integer(document, element, "height", minimum=1)
    if subset != DEFAULT_SUBSET:
        losses[(ImportLossKind.ATTRIBUTE, "subset", _SUBSET)] += 1
    labels: list[ImportedLabel] = []
    tagged: set[str] = set()
    for shape in element:
        if shape.tag not in SHAPES and shape.tag != "tag":
            raise document.refuse(shape, f"<{shape.tag}> is not a CVAT shape")
        class_name = label_of(document, shape, declared, losses)
        if class_name is None:
            continue
        if shape.tag == "tag":
            if class_name in tagged:
                losses[(ImportLossKind.LABEL, class_name, REPEATED_TAG)] += 1
                continue
            values = extras(document, shape, losses, class_name, declared)
            tagged.add(class_name)
            used.setdefault(class_name, set()).add(GeometryType.CLASSIFICATION_TAG)
            labels.append(
                ImportedLabel(
                    class_name=class_name, geometry=ClassificationGeometry(), attributes=values
                )
            )
            continue
        drawn = geometry(document, shape, losses, class_name)
        if drawn is None:
            continue
        values = extras(document, shape, losses, class_name, declared)
        used.setdefault(class_name, set()).add(DRAWN[shape.tag])
        labels.append(ImportedLabel(class_name=class_name, geometry=drawn, attributes=values))
    return ImportedImage(path=path, width=width, height=height, labels=tuple(labels))


class CvatImagesExporter:
    """Writes a release as a CVAT for images 1.1 task export."""

    format_name = FORMAT_NAME

    lossy = True

    supported_geometries = frozenset(
        {
            GeometryType.BBOX,
            GeometryType.POLYGON,
            GeometryType.POLYLINE,
            GeometryType.CLASSIFICATION_TAG,
        }
    )

    degraded_geometries: frozenset[GeometryType] = frozenset()

    supported_modalities = frozenset({"image"})

    targets = self_target(FORMAT_NAME, supported_geometries)

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
        assignment: SplitAssignment | None,
    ) -> None:
        folds = folds_of(manifest, assignment) if assignment is not None else None
        root = new_document()
        write_meta(
            root,
            name=release.tag,
            size=len(manifest.assets),
            mode="annotation",
            classes=manifest.classes,
        )
        for identity, asset in enumerate(manifest.assets):
            width, height = dimensions_of(asset)
            name = image_name(asset, image_suffix(asset, content))
            subset = DEFAULT_SUBSET if folds is None else folds[asset.asset_id]
            image = ElementTree.SubElement(
                root,
                "image",
                {
                    "id": str(identity),
                    "name": name,
                    "subset": subset,
                    "width": str(width),
                    "height": str(height),
                },
            )
            for annotation in asset.annotations:
                kind = GeometryType(annotation.geometry.type)
                if kind not in self.supported_geometries:
                    continue
                source = SOURCES[annotation.provenance]
                if kind is GeometryType.CLASSIFICATION_TAG:
                    tag = ElementTree.SubElement(
                        image, "tag", {"label": annotation.label_class, "source": source}
                    )
                    write_values(tag, annotation)
                    continue
                write_shape(image, annotation, {"label": annotation.label_class, "source": source})
        require_writable(root)
        for asset in manifest.assets:
            write_image(asset, dest / IMAGES_DIRNAME, content)
        save(root, dest / DOCUMENT_FILENAME)


__all__ = ["CvatImagesExporter", "CvatImagesImporter"]
