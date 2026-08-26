# usage: from visionset.formats.yolov5_yaml import Yolov5YamlExporter
"""The YOLOv5 descriptor dialect: ``data.yaml`` with ``nc``, a ``names`` list, and ``./`` paths.

The same images-and-labels layout as the ``ultralytics`` dialect, under the
descriptor grammar the YOLOv5 README documents and the trainers that grew out
of it read: no ``path`` key, every split path relative to the yaml's own
directory and spelled with a leading ``./``, ``nc`` as an integer, and
``names`` as a list in index order. YOLOv7 is the target that reads this and
not the mapping form.

Detection only, always. ``supported_geometries`` is ``{bbox}`` and
``degraded_geometries`` is ``{polygon}``: a polygon is written as its
axis-aligned bounding box, which a detector can use, and the report counts it
as degraded and says so by class. A classification tag has no location and is
dropped. ``lossy = True`` for the reason every label-row format is — a row is
five numbers, so attributes, confidence and provenance never survive.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from visionset.formats._yolo_writer import (
    DATA_FILENAME,
    HEADER_COMMENT,
    LABELS_DIRNAME,
    class_names,
    detect_rows,
    fold_path,
    write_label_layout,
    yaml_scalar,
)
from visionset.kernel.domain import (
    ExportTarget,
    GeometryType,
    Manifest,
    PreprocessingHints,
    Release,
    ResizeStrategy,
    TargetFamily,
    Task,
)
from visionset.kernel.ports import ContentReader

__all__ = ["DATA_FILENAME", "LABELS_DIRNAME", "TARGETS", "Yolov5YamlExporter"]

TARGETS: Final[frozenset[ExportTarget]] = frozenset(
    {
        ExportTarget(
            name="yolov7",
            label="YOLOv7",
            family=TargetFamily.COMMUNITY_YOLO,
            tasks=frozenset({Task.DETECT}),
            supported_geometries=frozenset({GeometryType.BBOX}),
            hints=PreprocessingHints(
                recommended_size=(640, 640),
                recommended_strategy=ResizeStrategy.LETTERBOX,
                trainer_resizes=True,
                augmentation_common=True,
            ),
        )
    }
)


class Yolov5YamlExporter:
    """Writes a release as a YOLO detection dataset under the YOLOv5 descriptor grammar."""

    format_name = "yolov5-yaml"

    #: A label row is ``class cx cy w h`` and nothing else, so attributes,
    #: confidence and per-annotation provenance are dropped from every export
    #: regardless of what a particular release happens to hold.
    lossy = True

    #: Boxes, and only boxes, arrive intact.
    supported_geometries = frozenset({GeometryType.BBOX})

    #: Polygons, because the detect rows write one as its axis-aligned bounds.
    #: Declared rather than left to the reader: without this set the report has
    #: no word for the conversion and calls it a removal.
    degraded_geometries = frozenset({GeometryType.POLYGON})

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
        folds = write_label_layout(release, manifest, dest, content, detect_rows)
        _write_data_yaml(dest / DATA_FILENAME, class_names(manifest), folds)


def _write_data_yaml(target: Path, names: list[str], folds: set[str]) -> None:
    """The descriptor: ``./``-prefixed split paths, ``nc``, and ``names`` as a list.

    ``nc`` is written and it equals ``len(names)`` by construction — the
    grammar has both, and a reader asserts they agree. ``train`` and ``val``
    are both required, so a release with no recipe points ``val`` at the
    training images rather than omitting the key; ``test`` is written only when
    it has something in it. The list is a JSON array, which is a YAML flow
    sequence, so a name holding a comma or a quote cannot break it.
    """
    present = sorted(folds)
    train = fold_path(folds, "train", f"./images/{present[0]}", prefix="./")
    lines = [
        HEADER_COMMENT,
        f"train: {train}",
        f"val: {fold_path(folds, 'val', train, prefix='./')}",
    ]
    if "test" in folds:
        lines.append("test: ./images/test")
    lines.append(f"nc: {len(names)}")
    lines.append(f"names: [{', '.join(yaml_scalar(name) for name in names)}]")
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
