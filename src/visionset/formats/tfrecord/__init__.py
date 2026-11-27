# usage: from visionset.formats.tfrecord import TfrecordExporter, TfrecordImporter
"""TensorFlow Object Detection TFRecords: ``tf.train.Example`` boxes per split and a label map.

The TensorFlow Object Detection API's dataset schema, written without
TensorFlow or protobuf (see :mod:`visionset.formats.tfrecord._wire`).

**Out.** :data:`LABEL_MAP_FILENAME` at the top of the export, one ``item { id: N
name: "x" }`` per declared class, ids ``1``.. in class-name order (``0`` is the
background the API reserves). Beside it one uncompressed ``<split>.tfrecord``
per split holding pictures, ``train`` for a release without a split recipe, one
record per picture, every picture written whether or not it has boxes.

Each record is a ``tf.train.Example`` of ``image/encoded`` (the picture's own
bytes), ``image/format`` (``jpeg`` or ``png``), ``image/filename``
(``<hash>.<ext>``), ``image/source_id`` (the hash), ``image/height`` and
``image/width``, and per box ``image/object/bbox/xmin``, ``xmax``, ``ymin`` and
``ymax``, ``image/object/class/text`` and ``image/object/class/label``. A box is
clamped into its picture, its far corner first rounded to
:data:`~visionset.formats.tfrecord.reader.PRECISION` decimals of a pixel, and
divided by the recorded size into a float32. ``image/object/difficult``,
``truncated`` and ``is_crowd`` are written, ``1`` or ``0``, when a box of the
picture carries a boolean attribute of that name; a box without one is ``0``.

``lossy``: confidence, other attributes and provenance have nowhere to go.
Polygons, rotated boxes, polylines, masks, tags and 3D geometry are dropped,
and the compatibility report says so before anything is written. Instance masks
and keypoints are deliberately not written in this version. A WebP picture is
refused, because the API decodes JPEG and PNG.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Final

from visionset.formats._layout import FOLDS, dimensions_of, folds_of, image_name
from visionset.formats._targets import self_target
from visionset.formats.tfrecord._wire import (
    Feature,
    bytes_feature,
    encode_example,
    float_feature,
    frame,
    int64_feature,
)
from visionset.formats.tfrecord.reader import (
    CLASS_LABEL,
    CLASS_TEXT,
    FLAGS,
    FORMAT_NAME,
    LABEL_MAP_FILENAME,
    PRECISION,
    SUFFIX,
    XMAX,
    XMIN,
    YMAX,
    YMIN,
)
from visionset.formats.tfrecord.reader import TfrecordImporter as TfrecordImporter
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

_FORMATS: Final = ((b"\xff\xd8\xff", b"jpeg", ".jpg"), (b"\x89PNG\r\n\x1a\n", b"png", ".png"))


class TfrecordExporter:
    """Writes a release as TensorFlow Object Detection TFRecords and a label map."""

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
        ids = {
            name: number
            for number, name in enumerate(sorted(one.name for one in manifest.classes), start=1)
        }
        (dest / LABEL_MAP_FILENAME).write_text(label_map_text(ids), encoding="utf-8")

        folds = folds_of(manifest, assignment)
        by_split: dict[str, list[ManifestAsset]] = {}
        for asset in manifest.assets:
            by_split.setdefault(folds[asset.asset_id], []).append(asset)
        if not by_split:
            by_split["train"] = []
        for split in sorted(by_split, key=FOLDS.index):
            with (dest / f"{split}{SUFFIX}").open("wb") as handle:
                for asset in by_split[split]:
                    handle.write(frame(encode_example(_features(asset, ids, content))))


def label_map_text(ids: Mapping[str, int]) -> str:
    """A ``StringIntLabelMap`` in protobuf text format, one item per class."""
    return "".join(
        f'item {{\n  id: {number}\n  name: "{_escaped(name)}"\n}}\n'
        for name, number in sorted(ids.items(), key=lambda one: one[1])
    )


def _escaped(name: str) -> str:
    return (
        name.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )


def _features(
    asset: ManifestAsset, ids: Mapping[str, int], content: ContentReader
) -> dict[str, Feature]:
    width, height = dimensions_of(asset)
    with content(asset.content_hash) as stream:
        encoded = stream.read()
    kind, suffix = _format_of(encoded, asset)

    boxes: list[tuple[float, float, float, float]] = []
    names: list[str] = []
    flags: dict[str, list[int]] = {flag: [] for flag in FLAGS}
    carried: set[str] = set()
    for annotation in asset.annotations:
        if annotation.label_class not in ids:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
                f"which the release's schema does not declare"
            )
        geometry = annotation.geometry
        if not isinstance(geometry, BboxGeometry):
            continue
        boxes.append(_corners(geometry, width, height, asset))
        names.append(annotation.label_class)
        for flag in FLAGS:
            value = annotation.attributes.get(flag)
            if isinstance(value, bool):
                carried.add(flag)
            flags[flag].append(1 if value is True else 0)

    features: dict[str, Feature] = {
        "image/encoded": bytes_feature(encoded),
        "image/format": bytes_feature(kind),
        "image/filename": bytes_feature(image_name(asset, suffix).encode("ascii")),
        "image/source_id": bytes_feature(asset.content_hash.encode("ascii")),
        "image/height": int64_feature(height),
        "image/width": int64_feature(width),
        XMIN: float_feature(*(box[0] for box in boxes)),
        XMAX: float_feature(*(box[1] for box in boxes)),
        YMIN: float_feature(*(box[2] for box in boxes)),
        YMAX: float_feature(*(box[3] for box in boxes)),
        CLASS_TEXT: bytes_feature(*(name.encode("utf-8") for name in names)),
        CLASS_LABEL: int64_feature(*(ids[name] for name in names)),
    }
    for flag in sorted(carried):
        features[f"image/object/{flag}"] = int64_feature(*flags[flag])
    return features


def _format_of(encoded: bytes, asset: ManifestAsset) -> tuple[bytes, str]:
    for signature, kind, suffix in _FORMATS:
        if encoded.startswith(signature):
            return kind, suffix
    raise ExportSourceUnreadable(
        f"asset {asset.asset_id} ({asset.content_hash}) is not a JPEG or PNG, "
        f"which the TensorFlow Object Detection API decodes"
    )


def _corners(
    box: BboxGeometry, width: int, height: int, asset: ManifestAsset
) -> tuple[float, float, float, float]:
    """``xmin``, ``xmax``, ``ymin``, ``ymax`` as fractions, clamped into the picture."""
    left = max(0.0, box.x)
    top = max(0.0, box.y)
    right = min(float(width), round(box.x + box.width, PRECISION))
    bottom = min(float(height), round(box.y + box.height, PRECISION))
    if right <= left or bottom <= top:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} carries a box with no pixel inside its picture"
        )
    return left / width, right / width, top / height, bottom / height


__all__ = ["LABEL_MAP_FILENAME", "TfrecordExporter", "TfrecordImporter", "label_map_text"]
