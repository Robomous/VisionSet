# usage: from visionset.server.routes import inference
"""Inference connections: configuring where a model may be asked to predict.

Every handler is one call to ``InferenceConnectionService`` and one shaping step.
A route never translates an error — it raises the kernel's and stops, and the
handlers ``create_app()`` installed turn it into an ``ErrorBody`` with a stable
code.

**Nothing in this file runs a model or contacts a configured endpoint.** The two
operations over a snapshot — the weight download and the integrity check — are
both queued rather than performed, answering 202 and pointing at a background
job, the contract the export route already uses. A reachability ``test`` is
still absent rather than stubbed, so ``allowed_actions`` does not name it and no
client is told about a control that does not exist yet.

The one network call made here is ``download-size``, and it reads a file
listing rather than files: the number has to be on screen *before* somebody
agrees to a download, so it cannot be a by-product of one.

Handlers are ``def`` rather than ``async def``, on ``projects``' terms: every
kernel call underneath is a blocking SQLite call, and a coroutine would run it on
the event loop.
"""

from uuid import UUID

from fastapi import Response, status

from visionset.inference import download_size, suggest, with_families
from visionset.inference import require as require_local_inference
from visionset.jobs.integrity import JOB_TYPE as integrity_job_type
from visionset.jobs.integrity import payload_for as integrity_payload_for
from visionset.jobs.weights import JOB_TYPE as download_job_type
from visionset.jobs.weights import payload_for as download_payload_for
from visionset.kernel.domain import BackgroundJobSpec, PointPrompt
from visionset.kernel.services import InferenceConnectionService
from visionset.server.dependencies import RunnerDep, WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    AppliedParameters,
    BackgroundJobOut,
    ConnectionCreate,
    ConnectionOut,
    ConnectionPage,
    ConnectionUpdate,
    DownloadSizeOut,
    SuggestedRegion,
    SuggestionOut,
    SuggestRequest,
)

router = protected_router(prefix="/inference/connections", tags=["inference"])

#: A second router for the paths that are siblings of ``connections`` rather than
#: children of one. A suggestion is made *through* a connection, not *on* it, and
#: nesting it under ``/inference/connections/{id}/suggest`` would put the asset —
#: the thing the call is actually about — in the body under a URL claiming the
#: connection owns it. A download size is not about a connection at all: it is
#: asked while a form is being filled in, before there is a row to hang it on.
beside_connections = protected_router(prefix="/inference", tags=["inference"])


@router.get("")
def list_inference_connections(workspace: WorkspaceDep) -> ConnectionPage:
    """Every configured connection in this workspace, in the order they were made.

    Each row carries its most recent weight download **and its most recent
    integrity check**, so a client sees a run it did not start — after a reload,
    in a second tab, on another machine, or from a terminal. This is therefore the
    read a screen polls while either is live, and the reason it can stop polling
    the moment neither is.

    A set-up connection that has never been asked what kind of model it holds is
    asked here, once, from files already on this disk — see
    ``visionset.inference.weights.with_families``. It is the backfill for rows
    written before a connection recorded that, and it is on the read path because
    the kernel cannot reach a model cache and a migration runs in the kernel.
    """
    service = InferenceConnectionService(workspace)
    connections = with_families(workspace, service.list())
    # One queue read for both kinds and the whole page rather than one per row:
    # this is a poll path while anything is running.
    jobs = service.connection_jobs()
    items = [
        ConnectionOut.of(
            one,
            download=jobs.downloads.get(one.id),
            integrity_check=jobs.checks.get(one.id),
        )
        for one in connections
    ]
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
    """The connection with that id.

    Carries the same backfill the listing does, and the same runs, so that reading
    one connection and reading the list never disagree about what it can be asked
    for or about what is happening to it.
    """
    service = InferenceConnectionService(workspace)
    connection = service.get(connection_id)
    (resolved,) = with_families(workspace, [connection])
    jobs = service.connection_jobs()
    return ConnectionOut.of(
        resolved,
        download=jobs.downloads.get(resolved.id),
        integrity_check=jobs.checks.get(resolved.id),
    )


@router.patch("/{connection_id}", responses=documented(404, 409, 422))
def update_inference_connection(
    workspace: WorkspaceDep, connection_id: UUID, body: ConnectionUpdate
) -> ConnectionOut:
    """Edit a connection. Omitted fields are left alone; the kind cannot change."""
    service = InferenceConnectionService(workspace)
    edited = service.update(
        connection_id,
        name=body.name,
        model_id=body.model_id,
        model_revision=body.model_revision,
        device=body.device,
        precision=body.precision,
        endpoint_url=body.endpoint_url,
    )
    # An edit can land while a run is in flight, so the response says the same
    # thing the listing would. A shape that carried the fields only on some routes
    # would be a client having to know which reads it can believe.
    jobs = service.connection_jobs()
    return ConnectionOut.of(
        edited,
        download=jobs.downloads.get(edited.id),
        integrity_check=jobs.checks.get(edited.id),
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


@router.post(
    "/{connection_id}/check-integrity",
    status_code=status.HTTP_202_ACCEPTED,
    responses=documented(404, 409),
)
def check_connection_integrity(
    workspace: WorkspaceDep,
    runner: RunnerDep,
    response: Response,
    connection_id: UUID,
) -> BackgroundJobOut:
    """Re-read every cached file and compare it against what the hub published.

    The `check_integrity` action. Distinct from `download_weights`
    over the same files, and the distinction is what each can prove: a download
    against a set-up connection establishes that nothing is **missing**, reading
    an index rather than the files; this establishes that nothing is
    **damaged**, and can only do so by reading every byte.

    **202, not 200.** A snapshot is gigabytes and this reads all of it, so it
    follows the launch-and-poll contract the download route uses. The run is then
    on the connection itself as `integrity_check`, which is what lets a client
    that never made this request — after a reload, in another tab, or beside a
    terminal that started it — see one in flight and how it ended. `GET
    /background-jobs/{id}` answers the same run, and the `Location` header names
    it; a successful job's result carries how many files were read and how many
    bytes that came to.

    **Only for a local connection that is already set up.** An HTTP connection
    has no files here and one whose weights never arrived has none to read;
    both are 409 `INFERENCE_CONNECTION_NOT_CHECKABLE`, the same answer
    `allowed_actions` gave, from the same table. A deployment without the local
    runtime is refused here too, with the install command.

    **A failed check has already acted.** Damage means the offending files are
    purged and the connection is back to `not_set_up` by the time the job row
    says so — purged first, because a cache hit is returned unread and a
    download over damaged bytes would otherwise hand them straight back. So the
    remedy is the `download_weights` the connection now declares, and it is a
    real transfer. A check that could not reach the hub changes nothing and
    purges nothing: no digests to compare against is an absence of evidence, not
    a verdict.
    """
    InferenceConnectionService(workspace).require_checkable(connection_id)
    # Before the job exists, for the download route's reason: a refusal a
    # request can make is a refusal the request makes.
    require_local_inference()
    job = workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=integrity_job_type,
            payload=integrity_payload_for(connection_id),
            idempotent=True,
        )
    )
    runner.wake()
    response.headers["Location"] = f"/background-jobs/{job.id}"
    return BackgroundJobOut.of(job)


@beside_connections.get("/download-size", responses=documented(422))
def inference_download_size(model_id: str, model_revision: str) -> DownloadSizeOut:
    """How big fetching that model's weights would be, before anybody fetches them.

    What the local-connection form shows beside its confirm control, so that
    "VisionSet downloads nothing on its own" is a decision somebody can actually
    make.

    **This downloads nothing.** It reads the publishing hub's file listing, which
    is the one question answerable before the download it describes. The number
    covers every file in the revision, because that is what the download fetches.

    Query parameters rather than a path, because a model id contains a slash
    (`facebook/sam2-hiera-base-plus`) and a segment that has to be escaped to be
    written is a URL people get wrong by hand.

    **Not a connection route**, and it takes no connection id: the moment the
    number is needed is the moment before the connection exists. Asking about a
    connection that already exists is the same pair of values, asked the same way.

    Refused with the install command when the local runtime is absent — the size
    is read with the same client that would do the fetching — and refused rather
    than guessed when the hub cannot size every file in the revision.
    """
    return DownloadSizeOut.of(download_size(model_id, model_revision))


@beside_connections.post("/suggest", responses=documented(404, 409, 422))
def suggest_region(workspace: WorkspaceDep, body: SuggestRequest) -> SuggestionOut:
    """Propose a shape for the thing under those points.

    The server side of the editor's suggest gesture. One asset, one prompt set,
    one answer — batch prediction is a separate path and is not this one.

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
    polygons gets outlines, a class that admits only boxes gets their extents,
    and a class that admits neither gets no regions. Answering in a kind the
    schema would refuse would produce a suggestion that cannot be accepted.

    **The three parameters shape the mask, and none of them reaches the model.**
    `detail` decides how much of an outline survives simplification, `fill_holes`
    how wide a gap in the mask is closed before it is traced, and `fragments`
    whether the piece under the click is the answer or every piece worth
    proposing. Each is optional and each has a default, so a caller that sends
    none of them gets what this route always gave.

    **`parameters` says which of them apply here**, for the kind of shape this
    request will come back in — `detail` and `fill_holes` change an outline and a
    box has none — and it is present even when there is nothing to propose, so
    somebody who adjusted their way into an empty answer can adjust their way
    back out. A client renders what this names and works none of it out itself.

    **`contour` on each region is the unsimplified outline.** It is what lets a
    client re-run `detail` locally rather than asking again, and it is the *same*
    points this route reduced — simplification is not nested, so a client
    starting from anything else could not be held to the same answer. A box
    carries none, because there is nothing it was reduced from.

    **Every point must be on the asset**, positive and negative alike — `x` in
    `[0, width]` and `y` in `[0, height]`, both ends included, in the asset's own
    pixel frame. One point off the picture refuses the whole request with 422
    `PROMPT_POINT_OUT_OF_BOUNDS` rather than being dropped, because a gesture
    with a point removed is a different gesture. Nothing is clamped: a
    coordinate outside the frame is not a place on the image, and answering
    about the nearest edge instead would return a mask, and a confidence, for a
    question nobody asked.

    An empty `regions` is a successful answer with nothing to propose. Refusals
    are reserved for things the caller can act on: an unknown project, asset or
    connection is 404; a connection whose weights are not here yet, or whose kind
    this build cannot run, is 409 and names what to do; a connection whose model
    answers words rather than places is 422, as is a prompt point off the asset.
    """
    prompt = PointPrompt(
        positive=tuple((point.x, point.y) for point in body.positive),
        negative=tuple((point.x, point.y) for point in body.negative),
    )
    answer = suggest(
        workspace,
        project_id=body.project_id,
        asset_id=body.asset_id,
        connection_id=body.connection_id,
        prompt=prompt,
        allowed=tuple(body.allowed_geometries),
        detail=body.detail,
        fill_holes=body.fill_holes,
        fragments=body.fragments,
    )
    return SuggestionOut(
        model_ref=answer.model_ref,
        confidence=answer.confidence,
        regions=[
            SuggestedRegion(geometry=shape.geometry, contour=list(shape.contour))
            for shape in answer.shapes
        ],
        applied=AppliedParameters(
            detail=body.detail, fill_holes=body.fill_holes, fragments=body.fragments
        ),
        parameters=list(answer.parameters),
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
    than pointing here. What is destroyed is a configuration.
    """
    InferenceConnectionService(workspace).delete(connection_id)
