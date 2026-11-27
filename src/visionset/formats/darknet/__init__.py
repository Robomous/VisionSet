# usage: from visionset.formats.darknet import DarknetExporter, DarknetImporter
"""The Darknet dialect: ``obj.data``, ``obj.names`` and ``train.txt`` / ``valid.txt`` image lists.

The same images-and-labels layout as the ``ultralytics`` dialect, described the
way the Darknet framework and the trainers that fork it (AlexeyAB's darknet,
the YOLOv4 line) read a dataset: a ``classes=`` count, two lists of image
paths, a names file with one class per line, and a backup directory. Label
files are the shared ``class cx cy w h`` rows, found by Darknet's own rule of
swapping ``images`` for ``labels`` in an image path.

Image paths in the lists are relative to the export root, which is where
Darknet is expected to be run from. ``valid.txt`` is always written: a release
with no validation fold points it at the training list, as ``yolov5-yaml``
points ``val`` at the training images. Darknet has no test key, so test images
are written to ``images/test`` and listed in neither file.

Detection only. A polygon or a rotated box is written as its axis-aligned
bounding box and counted as degraded; a classification tag has no location and is dropped.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from visionset.formats._layout import IMAGES_DIRNAME
from visionset.formats._yolo_writer import class_names, degraded_detect_rows, write_label_layout
from visionset.formats.darknet.reader import DATA_FILENAME, NAMES_FILENAME, DarknetImporter
from visionset.kernel.domain import (
    ExportTarget,
    GeometryType,
    Manifest,
    PreprocessingHints,
    Release,
    ResizeStrategy,
    SplitAssignment,
    TargetFamily,
    Task,
)
from visionset.kernel.ports import ContentReader

__all__ = ["DATA_FILENAME", "NAMES_FILENAME", "TARGETS", "DarknetExporter", "DarknetImporter"]

TRAIN_FILENAME: Final = "train.txt"
VALID_FILENAME: Final = "valid.txt"
BACKUP_DIRNAME: Final = "backup"

TARGETS: Final[frozenset[ExportTarget]] = frozenset(
    {
        ExportTarget(
            name="yolov4",
            label="YOLOv4",
            family=TargetFamily.COMMUNITY_YOLO,
            tasks=frozenset({Task.DETECT}),
            supported_geometries=frozenset({GeometryType.BBOX}),
            hints=PreprocessingHints(
                recommended_size=(416, 416),
                recommended_strategy=ResizeStrategy.STRETCH,
                trainer_resizes=True,
                augmentation_common=True,
            ),
        )
    }
)


class DarknetExporter:
    """Writes a release as a Darknet detection dataset."""

    format_name = "darknet"

    #: A label row is ``class cx cy w h`` and nothing else.
    lossy = True

    supported_geometries = frozenset({GeometryType.BBOX})

    #: Polygons, written as their axis-aligned bounds.
    degraded_geometries = frozenset({GeometryType.OBB, GeometryType.POLYGON})

    supported_modalities = frozenset({"image"})

    targets = TARGETS

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
        assignment: SplitAssignment | None,
    ) -> None:
        folds = write_label_layout(manifest, dest, content, assignment, degraded_detect_rows)
        names = class_names(manifest)
        (dest / NAMES_FILENAME).write_text("".join(f"{name}\n" for name in names), encoding="utf-8")

        train_fold = "train" if "train" in folds else sorted(folds)[0]
        train = _listing(dest, train_fold)
        valid = _listing(dest, "val") if "val" in folds else train
        (dest / TRAIN_FILENAME).write_text(train, encoding="utf-8")
        (dest / VALID_FILENAME).write_text(valid, encoding="utf-8")
        (dest / DATA_FILENAME).write_text(
            f"classes = {len(names)}\n"
            f"train = {TRAIN_FILENAME}\n"
            f"valid = {VALID_FILENAME}\n"
            f"names = {NAMES_FILENAME}\n"
            f"backup = {BACKUP_DIRNAME}/\n",
            encoding="utf-8",
        )


def _listing(dest: Path, fold: str) -> str:
    """One image path per line, relative to ``dest``, in a stable order."""
    images = sorted((dest / IMAGES_DIRNAME / fold).iterdir())
    return "".join(f"{IMAGES_DIRNAME}/{fold}/{image.name}\n" for image in images)
