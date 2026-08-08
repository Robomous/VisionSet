# usage: from visionset.server.routes import inference
"""Inference connections: configuring where a model may be asked to predict.

Every handler is one call to ``InferenceConnectionService`` and one shaping step.
A route never translates an error — it raises the kernel's and stops, and the
handlers ``create_app()`` installed turn it into an ``ErrorBody`` with a stable
code.

**Nothing here runs a model, fetches weights, or contacts an endpoint.** The two
operations that will — a weight download and a reachability test — are absent
rather than stubbed, and ``ConnectionOut.allowed_actions`` does not name them, so
no client is told about a control that does not exist yet (`cf. #418`, `#421`).

Handlers are ``def`` rather than ``async def``, on ``projects``' terms: every
kernel call underneath is a blocking SQLite call, and a coroutine would run it on
the event loop.
"""

from uuid import UUID

from fastapi import status

from visionset.kernel.services import InferenceConnectionService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    ConnectionCreate,
    ConnectionOut,
    ConnectionPage,
    ConnectionUpdate,
)

router = protected_router(prefix="/inference/connections", tags=["inference"])


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
