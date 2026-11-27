# usage: from visionset.formats.yolo_obb import YoloObbExporter, YoloObbImporter
"""The Ultralytics OBB dialect: ``class x1 y1 x2 y2 x3 y3 x4 y4`` per rotated box.

The layout of the ``ultralytics`` detection export — ``images/<fold>``,
``labels/<fold>``, one label file per picture (empty when it holds nothing) and
a ``data.yaml`` naming the folds and the classes by index in the release's
frozen schema order — with a row that is a class index and the rotated box's
four corners in order round the rectangle, each a fraction of the picture's
width or height. Ultralytics' OBB models (``yolo11n-obb`` and its siblings)
train on it.

**Rotated boxes only.** Every other geometry is dropped and the export report
says so; nothing is converted. A four-point polygon that happens to be a
rectangle is a polygon, and is dropped like any other. Corners are written to
twelve decimals and are not clamped into the picture, because clamping one
corner of a rotated box that crosses the edge bends it into a shape that is no
longer a rectangle; Ultralytics' own DOTA converter does not clamp either.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Final

from visionset.formats._layout import dimensions_of
from visionset.formats._obb import decimal, obb_of
from visionset.formats._targets import self_target
from visionset.formats._yolo_writer import (
    DATA_FILENAME,
    LABELS_DIRNAME,
    class_index,
    class_names,
    write_data_yaml,
    write_label_layout,
)
from visionset.formats.yolo_obb.reader import YoloObbImporter
from visionset.kernel.domain import (
    GeometryType,
    Manifest,
    ManifestAsset,
    Release,
    SplitAssignment,
    obb_corners,
)
from visionset.kernel.ports import ContentReader

__all__ = ["DATA_FILENAME", "LABELS_DIRNAME", "YoloObbExporter", "YoloObbImporter"]

#: Twelve decimals of a fraction keep a box drawn on a picture a hundred thousand
#: pixels wide a rectangle to within the reader's tolerance.
PRECISION: Final = 12


class YoloObbExporter:
    """Writes a release's rotated boxes as an Ultralytics OBB dataset."""

    format_name = "yolo-obb"

    #: A row is a class index and four corners: every other geometry, attributes,
    #: confidence and provenance are dropped.
    lossy = True

    supported_geometries = frozenset({GeometryType.OBB})

    degraded_geometries: frozenset[GeometryType] = frozenset()

    supported_modalities = frozenset({"image"})

    targets = self_target("yolo-obb", frozenset({GeometryType.OBB}))

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
        assignment: SplitAssignment | None,
    ) -> None:
        folds = write_label_layout(manifest, dest, content, assignment, obb_rows)
        if folds:
            write_data_yaml(dest / DATA_FILENAME, class_names(manifest), folds)


def obb_rows(asset: ManifestAsset, index_of: Mapping[str, int]) -> Iterable[str]:
    """``class x1 y1 x2 y2 x3 y3 x4 y4`` per rotated box, as fractions of the picture."""
    width, height = dimensions_of(asset)
    for annotation in asset.annotations:
        index = class_index(asset, annotation, index_of)
        geometry = obb_of(annotation)
        if geometry is None:
            continue
        values = (
            decimal(value, PRECISION)
            for x, y in obb_corners(geometry)
            for value in (x / width, y / height)
        )
        yield f"{index} {' '.join(values)}"
