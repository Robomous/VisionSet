from pathlib import Path
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import ImportedDataset


@runtime_checkable
class Importer(Protocol):
    """An annotation-format importer plugin.

    Implementations are discovered via the ``visionset.formats`` entry-point
    group, so third-party distributions can plug in. ``read`` reads a directory
    and returns a value: it never touches a workspace, and it reports everything
    it could not represent in ``ImportedDataset.losses`` rather than dropping it.

    Raises:
        ImportSourceUnreadable: the source is malformed or names an unsafe path.
    """

    format_name: str

    def read(self, src: Path) -> ImportedDataset: ...
