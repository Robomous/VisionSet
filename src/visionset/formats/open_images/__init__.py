# usage: from visionset.formats.open_images import OpenImagesExporter, OpenImagesImporter
"""Open Images box annotations: a normalized-corner CSV per split and a class descriptions file.

**Out.** :data:`DESCRIPTIONS_FILENAME` at the top of the export, ``LabelName,
DisplayName`` with its header, one row per declared class, both columns the
class's name: VisionSet holds no Open Images MID to write. Beside it one
``<split>-annotations-bbox.csv`` per split holding pictures, with the
:data:`~visionset.formats.open_images.reader.COLUMNS` header, and the pictures
as ``<split>/<hash>.<ext>``; the hash is the ``ImageID``. ``train`` holds
everything for a release without a split recipe; ``val`` is written
``validation``, as Open Images names it.

A box is one row: ``XMin``, ``XMax``, ``YMin`` and ``YMax`` its corners
divided by the picture's recorded size (the far corner first rounded to
:data:`~visionset.formats.open_images.reader.PRECISION` decimals of a pixel),
written as the shortest decimal that reads back as that float, never clamped.
``Source`` is blank, ``Confidence`` the label's or ``1``, and each ``Is*``
flag ``1`` or ``0`` from a boolean attribute of that name, ``-1`` (unknown)
without one.

``lossy``: other attributes and provenance have nowhere to go. Polygons,
rotated boxes, polylines, masks, tags and 3D geometry are dropped, and the
compatibility report says so before anything is written.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Final

from visionset.formats._layout import dimensions_of, folds_of, write_image
from visionset.formats._targets import self_target
from visionset.formats.open_images.reader import (
    BOXES_SUFFIX,
    COLUMNS,
    DESCRIPTION_COLUMNS,
    FLAGS,
    PRECISION,
)
from visionset.formats.open_images.reader import OpenImagesImporter as OpenImagesImporter
from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    Manifest,
    ManifestAsset,
    Release,
    SplitAssignment,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

FORMAT_NAME: Final = "open-images"
DESCRIPTIONS_FILENAME: Final = "class-descriptions-boxable.csv"

#: VisionSet's fold names, as Open Images names its splits.
SPLITS: Final = {"train": "train", "val": "validation", "test": "test"}


class OpenImagesExporter:
    """Writes a release as Open Images box CSVs beside their pictures."""

    format_name = FORMAT_NAME

    lossy = True

    supported_geometries = frozenset({GeometryType.BBOX})

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
        dest.mkdir(parents=True, exist_ok=True)
        with (dest / DESCRIPTIONS_FILENAME).open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(DESCRIPTION_COLUMNS)
            writer.writerows((one.name, one.name) for one in manifest.classes)

        declared = {one.name for one in manifest.classes}
        folds = folds_of(manifest, assignment)
        rows: dict[str, list[list[str]]] = {}
        for asset in manifest.assets:
            split = SPLITS[folds[asset.asset_id]]
            written = _rows(asset, declared)
            write_image(asset, dest / split, content)
            rows.setdefault(split, []).extend(written)
        if not rows:
            rows[SPLITS["train"]] = []
        for split, split_rows in rows.items():
            path = dest / f"{split}{BOXES_SUFFIX}"
            with path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle, lineterminator="\n")
                writer.writerow(COLUMNS)
                writer.writerows(split_rows)


def _rows(asset: ManifestAsset, declared: set[str]) -> list[list[str]]:
    rows: list[list[str]] = []
    for annotation in asset.annotations:
        if annotation.label_class not in declared:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
                f"which the release's schema does not declare"
            )
        geometry = annotation.geometry
        if not isinstance(geometry, BboxGeometry):
            continue
        width, height = dimensions_of(asset)
        flags = [
            "-1" if not isinstance(value, bool) else str(int(value))
            for value in (annotation.attributes.get(flag) for flag in FLAGS)
        ]
        rows.append(
            [
                asset.content_hash,
                "",
                annotation.label_class,
                "1" if annotation.confidence is None else _number(annotation.confidence),
                _number(geometry.x / width),
                _number(round(geometry.x + geometry.width, PRECISION) / width),
                _number(geometry.y / height),
                _number(round(geometry.y + geometry.height, PRECISION) / height),
                *flags,
            ]
        )
    return rows


def _number(value: float) -> str:
    return repr(value + 0.0)


__all__ = ["DESCRIPTIONS_FILENAME", "OpenImagesExporter", "OpenImagesImporter"]
