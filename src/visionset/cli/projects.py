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

from collections.abc import Callable
from dataclasses import asdict
from typing import Annotated, Final
from uuid import UUID

import typer

from visionset import wire
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._resolve import resolve_project
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.cli.batches import announce_plan
from visionset.cli.inference import ConnectionArgument, _resolve
from visionset.inference import (
    DEFAULT_MINIMUM_CONFIDENCE,
    pre_label,
    select_pre_labelable,
    served_for,
)
from visionset.kernel.services import InferenceConnectionService, ProjectService

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


def _progress_note(batch_name: str) -> Callable[[int, int], None]:
    def report(done: int, total: int) -> None:
        note(f"Pre-labeling {batch_name!r} {done}/{total} asset(s).")

    return report


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
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Ask a model to label every untouched asset across a project's open batches.

    One batch after another, each the same run `batch pre-label` makes; blocks
    because a terminal has no dispatcher. The connection is checked first: an
    unknown connection, one not set up yet, or one whose model answers places
    rather than words is refused before the selection is read. The selection
    is refused whole before the first forward pass: a batch outside the
    project, a named batch that is not open, a project with no open batch, or
    a pinned schema with no class a shape this model produces can be written as.
    """
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        connection_id = _resolve(InferenceConnectionService(service), connection)
        declared = served_for(service, connection_id)
        selected = select_pre_labelable(service, resolved.id, declared.produces, batch)
        outcomes = []
        for one in selected:
            note(f"Batch {one.name!r}:")
            outcome = pre_label(
                service,
                batch_id=one.id,
                connection_id=connection_id,
                minimum_confidence=minimum_confidence,
                on_plan=announce_plan,
                on_progress=_progress_note(one.name),
            )
            outcomes.append((one, outcome))
    written = sum(outcome.annotations_written for _, outcome in outcomes)
    if json_out:
        document(
            {
                "items": [
                    {"batch_id": str(one.id), "batch_name": one.name, **asdict(outcome)}
                    for one, outcome in outcomes
                ],
                "annotations_written": written,
            }
        )
        return
    for one, outcome in outcomes:
        note(
            f"Batch {one.name!r}: pre-labeled {outcome.assets_labeled} asset(s), "
            f"wrote {outcome.annotations_written} annotation(s)."
        )
    note(f"Pre-labeled {len(outcomes)} batch(es), wrote {written} annotation(s).")
    typer.echo(str(written))
