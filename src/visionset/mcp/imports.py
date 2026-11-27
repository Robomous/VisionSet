# usage: from visionset.mcp import imports
"""Import tools: an external dataset in, one approved batch out.

``inspect_import`` and ``import_dataset`` take the same arguments, and the first
writes nothing: it answers with the plan the second would carry out, losses
included. Consent is per loss kind, the kinds ``inspect_import`` lists in
``loss_kinds``.

**A local path, synchronous, like ``ingest``.** An agent runs beside the
workspace, so it names a directory rather than uploading one, and a stdio server
has no worker to poll. A client that sends a ``progressToken`` hears each image
or scan stored.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

from mcp.server.mcpserver import Context
from pydantic import AfterValidator, Field

from visionset import wire
from visionset.formats import registry
from visionset.kernel.domain import ImportConsent, ImportLossKind
from visionset.kernel.ports import Importer
from visionset.kernel.services import ImportService, ProjectService
from visionset.mcp._errors import Refusal
from visionset.mcp._progress import reporting
from visionset.mcp._resolve import ProjectRef
from visionset.mcp._workspace import opened_workspace
from visionset.wire import shapes

ImportFormatRef = Annotated[
    str,
    Field(description="The format the dataset is in, such as `coco`."),
]
"""Module-level for the ``inspect.signature`` reason."""

SourcePath = Annotated[
    str,
    Field(
        description=(
            "A path on this machine to the dataset's directory; `~` is expanded, and a "
            "relative path is read against the server's working directory."
        )
    ),
]
"""Module-level for the ``inspect.signature`` reason."""


# A string checked against the enum rather than the enum itself, so the listing
# carries no `"class"` token: the one spelling the registration test reserves.
def _loss_kind(value: str) -> str:
    return ImportLossKind(value).value


LossKindName = Annotated[str, AfterValidator(_loss_kind)]


def inspect_import(
    project: ProjectRef, format: ImportFormatRef, path: SourcePath
) -> shapes.ImportPlan:
    """Read an external dataset and report what importing it would do. Writes nothing.

    `losses` lists everything the import cannot carry, by kind, subject and
    count: a geometry the kernel has no type for, a label outside its image, an
    image the source names but does not hold. A dataset of point-cloud scans,
    such as `kitti`, counts them in `scans` and names the frame its scans and
    labels are written in as `frame`. `loss_kinds` is what
    `import_dataset` needs in `consent_lossy` to go ahead. `conflicts` refuse an
    import whatever it consents to, such as a label the project's existing schema
    cannot accept.

    `creates_schema` is true when the project has no schema and the dataset's
    classes would become version 1. `new_assets` and `new_annotations` are what
    a commit would add; images already in the project are matched by content.
    `sequences` counts the image sequences a commit would write as sources, those
    holding an asset it creates or labels (such as OpenLane segments), and
    `tracks` the tracks over the labels it would write.

    Every image or scan is decoded, so expect it to take a while on a large dataset.
    """
    with opened_workspace() as workspace:
        resolved = ProjectService(workspace).resolve(project)
        plan = ImportService(workspace).inspect(resolved.id, _importer(format), _local(path))
    return wire.import_plan(plan)


def import_dataset(
    project: ProjectRef,
    format: ImportFormatRef,
    path: SourcePath,
    consent_lossy: Annotated[
        list[LossKindName] | None,
        Field(
            description=(
                "The loss kinds to accept dropping, from `inspect_import`'s `loss_kinds`: "
                f"any of {', '.join(f'`{kind.value}`' for kind in ImportLossKind)}. "
                "An import that would drop a kind not named here is refused."
            )
        ),
    ] = None,
    ctx: Context[Any, Any] | None = None,
) -> shapes.ImportRun | Refusal:
    """Import an external dataset into a project as one approved batch. Blocks until done.

    The images, or a dataset's point-cloud scans, are ingested by content, the
    dataset's classes become schema version 1 when the project has none, and
    every label is written with `import` provenance. Scans are registered under
    a point-cloud source at `path` that declares the dataset's frame. The batch
    is approved and stops there: each labeled asset arrives `annotated`, and a
    person reviews and promotes them as with any other batch. An existing schema
    is never changed by an import. Each image sequence holding an asset the run
    creates or labels becomes a new source, listed in `source_ids`, and its
    tracks are written over it; `tracks_written` counts them.

    Call `inspect_import` first: an import that would drop anything refuses
    with `IMPORT_NOT_CONSENTED` unless `consent_lossy` names each kind, and the
    refusal's `detail.losses` lists what. Re-running the same source writes
    nothing new and answers a null `batch_id`.

    A client that sends a `progressToken` hears each image or scan as it is stored.
    """
    consent = ImportConsent(kinds=frozenset(ImportLossKind(kind) for kind in consent_lossy or ()))
    with opened_workspace() as workspace, reporting(ctx) as report:
        resolved = ProjectService(workspace).resolve(project)
        run = ImportService(workspace).commit(
            resolved.id,
            _importer(format),
            _local(path),
            consent=consent,
            on_progress=lambda done, total: report(done, total, f"stored {done} of {total} files"),
        )
    return wire.import_run(run)


def _importer(format_name: str) -> Importer:
    return registry.pick_importer(registry.importers(), format_name)[0]


def _local(path: str) -> Path:
    return Path(path).expanduser().resolve()
