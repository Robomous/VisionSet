# usage: from visionset.formats._yolo_writer import derive_task, write_label_layout
"""What the YOLO dialects write the same way.

A YOLO dataset is images laid out per fold, one label file per image, and a
descriptor naming the folds and the classes. The two dialects shipped here
differ only in the descriptor's grammar, so the layout, the label arithmetic
and the task derivation live once, here, and each dialect writes its own
``data.yaml`` on top.

Private to :mod:`visionset.formats`, like ``_layout``: importable, but not part
of the ``Exporter`` contract.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Final

from visionset.formats._layout import IMAGES_DIRNAME, dimensions_of, folds_of, write_image
from visionset.kernel.domain import (
    BboxGeometry,
    ClassificationGeometry,
    Geometry,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    Release,
    Task,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

#: Where the label file for an image goes, relative to ``dest``.
#:
#: Ultralytics finds labels by replacing the last ``/images/`` segment of an image
#: path with ``/labels/`` — it is a string substitution on the path, not a
#: configured location — so these two names are load-bearing rather than
#: conventional. Renaming either produces an export that loads with zero labels
#: and no error.
LABELS_DIRNAME: Final = "labels"

DATA_FILENAME: Final = "data.yaml"

HEADER_COMMENT: Final = "# Written by VisionSet. Class order is the release's frozen schema."

#: How many digits a normalized coordinate is written with.
#:
#: Six, which is the format's de-facto convention. It resolves a single pixel
#: on an image up to a million pixels wide, so the rounding is below what the
#: annotation itself can express.
PRECISION: Final = 6

Rows = Callable[[ManifestAsset, Mapping[str, int]], Iterable[str]]
"""How one asset's annotations become label lines: the half a task decides."""


def derive_task(manifest: Manifest, accepted: frozenset[Task]) -> Task:
    """The one task an export of this manifest is written for.

    Derived, never chosen: ``segment`` when the accepting side takes it and any
    polygon is present, ``classify`` when it takes that and the manifest holds
    classification tags and no box or polygon, otherwise ``detect``.
    """
    has_polygon = has_box = has_tag = False
    for asset in manifest.assets:
        for annotation in asset.annotations:
            geometry: Geometry = annotation.geometry
            if isinstance(geometry, PolygonGeometry):
                has_polygon = True
            elif isinstance(geometry, BboxGeometry):
                has_box = True
            elif isinstance(geometry, ClassificationGeometry):
                has_tag = True
    if Task.SEGMENT in accepted and has_polygon:
        return Task.SEGMENT
    if Task.CLASSIFY in accepted and has_tag and not (has_box or has_polygon):
        return Task.CLASSIFY
    return Task.DETECT


def class_names(manifest: Manifest) -> list[str]:
    """Every declared class, in the release's frozen schema order.

    Indices are the positions here, so they are contiguous from zero by
    construction: a class carries no number of its own, and one nobody
    labelled keeps its slot rather than shifting every later index.
    """
    return [declared.name for declared in manifest.classes]


def write_label_layout(
    release: Release,
    manifest: Manifest,
    dest: Path,
    content: ContentReader,
    rows: Rows,
) -> set[str]:
    """Images under ``images/<fold>``, labels under ``labels/<fold>``; answer the folds present."""
    index_of = {name: index for index, name in enumerate(class_names(manifest))}
    folds = folds_of(release, manifest)
    for asset in manifest.assets:
        fold = folds[asset.asset_id]
        write_image(asset, dest / IMAGES_DIRNAME / fold, content)
        _write_labels(
            asset,
            (dest / LABELS_DIRNAME / fold / asset.content_hash).with_suffix(".txt"),
            rows(asset, index_of),
        )
    return set(folds.values())


def _write_labels(asset: ManifestAsset, target: Path, lines: Iterable[str]) -> None:
    """One line per exportable annotation, or an empty file.

    **An asset with nothing to say still gets a file**, and it is empty rather
    than absent: ultralytics reads a missing label file as an unlabelled image
    and an empty one as an image with no objects, and those are different
    training signals. A frame somebody looked at and found nothing in is the
    second.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("".join(f"{row}\n" for row in lines), encoding="utf-8")


def detect_rows(asset: ManifestAsset, index_of: Mapping[str, int]) -> Iterable[str]:
    """``class cx cy w h`` per box; a polygon contributes its axis-aligned bounds."""
    width, height = dimensions_of(asset)
    for annotation in asset.annotations:
        index = class_index(asset, annotation, index_of)
        box = _as_box(annotation)
        if box is None:
            continue
        yield f"{index} {' '.join(_normalized_box(box, width, height))}"


def segment_rows(asset: ManifestAsset, index_of: Mapping[str, int]) -> Iterable[str]:
    """``class x1 y1 … xn yn`` per polygon; a box is written as its four corners."""
    width, height = dimensions_of(asset)
    for annotation in asset.annotations:
        index = class_index(asset, annotation, index_of)
        points = _as_ring(annotation)
        if points is None:
            continue
        yield f"{index} {' '.join(_normalized_points(points, width, height))}"


def class_index(
    asset: ManifestAsset, annotation: ManifestAnnotation, index_of: Mapping[str, int]
) -> int:
    """The index a label row starts with, or refuse a class the schema never declared.

    Publication rejects new inconsistent manifests, but archived or externally
    supplied manifests can still be malformed, and an invented index would
    silently mislabel a file a trainer reads as ground truth.
    """
    index = index_of.get(annotation.label_class)
    if index is None:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
            f"which the release's schema does not declare"
        )
    return index


def _as_box(annotation: ManifestAnnotation) -> BboxGeometry | None:
    """The box this annotation contributes, or ``None`` if it contributes none.

    A polygon becomes its axis-aligned bounding box, reachable only under
    consent because the dialects writing it declare it degraded. A
    classification tag has no location at all, so a detection dataset has
    nowhere to put it and it is dropped rather than given an invented box
    covering the whole image.
    """
    geometry: Geometry = annotation.geometry
    if isinstance(geometry, BboxGeometry):
        return geometry
    if isinstance(geometry, PolygonGeometry):
        xs = [x for x, _ in geometry.points]
        ys = [y for _, y in geometry.points]
        return BboxGeometry(x=min(xs), y=min(ys), width=max(xs) - min(xs), height=max(ys) - min(ys))
    return None


def _as_ring(annotation: ManifestAnnotation) -> list[tuple[float, float]] | None:
    geometry: Geometry = annotation.geometry
    if isinstance(geometry, PolygonGeometry):
        return list(geometry.points)
    if isinstance(geometry, BboxGeometry):
        left, top = geometry.x, geometry.y
        right, bottom = geometry.x + geometry.width, geometry.y + geometry.height
        return [(left, top), (right, top), (right, bottom), (left, bottom)]
    return None


def _normalized_box(box: BboxGeometry, width: int, height: int) -> list[str]:
    """``cx cy w h`` as fractions of the image, clamped into it.

    Clamped because the domain does not require a box to be inside its image —
    an annotator dragging past the edge produces a legitimate stored label — while
    YOLO requires every number in ``[0, 1]`` and ultralytics refuses a dataset
    that breaks it. The centre is clamped after the extent, so a box that hangs
    off an edge keeps as much of itself as fits rather than being moved.
    """
    left = max(0.0, min(box.x, float(width)))
    top = max(0.0, min(box.y, float(height)))
    right = max(left, min(box.x + box.width, float(width)))
    bottom = max(top, min(box.y + box.height, float(height)))
    values = (
        ((left + right) / 2) / width,
        ((top + bottom) / 2) / height,
        (right - left) / width,
        (bottom - top) / height,
    )
    return [f"{value:.{PRECISION}f}" for value in values]


def _normalized_points(points: list[tuple[float, float]], width: int, height: int) -> list[str]:
    """Each vertex as fractions of the image, clamped into it, under the same rule as a box."""
    return [
        f"{value:.{PRECISION}f}"
        for x, y in points
        for value in (
            max(0.0, min(x, float(width))) / width,
            max(0.0, min(y, float(height))) / height,
        )
    ]


def yaml_scalar(name: str) -> str:
    """A class name as a JSON string literal, which YAML accepts.

    No YAML library: a runtime dependency for one descriptor would be a
    dependency for one function. YAML 1.2 is a superset of JSON and pyyaml's
    1.1 loader accepts double-quoted scalars with the same escapes, so a name
    holding a colon, a quote or a leading ``*`` cannot break the file.
    """
    return json.dumps(name)


def fold_path(folds: set[str], wanted: str, fallback: str, *, prefix: str = "") -> str:
    """Where a required key points when its own fold holds nothing.

    A fold with no assets has no directory, and ultralytics checks that ``val``
    exists before it will load anything — so an empty ``val`` points at the
    training images rather than at a path nobody created.
    """
    return f"{prefix}{IMAGES_DIRNAME}/{wanted}" if wanted in folds else fallback
