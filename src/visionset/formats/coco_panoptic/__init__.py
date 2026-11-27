# usage: from visionset.formats.coco_panoptic import CocoPanopticExporter, CocoPanopticImporter
"""COCO panoptic: an RGB segment PNG per picture, and a JSON per split saying what each segment is.

Independent of the ``coco`` instances format: its own files, and its PNGs are
segment maps, never class-index masks.

**Out.** ``annotations/panoptic_<fold>.json`` with ``info``, ``licenses``,
``images``, ``annotations`` and ``categories``; ``annotations/panoptic_<fold>/<hash>.png``
per picture; the pictures under ``images/<fold>/``. Every class whose declared
geometries include a mask or a polygon is a category, ids ``1`` upward in the
schema's order, with ``supercategory`` its own name and ``isthing`` ``1``:
VisionSet has no thing/stuff flag, and a mask is one object.

Each mask or polygon of a picture is one segment, ids ``1`` upward in the
manifest's order of its annotations, so two exports of one release agree. The
PNG holds each pixel's segment id as ``R + 256 * G + 65536 * B``, and ``0``,
void, where no segment is. ``segments_info`` gives each segment its
``category_id``, its ``bbox`` and ``area`` read off its pixels, and ``iscrowd``
``0``. A polygon is rasterized at pixel centres, so it is declared degraded;
boxes, tags and every other geometry are dropped, and attributes, confidence
and provenance have nowhere to go, so the format is lossy.

Refused by asset: two segments claiming one pixel, since a panoptic map gives
each pixel one owner; a mask or polygon covering no pixel; a mask not the size
of its picture.
"""

from __future__ import annotations

import json
from array import array
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Final

from visionset import __version__
from visionset.formats._layout import FOLDS, IMAGES_DIRNAME, dimensions_of, folds_of, write_image
from visionset.formats._targets import self_target
from visionset.formats.coco_panoptic.reader import (
    ANNOTATIONS_DIRNAME,
    FORMAT_NAME,
    MAX_SEGMENT_ID,
    PANOPTIC_PREFIX,
    CocoPanopticImporter,
    read_segment_map,
)
from visionset.kernel.domain import (
    GeometryType,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    MaskEncodingError,
    MaskGeometry,
    PolygonGeometry,
    Release,
    SplitAssignment,
    mask_area,
    mask_bitmap,
    mask_enclosing_box,
    rasterize_polygon,
)
from visionset.kernel.domain.geometry import mask_runs
from visionset.kernel.domain.rle import check_mask_size
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

ISTHING: Final = 1
_WRITTEN: Final = frozenset({GeometryType.MASK, GeometryType.POLYGON})

__all__ = [
    "ANNOTATIONS_DIRNAME",
    "ISTHING",
    "PANOPTIC_PREFIX",
    "CocoPanopticExporter",
    "CocoPanopticImporter",
    "read_segment_map",
    "rgb_of",
]


class CocoPanopticExporter:
    """Writes a release's masks and polygons as COCO panoptic segment PNGs and JSON."""

    format_name = FORMAT_NAME

    lossy = True

    supported_geometries = frozenset({GeometryType.MASK})

    #: Rasterized at pixel centres: what is finer than a pixel is lost.
    degraded_geometries = frozenset({GeometryType.POLYGON})

    supported_modalities = frozenset({"image"})

    targets = self_target(FORMAT_NAME, _WRITTEN)

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
        ids = {name: index for index, name in enumerate(written, start=1)}
        declared = {one.name for one in manifest.classes}
        categories = [
            {"id": category_id, "name": name, "supercategory": name, "isthing": ISTHING}
            for name, category_id in ids.items()
        ]
        folds = folds_of(manifest, assignment)
        present = set(folds.values())
        documents: dict[str, dict[str, Any]] = {
            fold: {
                "info": _info(release, manifest),
                "licenses": [{"id": 1, "name": "unspecified", "url": ""}],
                "images": [],
                "annotations": [],
                "categories": categories,
            }
            for fold in FOLDS
            if fold in present
        }
        for asset in manifest.assets:
            fold = folds[asset.asset_id]
            document = documents[fold]
            image_id = len(document["images"]) + 1
            name = write_image(asset, dest / IMAGES_DIRNAME / fold, content)
            width, height = dimensions_of(asset)
            png = f"{asset.content_hash}.png"
            segments = _write_segments(
                asset,
                ids,
                declared,
                dest / ANNOTATIONS_DIRNAME / f"{PANOPTIC_PREFIX}{fold}" / png,
            )
            document["images"].append(
                {
                    "id": image_id,
                    "file_name": name,
                    "width": width,
                    "height": height,
                    "license": 1,
                }
            )
            document["annotations"].append(
                {"image_id": image_id, "file_name": png, "segments_info": segments}
            )
        for fold, document in documents.items():
            target = dest / ANNOTATIONS_DIRNAME / f"{PANOPTIC_PREFIX}{fold}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
                encoding="utf-8",
            )


def _info(release: Release, manifest: Manifest) -> dict[str, Any]:
    return {
        "description": f"VisionSet release {release.tag}",
        "version": release.tag,
        "year": release.created_at.year,
        "contributor": f"VisionSet {__version__}",
        "date_created": release.created_at.isoformat(),
        "url": "",
        "visionset": {
            "release_id": str(release.id),
            "manifest_hash": release.manifest_hash,
            "manifest_version": manifest.manifest_version,
            "schema_version": manifest.schema_version,
        },
    }


def _write_segments(
    asset: ManifestAsset, ids: dict[str, int], declared: set[str], target: Path
) -> list[dict[str, Any]]:
    """Write one picture's segment PNG, and answer its ``segments_info``."""
    from PIL import Image

    width, height = dimensions_of(asset)
    try:
        total = check_mask_size(height, width)
    except MaskEncodingError as exc:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} cannot have a segment map: {exc}"
        ) from None
    owner = array("I", [0]) * total
    occupied = 0
    drawn: list[tuple[int, ManifestAnnotation]] = []
    segments: list[dict[str, Any]] = []
    for annotation in asset.annotations:
        mask = _mask_of(asset, annotation, ids, declared, width=width, height=height)
        if mask is None:
            continue
        area = mask_area(mask)
        if area == 0:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id}: annotation {annotation.id} ({annotation.label_class!r}) "
                "covers no pixel, and a panoptic segment holds at least one; remove it or "
                "redraw it"
            )
        bits = int.from_bytes(mask_bitmap(mask), "big")
        if bits & occupied:
            other = next(one for held, one in drawn if held & bits)
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id}: annotations {other.id} ({other.label_class!r}) and "
                f"{annotation.id} ({annotation.label_class!r}) claim the same pixels, and a "
                "panoptic segment map gives each pixel one segment; remove the overlap, or "
                "export to coco, which keeps overlapping masks"
            )
        occupied |= bits
        drawn.append((bits, annotation))
        segment_id = len(segments) + 1
        if segment_id > MAX_SEGMENT_ID:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} has more than {MAX_SEGMENT_ID} segments, more than "
                "an RGB segment map holds"
            )
        start = 0
        for index, run in enumerate(mask_runs(mask)):
            if index % 2:
                owner[start : start + run] = array("I", [segment_id]) * run
            start += run
        box = mask_enclosing_box(mask)
        assert box is not None
        segments.append(
            {
                "id": segment_id,
                "category_id": ids[annotation.label_class],
                "area": area,
                "bbox": [int(box.x), int(box.y), int(box.width), int(box.height)],
                "iscrowd": 0,
            }
        )
    row_major = array("I")
    for y in range(height):
        row_major.extend(owner[y::height])
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.frombytes("RGB", (width, height), rgb_of(row_major)).save(target, format="PNG")
    return segments


def rgb_of(ids: Sequence[int]) -> bytes:
    """Segment ids as RGB pixels, ``R + 256 * G + 65536 * B`` each."""
    pixels = bytearray(3 * len(ids))
    pixels[0::3] = bytes(value & 0xFF for value in ids)
    pixels[1::3] = bytes(value >> 8 & 0xFF for value in ids)
    pixels[2::3] = bytes(value >> 16 & 0xFF for value in ids)
    return bytes(pixels)


def _mask_of(
    asset: ManifestAsset,
    annotation: ManifestAnnotation,
    ids: dict[str, int],
    declared: set[str],
    *,
    width: int,
    height: int,
) -> MaskGeometry | None:
    name = annotation.label_class
    if name not in declared:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} carries class {name!r}, "
            "which the release's schema does not declare"
        )
    geometry = annotation.geometry
    if not isinstance(geometry, MaskGeometry | PolygonGeometry):
        return None
    if name not in ids:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} carries a {geometry.type.value} of class {name!r}, "
            "which the release's schema does not declare one for"
        )
    if isinstance(geometry, PolygonGeometry):
        return rasterize_polygon(geometry, height=height, width=width)
    if geometry.size != (height, width):
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} carries a {geometry.size[0]} by {geometry.size[1]} "
            "mask, which is not the size of its picture"
        )
    return geometry
