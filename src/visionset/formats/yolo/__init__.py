# usage: from visionset.formats.yolo import YoloDetectionExporter
"""YOLO detection: ``data.yaml``, one label file per image, images laid out per split.

The primary export of the thirty-minute flow, and the first plugin in this
repository that writes anything. It is a rewrite rather than a port: the arithmetic
below is v1's, and four of its decisions are deliberately not.

**Classes come from the frozen schema, never from the annotations present.** v1
built its class index by walking every annotation snapshot and sorting the names
it found, which has two failure modes and no warning for either: a class nobody
labelled yet vanishes from ``data.yaml``, and — worse — the *indices shift* the
moment somebody draws the first box of a new class, so two exports of two
releases of one project disagree about what class ``0`` means. A model trained on
the first and evaluated against the second is quietly wrong. Here the order is
``Manifest.classes``, which is the project's authored schema order frozen at
publication, and every class gets an index whether or not anything uses it.

**A read failure aborts.** v1 wrapped the image read in ``except Exception:
pass`` and then wrote the label file anyway, so a permissions problem or a lost
object produced a training set silently short of images *and* carrying labels
that point at nothing. Every read here goes through the ``ContentReader``
``ReleaseService`` composes, which raises :class:`ExportSourceUnreadable` naming
the asset.

**Pixel dimensions are required, not defaulted.** v1 parsed ``"WxH"`` out of a
string and fell back to ``(1, 1)``, which does not fail — it divides by one, and
writes raw pixel coordinates into a file whose contract is that every number is a
fraction of the image. An asset with no recorded size is refused by name.

**Files are named by content hash.** v1 used the original filename with a
``_2``/``_3`` de-duplicating suffix, which makes the mapping depend on iteration
order and lets the same picture ingested from two directories land twice under
different names. A hash is stable across machines and runs, cannot collide, and
matches the manifest's own canonical ordering. The cost is that the names are not
human-readable, which an export destined for a trainer does not need.

Two things this format cannot carry, both reported by the compatibility check
before anything is written:

- **Attributes, confidence and provenance.** A YOLO label row is five numbers.
  That is what ``lossy = True`` says, and it is why every export in this format
  asks for consent whatever the release holds.
- **Geometry that is not a box.** ``supported_geometries`` is ``{bbox}`` and
  ``degraded_geometries`` is ``{polygon}``. A polygon is still exported — as its
  axis-aligned bounding box, which is what a detection dataset can use — but its
  shape is gone, so the report counts it as **degraded** and says so by class. A
  classification tag has no box at all and is **dropped**: a detection format has
  nowhere to put a label with no location. One word covering both would report a
  polygon as absent while writing it.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Final

from visionset.formats._layout import (
    IMAGES_DIRNAME,
    dimensions_of,
    folds_of,
    write_image,
)
from visionset.formats._targets import self_target
from visionset.kernel.domain import (
    BboxGeometry,
    Geometry,
    GeometryType,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    Release,
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

#: How many digits a normalized coordinate is written with.
#:
#: Six, which is v1's and the format's de-facto convention. It resolves a single
#: pixel on an image up to a million pixels wide, so the rounding is below what
#: the annotation itself can express.
PRECISION: Final = 6


class YoloDetectionExporter:
    """Writes a release as a YOLO detection dataset."""

    format_name = "yolo"

    #: A label row is ``class cx cy w h`` and nothing else, so attributes,
    #: confidence and per-annotation provenance are dropped from every export
    #: regardless of what a particular release happens to hold. That is exactly
    #: what this flag is for, and it is why consent is always asked.
    lossy = True

    #: Boxes, and only boxes arrive intact.
    supported_geometries = frozenset({GeometryType.BBOX})

    #: Polygons, because ``_as_box`` writes one as its axis-aligned bounds.
    #:
    #: Declared rather than left to the reader: without this set the report has no
    #: word for the conversion and calls it a removal, so a caller consents to
    #: losing two annotations and receives two boxes.
    degraded_geometries = frozenset({GeometryType.POLYGON})

    #: A YOLO dataset is a directory of pictures.
    supported_modalities = frozenset({"image"})

    targets = self_target(format_name, supported_geometries)

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        names = [declared.name for declared in manifest.classes]
        index_of = {name: index for index, name in enumerate(names)}
        folds = folds_of(release, manifest)

        for asset in manifest.assets:
            fold = folds[asset.asset_id]
            write_image(asset, dest / IMAGES_DIRNAME / fold, content)
            _write_labels(
                asset,
                (dest / LABELS_DIRNAME / fold / asset.content_hash).with_suffix(".txt"),
                index_of,
            )

        _write_data_yaml(dest / DATA_FILENAME, names, set(folds.values()))


def _write_labels(asset: ManifestAsset, target: Path, index_of: Mapping[str, int]) -> None:
    """One line per exportable annotation, or an empty file.

    **An asset with nothing to say still gets a file**, and it is empty rather
    than absent: ultralytics reads a missing label file as an unlabelled image
    and an empty one as an image with no objects, and those are different
    training signals. A frame somebody looked at and found nothing in is the
    second.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("".join(f"{row}\n" for row in _rows(asset, index_of)), encoding="utf-8")


def _rows(asset: ManifestAsset, index_of: Mapping[str, int]) -> Iterable[str]:
    width, height = dimensions_of(asset)
    for annotation in asset.annotations:
        index = index_of.get(annotation.label_class)
        # Publication rejects new inconsistent manifests, but archived or externally
        # supplied manifests can still be malformed. An invented class index would
        # silently mislabel a file a trainer reads as ground truth.
        if index is None:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
                f"which the release's schema does not declare"
            )
        box = _as_box(annotation)
        if box is None:
            continue
        yield f"{index} {' '.join(_normalized(box, width, height))}"


def _as_box(annotation: ManifestAnnotation) -> BboxGeometry | None:
    """The box this annotation contributes, or ``None`` if it contributes none.

    A polygon becomes its axis-aligned bounding box, reachable only under consent
    because ``lossy`` is true. A classification tag
    has no location at all, so a detection dataset has nowhere to put it and it is
    dropped rather than given an invented box covering the whole image.
    """
    geometry: Geometry = annotation.geometry
    if isinstance(geometry, BboxGeometry):
        return geometry
    if isinstance(geometry, PolygonGeometry):
        xs = [x for x, _ in geometry.points]
        ys = [y for _, y in geometry.points]
        return BboxGeometry(x=min(xs), y=min(ys), width=max(xs) - min(xs), height=max(ys) - min(ys))
    return None


def _normalized(box: BboxGeometry, width: int, height: int) -> list[str]:
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


def _write_data_yaml(target: Path, names: list[str], folds: set[str]) -> None:
    """The dataset descriptor, hand-written rather than dumped.

    No YAML library: this document has five keys and a list of strings, and adding
    a runtime dependency to emit it would be a dependency for one function. Every
    scalar is written as a **JSON string literal**, which is valid YAML — YAML 1.2
    is a superset of JSON and pyyaml's 1.1 loader accepts double-quoted scalars
    with the same escapes — so a class name holding a colon, a quote or a leading
    ``*`` cannot break the file.

    **There is no ``path:`` key, and its absence is the load-bearing part.**
    Ultralytics resolves ``path`` relative to its *dataset root*, not to the yaml,
    and only when the value does not already exist as a directory — so the obvious
    ``path: .`` resolves against the **current working directory of whatever
    process loads the file**, which is almost never where the export is. Omitted,
    it falls back to the yaml's own parent, which is what makes the directory
    movable to a training machine and still loadable.

    **``train`` and ``val`` are both required**, and ultralytics raises a
    ``SyntaxError`` naming the missing key rather than defaulting — so a release
    published with no recipe, which is one undivided set, still declares a ``val``
    and points it at the training images. That says "there is no held-out set",
    which is true, where omitting the key says "this file is malformed", which is
    not. ``test`` is optional and is written only when it has something in it.

    ``names`` is a mapping from index rather than a list, because the index is the
    thing that matters and a list makes it positional and invisible. Ultralytics
    accepts both.
    """
    present = sorted(folds)
    train = _fold_path(folds, "train", present[0])
    lines = [
        "# Written by VisionSet. Class order is the release's frozen schema.",
        f"train: {train}",
        f"val: {_fold_path(folds, 'val', train)}",
    ]
    if "test" in folds:
        lines.append(f"test: {IMAGES_DIRNAME}/test")
    lines.append(f"nc: {len(names)}")
    lines.append("names:")
    lines.extend(f"  {index}: {json.dumps(name)}" for index, name in enumerate(names))
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _fold_path(folds: set[str], wanted: str, fallback: str) -> str:
    """Where a required key points when its own fold holds nothing.

    A fold with no assets has no directory, and ultralytics checks that ``val``
    exists before it will load anything — so an empty ``val`` points at the
    training images rather than at a path nobody created.
    """
    return f"{IMAGES_DIRNAME}/{wanted}" if wanted in folds else fallback
