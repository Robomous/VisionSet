# usage: from visionset.formats.yolo_obb import YoloObbImporter
"""Ultralytics OBB in: ``data.yaml`` and rows of a class index and four normalized corners.

The inverse of :class:`YoloObbExporter`. The descriptor and the layout are read
as the ``ultralytics`` importer reads them; each row must be a class index and
exactly eight numbers, the corners of a rectangle in order round it from any
start, in either direction, scaled out of the picture's oriented size. Each
becomes a canonical rotated box. A row of any other length, four corners that
are not a rectangle or enclose no area, a class the descriptor does not name and
a box wholly outside its picture are each a lost label. The split is not imported.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from visionset.formats._obb import NOT_FINITE, read_corners
from visionset.formats._reading import Losses, index, number
from visionset.formats._yolo_reader import (
    Descriptor,
    descriptor_file,
    read_label_layout,
    yaml_descriptor,
)
from visionset.formats._yolo_writer import DATA_FILENAME
from visionset.kernel.domain import (
    GeometryType,
    ImportedDataset,
    ImportedLabel,
    ImportLossKind,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.errors import ImportSourceUnreadable

_LABEL: Final = "YOLO OBB"
_CORNER_VALUES: Final = 8


class YoloObbImporter:
    """Reads an Ultralytics OBB dataset into an ``ImportedDataset``."""

    format_name = "yolo-obb"

    def read(self, src: Path) -> ImportedDataset:
        descriptor = descriptor_file(src, DATA_FILENAME, _LABEL)
        if descriptor is None:
            raise ImportSourceUnreadable(
                f"the YOLO OBB source {src.name!r} holds no {DATA_FILENAME} nor a single YAML "
                "file at its top"
            )
        return read_label_layout(
            src,
            yaml_descriptor(descriptor),
            _LABEL,
            parse=_label,
            default_geometry=GeometryType.OBB,
        )


def _label(
    row: tuple[str, list[str]],
    descriptor: Descriptor,
    size: tuple[int, int] | None,
    geometries: dict[str, set[GeometryType]],
    losses: Losses,
) -> ImportedLabel | None:
    where, tokens = row
    position = index(tokens[0])
    if position is None:
        losses[(ImportLossKind.LABEL, "label row", "its class is not a whole number")] += 1
        return None
    name = descriptor.names.get(position)
    if name is None:
        losses[
            (ImportLossKind.LABEL, f"class {position}", "the descriptor names no such class")
        ] += 1
        return None
    if len(tokens) - 1 != _CORNER_VALUES:
        losses[(ImportLossKind.LABEL, name, "its row is not a class and four corners")] += 1
        return None
    values = [number(token, where) for token in tokens[1:]]
    if any(value is None for value in values):
        losses[(ImportLossKind.LABEL, name, NOT_FINITE)] += 1
        return None
    if size is None:
        losses[
            (
                ImportLossKind.LABEL,
                name,
                "its picture cannot be measured, so normalized coordinates cannot be scaled",
            )
        ] += 1
        return None
    width, height = size
    coordinates = [float(value) for value in values if value is not None]
    points = tuple(
        (x * width, y * height) for x, y in zip(coordinates[::2], coordinates[1::2], strict=True)
    )
    geometry, refusal = read_corners(points)
    if geometry is None:
        losses[(ImportLossKind.LABEL, name, refusal)] += 1
        return None
    if not geometry_intersects_asset(geometry, width=width, height=height):
        losses[(ImportLossKind.LABEL, name, "it lies wholly outside its picture")] += 1
        return None
    geometries[name].add(geometry.type)
    return ImportedLabel(class_name=name, geometry=geometry)


__all__ = ["YoloObbImporter"]
