# usage: from visionset.inference import provider_for, resident
"""Which adapter answers for a connection, and keeping the loaded one around.

Two questions that belong together because the answer to the second depends on
the first being cheap to ask.

**Resolution is by the model's own declared family, not by the connection's
kind.** ``ConnectionType`` says *where* a model runs — here or elsewhere — and
that is the only thing it says. It cannot say whether the weights behind a local
connection are a detector or a segmenter, and those answer different questions:
one takes words and one takes places. So the family is read from the model's own
config, which is a small JSON file already sitting in the cache beside the
weights the connection downloaded. A connection pointed at a detector and asked
with points is then refused with the port's own vocabulary rather than dying
somewhere inside a forward pass on a shape mismatch.

**Loaded models are kept, because the alternative defeats the embedding cache.**
D5 on #424 budgets =<300 ms for a click. A provider built fresh per request would
re-read gigabytes of weights every time and would carry an empty embedding cache
into every click — so the per-asset encode would happen on every click too, and
the two caches would each be defeated by the absence of the other. Keeping the
provider is what makes keeping the embedding worth anything.

**Keyed on the connection's identity *and* its last edit**, so changing the model
id, the device or the precision builds a new provider rather than silently
serving the old weights under new settings. Deleting a connection needs no
special handling: nothing will ask for that key again, and the bound evicts it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Final

from visionset.inference._extra import imported, require
from visionset.inference.cache import DEFAULT_PROVIDER_CAPACITY, BoundedCache
from visionset.inference.sam_provider import LocalSamProvider
from visionset.inference.transformers_provider import LocalTransformersProvider
from visionset.inference.weights import cache_root
from visionset.kernel.domain import ConnectionSetupState, ConnectionType, InferenceConnection
from visionset.kernel.errors import (
    InferenceConnectionNotRunnable,
    InferenceConnectionNotSetUp,
)
from visionset.kernel.ports import ModelProvider

SEGMENTER_FAMILIES: Final[frozenset[str]] = frozenset({"sam2"})
"""``model_type`` values this build serves with the point-prompted adapter.

A set rather than a single string because the family is what matters and its
members grow: the video variant of the same architecture is the 0.2.0 door D1
keeps open, and it arrives here as one more name rather than as a second
resolution mechanism. Anything not named here is served by the detector adapter,
which is the older and more common case.
"""

_Key = tuple[str, str]


class ProviderPool:
    """Loaded providers, bounded and least-recently-used.

    Instantiable rather than only module-level so a test can hold its own and
    assert on it without reaching into process state — and so two workspaces in
    one process cannot end up sharing a provider through a global.
    """

    def __init__(self, capacity: int = DEFAULT_PROVIDER_CAPACITY) -> None:
        self._held: BoundedCache[_Key, ModelProvider] = BoundedCache(capacity)
        self._builds = 0

    @property
    def builds(self) -> int:
        """How many providers this pool has actually constructed.

        The counter that separates a working pool from one that rebuilds every
        time — both answer correctly, and only this tells them apart.
        """
        return self._builds

    def get(self, connection: InferenceConnection, *, workspace_root: Path) -> ModelProvider:
        """The provider for that connection, built once and kept.

        Every refusal ``provider_for`` can raise is raised here too, and raised
        *before* anything is cached: a connection that is not ready must not
        leave a half-answer behind for the request that follows its download.
        """
        key = (str(connection.id), connection.updated_at.isoformat())
        held = self._held.get(key)
        if held is not None:
            return held
        built = provider_for(connection, workspace_root=workspace_root)
        self._builds += 1
        return self._held.put(key, built)

    def clear(self) -> None:
        """Drop everything held. What a test does between cases."""
        self._held.clear()

    def __len__(self) -> int:
        return len(self._held)


_RESIDENT: Final = ProviderPool()


def resident() -> ProviderPool:
    """The process-wide pool.

    A function rather than the object itself so that importing this module does
    not read as taking a handle on shared state, and so the one place it is
    reached from is greppable.
    """
    return _RESIDENT


def provider_for(connection: InferenceConnection, *, workspace_root: Path) -> ModelProvider:
    """The thing that will answer for this connection, or the reason nothing can.

    Builds a provider without loading any weights — the load is lazy, in the
    adapter — so a caller may construct one to find out whether it *could* run.
    That is what makes the refusals here worth raising early.

    Raises:
        InferenceConnectionNotSetUp: a local connection whose weights are not
            here yet. The message names ``download_weights``, because that is the
            action that makes the identical call succeed.
        InferenceConnectionNotRunnable: nothing in this build runs a connection
            of that kind.
        LocalInferenceUnavailable: the optional runtime is not installed.
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
    """A local provider of whichever family this connection's model belongs to.

    The order of the two checks is deliberate and unchanged from the slice that
    introduced it: the connection's own state first, because "your weights are
    not here" is about something the caller can fix from where they are standing,
    while a missing extra is about the installation and is the same answer for
    every connection in the workspace.
    """
    if connection.setup_state is not ConnectionSetupState.READY:
        raise InferenceConnectionNotSetUp(
            f"connection {connection.name!r} has no weights on this machine yet; "
            "run its download_weights action first"
        )
    require()
    # ``device`` is non-null on a local connection — the domain's cross-field
    # rule is what makes that true — so this narrows for the type checker rather
    # than handling a possibility.
    assert connection.device is not None
    cache_dir = cache_root(workspace_root)
    common: dict[str, Any] = {
        "device": connection.device,
        "precision": connection.precision,
        "cache_dir": cache_dir,
        "connection_name": connection.name,
    }
    if family_of(connection, cache_dir=cache_dir) in SEGMENTER_FAMILIES:
        return LocalSamProvider(connection.model_id, connection.model_revision, **common)
    return LocalTransformersProvider(connection.model_id, connection.model_revision, **common)


def family_of(connection: InferenceConnection, *, cache_dir: Path) -> str:
    """The ``model_type`` the downloaded config declares, or ``""`` if it cannot say.

    Read from the cache rather than from the network — ``local_files_only`` — for
    the same reason every other load in this package is: this product downloads
    weights when somebody asks it to and at no other time.

    An unreadable or unrecognised config answers ``""`` rather than raising, and
    ``""`` resolves to the detector. A connection whose config cannot be parsed
    is going to fail at load time with the library's own message, which says far
    more about what is wrong with those files than anything this function could
    invent from having failed to read one field.
    """
    transformers = imported("transformers")
    try:
        config = transformers.AutoConfig.from_pretrained(
            connection.model_id,
            revision=connection.model_revision,
            cache_dir=str(cache_dir),
            local_files_only=True,
        )
    except Exception:  # noqa: BLE001 — see the docstring: this is a fallback, not a handler
        return ""
    return str(getattr(config, "model_type", "") or "")
