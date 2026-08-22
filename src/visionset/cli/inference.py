# usage: from visionset.cli.inference import inference_app
"""``visionset inference`` — configuring where a model may be asked to predict.

Nine commands, so a workspace can be made ready for auto-labeling without a
browser. Eight are one call to ``InferenceConnectionService``; ``size`` is the
exception and says so — it is about a published model rather than about a
configured row, so it opens no workspace at all. Four reach a network:
``download``, which fetches; ``size``, which reads a listing so that
``download`` can be an informed decision; ``check-integrity``, which reads the
digests a snapshot on disk is compared against; and ``test-endpoint``, which
asks an http connection's endpoint what it answers.

**``download`` and ``check-integrity`` block, and that is ``ingest``'s pattern
rather than a shortcut.**
The API queues the same work because it has a dispatcher to run it; a terminal
does not, and a CLI that enqueued would print a job id nothing was ever going to
claim. So this runs the work here, says so on stderr first, and shares its body
with the job handler — ``visionset.inference.fetch_weights`` is the sequence
both call, because two implementations of "what downloading means" is how a
terminal and an API come to disagree about what "set up" means.
``check-integrity`` shares ``visionset.inference.check_integrity`` with its own
job handler for the same reason.
"""

from __future__ import annotations

from typing import Annotated, Final
from uuid import UUID

import typer

from visionset import wire
from visionset.cli._errors import domain_errors
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.inference import ask_endpoint, check_integrity, download_size, fetch_weights
from visionset.kernel.domain import ConnectionType, InferenceConnection, Precision
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
        str | None,
        typer.Option("--device", help="Local only. cpu, mps, cuda, or cuda:N for a second GPU."),
    ] = None,
    precision: Annotated[
        Precision | None,
        typer.Option(
            "--precision", help="Local only. fp16 needs a cuda device; cpu and mps run in fp32."
        ),
    ] = None,
    endpoint_url: Annotated[
        str | None, typer.Option("--endpoint", help="HTTP only. Where to send predictions.")
    ] = None,
    provider_id: Annotated[
        str | None,
        typer.Option(
            "--provider",
            help=(
                "Which installed driver serves it. Omitted, the connection resolves "
                "by the model type its downloaded config declares."
            ),
        ),
    ] = None,
    credential_env: Annotated[
        str | None,
        typer.Option(
            "--credential-env",
            help=(
                "HTTP only. The NAME of an environment variable holding the endpoint's "
                "credential; the value is read where VisionSet runs, never stored, and "
                "sent as a bearer token."
            ),
        ),
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
            provider_id=provider_id,
            credential_env=credential_env,
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
        # Either run happens in the server's worker against this same workspace,
        # so a terminal can watch one it did not start — the property the REST
        # listing has, published by the surface that shares its projection.
        jobs = connections.connection_jobs()
    if json_out:
        document(wire.connection(found, jobs.downloads.get(found.id), jobs.checks.get(found.id)))
        return
    table(_COLUMNS, [_row(found)])


@inference_app.command("update")
def inference_update(
    connection: ConnectionArgument,
    name: Annotated[str | None, typer.Option("--name", help="Rename it.")] = None,
    model_id: Annotated[str | None, typer.Option("--model", help="Point at another model.")] = None,
    model_revision: Annotated[str | None, typer.Option("--revision", help="Move the pin.")] = None,
    device: Annotated[
        str | None,
        typer.Option("--device", help="Local only. cpu, mps, cuda, or cuda:N for a second GPU."),
    ] = None,
    precision: Annotated[
        Precision | None,
        typer.Option(
            "--precision", help="Local only. fp16 needs a cuda device; cpu and mps run in fp32."
        ),
    ] = None,
    endpoint_url: Annotated[str | None, typer.Option("--endpoint", help="HTTP only.")] = None,
    provider_id: Annotated[
        str | None,
        typer.Option(
            "--provider",
            help=(
                "Which installed driver serves it. Omitted, the connection resolves "
                "by the model type its downloaded config declares."
            ),
        ),
    ] = None,
    credential_env: Annotated[
        str | None,
        typer.Option(
            "--credential-env",
            help=(
                "HTTP only. The NAME of an environment variable holding the endpoint's "
                "credential; the value is read where VisionSet runs, never stored, and "
                "sent as a bearer token."
            ),
        ),
    ] = None,
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
            provider_id=provider_id,
            credential_env=credential_env,
        )
    if json_out:
        document(wire.connection(edited))
        return
    note(f"Updated connection {edited.name!r}.")
    typer.echo(str(edited.id))


@inference_app.command("size")
def inference_size(
    model_id: Annotated[str, typer.Argument(help="Which model, at its source.")],
    model_revision: Annotated[
        str, typer.Option("--revision", help="Pinned. A size is a fact about one revision.")
    ],
    json_out: JsonOption = False,
) -> None:
    """How big fetching that model's weights would be. Nothing is downloaded.

    The number to look at *before* running ``download``, read from the publishing
    hub's file listing rather than from the files. It covers every file in the
    revision, because that is what the download fetches.

    Takes a model and a revision rather than a connection, and opens no
    workspace: the moment the number is wanted is usually the moment before a
    connection exists. ``domain_errors`` is therefore explicit here, where every
    other command in this file inherits it from ``opened_workspace`` — a missing
    extra is still a refusal and must still be a sentence rather than a
    traceback.
    """
    with domain_errors():
        size = download_size(model_id, model_revision)
    if json_out:
        document(wire.download_size(size))
        return
    note(f"{size.file_count} files in {size.model_id} at {size.model_revision}.")
    typer.echo(str(size.total_bytes))


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


@inference_app.command("check-integrity")
def inference_check_integrity(
    connection: ConnectionArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Re-read a local connection's weights and prove they are undamaged.

    Not the same check as re-running ``download``. That one establishes the
    snapshot is **complete** — every file the revision names is present — and it
    answers from an index without opening a file. This reads **every byte** and
    compares it against the digests the publishing hub holds, which is the only
    way to catch a file that is present and wrong: truncated by a filesystem
    error, rotted on a failing disk, edited in place.

    It **blocks**, and it is slow in proportion to the model — gigabytes of
    reading for a large one. ``download``'s reason: there is no worker at a
    terminal to hand the job to.

    If anything fails to match, the damaged copies are **removed** and the
    connection goes back to not set up, so that ``download`` is a real transfer
    rather than a cache hit that hands the same bad bytes back. Interrupting is
    safe: nothing is written or removed until every file has been read.

    Refused when there is nothing to read: an `http` connection has no weights
    of its own, and a local one whose weights never arrived has none yet.
    """
    with opened_workspace(workspace) as service:
        connections = InferenceConnectionService(service)
        connection_id = _resolve(connections, connection)
        # Inside the block, ``download``'s reason: every refusal below is a
        # ``VisionSetError`` — nothing to check, the extra missing, the hub
        # unreachable, and the damage verdict itself — and this is what turns
        # one into a sentence and exit 1 rather than a traceback.
        report = check_integrity(service, connection_id, on_progress=note)
    if json_out:
        document(report.counts())
        return
    note(f"{report.files_checked} files read, {report.bytes_read} bytes, all intact.")
    typer.echo(str(report.files_checked))


@inference_app.command("test-endpoint")
def inference_test_endpoint(
    connection: ConnectionArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Ask an http connection's endpoint what it answers, and record the answer.

    One request to the endpoint, which must answer this project's contract —
    ``{"model_ref": …, "capability": …}``. The capability it declares is what
    the suggest tool and pre-labeling then offer the connection for. Asking
    again re-asks and overwrites.

    Refused for a local connection, which has no endpoint. An endpoint that
    cannot be reached or answers outside the contract is a sentence naming it
    and exit 1, and nothing is recorded.
    """
    with opened_workspace(workspace) as service:
        connections = InferenceConnectionService(service)
        connection_id = _resolve(connections, connection)
        answered = ask_endpoint(service, connection_id)
        jobs = connections.connection_jobs()
    if json_out:
        document(
            wire.connection(answered, jobs.downloads.get(answered.id), jobs.checks.get(answered.id))
        )
        return
    note(f"{answered.name!r} answers {answered.model_family}.")
    typer.echo(answered.model_family)


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
        configured = InferenceConnectionService(service)
        connections = configured.list()
        # One queue read for both kinds and the whole page, on the REST listing's
        # terms: a terminal watches a run the server's worker is doing.
        jobs = configured.connection_jobs()
        root = service.root
    if json_out:
        document(
            wire.page(
                [
                    wire.connection(one, jobs.downloads.get(one.id), jobs.checks.get(one.id))
                    for one in connections
                ]
            )
        )
        return
    table(_COLUMNS, [_row(one) for one in connections])
    if not connections:
        note(f"No inference connections in {root}.")
