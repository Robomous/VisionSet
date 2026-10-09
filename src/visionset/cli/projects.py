# usage: from visionset.cli.projects import project_app
"""``visionset project`` — the container everything else hangs off.

Three commands. ``create`` and ``list`` are each one ``ProjectService`` call, and
the rules behind them — a name unique per workspace case-insensitively, a
dataset created in the same transaction, a blank name refused — are the
kernel's and not one of them is restated here. ``pre-label`` hangs off
``project`` rather than off a group of its own because its subject is the
project, the same way ``batch pre-label``'s subject is the batch.

``create`` takes its name **positionally** where ``token create`` takes ``--name``,
and the difference is what the name is. A token's name is metadata attached to a
credential whose actual output is the secret; a project's name *is* the project,
the way ``token revoke NAME`` already treats one. Its id goes to stdout alone, so
``P=$(visionset project create road-signs)`` works — though every other command
also takes the name, which is usually what a person types.

There is deliberately no ``rename`` and no ``delete``. Both are administration
rather than flow, and both want a confirmation prompt and the cascade explained;
landing them together is how that gets documented once instead of twice.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated, Final
from uuid import UUID

import typer

from visionset import wire
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.cli.batches import GeometryOption, announce_plan
from visionset.cli.inference import ConnectionArgument
from visionset.inference import (
    DEFAULT_MINIMUM_CONFIDENCE,
    effective_produces,
    geometry_selection,
    pre_label_selection,
    select_pre_labelable,
    served_for,
)
from visionset.kernel.services import (
    InferenceConnectionService,
    ProjectService,
)

project_app = typer.Typer(help="Create and list projects.", no_args_is_help=True)

_COLUMNS: Final = ("ID", "NAME", "DESCRIPTION")

_NONE: Final = "-"
"""What an absent description shows, so the column never collapses."""


@project_app.command("create")
def project_create(
    name: Annotated[str, typer.Argument(help="Unique in this workspace, ignoring case.")],
    description: Annotated[
        str | None, typer.Option("--description", help="Free text, for people.")
    ] = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Create a project and its empty dataset."""
    with opened_workspace(workspace) as service:
        created = ProjectService(service).create(name, description)
    if json_out:
        # A project created this instant has no batches, so its preview is settled.
        document(wire.project(created, None))
        return
    note(f"Created project {created.name!r}.")
    typer.echo(str(created.id))


@project_app.command("list")
def project_list(
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """List this workspace's projects, oldest first."""
    with opened_workspace(workspace) as service:
        found = ProjectService(service)
        projects = found.list()
        previews = found.previews() if json_out else {}
        root = service.root
    if json_out:
        document(wire.page([wire.project(p, previews.get(p.id)) for p in projects]))
        return
    table(_COLUMNS, [(str(p.id), p.name, p.description or _NONE) for p in projects])
    if not projects:
        note(f"No projects in {root}.")


@project_app.command("pre-label")
def project_pre_label(
    project: Annotated[str, typer.Argument(help="The project, by name or by id.")],
    connection: ConnectionArgument,
    batch: Annotated[
        list[UUID] | None,
        typer.Option(
            "--batch",
            help="Only this batch, by id; repeat for several. Omit for every open batch.",
        ),
    ] = None,
    minimum_confidence: Annotated[
        float,
        typer.Option(
            "--minimum-confidence",
            min=0.0,
            max=1.0,
            help="The floor a prediction must clear to be written, in [0, 1].",
        ),
    ] = DEFAULT_MINIMUM_CONFIDENCE,
    geometry: GeometryOption = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Ask a model to label every untouched asset across a project's open batches.

    One batch after another, each the same run `batch pre-label` makes; blocks
    because a terminal has no dispatcher. The connection is checked first: an
    unknown connection, one not set up yet, one whose model answers places
    rather than words, or a `--geometry` it does not produce is refused before
    the selection is read. The selection is refused whole before the first
    forward pass: a batch outside the project, a named batch that is not open,
    a project with no open batch, or a pinned schema with no class a shape
    this run writes can be written as.
    """
    with opened_workspace(workspace) as service:
        resolved = ProjectService(service).resolve(project)
        connection_id = InferenceConnectionService(service).resolve(connection).id
        declared = served_for(service, connection_id)
        geometries = geometry_selection(geometry)
        produces = effective_produces(declared.produces, geometries)
        selected = select_pre_labelable(service, resolved.id, produces, batch)
        ran = pre_label_selection(
            service,
            selected,
            connection_id=connection_id,
            minimum_confidence=minimum_confidence,
            geometries=geometries,
            on_batch=lambda one: note(f"Batch {one.name!r}:"),
            on_plan=lambda _one, index, plan: announce_plan(plan) if index == 0 else None,
            on_progress=lambda one, done, total: note(
                f"Pre-labeling {one.name!r} {done}/{total} asset(s)."
            ),
        )
    written = sum(job.outcome.annotations_written for job in ran)
    if json_out:
        document(
            {
                "items": [
                    {
                        "batch_id": str(job.batch.id),
                        "batch_name": job.batch.name,
                        "job_id": str(job.job_id),
                        **asdict(job.outcome),
                    }
                    for job in ran
                ],
                "annotations_written": written,
            }
        )
        return
    for job in ran:
        note(
            f"Batch {job.batch.name!r} job {job.job_id}: pre-labeled "
            f"{job.outcome.assets_labeled} asset(s), "
            f"wrote {job.outcome.annotations_written} annotation(s)."
        )
    note(f"Pre-labeled {len(selected)} batch(es), wrote {written} annotation(s).")
    typer.echo(str(written))
