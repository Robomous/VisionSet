# usage: from visionset.inference import provider_for, resident
"""Which adapter answers for a connection, and keeping the loaded one around.

Two questions that belong together because the answer to the second depends on
the first being cheap to ask.

**Resolution is by the model's own declared family, not by the connection's
kind**, and which driver serves a family is what ``registry`` discovers.
``ConnectionType`` says *where* a model runs and that is the only thing it says:
it cannot tell whether the weights behind a local connection are a detector or a
segmenter, and those answer different questions — one takes words and one takes
places. So the family is read from the model's own config, a small JSON file
already sitting in the cache beside the weights. A connection pointed at a
detector and asked with points is then refused with the port's own vocabulary
rather than dying inside a forward pass on a shape mismatch. An ``http``
connection resolves by what it recorded instead: the driver it names and the
capability its endpoint declared, because there is no config on this machine
to read.

**And a family no installed driver serves is refused rather than guessed at.**
What the installed drivers declare is the whole of what resolves; there is no
fallback. A resolver with one guesses on every model it has not been told about,
and the guess is invisible until the wrong adapter refuses the request in its own
vocabulary — a sentence describing a model the user does not have.

**Loaded models are kept, because the alternative defeats the embedding cache.**
The design budget for a click is =<300 ms. A provider built fresh per request
would re-read gigabytes of weights every time and carry an empty embedding cache
into every click — so the per-asset encode would happen on every click too, and
the two caches would each be defeated by the absence of the other. Keeping the
provider is what makes keeping the embedding worth anything.

**Keyed on the connection's identity *and* its last edit**, so changing the model
id, the device or the precision builds a new provider rather than silently
serving the old weights under new settings. Deleting a connection needs no
special handling: nothing will ask for that key again, and the bound evicts it.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Final

from visionset.inference._extra import require
from visionset.inference.cache import DEFAULT_PROVIDER_CAPACITY, BoundedCache, KeyedLocks
from visionset.inference.families import family_of
from visionset.inference.http_provider import HTTP_PROVIDER_ID
from visionset.inference.registry import families_served, recorded, registered, serving
from visionset.inference.stub_provider import STUB_FAMILY, STUB_MODEL_ID
from visionset.inference.weights import cache_root
from visionset.kernel.domain import (
    ConnectionSetupState,
    ConnectionType,
    InferenceConnection,
    ServedFamily,
)
from visionset.kernel.errors import (
    InferenceConnectionNotRunnable,
    InferenceConnectionNotSetUp,
)
from visionset.kernel.ports import Provider, Runner

_Key = tuple[str, str]

__all__ = [
    "ProviderPool",
    "Runner",
    "driver_for",
    "not_set_up_message",
    "provider_for",
    "resident",
    "resolve",
]
"""``Runner`` is re-exported rather than redefined.

It moved to ``kernel/ports/provider.py``, beside the ``Provider`` whose ``build``
returns one, because both of its members are kernel ports and a union of them is
kernel vocabulary. It stays reachable from here because this is where callers
already import it from, and two spellings of one union is how the two would come
to disagree about what a connection can resolve to.
"""


class ProviderPool:
    """Loaded providers, bounded and least-recently-used.

    Instantiable rather than only module-level so a test can hold its own and
    assert on it without reaching into process state — and so two workspaces in
    one process cannot end up sharing a provider through a global.
    """

    def __init__(self, capacity: int = DEFAULT_PROVIDER_CAPACITY) -> None:
        self._held: BoundedCache[_Key, Runner] = BoundedCache(capacity)
        self._building: KeyedLocks[_Key] = KeyedLocks()
        self._builds = 0

    @property
    def builds(self) -> int:
        """How many providers this pool has actually constructed.

        The counter that separates a working pool from one that rebuilds every
        time — both answer correctly, and only this tells them apart.
        """
        return self._builds

    def get(self, connection: InferenceConnection, *, workspace_root: Path) -> Runner:
        """The provider for that connection, built once and kept.

        Every refusal ``provider_for`` can raise is raised here too, and raised
        *before* anything is cached: a connection that is not ready must not
        leave a half-answer behind for the request that follows its download.

        **Built once even when the first several clicks arrive together.** The
        window between finding nothing here and storing what was built is wide —
        a build reads a config off disk and the adapter then loads gigabytes of
        weights — and four concurrent first clicks went through it four times in
        one process. The lock is per connection, so two connections still build
        in parallel, and a refusal still caches nothing.
        """
        key = (str(connection.id), connection.updated_at.isoformat())
        held = self._held.get(key)
        if held is not None:
            return held
        with self._building.for_key(key):
            held = self._held.get(key)
            if held is not None:
                return held
            built = provider_for(connection, workspace_root=workspace_root)
            self._builds += 1
            return self._held.put(key, built)

    def served(self, connection: InferenceConnection, *, workspace_root: Path) -> ServedFamily:
        """What the family this connection resolves to declares — asked for and answered in.

        Resolved, never built: a caller planning a run wants the shapes before it
        pays for a runner, and every refusal :func:`resolve` raises is raised here
        too, in the same order.

        Raises:
            InferenceConnectionNotSetUp: a local connection whose weights are not
                here yet, or an http connection whose endpoint has not been asked.
            InferenceConnectionNotRunnable: the recorded driver is not installed,
                or does not serve what the model (or the endpoint) declares — including
                a local connection whose snapshot config went missing after a
                provider was recorded, which ``resolve`` tolerates but no driver
                declares a family for.
            LocalInferenceUnavailable: the optional runtime is not installed.
        """
        driver, family = resolve(connection, workspace_root=workspace_root)
        declared = driver.families.get(family)
        if declared is None:
            raise InferenceConnectionNotRunnable(_wrong_family_for(connection, driver, family))
        return declared

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


def not_set_up_message(connection: InferenceConnection) -> str:
    """The sentence a connection that is not set up gets, naming the action that
    makes the identical request succeed.

    A function rather than a literal so resolution and a route that must refuse
    the same fact before it would otherwise build a runner raise the identical
    sentence — and kind-aware, because the action differs by kind.
    """
    if connection.connection_type is ConnectionType.HTTP:
        return (
            f"connection {connection.name!r} has not been asked what its endpoint answers yet; "
            "run its test_endpoint action first"
        )
    return (
        f"connection {connection.name!r} has no weights on this machine yet; "
        "run its download_weights action first"
    )


def resolve(connection: InferenceConnection, *, workspace_root: Path) -> tuple[Provider, str]:
    """The driver and the family this connection resolves to, or the reason nothing can.

    What :func:`provider_for` builds from and what a caller asks the declaration
    of — one resolution, so the runner and the ``ServedFamily`` describing it can
    never come from different drivers. Loads nothing.

    Raises:
        InferenceConnectionNotSetUp: a local connection whose weights are not
            here yet, or an http connection whose endpoint has not been asked.
        InferenceConnectionNotRunnable: the recorded driver is not installed,
            or does not serve what the model (or the endpoint) declares.
        LocalInferenceUnavailable: the optional runtime is not installed.
    """
    match connection.connection_type:
        case ConnectionType.LOCAL:
            return _local(connection, workspace_root=workspace_root)
        case ConnectionType.HTTP:
            return _remote(connection)


def provider_for(connection: InferenceConnection, *, workspace_root: Path) -> Runner:
    """The thing that will answer for this connection, or the reason nothing can.

    Builds a provider without loading any weights — the load is lazy, in the
    adapter — so a caller may construct one to find out whether it *could* run.
    That is what makes the refusals here worth raising early.

    Raises:
        InferenceConnectionNotSetUp: a local connection whose weights are not
            here yet, or an http connection whose endpoint has not been asked
            what it answers — the message names the action that makes the
            identical call succeed.
        InferenceConnectionNotRunnable: the connection's recorded driver is not
            installed, or does not serve what the model (or the endpoint)
            declares.
        LocalInferenceUnavailable: the optional runtime is not installed.
    """
    driver, family = resolve(connection, workspace_root=workspace_root)
    return driver.build(connection, family=family, workspace_root=workspace_root)


def _local(connection: InferenceConnection, *, workspace_root: Path) -> tuple[Provider, str]:
    """The driver and family of whichever family this connection's model belongs to.

    The order of the two checks is deliberate and unchanged from the slice that
    introduced it: the connection's own state first, because "your weights are
    not here" is about something the caller can fix from where they are standing,
    while a missing extra is about the installation and is the same answer for
    every connection in the workspace.

    **A family this build does not serve is refused, never approximated.** There
    is no fallback adapter, because a fallback answers with the wrong adapter's
    vocabulary: a point-prompt model read as a detector refuses a click by saying
    the model "answers text prompts", which is a confident sentence about some
    other model. An honest "this build has no adapter for that model type" is
    worth more than a guess that is right most of the time.
    """
    if connection.setup_state is not ConnectionSetupState.READY:
        raise InferenceConnectionNotSetUp(not_set_up_message(connection))
    drivers = registered().providers
    if connection.model_id == STUB_MODEL_ID:
        # Before ``require()``, and that ordering is the point rather than an
        # optimisation: this build's own no-op segmenter needs no runtime, so a
        # base install can run the whole suggest path and the browser suite does
        # not install two gigabytes of wheels to click a button. Its family is
        # known without reading anything, since there is no config to read.
        family = STUB_FAMILY
    else:
        require()
        family = family_of(connection, cache_dir=cache_root(workspace_root))
    driver = driver_for(connection, family=family, drivers=drivers)
    return driver, family


def _remote(connection: InferenceConnection) -> tuple[Provider, str]:
    """The driver and family for the endpoint this connection names.

    Resolved by what the row recorded and nothing else: the driver it names
    (the built-in one when it names none — every http connection created before
    there was one to name) and the capability its endpoint declared, which
    ``test_endpoint`` wrote. Nothing is read from disk and nothing is
    contacted; a connection nobody has asked is refused with the action that
    asks.
    """
    driver = recorded(registered().providers, connection.provider_id or HTTP_PROVIDER_ID)
    family = connection.model_family or ""
    if not family:
        raise InferenceConnectionNotSetUp(not_set_up_message(connection))
    if family not in driver.families:
        raise InferenceConnectionNotRunnable(_wrong_family_for(connection, driver, family))
    return driver, family


def driver_for(
    connection: InferenceConnection, *, family: str, drivers: Mapping[str, Provider]
) -> Provider:
    """Which installed driver answers for this connection.

    **A recorded provider beats a derived one**, because it is an answer
    somebody gave rather than one worked out: it was chosen from the served
    catalog when the connection was made, or written down by the download that
    actually used it. Deriving over the top of that would let a second driver
    claiming the same family silently take a connection away from the one that
    fetched its weights.

    **The family still has to agree**, and that is why recording a provider does
    not make the config unnecessary. What the snapshot on disk declares is the
    check that catches a connection pointed at the wrong kind of model, and a
    driver serving several families still has to be told which one — so a
    recorded driver that does not serve what arrived is refused rather than
    handed a model it never said it could load.

    A connection that recorded nothing resolves by family exactly as every
    connection did before there was anywhere to record one.

    Raises:
        InferenceConnectionNotRunnable: the recorded provider is not installed,
            it does not serve the family this connection's model declares, or —
            for a connection that recorded none — nothing installed serves that
            family.
    """
    if connection.provider_id is None:
        driver = serving(drivers, family)
        if driver is None:
            raise InferenceConnectionNotRunnable(_no_adapter_for(connection, family, drivers))
        return driver
    driver = recorded(drivers, connection.provider_id)
    if family and family not in driver.families:
        raise InferenceConnectionNotRunnable(_wrong_family_for(connection, driver, family))
    return driver


def _wrong_family_for(connection: InferenceConnection, driver: Provider, family: str) -> str:
    """Why the recorded driver cannot run what was downloaded.

    The connection names a driver and the weights turned out to be something
    else, so both halves are named: a reader has to know which of the two to
    change, and the sentence is useless if it reports only that they disagree.
    """
    serves = ", ".join(sorted(driver.families))
    return (
        f"connection {connection.name!r} is served by provider {driver.provider_id!r}, whose "
        f"declared model type {family!r} — the downloaded config's, or the endpoint's — is a "
        f"type that provider does not serve; it serves {serves}. Point the connection at a model "
        "of one of those types, or at the provider that serves this one"
    )


def _no_adapter_for(
    connection: InferenceConnection, family: str, drivers: Mapping[str, Provider]
) -> str:
    """Why nothing here can answer for that model, and what this build does run.

    Two openings and one remedy. A config that named a type this build has never
    heard of and a config that named nothing at all are different things to have
    happened — the first is a model choice, the second is usually damaged files —
    and a reader who is told which can tell whether to change the connection or
    to fetch it again.

    The list is what the installed drivers declare rather than a constant, so a
    plugin's families appear in it without this sentence being edited.
    """
    supported = ", ".join(sorted(families_served(drivers)))
    if not family:
        return (
            f"connection {connection.name!r} names {connection.model_id!r}, whose downloaded "
            "config does not say what model type it is, so this build cannot tell which adapter "
            f"would answer for it; this build supports {supported} — point the connection at one "
            "of those, or run its download_weights action again if those files are damaged"
        )
    return (
        f"connection {connection.name!r} names {connection.model_id!r}, whose config declares "
        f"model type {family!r}, and this build has no adapter for that model type; it supports "
        f"{supported} — point the connection at a model of one of those types"
    )
