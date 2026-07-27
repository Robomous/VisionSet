from pathlib import Path
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import Manifest, Release


@runtime_checkable
class Exporter(Protocol):
    """A dataset-format exporter plugin.

    Implementations are discovered via the ``visionset.formats`` entry-point
    group, so third-party distributions can plug in. Any coordinate
    normalization a format requires happens here — never in the domain.

    The manifest comes in beside the release rather than off it. A ``Release``
    only *names* its manifest, because the document lives in the blob store and
    can be megabytes; an exporter given the release alone would hold a hash and
    no way to resolve it, since the kernel hands its plugins domain values and
    never a port. ``ReleaseService.manifest`` is what a caller resolves it with.
    """

    format_name: str

    def export(self, release: Release, manifest: Manifest, dest: Path) -> None: ...
