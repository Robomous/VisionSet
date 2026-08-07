# usage: from visionset.formats.voc import VocExporter
"""Pascal VOC: one XML per image, and an ``ImageSets`` index per fold.

The third exporter, and the interchange format the wider ecosystem expects. It
is also the smallest, because #62 and #63 already paid for it: fold assignment,
content-hash naming, the image-signature sniff and the required-dimensions check
all live in :mod:`visionset.formats._layout`, and #65 owns the compatibility
report. What is left is the document.

**Coordinates are 1-based and inclusive, which is what "Pascal VOC" means.** The
original devkit's annotations index from 1, and evaluation code written against
them subtracts one — detectron2's VOC loader does exactly that, with a comment
saying why. A box stored here as ``x=8, width=16`` covers 0-based pixels 8..23, so
it is written ``<xmin>9</xmin><xmax>24</xmax>``: sixteen pixels, counted the way
the format counts them. Writing the domain's own numbers straight through would
be off by one against every consumer that assumes the devkit, and off by one is
the error nobody notices.

**One value is a constant rather than a measurement**, and it is
``<depth>3</depth>``. VisionSet records an asset's width and height and not its
channel count, so there is nothing to read; VOC readers expect the element, and
consumers universally ignore it. Said out loud rather than dressed up.

``lossy = True`` and ``supported_geometries`` is ``{bbox}``: the ``<object>``
element has a fixed schema its consumers index by tag name, so there is nowhere to
put an attribute, a confidence or a provenance — unlike COCO, where JSON's
tolerance for unknown keys is what makes that format lossless. A polygon is still
exported, as its bounding box, which is why ``degraded_geometries`` is
``{polygon}``; a classification tag is dropped. #65's report names both, by class
and with a count, before anything is written — and since #158 it names them
differently, because "reduced to a box" and "absent" are not the same thing to
consent to.
"""

from __future__ import annotations

import xml.etree.ElementTree as ElementTree
from math import ceil, floor
from pathlib import Path
from typing import Final

from visionset.formats._layout import (
    FOLDS,
    dimensions_of,
    folds_of,
    write_image,
)
from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    Release,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

#: VOC's own three directories, and the names are the contract.
#:
#: A reader locates an annotation by replacing ``JPEGImages`` with ``Annotations``
#: and the suffix with ``.xml``, exactly as ultralytics substitutes ``labels`` for
#: ``images`` — so these are load-bearing rather than decorative. ``JPEGImages``
#: holds PNGs too, and always has: the name is historical and every tool expects
#: it.
IMAGES_DIRNAME: Final = "JPEGImages"
ANNOTATIONS_DIRNAME: Final = "Annotations"
IMAGE_SETS_DIRNAME: Final = "ImageSets"

#: Where the per-fold index lives. ``Main`` is the detection task's set; VOC also
#: has ``Segmentation``, ``Layout`` and ``Action``, and this format writes none of
#: them because it writes no segmentation, no parts and no actions.
IMAGE_SETS_TASK: Final = "Main"

#: Channels, declared because VOC readers expect the element and VisionSet
#: measures no such thing. See the module docstring.
DEPTH: Final = 3


class VocExporter:
    """Writes a release as a Pascal VOC detection dataset."""

    format_name = "voc"

    #: A VOC ``<object>`` has a fixed set of children its consumers index by tag
    #: name, so attributes, confidence and provenance have nowhere to go. COCO can
    #: carry them because JSON readers ignore keys they do not know; VOC's do not
    #: have that convention, and inventing one would produce a document that is
    #: only readable by us.
    lossy = True

    #: Boxes, and only boxes arrive intact.
    supported_geometries = frozenset({GeometryType.BBOX})

    #: Polygons, written as their axis-aligned bounding box. #158: this exporter
    #: has always done it and the report used to call it a removal. A
    #: classification tag has no location for VOC to record at all, so it stays
    #: outside both sets and is genuinely dropped.
    degraded_geometries = frozenset({GeometryType.POLYGON})

    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        declared = {one.name for one in manifest.classes}
        folds = folds_of(release, manifest)
        members: dict[str, list[str]] = {fold: [] for fold in FOLDS}

        images = dest / IMAGES_DIRNAME
        annotations = dest / ANNOTATIONS_DIRNAME
        annotations.mkdir(parents=True, exist_ok=True)

        for asset in manifest.assets:
            # **One flat directory for every fold**, unlike YOLO and COCO. VOC
            # splits by *listing* rather than by layout: `ImageSets/Main/val.txt`
            # names the stems that belong to the fold, and a reader resolves each
            # against the one `JPEGImages`. Two assets in different folds must not
            # be in different directories, or every path in those files is wrong.
            name = write_image(asset, images, content)
            stem = Path(name).stem
            members[folds[asset.asset_id]].append(stem)
            _write_annotation(annotations / f"{stem}.xml", asset, name, release, declared)

        sets = dest / IMAGE_SETS_DIRNAME / IMAGE_SETS_TASK
        sets.mkdir(parents=True, exist_ok=True)
        for fold, stems in members.items():
            if not stems:
                continue
            # Sorted, so the file is stable whatever order the manifest happened
            # to be walked in — the manifest is canonical already, but a fold's
            # listing is the one artifact here a person diffs.
            sets.joinpath(f"{fold}.txt").write_text(
                "".join(f"{stem}\n" for stem in sorted(stems)), encoding="utf-8"
            )


def _write_annotation(
    target: Path,
    asset: ManifestAsset,
    filename: str,
    release: Release,
    declared: set[str],
) -> None:
    """One image's XML document.

    ``<folder>`` and ``<path>`` are what the original devkit wrote and what some
    readers still look at. ``<path>`` is deliberately **relative** — the devkit's
    was absolute, naming a directory on somebody's 2007 workstation, which is
    information no consumer can use and this build does not have.
    """
    width, height = dimensions_of(asset)
    root = ElementTree.Element("annotation")
    ElementTree.SubElement(root, "folder").text = IMAGES_DIRNAME
    ElementTree.SubElement(root, "filename").text = filename
    ElementTree.SubElement(root, "path").text = f"{IMAGES_DIRNAME}/{filename}"

    source = ElementTree.SubElement(root, "source")
    ElementTree.SubElement(source, "database").text = f"VisionSet release {release.tag}"

    size = ElementTree.SubElement(root, "size")
    ElementTree.SubElement(size, "width").text = str(width)
    ElementTree.SubElement(size, "height").text = str(height)
    ElementTree.SubElement(size, "depth").text = str(DEPTH)

    # Zero always: this format writes no segmentation masks, and a `1` tells a
    # reader to go looking for one in `SegmentationObject/`.
    ElementTree.SubElement(root, "segmented").text = "0"

    for annotation in asset.annotations:
        box = _as_box(annotation, asset, declared)
        if box is None:
            continue
        _append_object(root, annotation.label_class, box, width, height)

    ElementTree.indent(root, space="  ")
    ElementTree.ElementTree(root).write(target, encoding="utf-8", xml_declaration=True)


def _append_object(
    root: ElementTree.Element,
    label_class: str,
    box: BboxGeometry,
    width: int,
    height: int,
) -> None:
    """One ``<object>``, with the four children every VOC reader indexes by name.

    ``pose``, ``truncated`` and ``difficult`` are required by the devkit's own
    parser and are written with the values that mean "not recorded" and "no".
    ``difficult`` matters more than it looks: VOC's evaluation *excludes* objects
    marked ``1`` from both the ground truth and the false positives, so writing a
    ``1`` anywhere would silently change what a score means.
    """
    element = ElementTree.SubElement(root, "object")
    ElementTree.SubElement(element, "name").text = label_class
    ElementTree.SubElement(element, "pose").text = "Unspecified"
    ElementTree.SubElement(element, "truncated").text = "0"
    ElementTree.SubElement(element, "difficult").text = "0"

    xmin, ymin, xmax, ymax = _voc_box(box, width, height)
    bounds = ElementTree.SubElement(element, "bndbox")
    ElementTree.SubElement(bounds, "xmin").text = str(xmin)
    ElementTree.SubElement(bounds, "ymin").text = str(ymin)
    ElementTree.SubElement(bounds, "xmax").text = str(xmax)
    ElementTree.SubElement(bounds, "ymax").text = str(ymax)


def _voc_box(box: BboxGeometry, width: int, height: int) -> tuple[int, int, int, int]:
    """The domain's float box as VOC's four 1-based inclusive integers.

    Three conversions at once, and each is a way to be wrong:

    - **Clamped into the image.** The domain allows a box to hang off an edge —
      an annotator dragging past the border produces a legitimate stored label —
      and a VOC reader given ``xmax`` beyond ``width`` either crashes or trains on
      a crop nobody drew.
    - **Rounded outwards**, ``floor`` on the near edge and ``ceil`` on the far
      one, so the integer box covers every pixel the float box touches. Rounding
      to nearest would shrink a box by up to a pixel on each side, which matters
      for the small objects a detector is worst at.
    - **Shifted to 1-based**, which is the format's own indexing. See the module
      docstring; this is the conversion that is invisible when it is wrong.

    A degenerate box — one whose extent rounds away entirely, or which sits
    outside the image — still yields ``xmax >= xmin``, because a VOC reader
    computing ``xmax - xmin`` on an inverted box gets a negative area and behaves
    unpredictably rather than refusing.
    """
    left = max(0.0, min(box.x, float(width)))
    top = max(0.0, min(box.y, float(height)))
    right = max(left, min(box.x + box.width, float(width)))
    bottom = max(top, min(box.y + box.height, float(height)))

    xmin = floor(left) + 1
    ymin = floor(top) + 1
    xmax = max(xmin, min(ceil(right), width))
    ymax = max(ymin, min(ceil(bottom), height))
    return xmin, ymin, xmax, ymax


def _as_box(
    annotation: ManifestAnnotation, asset: ManifestAsset, declared: set[str]
) -> BboxGeometry | None:
    """The box this annotation contributes, or ``None`` if it contributes none."""
    if annotation.label_class not in declared:
        # Cannot happen — `SchemaChangeWouldOrphan` refuses to remove a class
        # annotations depend on — but an `<object>` naming a class the release
        # does not declare would be a silent lie in a file read as ground truth.
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
            f"which the release's schema does not declare"
        )

    geometry = annotation.geometry
    if isinstance(geometry, BboxGeometry):
        return geometry
    if isinstance(geometry, PolygonGeometry):
        xs = [x for x, _ in geometry.points]
        ys = [y for _, y in geometry.points]
        return BboxGeometry(x=min(xs), y=min(ys), width=max(xs) - min(xs), height=max(ys) - min(ys))
    # A classification tag: no location, and VOC's `<object>` is a location.
    return None
