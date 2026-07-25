from pathlib import Path
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import Release


@runtime_checkable
class Exporter(Protocol):
    """A dataset-format exporter plugin.

    Implementations are discovered via the ``visionset.formats`` entry-point
    group, so third-party distributions can plug in. Any coordinate
    normalization a format requires happens here — never in the domain.
    """

    format_name: str

    def export(self, release: Release, dest: Path) -> None: ...
