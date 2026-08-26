# usage: from visionset.formats.ultralytics import UltralyticsExporter
"""The Ultralytics dialect: ``data.yaml`` with ``path`` and indexed ``names``, or a class tree.

The primary export of the thirty-minute flow, and the format every YOLO
trainer from YOLOv3 to YOLO26 reads. Four decisions carried over from the
first exporter in this repository, each the negation of a defect a previous
generation of this tool shipped:

**Classes come from the frozen schema, never from the annotations present.**
Building the class index by walking the annotations has two failure modes and
no warning for either: a class nobody labelled yet vanishes from ``data.yaml``,
and the *indices shift* the moment somebody draws the first box of a new
class, so two exports of two releases of one project disagree about what class
``0`` means. Here the order is ``Manifest.classes``, the project's authored
schema order frozen at publication, and every class gets an index whether or
not anything uses it.

**A read failure aborts.** Every read goes through the ``ContentReader``
``ReleaseService`` composes, which raises :class:`ExportSourceUnreadable`
naming the asset, so a lost blob cannot produce a training set silently short
of an image while its labels claim otherwise.

**Pixel dimensions are required, not defaulted.** An asset with no recorded
size is refused by name, because a fallback of ``(1, 1)`` does not fail — it
divides by one and writes pixels where a fraction was promised.

**Files are named by content hash.** Stable across machines and runs, and it
cannot collide.

**The task is derived, never chosen.** One export is written for exactly one
of the trainer's tasks: ``segment`` when the manifest carries any polygon,
``classify`` when it carries classification tags and no box or polygon, and
``detect`` otherwise. A segment export writes every polygon as its vertices
and every box as its four corners, so nothing located is reduced; a classify
export is the class tree the trainer reads, one copy of an image per tag it
carries. What one export cannot carry — a tag beside a box, an attribute, a
confidence — is what ``lossy = True`` says, and why consent is always asked.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path
from typing import Final

from visionset.formats._layout import IMAGES_DIRNAME, folds_of, write_image
from visionset.formats._yolo_writer import (
    DATA_FILENAME,
    HEADER_COMMENT,
    LABELS_DIRNAME,
    class_index,
    class_names,
    derive_task,
    detect_rows,
    fold_path,
    segment_rows,
    write_label_layout,
    yaml_scalar,
)
from visionset.kernel.domain import (
    ClassificationGeometry,
    ExportTarget,
    GeometryType,
    Manifest,
    PreprocessingHints,
    Release,
    ResizeStrategy,
    TargetFamily,
    Task,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

__all__ = ["DATA_FILENAME", "LABELS_DIRNAME", "TARGETS", "UltralyticsExporter"]

#: The tasks this dialect can lay out. A target narrower than this still gets
#: the layout its task set allows; a target wider than this is a promise the
#: format cannot keep, which ``validate_targets`` refuses.
TASKS: Final = frozenset({Task.DETECT, Task.SEGMENT, Task.CLASSIFY})

_HINTS: Final = PreprocessingHints(
    recommended_size=(640, 640),
    recommended_strategy=ResizeStrategy.LETTERBOX,
    trainer_resizes=True,
    augmentation_common=True,
)

_LOCATED: Final = frozenset({GeometryType.BBOX, GeometryType.POLYGON})
_EVERYTHING: Final = _LOCATED | {GeometryType.CLASSIFICATION_TAG}


def _target(
    name: str, label: str, tasks: frozenset[Task], geometries: frozenset[GeometryType]
) -> ExportTarget:
    return ExportTarget(
        name=name,
        label=label,
        family=TargetFamily.ULTRALYTICS_YOLO,
        tasks=tasks,
        supported_geometries=geometries,
        hints=_HINTS,
    )


#: The models this dialect writes for, with the task each accepts.
#:
#: ``tasks`` is the trainer's whole vocabulary — pose, obb, semantic and depth
#: included — while ``supported_geometries`` carries only what VisionSet can
#: produce today; a task with no geometry behind it is absence, not a drop.
TARGETS: Final[frozenset[ExportTarget]] = frozenset(
    {
        _target(
            "yolo26",
            "YOLO26",
            frozenset(
                {
                    Task.DETECT,
                    Task.SEGMENT,
                    Task.SEMANTIC,
                    Task.DEPTH,
                    Task.CLASSIFY,
                    Task.POSE,
                    Task.OBB,
                }
            ),
            _EVERYTHING,
        ),
        _target(
            "yolo12",
            "YOLO12",
            frozenset({Task.DETECT, Task.SEGMENT, Task.CLASSIFY, Task.POSE, Task.OBB}),
            _EVERYTHING,
        ),
        _target(
            "yolo11",
            "YOLO11",
            frozenset({Task.DETECT, Task.SEGMENT, Task.CLASSIFY, Task.POSE, Task.OBB}),
            _EVERYTHING,
        ),
        _target("yolov10", "YOLOv10", frozenset({Task.DETECT}), frozenset({GeometryType.BBOX})),
        _target("yolov9", "YOLOv9", frozenset({Task.DETECT, Task.SEGMENT}), _LOCATED),
        _target(
            "yolov8",
            "YOLOv8",
            frozenset({Task.DETECT, Task.SEGMENT, Task.CLASSIFY, Task.POSE, Task.OBB}),
            _EVERYTHING,
        ),
        _target("yolov6", "YOLOv6", frozenset({Task.DETECT}), frozenset({GeometryType.BBOX})),
        _target(
            "yolov5",
            "YOLOv5",
            frozenset({Task.DETECT, Task.SEGMENT, Task.CLASSIFY}),
            _EVERYTHING,
        ),
        _target("yolov3", "YOLOv3", frozenset({Task.DETECT}), frozenset({GeometryType.BBOX})),
    }
)


class UltralyticsExporter:
    """Writes a release as an Ultralytics dataset, for the task the manifest implies."""

    format_name = "ultralytics"

    #: A label row is a class index and coordinates, and a class tree is a
    #: directory name: attributes, confidence and per-annotation provenance are
    #: dropped from every export regardless of what a release holds, and a tag
    #: beside a located label has no layout to land in. Consent is always asked.
    lossy = True

    #: Boxes and polygons arrive intact — a box in a segment export is its own
    #: four corners, which loses nothing — and a tag arrives intact in the class
    #: tree a tags-only release is written as.
    supported_geometries = _EVERYTHING

    #: Nothing is written in a reduced form: a polygon in this dialect is
    #: always written as its vertices, because its presence is what selects
    #: the segment layout.
    degraded_geometries: frozenset[GeometryType] = frozenset()

    #: A YOLO dataset is a directory of pictures.
    supported_modalities = frozenset({"image"})

    targets = TARGETS

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        task = derive_task(manifest, TASKS)
        if task is Task.CLASSIFY:
            _write_class_tree(release, manifest, dest, content)
            return
        rows = segment_rows if task is Task.SEGMENT else detect_rows
        folds = write_label_layout(release, manifest, dest, content, rows)
        _write_data_yaml(dest / DATA_FILENAME, class_names(manifest), folds)


def _write_data_yaml(target: Path, names: list[str], folds: set[str]) -> None:
    """The descriptor: ``path: .``, one key per fold present, ``names`` as a mapping.

    ``names`` is a mapping from index rather than a list, because the index is
    the thing that matters and a list makes it positional and invisible. No
    ``nc``: the trainer counts the mapping, and a second number is one that can
    disagree with it.

    ``train`` and ``val`` are both required by the trainer, which raises naming
    the missing key rather than defaulting — so a release published with no
    recipe, one undivided set, still declares a ``val`` and points it at the
    training images. That says "there is no held-out set", where omitting the
    key says "this file is malformed". ``test`` is written only when it has
    something in it.
    """
    present = sorted(folds)
    train = fold_path(folds, "train", present[0])
    lines = [
        HEADER_COMMENT,
        "path: .",
        f"train: {train}",
        f"val: {fold_path(folds, 'val', train)}",
    ]
    if "test" in folds:
        lines.append(f"test: {IMAGES_DIRNAME}/test")
    lines.append("names:")
    lines.extend(f"  {index}: {yaml_scalar(name)}" for index, name in enumerate(names))
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_class_tree(
    release: Release, manifest: Manifest, dest: Path, content: ContentReader
) -> None:
    """The classify layout: ``<fold>/<class>/<image>``, one copy of an image per tag.

    The trainer reads the class list off the ``train`` directory's
    subdirectories, so every tag-capable class gets one under every fold
    present, whether or not anything was tagged with it — the same slot-keeping
    rule the label index follows. A class that cannot carry a tag never appears,
    because a directory for it would let a trainer allocate an output nothing
    can fill. An asset carrying no tag has no directory to land in and is not
    written.
    """
    vocabulary = [
        one.name for one in manifest.classes if GeometryType.CLASSIFICATION_TAG in one.geometries
    ]
    for name in vocabulary:
        if not _is_a_directory_name(name):
            raise ExportSourceUnreadable(
                f"class {name!r} cannot name a directory, so it cannot be written as a "
                f"class of an image-classification tree"
            )
    index_of = {name: index for index, name in enumerate(class_names(manifest))}
    folds = folds_of(release, manifest)
    for fold in set(folds.values()):
        for name in vocabulary:
            (dest / fold / name).mkdir(parents=True, exist_ok=True)
    for asset in manifest.assets:
        fold = folds[asset.asset_id]
        for annotation in asset.annotations:
            class_index(asset, annotation, index_of)
            if isinstance(annotation.geometry, ClassificationGeometry):
                write_image(asset, dest / fold / annotation.label_class, content)


def _is_a_directory_name(name: str) -> bool:
    """Whether a class name can be one path segment."""
    return (
        name not in {".", ".."}
        and "/" not in name
        and "\\" not in name
        and not any(unicodedata.category(char) == "Cc" for char in name)
    )
