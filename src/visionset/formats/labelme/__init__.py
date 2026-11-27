# usage: from visionset.formats.labelme import LabelmeExporter, LabelmeImporter
"""LabelMe JSON: one document per picture, beside it, holding its shapes in pixels.

**Out.** Each picture is written as ``<hash>.<ext>`` with ``<hash>.json`` beside
it, at the top of the export for a release without a split recipe and under
``<fold>/`` for one with. The document carries every key LabelMe's own loader
reads: ``version`` (:data:`LABELME_VERSION`, the schema written, not a tool
that wrote it), ``flags`` (empty), ``shapes``, ``imagePath`` (the picture's
file name), ``imageData`` (``null``: the picture is linked, not embedded),
``imageHeight`` and ``imageWidth``. A box is a ``rectangle`` of its top-left and
bottom-right corners and a polygon a ``polygon`` of its vertices, each
coordinate written as stored. A shape's ``flags`` are its boolean attribute
values and its ``description`` its string attribute ``description``;
``group_id`` and ``mask`` are ``null``.

``lossy``: confidence, provenance, and attribute values other than booleans and
``description`` have nowhere to go. Rotated boxes, polylines, masks, tags and
3D geometry are dropped, and the compatibility report says so before anything
is written.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final

from visionset.formats._layout import dimensions_of, folds_of, write_image
from visionset.formats._targets import self_target
from visionset.formats.labelme.reader import DESCRIPTION
from visionset.formats.labelme.reader import LabelmeImporter as LabelmeImporter
from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    Release,
    SplitAssignment,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

FORMAT_NAME: Final = "labelme"
LABELME_VERSION: Final = "5.5.0"


class LabelmeExporter:
    """Writes a release as LabelMe JSON documents beside their pictures."""

    format_name = FORMAT_NAME

    lossy = True

    supported_geometries = frozenset({GeometryType.BBOX, GeometryType.POLYGON})

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
        declared = {one.name for one in manifest.classes}
        folds = folds_of(manifest, assignment) if assignment is not None else None
        for asset in manifest.assets:
            into = dest if folds is None else dest / folds[asset.asset_id]
            document = _document(asset, declared)
            name = write_image(asset, into, content)
            document["imagePath"] = name
            (into / f"{Path(name).stem}.json").write_text(
                json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
                encoding="utf-8",
            )


def _document(asset: ManifestAsset, declared: set[str]) -> dict[str, Any]:
    width, height = dimensions_of(asset)
    shapes: list[dict[str, Any]] = []
    for annotation in asset.annotations:
        if annotation.label_class not in declared:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
                f"which the release's schema does not declare"
            )
        shape = _shape(annotation)
        if shape is not None:
            shapes.append(shape)
    return {
        "version": LABELME_VERSION,
        "flags": {},
        "shapes": shapes,
        "imagePath": "",
        "imageData": None,
        "imageHeight": height,
        "imageWidth": width,
    }


def _shape(annotation: ManifestAnnotation) -> dict[str, Any] | None:
    geometry = annotation.geometry
    if isinstance(geometry, BboxGeometry):
        shape_type = "rectangle"
        points = [
            [geometry.x, geometry.y],
            [geometry.x + geometry.width, geometry.y + geometry.height],
        ]
    elif isinstance(geometry, PolygonGeometry):
        shape_type = "polygon"
        points = [[x, y] for x, y in geometry.points]
    else:
        return None
    description = annotation.attributes.get(DESCRIPTION)
    flags: dict[str, bool] = {
        name: value
        for name, value in annotation.attributes.items()
        if isinstance(value, bool) and name != DESCRIPTION
    }
    return {
        "label": annotation.label_class,
        "points": points,
        "group_id": None,
        "description": description if isinstance(description, str) else "",
        "shape_type": shape_type,
        "flags": flags,
        "mask": None,
    }


__all__ = ["LabelmeExporter", "LabelmeImporter"]
