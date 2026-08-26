# usage: from visionset.server.routes import formats
"""What this deployment can export to: the formats, and the targets they write for.

Two routes, both listings rather than lines in the documentation, because the
answer is a property of the *installation*: any distribution registering into
the ``visionset.formats`` entry-point group adds a row to each, and nothing in
this repository can enumerate what somebody else has installed.

Not nested under anything. A format is not owned by a project, a dataset or a
release — the same set is available to all of them — and hanging the list off one
of those would suggest otherwise. The target catalog is the same set seen from
the trainer's side, flattened so a client renders one control from one read.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from visionset.server.dependencies import ExportersDep, protected_router
from visionset.server.models import ExportTargetOut, ExportTargetPage, FormatOut, FormatPage

router = protected_router(prefix="/formats", tags=["formats"])
targets_router = protected_router(prefix="/export-targets", tags=["formats"])


@router.get("")
def list_formats(exporters: ExportersDep) -> FormatPage:
    """Every export format installed on this server, by name.

    `name` is what `POST /releases/{release_id}/export?format=` takes. `targets`
    names the models this format writes for; `GET /export-targets` carries each
    one in full.

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


@targets_router.get("")
def list_export_targets(exporters: ExportersDep) -> ExportTargetPage:
    """Every model this server can export a release for, by name.

    The catalog is derived from the installed formats: each declares the targets
    it writes for, and every installed format declares at least one, so nothing
    exportable is missing from this list. `name` is what
    `POST /releases/{release_id}/export?target=` takes, and `format` is the
    installed format that export resolves to.

    `geometries` is what an export addressed to the target carries — never wider
    than its format writes, and narrower where the trainer has no task for a
    shape. `tasks` is the trainer's own vocabulary and may name tasks nothing
    here can feed. `hints` is what the trainer expects of its images, for a
    client that offers to prepare them.
    """
    rows = [
        ExportTargetOut.of(target, exporter)
        for exporter in exporters.values()
        for target in exporter.targets
    ]
    return ExportTargetPage(items=sorted(rows, key=lambda out: out.name), total=len(rows))
