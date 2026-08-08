# usage: from visionset.server.routes import inference
"""Inference connections: configuring where a model may be asked to predict.

Every handler is one call to ``InferenceConnectionService`` and one shaping step.
A route never translates an error — it raises the kernel's and stops, and the
handlers ``create_app()`` installed turn it into an ``ErrorBody`` with a stable
code.

**Nothing in this file runs a model or contacts an endpoint.** The weight
download is queued rather than performed — it answers 202 and points at a
background job, the contract the export route already uses — and a reachability
``test`` is still absent rather than stubbed, so ``allowed_actions`` does not
name it and no client is told about a control that does not exist yet
(`cf. #418`, `#421`).

Handlers are ``def`` rather than ``async def``, on ``projects``' terms: every
kernel call underneath is a blocking SQLite call, and a coroutine would run it on
the event loop.
"""

from uuid import UUID

from fastapi import Response, status

from visionset.inference import DEFAULT_DETAIL, suggest
from visionset.inference import require as require_local_inference
from visionset.jobs.weights import JOB_TYPE as download_job_type
from visionset.jobs.weights import payload_for as download_payload_for
from visionset.kernel.domain import BackgroundJobSpec, PointPrompt
from visionset.kernel.services import InferenceConnectionService
from visionset.server.dependencies import RunnerDep, WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    BackgroundJobOut,
    ConnectionCreate,
    ConnectionOut,
    ConnectionPage,
    ConnectionUpdate,
    SuggestedRegion,
    SuggestionOut,
    SuggestRequest,
)

router = protected_router(prefix="/inference/connections", tags=["inference"])

#: A second router because the path is a sibling of ``connections`` rather than a
#: child of one: a suggestion is made *through* a connection, not *on* it, and
#: nesting it under ``/inference/connections/{id}/suggest`` would put the asset —
#: the thing the call is actually about — in the body under a URL claiming the
#: connection owns it.
suggestions = protected_router(prefix="/inference", tags=["inference"])


@router.get("")
def list_inference_connections(workspace: WorkspaceDep) -> ConnectionPage:
    """Every configured connection in this workspace, in the order they were made."""
    connections = InferenceConnectionService(workspace).list()
    items = [ConnectionOut.of(one) for one in connections]
    return ConnectionPage(items=items, total=len(items))


@router.post("", status_code=status.HTTP_201_CREATED, responses=documented(409, 422))
def create_inference_connection(workspace: WorkspaceDep, body: ConnectionCreate) -> ConnectionOut:
    """Configure a connection. Nothing is downloaded and nothing is contacted."""
    return ConnectionOut.of(
        InferenceConnectionService(workspace).create(
            body.name,
            connection_type=body.connection_type,
            model_id=body.model_id,
            model_revision=body.model_revision,
            device=body.device,
            precision=body.precision,
            endpoint_url=body.endpoint_url,
        )
    )


@router.get("/{connection_id}", responses=documented(404))
def get_inference_connection(workspace: WorkspaceDep, connection_id: UUID) -> ConnectionOut:
    """The connection with that id."""
    return ConnectionOut.of(InferenceConnectionService(workspace).get(connection_id))


@router.patch("/{connection_id}", responses=documented(404, 409, 422))
def update_inference_connection(
    workspace: WorkspaceDep, connection_id: UUID, body: ConnectionUpdate
) -> ConnectionOut:
    """Edit a connection. Omitted fields are left alone; the kind cannot change."""
    return ConnectionOut.of(
        InferenceConnectionService(workspace).update(
            connection_id,
            name=body.name,
            model_id=body.model_id,
            model_revision=body.model_revision,
            device=body.device,
            precision=body.precision,
            endpoint_url=body.endpoint_url,
        )
    )


@router.post(
    "/{connection_id}/download",
    status_code=status.HTTP_202_ACCEPTED,
    responses=documented(404, 409),
)
def download_connection_weights(
    workspace: WorkspaceDep,
    runner: RunnerDep,
    response: Response,
    connection_id: UUID,
) -> BackgroundJobOut:
    """Fetch this connection's weights, and answer at once with the job to poll.

    The `download_weights` action, and the only thing in this product that
    downloads a model at all. It runs because somebody asked: nothing fetches
    weights at install time, at startup, or on the way to anything else.

    **202, not 200.** Weights for a detector of this class are gigabytes, so this
    follows the launch-and-poll contract the export route uses: poll `GET
    /background-jobs/{id}` — the `Location` header names it — until `state` is
    `succeeded`, then re-read the connection to see `setup_state` as `ready`.

    **Everything a caller can be told now is told now.** A connection that is
    already set up, or one whose model runs elsewhere, is 409
    `INFERENCE_CONNECTION_NOT_DOWNLOADABLE` on this request — the same answer
    `allowed_actions` gave, from the same table. A deployment without the local
    runtime installed is refused here too, with the exact install command in the
    message. Neither refusal creates a job, so a caller holding a job id holds
    one that will run.

    The action is declared on a connection whose *state* permits it even where
    the runtime is missing, deliberately: whether this machine has the extra is
    not a fact about the connection, and hiding the control would leave the
    install command with nowhere to be shown.

    Re-running is safe. The job verifies a cache it already filled rather than
    re-fetching it, and a run that fails leaves the connection exactly as it was
    — there is no half-set-up state to recover from.
    """
    InferenceConnectionService(workspace).require_downloadable(connection_id)
    # Before the job exists, for the reason the export route gives: a refusal a
    # request can make is a refusal the request makes. Discovering a missing
    # install inside a worker would put an install command on a failed row
    # somebody has to go and find.
    require_local_inference()
    job = workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=download_job_type,
            payload=download_payload_for(connection_id),
            idempotent=True,
        )
    )
    runner.wake()
    response.headers["Location"] = f"/background-jobs/{job.id}"
    return BackgroundJobOut.of(job)


@suggestions.post("/suggest", responses=documented(404, 409, 422))
def suggest_region(workspace: WorkspaceDep, body: SuggestRequest) -> SuggestionOut:
    """Propose a shape for the thing under those points.

    The server side of the editor's suggest gesture (`cf. #424`). One asset, one
    prompt set, one answer — batch prediction is a separate path and is not this
    one.

    **Nothing is written and nothing is remembered.** A suggestion is a proposal:
    accepting it is a later, ordinary annotation write carrying `provenance:
    model`, this response's `model_ref`, and its `confidence`. Discarding it
    costs a request that already finished. The only thing that outlives the call
    is a cached image embedding, which is an optimisation rather than a record —
    so the same points sent twice answer the same way, and a restart changes
    nothing but the latency of the first click.

    **The first click on an asset is the slow one.** A segmenter reads the whole
    image once and then answers any number of clicks from that reading almost for
    free, which is what makes refining by adding points practical. Sending the
    accumulated points — rather than a diff — is what keeps this stateless.

    **`allowed_geometries` is the caller's schema, not a preference.** The answer
    is produced in one of the kinds named or not at all: a class that admits
    polygons gets the outline, a class that admits only boxes gets its extent,
    and a class that admits neither gets `region: null`. Answering in a kind the
    schema would refuse would produce a suggestion that cannot be accepted.

    A null `region` is a successful answer with nothing to propose. Refusals are
    reserved for things the caller can act on: an unknown project, asset or
    connection is 404; a connection whose weights are not here yet, or whose kind
    this build cannot run, is 409 and names what to do; a connection whose model
    answers words rather than places is 422.
    """
    prompt = PointPrompt(
        positive=tuple((point.x, point.y) for point in body.positive),
        negative=tuple((point.x, point.y) for point in body.negative),
    )
    prediction = suggest(
        workspace,
        project_id=body.project_id,
        asset_id=body.asset_id,
        connection_id=body.connection_id,
        prompt=prompt,
        allowed=tuple(body.allowed_geometries),
        detail=DEFAULT_DETAIL if body.detail is None else body.detail,
    )
    region = next(iter(prediction.regions), None)
    return SuggestionOut(
        model_ref=prediction.model_ref,
        region=None
        if region is None
        else SuggestedRegion(geometry=region.geometry, confidence=region.confidence),
    )


@router.delete(
    "/{connection_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=documented(404),
)
def delete_inference_connection(workspace: WorkspaceDep, connection_id: UUID) -> None:
    """Remove a connection. Annotations keep the model provenance they recorded.

    No ``confirm`` gate, unlike deleting a project: nothing holds a key to this
    row, because an annotation copies its model's identity at write time rather
    than pointing here (`cf. #417`). What is destroyed is a configuration.
    """
    InferenceConnectionService(workspace).delete(connection_id)
