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

Two things this format cannot carry, both reported by #65's compatibility check
before anything is written:

- **Attributes, confidence and provenance.** A YOLO label row is five numbers.
  That is what ``lossy = True`` says, and it is why every export in this format
  asks for consent whatever the release holds.
- **Geometry that is not a box.** ``supported_geometries`` is ``{bbox}``. A
  polygon is still exported — as its axis-aligned bounding box, which is what a
  detection dataset can use — but its shape is gone, so the report counts it as
  not carried and says so by class. A classification tag has no box at all and is
  dropped: a detection format has nowhere to put a label with no location.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Final
from uuid import UUID

from visionset.kernel.domain import (
    BboxGeometry,
    Geometry,
    GeometryType,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    Release,
    assign_split,
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
IMAGES_DIRNAME: Final = "images"
LABELS_DIRNAME: Final = "labels"

DATA_FILENAME: Final = "data.yaml"

#: The fold every asset lands in when a release was published without a recipe.
#:
#: One undivided set, named ``train`` because that is the one key ultralytics
#: requires; answering with three empty folds would be a split nobody asked for.
DEFAULT_SPLIT: Final = "train"

#: How many digits a normalized coordinate is written with.
#:
#: Six, which is v1's and the format's de-facto convention. It resolves a single
#: pixel on an image up to a million pixels wide, so the rounding is below what
#: the annotation itself can express.
PRECISION: Final = 6

#: What the first bytes of a file say it is, and the suffix to give it.
#:
#: Sniffed rather than taken from ``ManifestAsset.uri``, because a ``uri`` is not
#: a filename: a frame cut out of a clip is recorded as
#: ``/clips/drive.mp4#frame=12``, whose suffix would name the container it came
#: out of. Three signatures, and anything else is refused by name rather than
#: written under a guessed extension — a trainer that cannot decode an image it
#: was handed fails much later and much less clearly.
_SIGNATURES: Final[tuple[tuple[bytes, str], ...]] = (
    (b"\xff\xd8\xff", ".jpg"),
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"RIFF", ".webp"),
)

_SIGNATURE_BYTES: Final = max(len(signature) for signature, _ in _SIGNATURES)


class YoloDetectionExporter:
    """Writes a release as a YOLO detection dataset."""

    format_name = "yolo"

    #: A label row is ``class cx cy w h`` and nothing else, so attributes,
    #: confidence and per-annotation provenance are dropped from every export
    #: regardless of what a particular release happens to hold. That is exactly
    #: what this flag is for, and it is why consent is always asked.
    lossy = True

    #: Boxes. A polygon is written as its bounding box under consent — see the
    #: module docstring — and #65's report is what tells a caller which classes
    #: that will happen to, with counts, before anything is written.
    supported_geometries = frozenset({GeometryType.BBOX})

    #: A YOLO dataset is a directory of pictures.
    supported_modalities = frozenset({"image"})

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
        folds = _folds(release, manifest)

        for asset in manifest.assets:
            fold = folds[asset.asset_id]
            _write_image(asset, dest / IMAGES_DIRNAME / fold, content)
            _write_labels(
                asset,
                (dest / LABELS_DIRNAME / fold / asset.content_hash).with_suffix(".txt"),
                index_of,
            )

        _write_data_yaml(dest / DATA_FILENAME, names, set(folds.values()))


def _folds(release: Release, manifest: Manifest) -> dict[UUID, str]:
    """Which fold each asset belongs to, keyed by asset id.

    Computed from the release's own recipe and its own frozen asset set, which is
    the same call ``ReleaseService.assignment`` makes — the plugin does not need
    the service, because ``assign_split`` is a pure function of a recipe and a
    sequence of manifest assets. An export is therefore reproducible from the
    release alone, on any machine, forever.
    """
    if release.split is None:
        return {asset.asset_id: DEFAULT_SPLIT for asset in manifest.assets}
    assignment = assign_split(release.split, manifest.assets)
    return {
        asset_id: fold
        for fold, members in (
            ("train", assignment.train),
            ("val", assignment.val),
            ("test", assignment.test),
        )
        for asset_id in members
    }


def _write_image(asset: ManifestAsset, into: Path, content: ContentReader) -> None:
    """Copy one asset's bytes into its fold, named by content hash.

    Streamed with ``shutil.copyfileobj`` rather than read whole: a release is
    every image somebody is about to train on, and holding one 4K frame in memory
    at a time is a choice where holding none is available.
    """
    into.mkdir(parents=True, exist_ok=True)
    with content(asset.content_hash) as stream:
        head = stream.read(_SIGNATURE_BYTES)
        suffix = _suffix_for(head, asset)
        target = (into / asset.content_hash).with_suffix(suffix)
        with target.open("wb") as handle:
            handle.write(head)
            shutil.copyfileobj(stream, handle)


def _suffix_for(head: bytes, asset: ManifestAsset) -> str:
    for signature, suffix in _SIGNATURES:
        if head.startswith(signature):
            return suffix
    raise ExportSourceUnreadable(
        f"asset {asset.asset_id} ({asset.content_hash}) is not a JPEG, PNG or WebP, "
        f"so it cannot be written into a YOLO dataset"
    )


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
    width, height = _dimensions(asset)
    for annotation in asset.annotations:
        index = index_of.get(annotation.label_class)
        # A label whose class the manifest does not declare cannot happen —
        # `SchemaChangeWouldOrphan` refuses to remove a class annotations depend
        # on — but writing an index derived from nothing would be a silent lie in
        # a file a trainer reads as ground truth.
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

    A polygon becomes its axis-aligned bounding box — the conversion #62 asks for,
    reachable only under consent because ``lossy`` is true. A classification tag
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


def _dimensions(asset: ManifestAsset) -> tuple[int, int]:
    """The pixel size every coordinate is divided by, or refuse by name.

    Never a fallback. v1 answered ``(1, 1)`` when it could not parse a size, which
    turns normalization into the identity and writes pixel coordinates into a file
    whose whole contract is that every number is between 0 and 1 — a dataset that
    loads, trains, and is wrong.
    """
    if asset.width is None or asset.height is None:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} has no recorded pixel size, so its annotations "
            f"cannot be normalized"
        )
    return asset.width, asset.height


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
