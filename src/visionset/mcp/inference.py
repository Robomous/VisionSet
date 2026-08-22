# usage: from visionset.mcp import inference
"""Model-connection tools: making a workspace auto-label-ready without a browser.

The third surface over ``InferenceConnectionService``, closing the SDK-first
parity the Inference section promised (#421): REST and the CLI already configure
connections, and an agent could not. Every tool is the CLI command's body without
the terminal — same service calls, same shared ``visionset.inference`` helpers,
same wire projection — so the three surfaces cannot disagree about what a
connection is or what "set up" means.

**``get`` folds into ``list_inference_connections``.** A workspace holds a
handful of connections, the page carries every field ``get`` would, and an agent
that just wrote one is holding the whole document already — ``get_source``'s
argument, one aggregate over.

**``download_connection_weights`` and ``check_connection_integrity`` are
synchronous, and that is ``ingest``'s pattern rather than a shortcut.** A stdio
server has no background worker; the API queues the same work because it has a
dispatcher to run it, and a tool that enqueued here would answer with a job id
nothing was ever going to claim. So the call blocks — minutes, for a large
model — and the finished connection (or the read report) comes back in the
answer. Interrupting either is safe: a connection is only marked ready once
every file is here, and a check writes nothing until every byte has been read.
Re-running a cut-off download resumes the cache rather than starting over.

**``test_inference_connection`` is one request, not a background run.** It asks
the connection's endpoint what it answers and records the declared capability,
which is what lets ``suggest`` and pre-labeling use the connection. Refused for
a local connection, which has no endpoint to ask.

**``delete_inference_connection`` is destructive posture, not cycle.** The
kernel's delete takes no ``confirm`` — what is destroyed is a configuration
rather than work, and annotations keep their model provenance because identity
is denormalized at write time — but this surface's destructive rule is about the
listing, not the blast radius: a verb that removes something irrecoverable is
absent unless the server was started with ``--allow-destructive``, and gated by
``confirm`` when it is offered, the CLI's own courtesy prompt in this surface's
idiom.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from visionset import wire
from visionset.inference import ask_endpoint, check_integrity, download_size, fetch_weights
from visionset.kernel import ConfirmationRequired
from visionset.kernel.domain import ConnectionType, Precision
from visionset.kernel.services import InferenceConnectionService
from visionset.mcp._resolve import ConnectionRef, resolve_connection
from visionset.mcp._workspace import opened_workspace


def create_inference_connection(
    name: Annotated[str, Field(description="Unique in this workspace, ignoring case.")],
    connection_type: Annotated[
        ConnectionType,
        Field(description="Where the model runs: `local` on this machine, `http` elsewhere."),
    ],
    model_id: Annotated[str, Field(description="Which model, at its source.")],
    model_revision: Annotated[
        str, Field(description="Pinned. A moving pointer is not a provenance.")
    ],
    device: Annotated[
        str | None,
        Field(description="Local only. cpu, mps, cuda, or cuda:N for a second GPU."),
    ] = None,
    precision: Annotated[
        Precision | None,
        Field(description="Local only. fp16 needs a cuda device; cpu and mps run in fp32."),
    ] = None,
    endpoint_url: Annotated[
        str | None, Field(description="HTTP only. Where to send predictions.")
    ] = None,
    provider_id: Annotated[
        str | None,
        Field(
            description=(
                "Which installed driver serves it, as `list_providers` names them. "
                "Omitted, the connection resolves by the model type its downloaded "
                "config declares."
            )
        ),
    ] = None,
    credential_env: Annotated[
        str | None,
        Field(
            description=(
                "HTTP only. The NAME of an environment variable holding the endpoint's "
                "credential. The value is read from the server's environment when the "
                "endpoint is spoken to and sent as a bearer token; it is never stored."
            )
        ),
    ] = None,
) -> dict[str, Any]:
    """Configure a connection. Nothing is downloaded and nothing is contacted.

    A `local` connection lands at `not_set_up` with `download_weights` among its
    `allowed_actions`; call `model_download_size` first so fetching is an
    informed decision, then `download_connection_weights` to make it `ready`.
    Refuses parameters that do not match the kind — an endpoint on a local
    connection, a device on an HTTP one — and a name already taken.
    """
    with opened_workspace() as workspace:
        created = InferenceConnectionService(workspace).create(
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
    return wire.connection(created)


def update_inference_connection(
    connection: ConnectionRef,
    name: Annotated[str | None, Field(description="Rename it.")] = None,
    model_id: Annotated[str | None, Field(description="Point at another model.")] = None,
    model_revision: Annotated[str | None, Field(description="Move the pin.")] = None,
    device: Annotated[
        str | None,
        Field(description="Local only. cpu, mps, cuda, or cuda:N for a second GPU."),
    ] = None,
    precision: Annotated[
        Precision | None,
        Field(description="Local only. fp16 needs a cuda device; cpu and mps run in fp32."),
    ] = None,
    endpoint_url: Annotated[str | None, Field(description="HTTP only.")] = None,
    credential_env: Annotated[
        str | None,
        Field(
            description=(
                "HTTP only. The NAME of the environment variable holding the endpoint's "
                "credential; the empty string clears it."
            )
        ),
    ] = None,
) -> dict[str, Any]:
    """Edit a connection. Parameters you omit are left alone; the type cannot change.

    Moving a local connection's model or revision stands it back to `not_set_up`,
    because the weights on disk are no longer the weights it names — download
    again to make it `ready`.
    """
    with opened_workspace() as workspace:
        connections = InferenceConnectionService(workspace)
        edited = connections.update(
            resolve_connection(workspace, connection).id,
            name=name,
            model_id=model_id,
            model_revision=model_revision,
            device=device,
            precision=precision,
            endpoint_url=endpoint_url,
            credential_env=credential_env,
        )
    return wire.connection(edited)


def model_download_size(
    model_id: Annotated[str, Field(description="Which model, at its source.")],
    model_revision: Annotated[
        str, Field(description="Pinned. A size is a fact about one revision.")
    ],
) -> dict[str, Any]:
    """How big fetching that model's weights would be. Nothing is downloaded.

    The number to look at *before* calling `download_connection_weights`, read
    from the publishing hub's file listing rather than from the files. It covers
    every file in the revision, because that is what the download fetches.

    Takes a model and a revision rather than a connection, and reads no
    workspace: the moment the number is wanted is usually the moment before a
    connection exists.
    """
    return wire.download_size(download_size(model_id, model_revision))


def download_connection_weights(connection: ConnectionRef) -> dict[str, Any]:
    """Fetch a local connection's weights. This is the only tool that downloads a model.

    Nothing arrives on an agent's behalf: no install, no first run, and no other
    tool fetches anything. This one does, because you asked it to. It **blocks**
    until the transfer finishes — minutes for a large model, with nothing to
    poll from here — and answers with the connection, now `ready`.

    Safe to re-run: a connection is only marked ready once every file is here,
    so a cut-off call changed nothing and the retry resumes the cache rather
    than starting over. On a connection that is already `ready` it re-checks the
    snapshot is complete and fetches only what is missing.

    Refused when there is nothing to do: an `http` connection has no weights of
    its own. Refused with the install command when the local runtime extra is
    not installed.
    """
    with opened_workspace() as workspace:
        found = resolve_connection(workspace, connection)
        ready = fetch_weights(workspace, found.id)
    return wire.connection(ready)


def check_connection_integrity(connection: ConnectionRef) -> dict[str, Any]:
    """Re-read a local connection's weights and prove they are undamaged.

    Not the same check as re-running the download. That one establishes the
    snapshot is **complete** — every file the revision names is present — and
    answers from an index without opening a file. This reads **every byte** and
    compares it against the digests the publishing hub holds, which is the only
    way to catch a file that is present and wrong. It **blocks**, in proportion
    to the model's size.

    If anything fails to match, the damaged copies are **removed**, the
    connection goes back to `not_set_up`, and the refusal names the files — so
    the remedy it points at, `download_connection_weights`, is a real transfer
    rather than a cache hit handing the same bad bytes back.

    Refused when there is nothing to read: an `http` connection has no weights
    of its own, and a local one whose weights never arrived has none yet.
    """
    with opened_workspace() as workspace:
        found = resolve_connection(workspace, connection)
        report = check_integrity(workspace, found.id)
    return report.counts()


def test_inference_connection(connection: ConnectionRef) -> dict[str, Any]:
    """Ask an http connection's endpoint what it answers, and record the answer.

    One request to the endpoint, which answers this project's contract —
    `{"model_ref": …, "capability": …}`. The declared capability becomes the
    connection's `capabilities`, which is what lets `suggest` and pre-labeling
    use it. Asking again re-asks and overwrites.

    Refused for a local connection, which has no endpoint. An endpoint that
    cannot be reached or answers outside the contract is a refusal naming it,
    and nothing is recorded.
    """
    with opened_workspace() as workspace:
        found = resolve_connection(workspace, connection)
        answered = ask_endpoint(workspace, found.id)
    return wire.connection(answered)


def delete_inference_connection(
    connection: ConnectionRef,
    confirm: Annotated[
        bool,
        Field(
            description=(
                "Must be true to actually delete. False returns a refusal and changes nothing."
            )
        ),
    ] = False,
) -> dict[str, Any]:
    """Remove a connection. Annotations keep the model provenance they recorded.

    Provenance stores model identity denormalized — id and revision copied at
    write time, no reference to the connection — so nothing breaks and no label
    changes; only this configuration is removed. Cached weights stay on disk,
    shared with any other connection naming the same model.

    Called without `confirm=true` it changes nothing and tells you so. An
    unknown connection is reported as missing whether or not `confirm` was
    passed.
    """
    with opened_workspace() as workspace:
        connections = InferenceConnectionService(workspace)
        found = resolve_connection(workspace, connection)
        # The kernel's delete takes no ``confirm`` — a configuration is not
        # work — so the gate is this surface's, the CLI's own prompt in the
        # idiom of a tool call. Raised rather than returned so the envelope
        # carries ``retry_with: "confirm"``.
        if not confirm:
            raise ConfirmationRequired(
                f"deleting connection {found.name!r} removes this configuration; "
                f"annotations keep their model provenance; pass confirm=True to proceed"
            )
        connections.delete(found.id)
    return {"deleted": wire.connection(found)}


# ``list``-named tools stay last, the CLI's rule for the class-body reason —
# and here simply because the listing is the fold target the docstring argues.
def list_inference_connections() -> dict[str, Any]:
    """List this workspace's model connections, oldest first.

    A connection is one configured place a model can be asked to predict; the
    interactive `suggest` capability and batch pre-labeling both run against
    one. `setup_state` says whether it is usable — `ready`, or `not_set_up`
    while a local connection's weights are not downloaded — and
    `allowed_actions` is what may be done to it next. `download` and
    `integrity_check` carry the most recent background run the server's worker
    did for it, when there is one; null otherwise.

    Takes no project: connections are workspace infrastructure, shared by every
    project.
    """
    with opened_workspace() as workspace:
        configured = InferenceConnectionService(workspace)
        connections = configured.list()
        jobs = configured.connection_jobs()
    return wire.page(
        [
            wire.connection(one, jobs.downloads.get(one.id), jobs.checks.get(one.id))
            for one in connections
        ]
    )
