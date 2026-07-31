"""No-op exporter proving entry-point discovery works end to end.

Registered in pyproject.toml under [project.entry-points."visionset.formats"].
"""

from __future__ import annotations

from pathlib import Path

from visionset.kernel.domain import GeometryType, Manifest, Release
from visionset.kernel.ports import ContentReader


class DummyExporter:
    """Implements the ``Exporter`` port structurally; exports nothing."""

    format_name = "dummy"

    #: ``False``, and it is not a lie by omission. Writing nothing is not the
    #: same as dropping something: the flag says what a format *cannot express*,
    #: and this one is never asked to express anything. A ``True`` here would put
    #: a consent prompt in front of an export that has nothing to consent to.
    lossy = False

    #: Everything, and it costs nothing to say so: this exporter writes no files,
    #: so there is no geometry it could fail to express. Declaring a narrower set
    #: would make #65's report describe a loss that never happens.
    #:
    #: Read off ``GeometryType`` rather than listed, so the eight names live in
    #: one place — the same reason ``IMPLEMENTED_GEOMETRIES`` is derived from the
    #: ``Geometry`` union rather than restated.
    supported_geometries = frozenset(GeometryType)

    #: Likewise. ``image`` is the only modality anything produces today; a set
    #: that named it would have to grow when the domain does.
    supported_modalities = frozenset({"image", "video", "point_cloud"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        return None
