"""Test-only exporter, registered by the static distribution beside this file."""

from __future__ import annotations

from pathlib import Path

from visionset.formats._targets import self_target
from visionset.kernel.domain import GeometryType, Manifest, Release
from visionset.kernel.ports import ContentReader


class DummyExporter:
    """Implements the ``Exporter`` port structurally; exports nothing."""

    format_name = "dummy"

    #: Writing nothing drops nothing, so it is never asked to consent to a loss.
    lossy = False

    supported_geometries = frozenset(GeometryType)

    degraded_geometries: frozenset[GeometryType] = frozenset()

    supported_modalities = frozenset({"image", "video", "point_cloud"})

    targets = self_target(format_name, supported_geometries)

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        return None
