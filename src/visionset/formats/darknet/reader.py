# usage: from visionset.formats.darknet import DarknetImporter
"""Darknet in: ``obj.names`` (through ``obj.data``'s ``names =``) and the label layout.

The inverse of :class:`DarknetExporter`. The names file is one class per line
in index order, looked up by its file name at the top of the source because
``obj.data`` names it relative to wherever Darknet is run, and ``obj.data``'s
``classes =`` must agree with it. The pictures are found under ``images/``, as
the exporter lays them out, rather than through ``train.txt`` and
``valid.txt``: the exporter writes test pictures that neither list names. The
label rows are read through the shared YOLO reader.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Final

from visionset.formats._reading import contained, index, read_text
from visionset.formats._yolo_reader import Descriptor, read_label_layout
from visionset.kernel.domain import ImportedDataset
from visionset.kernel.errors import ImportSourceUnreadable

DATA_FILENAME: Final = "obj.data"
NAMES_FILENAME: Final = "obj.names"
_LABEL: Final = "Darknet"


class DarknetImporter:
    """Reads a Darknet dataset into an ``ImportedDataset``."""

    format_name = "darknet"

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the Darknet source {src.name!r} is not a directory")
        data = src / DATA_FILENAME
        settings = _settings(contained(src, src.resolve(), data)) if data.is_file() else {}
        named = PurePosixPath(settings.get("names", "")).name
        names_path = src / (named if named not in ("", "..") else NAMES_FILENAME)
        if not names_path.is_file():
            raise ImportSourceUnreadable(
                f"the Darknet source {src.name!r} holds no {names_path.name}"
            )
        contained(src, src.resolve(), names_path)
        names = _names(names_path)
        if "classes" in settings and index(settings["classes"]) != len(names):
            raise ImportSourceUnreadable(
                f"{DATA_FILENAME}: classes is {settings['classes']!r} but "
                f"{names_path.name} lists {len(names)}"
            )
        return read_label_layout(src, Descriptor(names=names), _LABEL)


def _settings(path: Path) -> dict[str, str]:
    settings: dict[str, str] = {}
    for line in read_text(path, path.name).split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, equals, value = line.partition("=")
        if not equals:
            raise ImportSourceUnreadable(f"{path.name}: {line[:40]!r} is not a key = value line")
        settings[key.strip()] = value.strip()
    return settings


def _names(path: Path) -> dict[int, str]:
    lines = [line.removesuffix("\r") for line in read_text(path, path.name).split("\n")]
    while lines and not lines[-1].strip():
        lines.pop()
    for number, line in enumerate(lines, 1):
        if not line.strip():
            raise ImportSourceUnreadable(f"{path.name}: line {number} names no class")
    if not lines:
        raise ImportSourceUnreadable(f"{path.name} names no classes")
    names = [line.strip() for line in lines]
    if len(set(names)) != len(names):
        repeated = next(name for name in names if names.count(name) > 1)
        raise ImportSourceUnreadable(f"{path.name}: class name {repeated!r} is given twice")
    return dict(enumerate(names))


__all__ = ["DATA_FILENAME", "NAMES_FILENAME", "DarknetImporter"]
