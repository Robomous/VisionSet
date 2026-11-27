# usage: from visionset.formats.coco import CocoImporter
"""COCO instances in: boxes and single-ring polygons, with everything else reported.

Reads the layout :class:`CocoExporter` writes — ``annotations/instances_<fold>.json``
beside ``images/<fold>/`` — and the common variants of it: instance files at the
top of the source, images directly under ``images/`` or beside the JSON. Nothing
here touches a workspace; it returns an ``ImportedDataset``.

What the kernel cannot represent is counted into ``losses`` by kind, never
dropped silently: an RLE or crowd mask, a multi-ring polygon and a degenerate
shape lose the whole label; keypoints lose part of one (its box or polygon is
kept). Attribute values are read from the ``"visionset"`` object the exporter
writes, else from the row's own ``attributes``; a string, a boolean or a number
is carried and anything else is an ``attribute`` loss. COCO has no attribute
definitions, so each class defines an attribute by the first value it sees:
a number, a boolean or a string, never required and with no options. Whether a
given file is lossy depends on its content, so there is no ``lossy`` flag here.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Final

from pydantic import ValidationError

from visionset.formats._layout import IMAGES_DIRNAME
from visionset.kernel.domain import (
    BboxGeometry,
    Geometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLoss,
    ImportLossKind,
    PolygonGeometry,
    require_relative_path,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.domain.schema import Attribute, AttributeValue
from visionset.kernel.errors import ImportSourceUnreadable

ANNOTATIONS_DIRNAME: Final = "annotations"
_INSTANCES_PREFIX: Final = "instances_"
#: Below this many square pixels a ring is a line or a point, not a shape.
_DEGENERATE_AREA: Final = 1e-9


@dataclass
class _Image:
    path: PurePosixPath
    width: int | None
    height: int | None
    labels: list[ImportedLabel] = field(default_factory=list)


class CocoImporter:
    """Reads a COCO instances dataset into an ``ImportedDataset``."""

    format_name = "coco"

    def read(self, src: Path) -> ImportedDataset:
        documents, unread = _instance_files(src)
        geometries: dict[str, set[GeometryType]] = {}
        images: dict[PurePosixPath, _Image] = {}
        losses: Counter[tuple[ImportLossKind, str, str]] = Counter()
        definitions: dict[str, dict[str, Attribute]] = {}

        for document_path in documents:
            document = _load(document_path)
            categories = _categories(document, document_path.name)
            for name in categories.values():
                geometries.setdefault(name, set())
            image_dir = _image_dir(src, document_path)
            by_id = self._images(document, document_path.name, image_dir, images)
            for row in _rows(document, "annotations", document_path.name):
                self._annotation(row, categories, by_id, geometries, definitions, losses)

        for kind, subject, reason, count in map(_unread, unread):
            losses[(kind, subject, reason)] += max(count, 1)

        classes = tuple(
            ImportedClass(
                name=name,
                geometries=tuple(seen) or (GeometryType.BBOX,),
                attributes=tuple(definitions.get(name, {}).values()),
            )
            for name, seen in geometries.items()
        )
        try:
            return ImportedDataset(
                classes=classes,
                images=tuple(
                    ImportedImage(
                        path=image.path,
                        width=image.width,
                        height=image.height,
                        labels=tuple(image.labels),
                    )
                    for image in images.values()
                ),
                losses=tuple(
                    ImportLoss(kind=kind, subject=subject, count=count, reason=reason)
                    for (kind, subject, reason), count in losses.items()
                ),
            )
        except ValidationError as exc:
            raise ImportSourceUnreadable(f"the COCO dataset is inconsistent: {exc}") from None

    def _images(
        self,
        document: Mapping[str, Any],
        source_name: str,
        image_dir: PurePosixPath,
        images: dict[PurePosixPath, _Image],
    ) -> dict[Any, _Image]:
        by_id: dict[Any, _Image] = {}
        for row in _rows(document, "images", source_name):
            file_name = row.get("file_name")
            if not isinstance(file_name, str):
                raise ImportSourceUnreadable(f"{source_name}: an image has no file_name")
            try:
                path = require_relative_path(image_dir / require_relative_path(file_name))
            except ValueError as exc:
                raise ImportSourceUnreadable(f"{source_name}: {exc}") from None
            width, height = _dimension(row, "width"), _dimension(row, "height")
            image = images.get(path)
            if image is None:
                image = images[path] = _Image(path=path, width=width, height=height)
            elif (image.width, image.height) != (width, height):
                raise ImportSourceUnreadable(
                    f"{source_name}: image {file_name!r} is listed twice with different sizes"
                )
            if row.get("id") in by_id:
                raise ImportSourceUnreadable(f"{source_name}: image id {row.get('id')!r} repeats")
            by_id[row.get("id")] = image
        return by_id

    def _annotation(
        self,
        row: Mapping[str, Any],
        categories: Mapping[Any, str],
        by_id: Mapping[Any, _Image],
        geometries: dict[str, set[GeometryType]],
        definitions: dict[str, dict[str, Attribute]],
        losses: Counter[tuple[ImportLossKind, str, str]],
    ) -> None:
        name = categories.get(row.get("category_id"))
        if name is None:
            losses[(ImportLossKind.LABEL, "annotation", "it names no declared category")] += 1
            return
        image = by_id.get(row.get("image_id"))
        if image is None:
            losses[(ImportLossKind.LABEL, name, "it names an image the file does not list")] += 1
            return

        geometry, refusal = _geometry(row)
        if geometry is None:
            losses[(ImportLossKind.LABEL, name, refusal)] += 1
            return
        if not geometry_intersects_asset(geometry, width=image.width, height=image.height):
            losses[(ImportLossKind.LABEL, name, "it lies wholly outside its image")] += 1
            return
        if _has_keypoints(row):
            losses[
                (ImportLossKind.GEOMETRY, name, "keypoints are not imported; the shape is kept")
            ] += 1
        attributes = _attributes(row, name, losses)
        defined = definitions.setdefault(name, {})
        for key, value in attributes.items():
            defined.setdefault(key.casefold(), _defined_by(key, value))

        geometries[name].add(geometry.type)
        confidence, discarded = _confidence(row)
        if discarded:
            losses[
                (ImportLossKind.ATTRIBUTE, name, "a confidence outside [0, 1] is not imported")
            ] += 1
        image.labels.append(
            ImportedLabel(
                class_name=name, geometry=geometry, confidence=confidence, attributes=attributes
            )
        )


def _instance_files(src: Path) -> tuple[list[Path], list[Path]]:
    """The instances files to read, and the other COCO files beside them that are not read.

    Only ``instances_*.json`` holds detection and segmentation labels; a COCO
    folder also carries ``person_keypoints_*`` and ``captions_*`` over the same
    images, and reading those too would label every person twice. A single
    JSON file at the top of the source is read whatever it is called.
    """
    if not src.is_dir():
        raise ImportSourceUnreadable(f"the COCO source {src.name!r} is not a directory")
    nested = src / ANNOTATIONS_DIRNAME
    for directory in (nested, src):
        if not directory.is_dir():
            continue
        found = sorted(path for path in directory.glob("*.json") if path.is_file())
        instances = [path for path in found if path.name.startswith(_INSTANCES_PREFIX)]
        if instances:
            return instances, [path for path in found if path not in instances]
    top = sorted(path for path in src.glob("*.json") if path.is_file())
    if len(top) == 1:
        return top, []
    raise ImportSourceUnreadable(
        f"the COCO source {src.name!r} holds no {_INSTANCES_PREFIX}*.json at its top or under "
        f"{ANNOTATIONS_DIRNAME}/, nor a single JSON file at its top"
    )


def _unread(path: Path) -> tuple[ImportLossKind, str, str, int]:
    """The loss one COCO file that is not an instances file stands for."""
    try:
        rows = json.loads(path.read_text(encoding="utf-8")).get("annotations", [])
        count = len(rows) if isinstance(rows, list) else 0
    except (OSError, ValueError, AttributeError, RecursionError):
        count = 0
    if path.name.startswith("person_keypoints_"):
        return ImportLossKind.GEOMETRY, path.name, "keypoint files are not imported", count
    if path.name.startswith("captions_"):
        return ImportLossKind.LABEL, path.name, "captions are not imported", count
    return ImportLossKind.LABEL, path.name, "only instances files are imported", count


def _refuse_constant(name: str) -> float:
    raise ImportSourceUnreadable(f"the COCO file holds the non-finite number {name}")


def _load(path: Path) -> Mapping[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"), parse_constant=_refuse_constant)
    except (OSError, ValueError, RecursionError) as exc:
        raise ImportSourceUnreadable(f"{path.name} is not readable JSON: {exc}") from None
    if not isinstance(document, dict):
        raise ImportSourceUnreadable(f"{path.name} is not a COCO document")
    return document


def _rows(document: Mapping[str, Any], key: str, source_name: str) -> Iterable[Mapping[str, Any]]:
    rows = document.get(key, [])
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ImportSourceUnreadable(f"{source_name}: {key!r} is not a list of objects")
    return rows


def _categories(document: Mapping[str, Any], source_name: str) -> dict[Any, str]:
    categories: dict[Any, str] = {}
    for row in _rows(document, "categories", source_name):
        name = row.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ImportSourceUnreadable(f"{source_name}: a category has no name")
        if row.get("id") in categories:
            raise ImportSourceUnreadable(f"{source_name}: category id {row.get('id')!r} repeats")
        categories[row.get("id")] = name.strip()
    return categories


def _image_dir(src: Path, document_path: Path) -> PurePosixPath:
    """Where the images of one instances file live, relative to ``src``."""
    stem = document_path.stem
    fold = stem[len(_INSTANCES_PREFIX) :] if stem.startswith(_INSTANCES_PREFIX) else stem
    for candidate in (PurePosixPath(IMAGES_DIRNAME, fold), PurePosixPath(IMAGES_DIRNAME)):
        if (src / candidate).is_dir():
            return candidate
    return PurePosixPath()


def _dimension(row: Mapping[str, Any], key: str) -> int | None:
    value = row.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _geometry(row: Mapping[str, Any]) -> tuple[Geometry | None, str]:
    segmentation = row.get("segmentation")
    if row.get("iscrowd") == 1 or isinstance(segmentation, dict):
        return None, "an RLE or crowd mask cannot be represented"
    if isinstance(segmentation, list) and segmentation:
        if len(segmentation) > 1:
            return None, "a polygon of several rings cannot be represented"
        ring = segmentation[0]
        if (
            not isinstance(ring, list)
            or len(ring) < 6
            or len(ring) % 2
            or not all(_is_number(value) for value in ring)
        ):
            return None, "its polygon has fewer than three points or is malformed"
        points = [(float(x), float(y)) for x, y in zip(*[iter(ring)] * 2, strict=True)]
        if _shoelace(points) <= _DEGENERATE_AREA:
            return None, "its polygon encloses no area"
        return PolygonGeometry(points=points), ""
    box = row.get("bbox")
    if not isinstance(box, list) or len(box) != 4 or not all(_is_number(value) for value in box):
        return None, "it has neither a polygon nor a well-formed box"
    x, y, width, height = (float(value) for value in box)
    if width <= 0 or height <= 0:
        return None, "its box has no area"
    return BboxGeometry(x=x, y=y, width=width, height=height), ""


def _is_number(value: object) -> bool:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        raise ImportSourceUnreadable(
            f"the COCO file holds a number too large to be a coordinate ({str(value)[:20]}...)"
        ) from None


def _shoelace(points: list[tuple[float, float]]) -> float:
    total = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def _extension(row: Mapping[str, Any]) -> Mapping[str, Any]:
    extension = row.get("visionset")
    return extension if isinstance(extension, dict) else {}


def _has_keypoints(row: Mapping[str, Any]) -> bool:
    keypoints = row.get("keypoints")
    return isinstance(keypoints, list) and any(keypoints)


def _attributes(
    row: Mapping[str, Any], name: str, losses: Counter[tuple[ImportLossKind, str, str]]
) -> dict[str, AttributeValue]:
    """The label's attribute values, each loss counted against its class."""
    extension = _extension(row)
    if "attributes" in extension:
        found = extension["attributes"]
        if row.get("attributes"):
            reason = "the row's own attributes are not imported beside the visionset ones"
            losses[(ImportLossKind.ATTRIBUTE, name, reason)] += 1
    else:
        found = row.get("attributes")
    if found is None:
        return {}
    if not isinstance(found, dict):
        losses[
            (ImportLossKind.ATTRIBUTE, name, "attributes that are not an object are not imported")
        ] += 1
        return {}
    values: dict[str, AttributeValue] = {}
    for key, value in found.items():
        stripped = key.strip()
        shown = repr(key[:40])
        if not stripped or stripped in values:
            reason = f"attribute {shown} is unnamed or named twice; its value is not imported"
            losses[(ImportLossKind.ATTRIBUTE, name, reason)] += 1
            continue
        kept = _attribute_value(value)
        if kept is None:
            reason = f"attribute {shown} is not a string, a boolean or a number; it is not imported"
            losses[(ImportLossKind.ATTRIBUTE, name, reason)] += 1
            continue
        values[stripped] = kept
    return values


def _attribute_value(value: object) -> AttributeValue | None:
    if isinstance(value, bool | str):
        return value
    if not isinstance(value, int | float):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _defined_by(name: str, value: AttributeValue) -> Attribute:
    if isinstance(value, bool):
        return Attribute(name=name, kind="boolean")
    if isinstance(value, str):
        return Attribute(name=name, kind="string")
    return Attribute(name=name, kind="number")


def _confidence(row: Mapping[str, Any]) -> tuple[float | None, bool]:
    """The label's score, and whether one was present but unusable."""
    extension = _extension(row)
    value = extension.get("confidence") if "confidence" in extension else row.get("score")
    if value is None:
        return None, False
    if _is_number(value) and 0.0 <= float(value) <= 1.0:
        return float(value), False
    return None, True
