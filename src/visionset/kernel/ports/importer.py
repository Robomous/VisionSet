from collections.abc import Iterable
from pathlib import Path
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import Annotation


@runtime_checkable
class Importer(Protocol):
    """An annotation-format importer plugin.

    Implementations are discovered via the ``visionset.formats`` entry-point
    group, so third-party distributions can plug in.
    """

    format_name: str

    def read(self, src: Path) -> Iterable[Annotation]: ...
