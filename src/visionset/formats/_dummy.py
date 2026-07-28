"""No-op exporter proving entry-point discovery works end to end.

Registered in pyproject.toml under [project.entry-points."visionset.formats"].
"""

from __future__ import annotations

from pathlib import Path

from visionset.kernel.domain import Manifest, Release


class DummyExporter:
    """Implements the ``Exporter`` port structurally; exports nothing."""

    format_name = "dummy"

    #: ``False``, and it is not a lie by omission. Writing nothing is not the
    #: same as dropping something: the flag says what a format *cannot express*,
    #: and this one is never asked to express anything. A ``True`` here would put
    #: a consent prompt in front of an export that has nothing to consent to.
    lossy = False

    def export(self, release: Release, manifest: Manifest, dest: Path) -> None:
        return None
