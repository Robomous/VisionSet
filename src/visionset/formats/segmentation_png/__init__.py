# usage: from visionset.formats.segmentation_png import SegmentationPngExporter
"""Semantic segmentation as class-index PNGs: one greyscale mask per picture, and a descriptor.

The layout is ``images/<fold>/<content hash>.<ext>`` beside
``masks/<fold>/<content hash>.png``, and :data:`DESCRIPTOR_FILENAME` at the top
saying how to read the masks, so :class:`SegmentationPngImporter` reads an
export back with nothing guessed.

**Ids.** Every class whose declared geometries include a mask or a polygon gets
an id, ``1`` upward in the schema's order; ``0`` is background and nothing is
ignore. Each mask is a single-channel PNG whose grey level is the id: 8-bit
(``L``) when every id fits in 255, 16-bit (``I;16``) otherwise.

**What is written.** A mask is written pixel for pixel. A polygon is rasterized
at the picture's size, lighting the pixels whose centres it holds, so detail
finer than a pixel is lost and it is declared degraded. A box, a tag and every
other geometry are dropped: a box says where something is, not which pixels it
covers. A class map holds one class per pixel, so several masks of one class on
one picture are written as their union, and a pixel two classes claim takes the
lower id; each picture where that happened is recorded under
``visionset.overlaps`` in the descriptor, with the contested pixels and the
classes involved. Attributes, confidence and provenance
have nowhere to go, so the format is lossy.

COCO panoptic layouts and colour-encoded masks beyond an explicit palette are
not read or written.
"""

from __future__ import annotations

import json
import sys
from array import array
from pathlib import Path
from typing import Any, Final

from visionset.formats._layout import FOLDS, IMAGES_DIRNAME, dimensions_of, folds_of, write_image
from visionset.formats._targets import self_target
from visionset.formats.segmentation_png.reader import (
    DESCRIPTOR_FILENAME,
    DESCRIPTOR_VERSION,
    FORMAT_NAME,
    MASK_SUFFIX,
    MAX_CLASS_ID,
    SegmentationDescriptor,
    SegmentationPngImporter,
    read_class_map,
    read_descriptor,
)
from visionset.kernel.domain import (
    GeometryType,
    Manifest,
    ManifestAsset,
    MaskEncodingError,
    MaskGeometry,
    PolygonGeometry,
    Release,
    SplitAssignment,
    compose_class_map,
    rasterize_polygon,
)
from visionset.kernel.domain.rle import check_mask_size
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

MASKS_DIRNAME: Final = "masks"
BACKGROUND: Final = 0
_WRITTEN: Final = frozenset({GeometryType.MASK, GeometryType.POLYGON})

__all__ = [
    "BACKGROUND",
    "DESCRIPTOR_FILENAME",
    "MASKS_DIRNAME",
    "SegmentationDescriptor",
    "SegmentationPngExporter",
    "SegmentationPngImporter",
    "read_class_map",
    "read_descriptor",
]


class SegmentationPngExporter:
    """Writes a release's masks and polygons as class-index PNGs and a descriptor."""

    format_name = FORMAT_NAME

    lossy = True

    supported_geometries = frozenset({GeometryType.MASK})

    #: Rasterized at pixel centres: what is finer than a pixel is lost.
    degraded_geometries = frozenset({GeometryType.POLYGON})

    supported_modalities = frozenset({"image"})

    targets = self_target(FORMAT_NAME, frozenset({GeometryType.MASK, GeometryType.POLYGON}))

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
        assignment: SplitAssignment | None,
    ) -> None:
        written = [one.name for one in manifest.classes if _WRITTEN & set(one.geometries)]
        if len(written) > MAX_CLASS_ID:
            raise ExportSourceUnreadable(
                f"the release declares {len(written)} classes with masks or polygons, more than "
                f"the {MAX_CLASS_ID} ids a 16-bit PNG holds"
            )
        ids = {name: index for index, name in enumerate(written, start=1)}
        declared = {one.name for one in manifest.classes}
        mode = "L" if len(written) <= 255 else "I;16"
        folds = folds_of(manifest, assignment)
        overlaps: list[dict[str, Any]] = []
        for asset in manifest.assets:
            fold = folds[asset.asset_id]
            write_image(asset, dest / IMAGES_DIRNAME / fold, content)
            target = dest / MASKS_DIRNAME / fold / f"{asset.content_hash}{MASK_SUFFIX}"
            lost = _write_mask(asset, ids, declared, mode, target)
            if lost is not None:
                pixels, classes = lost
                overlaps.append(
                    {
                        "mask": target.relative_to(dest).as_posix(),
                        "pixels": pixels,
                        "classes": [written[class_id - 1] for class_id in sorted(classes)],
                    }
                )
        present = set(folds.values())
        descriptor = {
            "format": FORMAT_NAME,
            "version": DESCRIPTOR_VERSION,
            "encoding": "index",
            "classes": {str(class_id): name for name, class_id in ids.items()},
            "background": [BACKGROUND],
            "ignore": [],
            "images": IMAGES_DIRNAME,
            "masks": MASKS_DIRNAME,
            "splits": [fold for fold in FOLDS if fold in present],
            "visionset": {
                "release_id": str(release.id),
                "release_tag": release.tag,
                "manifest_hash": release.manifest_hash,
                "overlaps": overlaps,
            },
        }
        (dest / DESCRIPTOR_FILENAME).write_text(
            json.dumps(descriptor, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )


def _write_mask(
    asset: ManifestAsset,
    ids: dict[str, int],
    declared: set[str],
    mode: str,
    target: Path,
) -> tuple[int, frozenset[int]] | None:
    """Write one picture's class map; the pixels and ids two classes contested, if any."""
    from PIL import Image

    width, height = dimensions_of(asset)
    try:
        check_mask_size(height, width)
    except MaskEncodingError as exc:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} cannot have a class map: {exc}"
        ) from None
    pairs: list[tuple[int, MaskGeometry]] = []
    for annotation in asset.annotations:
        name = annotation.label_class
        if name not in declared:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} carries class {name!r}, "
                "which the release's schema does not declare"
            )
        geometry = annotation.geometry
        if not isinstance(geometry, MaskGeometry | PolygonGeometry):
            continue
        if name not in ids:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} carries a {geometry.type.value} of class {name!r}, "
                "which the release's schema does not declare one for"
            )
        if isinstance(geometry, PolygonGeometry):
            geometry = rasterize_polygon(geometry, height=height, width=width)
        elif geometry.size != (height, width):
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} carries a {geometry.size[0]} by {geometry.size[1]} "
                "mask, which is not the size of its picture"
            )
        pairs.append((ids[name], geometry))
    composition = compose_class_map(pairs, height=height, width=width, fill=BACKGROUND)
    if mode == "L":
        data = bytes(composition.values)
    else:
        wide = array("H", composition.values)
        if sys.byteorder == "big":
            wide.byteswap()
        data = wide.tobytes()
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.frombytes(mode, (width, height), data).save(target, format="PNG")
    if not composition.overlapping_pixels:
        return None
    return composition.overlapping_pixels, composition.overlapping_classes
