# usage: from visionset.server.routes import formats
"""What this deployment can export to.

One route, and it is a listing rather than a line in the documentation, because
the answer is a property of the *installation*: any distribution registering into
the ``visionset.formats`` entry-point group adds a row here, and nothing in this
repository can enumerate what somebody else has installed.

Not nested under anything. A format is not owned by a project, a dataset or a
release — the same set is available to all of them — and hanging the list off one
of those would suggest otherwise.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from visionset.server.dependencies import ExportersDep, protected_router
from visionset.server.models import FormatOut, FormatPage

router = protected_router(prefix="/formats", tags=["formats"])


@router.get("")
def list_formats(exporters: ExportersDep) -> FormatPage:
    """Every export format installed on this server, by name.

    `name` is what `POST /releases/{release_id}/export?format=` takes.

    `lossy` says the format cannot carry everything the kernel can represent —
    some geometry, attribute kind, or per-annotation provenance is dropped. It is
    a property of the format rather than of any one release, so it is answered
    here and not per export, and exporting in one requires `allow_lossy=true`.

    Never empty in practice: a built-in no-op format ships with VisionSet so the
    plugin path is exercised even before a real exporter is installed.
    """
    installed = exporters.values()
    return FormatPage(
        items=sorted((FormatOut.of(exporter) for exporter in installed), key=lambda out: out.name),
        total=len(installed),
    )
