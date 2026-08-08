# usage: from visionset.inference import provider_for, fetch_weights
"""The composition root for inference: a connection in, a ``ModelProvider`` out.

**A sibling of ``visionset.formats``, ``visionset.wire`` and ``visionset.jobs``,
and it is here for the same reason each of those is.** Running a model means
torch and transformers, and ``visionset.kernel`` may import neither — the port
describes the protocol and the kernel must stay implementable on a machine that
could not run anything. So the code that turns a configuration row into a running
model cannot live in the kernel, and it must not live in a delivery package
either: the CLI, the API and a background worker all need it, and shared logic
moves *down*, never sideways. One package above the kernel and beside the other
three is the only place left, and the import-linter contracts say so out loud.

**Importing this package imports nothing heavy.** Every reference to torch,
transformers, accelerate and huggingface_hub is inside a function — see
``_extra`` for why that is load-bearing rather than tidy — so a base install
starts a server, runs a worker and imports this module without the optional
runtime present. ``tests/architecture/test_optional_runtime.py`` proves it in a
fresh interpreter.

**Resolution is by connection type, and there is no plugin registry.** #418's
recorded decision is that adapters are instantiated from user-created model
connections and never from a bundled default, which makes ``InferenceConnection``
the registry: a row somebody wrote, naming a kind, a model and where it runs. A
provider discovered by entry point would have nothing to be instantiated *from*,
and a workspace could acquire the ability to predict through an unrelated ``pip
install`` — which is exactly what "VisionSet never downloads a model on its own"
exists to prevent. So the dispatch below is a ``match`` on two members, and it
grows by a deliberate change when a hosted adapter arrives.
"""

from __future__ import annotations

from pathlib import Path

from visionset.inference._extra import EXTRA, INSTALL_COMMAND, MODULES, require
from visionset.inference.nms import DEFAULT_IOU_THRESHOLD, suppressed
from visionset.inference.transformers_provider import LocalTransformersProvider
from visionset.inference.weights import MODELS_DIRNAME, cache_root, download, fetch_weights
from visionset.kernel.domain import ConnectionSetupState, ConnectionType, InferenceConnection
from visionset.kernel.errors import (
    InferenceConnectionNotRunnable,
    InferenceConnectionNotSetUp,
)
from visionset.kernel.ports import ModelProvider

__all__ = [
    "DEFAULT_IOU_THRESHOLD",
    "EXTRA",
    "INSTALL_COMMAND",
    "MODELS_DIRNAME",
    "MODULES",
    "LocalTransformersProvider",
    "cache_root",
    "download",
    "fetch_weights",
    "provider_for",
    "require",
    "suppressed",
]


def provider_for(connection: InferenceConnection, *, workspace_root: Path) -> ModelProvider:
    """The thing that will answer for this connection, or the reason nothing can.

    Every refusal here is a ``VisionSetError`` carrying what happened and what to
    do, never a stack trace and never a ``None`` a caller has to interpret — the
    error contract, applied at the one place where "can this predict?" is finally
    answered.

    Building one is cheap and loads no weights: a caller may construct a provider
    to find out whether it *could* run, which is what makes these refusals worth
    raising early.

    Raises:
        InferenceConnectionNotSetUp: a local connection whose weights are not
            here yet. The message names ``download_weights``, because that is the
            action that makes the identical call succeed.
        InferenceConnectionNotRunnable: nothing in this build runs a connection
            of that kind. An ``http`` connection is well formed and unusable
            here; the adapter that would speak to an endpoint is a later slice.
        LocalInferenceUnavailable: the optional runtime is not installed. Raised
            here rather than at the first ``predict`` so that a caller checking
            usability gets the install command before it starts a batch.
    """
    match connection.connection_type:
        case ConnectionType.LOCAL:
            return _local(connection, workspace_root=workspace_root)
        case ConnectionType.HTTP:
            raise InferenceConnectionNotRunnable(
                f"connection {connection.name!r} is an http connection, and this build has no "
                "adapter that can speak to one; use a local connection, or a later version"
            )


def _local(connection: InferenceConnection, *, workspace_root: Path) -> ModelProvider:
    """A local provider, once both things it needs are true.

    The order of the two checks is deliberate. The connection's own state comes
    first, because "your weights are not here" is about something the caller can
    fix from where they are standing, while a missing extra is about the
    installation and is the same answer for every connection in the workspace.
    Reporting the machine's problem over the row's would tell somebody to run an
    install when what they actually needed was a download.
    """
    if connection.setup_state is not ConnectionSetupState.READY:
        raise InferenceConnectionNotSetUp(
            f"connection {connection.name!r} has no weights on this machine yet; "
            "run its download_weights action first"
        )
    require()
    # ``device`` and ``precision`` are non-null on a local connection — the
    # domain's cross-field rule is what makes that true — so the narrowing here
    # is for the type checker rather than a possibility being handled.
    assert connection.device is not None
    return LocalTransformersProvider(
        connection.model_id,
        connection.model_revision,
        device=connection.device,
        precision=connection.precision,
        cache_dir=cache_root(workspace_root),
        connection_name=connection.name,
    )
