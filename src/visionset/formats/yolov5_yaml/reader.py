# usage: from visionset.formats.yolov5_yaml import Yolov5YamlImporter
"""YOLOv5 descriptor in: ``data.yaml`` with ``nc`` and a ``names`` list, and the label layout.

The inverse of :class:`Yolov5YamlExporter`. The descriptor names the classes,
``nc`` must agree with them, and the pictures under ``images/`` and their label
rows are read through the shared YOLO reader. The exporter writes boxes only,
so its exports read back as boxes; a polygon row from another tool is read as
a polygon rather than refused.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from visionset.formats._yolo_reader import descriptor_file, read_label_layout, yaml_descriptor
from visionset.formats._yolo_writer import DATA_FILENAME
from visionset.kernel.domain import ImportedDataset
from visionset.kernel.errors import ImportSourceUnreadable

_LABEL: Final = "YOLOv5"


class Yolov5YamlImporter:
    """Reads a YOLOv5-descriptor dataset into an ``ImportedDataset``."""

    format_name = "yolov5-yaml"

    def read(self, src: Path) -> ImportedDataset:
        descriptor = descriptor_file(src, DATA_FILENAME, _LABEL)
        if descriptor is None:
            raise ImportSourceUnreadable(
                f"the YOLOv5 source {src.name!r} holds no {DATA_FILENAME} nor a single YAML "
                "file at its top"
            )
        return read_label_layout(src, yaml_descriptor(descriptor), _LABEL)


__all__ = ["Yolov5YamlImporter"]
