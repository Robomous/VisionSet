# usage: from visionset.formats.createml import CreatemlExporter, CreatemlImporter
"""Apple Create ML object-detection JSON: one array per folder, centre-based boxes in pixels.

Only Create ML's object-detection annotation schema, not its other tasks.

**Out.** Each picture is written as ``<hash>.<ext>`` beside one
:data:`ANNOTATIONS_FILENAME`, at the top of the export for a release without a
split recipe and under ``<fold>/`` for one with, so each folder is a Create ML
data source of its own. The file is a JSON array with one entry per picture,
labelled or not, ``{"image": <file name>, "annotations": [...]}``, and each
box an annotation ``{"label": <class>, "coordinates": {"x", "y", "width",
"height"}}`` whose ``x`` and ``y`` are its centre, in pixels, ``y`` downward,
rounded to :data:`~visionset.formats.createml.reader.PRECISION` decimals so
the file holds no float noise and the importer recovers the stored corner.

``lossy``: attributes, confidence and provenance have nowhere to go. Polygons,
rotated boxes, polylines, masks, tags and 3D geometry are dropped, and the
compatibility report says so before anything is written.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final

from visionset.formats._layout import folds_of, write_image
from visionset.formats._targets import self_target
from visionset.formats.createml.reader import PRECISION
from visionset.formats.createml.reader import CreatemlImporter as CreatemlImporter
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

FORMAT_NAME: Final = "createml"
ANNOTATIONS_FILENAME: Final = "annotations.json"


class CreatemlExporter:
    """Writes a release as Create ML object-detection JSON beside its pictures."""

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
        declared = {one.name for one in manifest.classes}
        folds = folds_of(manifest, assignment) if assignment is not None else None
        documents: dict[Path, list[dict[str, Any]]] = {}
        for asset in manifest.assets:
            into = dest if folds is None else dest / folds[asset.asset_id]
            annotations = _annotations(asset, declared)
            name = write_image(asset, into, content)
            documents.setdefault(into, []).append({"image": name, "annotations": annotations})
        if not documents:
            documents[dest] = []
        for into, entries in documents.items():
            into.mkdir(parents=True, exist_ok=True)
            (into / ANNOTATIONS_FILENAME).write_text(
                json.dumps(entries, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
                encoding="utf-8",
            )


def _annotations(asset: ManifestAsset, declared: set[str]) -> list[dict[str, Any]]:
    written: list[dict[str, Any]] = []
    for annotation in asset.annotations:
        if annotation.label_class not in declared:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
                f"which the release's schema does not declare"
            )
        geometry = annotation.geometry
        if not isinstance(geometry, BboxGeometry):
            continue
        written.append(
            {
                "label": annotation.label_class,
                "coordinates": {
                    "x": round(geometry.x + geometry.width / 2, PRECISION) + 0.0,
                    "y": round(geometry.y + geometry.height / 2, PRECISION) + 0.0,
                    "width": geometry.width,
                    "height": geometry.height,
                },
            }
        )
    return written


__all__ = ["ANNOTATIONS_FILENAME", "CreatemlExporter", "CreatemlImporter"]
