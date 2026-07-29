# usage: from visionset.cli.projects import project_app
"""``visionset project`` — the container everything else hangs off.

Two commands, and both are one ``ProjectService`` call. The rules — a name unique
per workspace case-insensitively, a dataset created in the same transaction, a
blank name refused — are the kernel's and not one of them is restated here.

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

from typing import Annotated, Final

import typer

from visionset.cli import _json
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.services import ProjectService

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
        document(_json.project(created))
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
        projects = ProjectService(service).list()
        root = service.root
    if json_out:
        document(_json.page([_json.project(p) for p in projects]))
        return
    table(_COLUMNS, [(str(p.id), p.name, p.description or _NONE) for p in projects])
    if not projects:
        note(f"No projects in {root}.")
