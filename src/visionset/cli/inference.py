# usage: from visionset.cli.inference import inference_app
"""``visionset inference`` — configuring where a model may be asked to predict.

Six commands over one service, so a workspace can be made ready for
auto-labeling without a browser — including the one operation that reaches a
network, ``download``. Contacting an endpoint is still absent (`cf. #421`): a
command that cannot work is worse than one that is not there yet.

**``download`` blocks, and that is ``ingest``'s pattern rather than a shortcut.**
The API queues the same work because it has a dispatcher to run it; a terminal
does not, and a CLI that enqueued would print a job id nothing was ever going to
claim. So this runs the work here, says so on stderr first, and shares its body
with the job handler — ``visionset.inference.fetch_weights`` is the sequence
both call, because two implementations of "what downloading means" is how a
terminal and an API come to disagree about what "set up" means.
"""

from __future__ import annotations

from typing import Annotated, Final
from uuid import UUID

import typer

from visionset import wire
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.inference import fetch_weights
from visionset.kernel.domain import ConnectionType, InferenceConnection
from visionset.kernel.services import InferenceConnectionService

inference_app = typer.Typer(
    help="Configure where inference runs. Nothing is downloaded on your behalf.",
    no_args_is_help=True,
)

_COLUMNS: Final = ("ID", "NAME", "TYPE", "MODEL", "SETUP")
"""Every column always has a value, so there is no absent-value placeholder here:
the per-type parameters that *can* be absent are not in the listing, because a
column that is empty for half the rows is width nobody reads."""

ConnectionArgument = Annotated[str, typer.Argument(help="The connection, by name or by id.")]
"""What a command acts on. Names are unique in a workspace, so either resolves.

Module-level for the ``get_type_hints`` reason ``WorkspaceOption`` is.
"""


def _resolve(service: InferenceConnectionService, reference: str) -> UUID:
    """The id behind a name or an id, on ``_resolve.resolve_project``'s terms."""
    try:
        return UUID(reference)
    except ValueError:
        return service.get_by_name(reference).id


@inference_app.command("create")
def inference_create(
    name: Annotated[str, typer.Argument(help="Unique in this workspace, ignoring case.")],
    connection_type: Annotated[
        ConnectionType,
        typer.Option("--type", help="Where the model runs."),
    ],
    model_id: Annotated[str, typer.Option("--model", help="Which model, at its source.")],
    model_revision: Annotated[
        str, typer.Option("--revision", help="Pinned. A moving pointer is not a provenance.")
    ],
    device: Annotated[
        str | None, typer.Option("--device", help="Local only. For example cuda or cpu.")
    ] = None,
    precision: Annotated[
        str | None, typer.Option("--precision", help="Local only. For example fp16.")
    ] = None,
    endpoint_url: Annotated[
        str | None, typer.Option("--endpoint", help="HTTP only. Where to send predictions.")
    ] = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Configure a connection. Nothing is downloaded and nothing is contacted."""
    with opened_workspace(workspace) as service:
        created = InferenceConnectionService(service).create(
            name,
            connection_type=connection_type,
            model_id=model_id,
            model_revision=model_revision,
            device=device,
            precision=precision,
            endpoint_url=endpoint_url,
        )
    if json_out:
        document(wire.connection(created))
        return
    note(f"Created {created.connection_type.value} connection {created.name!r}.")
    typer.echo(str(created.id))


@inference_app.command("show")
def inference_show(
    connection: ConnectionArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """One connection, by name or by id."""
    with opened_workspace(workspace) as service:
        connections = InferenceConnectionService(service)
        found = connections.get(_resolve(connections, connection))
    if json_out:
        document(wire.connection(found))
        return
    table(_COLUMNS, [_row(found)])


@inference_app.command("update")
def inference_update(
    connection: ConnectionArgument,
    name: Annotated[str | None, typer.Option("--name", help="Rename it.")] = None,
    model_id: Annotated[str | None, typer.Option("--model", help="Point at another model.")] = None,
    model_revision: Annotated[str | None, typer.Option("--revision", help="Move the pin.")] = None,
    device: Annotated[str | None, typer.Option("--device", help="Local only.")] = None,
    precision: Annotated[str | None, typer.Option("--precision", help="Local only.")] = None,
    endpoint_url: Annotated[str | None, typer.Option("--endpoint", help="HTTP only.")] = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Edit a connection. Options you omit are left alone; the type cannot change."""
    with opened_workspace(workspace) as service:
        connections = InferenceConnectionService(service)
        edited = connections.update(
            _resolve(connections, connection),
            name=name,
            model_id=model_id,
            model_revision=model_revision,
            device=device,
            precision=precision,
            endpoint_url=endpoint_url,
        )
    if json_out:
        document(wire.connection(edited))
        return
    note(f"Updated connection {edited.name!r}.")
    typer.echo(str(edited.id))


@inference_app.command("download")
def inference_download(
    connection: ConnectionArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Fetch a local connection's weights. This is the only thing that downloads a model.

    Nothing arrives on your behalf: no install, no first run, and no other
    command fetches anything. This one does, because you asked it to.

    It **blocks** — the weights are gigabytes and there is no worker at a
    terminal to hand the job to — and reports each phase on stderr. Interrupting
    it is safe: the connection is only marked ready once the files are all here,
    so a run you stop has changed nothing and running it again resumes the cache
    rather than starting over.

    Refused, with a sentence, when there is nothing to do: an `http` connection
    has no weights of its own, and one that is already set up has them.
    """
    with opened_workspace(workspace) as service:
        connections = InferenceConnectionService(service)
        connection_id = _resolve(connections, connection)
        # Inside the block: every refusal below is a ``VisionSetError`` —
        # already set up, no weights of its own, the extra not installed — and
        # ``opened_workspace`` is what turns one into a sentence and exit 1
        # rather than a traceback.
        ready = fetch_weights(service, connection_id, on_progress=note)
    if json_out:
        document(wire.connection(ready))
        return
    note(f"Connection {ready.name!r} is ready.")
    typer.echo(str(ready.id))


@inference_app.command("delete")
def inference_delete(
    connection: ConnectionArgument,
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Do not ask.")] = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Remove a connection. Annotations keep the model provenance they recorded.

    Asks before acting even though the kernel takes no ``confirm``: what is
    destroyed is a configuration rather than work, so the gate is this surface's
    courtesy rather than a domain rule.
    """
    with opened_workspace(workspace) as service:
        connections = InferenceConnectionService(service)
        found = connections.get(_resolve(connections, connection))
        if not yes:
            typer.confirm(
                f"Delete connection {found.name!r}? Annotations keep their model "
                "provenance; only this configuration is removed.",
                abort=True,
            )
        connections.delete(found.id)
        removed = found.name
    note(f"Deleted connection {removed!r}.")


def _row(value: InferenceConnection) -> tuple[str, str, str, str, str]:
    """One listing row. Model and revision share a column, the way a person reads them."""
    return (
        str(value.id),
        value.name,
        value.connection_type.value,
        f"{value.model_id}@{value.model_revision}",
        value.setup_state.value,
    )


# ``list`` shadows the builtin for every annotation below it, so it is last.
@inference_app.command("list")
def inference_list(
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """List this workspace's connections, oldest first."""
    with opened_workspace(workspace) as service:
        connections = InferenceConnectionService(service).list()
        root = service.root
    if json_out:
        document(wire.page([wire.connection(one) for one in connections]))
        return
    table(_COLUMNS, [_row(one) for one in connections])
    if not connections:
        note(f"No inference connections in {root}.")
