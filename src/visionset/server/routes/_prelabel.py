# usage: from visionset.server.routes import _prelabel
"""What the three pre-label launches share: the connection gate, the shape
selection and the enqueue-or-join. One spelling, so a job launched alone and a
job launched inside a batch or project fan-out get the same row.

Underscored because it carries no router: ``routes/__init__`` lists the modules
``create_app`` includes, and this is not one of them.
"""

from __future__ import annotations

from uuid import UUID

from visionset.inference import (
    STUB_MODEL_ID,
    capabilities_of,
    effective_produces,
    not_set_up_message,
    produces_of,
    unsupported_prompt_message,
    with_families,
)
from visionset.inference import require as require_local_inference
from visionset.jobs.prelabel import JOB_TYPE as pre_label_job_type
from visionset.jobs.prelabel import payload_for as pre_label_payload_for
from visionset.kernel.domain import (
    AnnotationJob,
    BackgroundJob,
    BackgroundJobSpec,
    Batch,
    ConnectionSetupState,
    ConnectionType,
    GeometryType,
    InferenceConnection,
    ModelCapability,
)
from visionset.kernel.errors import InferenceConnectionNotSetUp, UnsupportedPrompt
from visionset.kernel.services import InferenceConnectionService, JobService
from visionset.server.dependencies import WorkspaceDep


def text_detect_connection(workspace: WorkspaceDep, connection_id: UUID) -> InferenceConnection:
    """The connection, once it is known to be set up and to answer words.

    The gate the plan and every launch share, so they cannot refuse
    differently. It runs before anything about the batch or the job, matching
    ``pre_label``'s own order: what a build can run is an answer about a setup
    somebody is part-way through, independent of any batch's state, and a
    caller most needs it first.

    The runtime is demanded here rather than inside a worker, on the download
    route's terms: a refusal a request can make is a refusal the request makes,
    and discovering a missing install mid-run would put an install command on a
    failed row somebody has to go and find. Not for the stub, which needs
    neither the runtime nor the network, and not for an ``http`` connection
    either — the gate is about a model that would load here, and an endpoint
    loads nothing here.

    ``setup_state`` is checked before the capability read: ``model_family`` is
    written only by a completed weight download or a tested ``http`` endpoint,
    so a connection that has finished neither reads no capabilities at all, and
    ``UNSUPPORTED_PROMPT`` for that would claim the model answers places rather
    than words when nothing has yet said what it answers. Capabilities are
    derived from the family rather than stored on the row, the same way the
    connection wire model asks for them.

    Raises:
        InferenceConnectionNotFound: no such connection.
        InferenceConnectionNotSetUp: its weights are not here, or its endpoint
            has not been asked what it answers.
        UnsupportedPrompt: its model answers places rather than words.
        LocalInferenceUnavailable: a local connection on a machine without the
            optional runtime.
    """
    connection = InferenceConnectionService(workspace).get(connection_id)
    (connection,) = with_families(workspace, [connection])
    if connection.connection_type is ConnectionType.LOCAL and connection.model_id != STUB_MODEL_ID:
        require_local_inference()
    if connection.setup_state is not ConnectionSetupState.READY or not connection.model_family:
        raise InferenceConnectionNotSetUp(not_set_up_message(connection))
    if ModelCapability.TEXT_DETECT not in capabilities_of(connection.model_family):
        raise UnsupportedPrompt(unsupported_prompt_message(connection.name))
    return connection


def selected_produces(
    connection: InferenceConnection, geometries: list[GeometryType] | None
) -> frozenset[GeometryType]:
    """The shapes a run writes — the model's, narrowed to a request's selection.

    Checked right after the connection and before the batch, on every pre-label
    surface, so the plan, the job launch and both fan-outs refuse a bad
    selection in one place in the order and with no row queued.

    Raises:
        GeometryNotProduced: the selection names a shape the model does not produce.
    """
    return effective_produces(
        produces_of(connection.model_family),
        None if geometries is None else frozenset(geometries),
    )


def launch(
    workspace: WorkspaceDep,
    job: AnnotationJob,
    batch: Batch,
    *,
    connection_id: UUID,
    minimum_confidence: float,
    replace_model_labels: bool,
    geometries: frozenset[GeometryType] | None,
) -> tuple[BackgroundJob, bool]:
    """The run for this job: joined if one is live, queued otherwise.

    The second element says which — true where the row existed before this
    call, so a fan-out can report per row whether it started anything.
    """
    running = JobService(workspace).live_job(job.id, job_type=pre_label_job_type)
    row = running or workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=pre_label_job_type,
            payload=pre_label_payload_for(
                job.id,
                batch.id,
                connection_id,
                minimum_confidence,
                replace_model_labels,
                geometries,
            ),
            idempotent=True,
        )
    )
    return row, running is not None
