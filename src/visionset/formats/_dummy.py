"""No-op exporter proving entry-point discovery works end to end.

Registered in pyproject.toml under [project.entry-points."visionset.formats"].
"""

from __future__ import annotations

from pathlib import Path

from visionset.kernel.domain import Release


class DummyExporter:
    """Implements the ``Exporter`` port structurally; exports nothing."""

    format_name = "dummy"

    def export(self, release: Release, dest: Path) -> None:
        return None
