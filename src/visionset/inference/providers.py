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

**And a family this build does not serve is refused rather than guessed at.**
The two sets below are the whole of what resolves; there is no fallback. A
resolver with one guesses on every model it has not been told about, and the
guess is invisible until the wrong adapter refuses the request in its own
vocabulary — a sentence that describes a model the user does not have.

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

SEGMENTER_FAMILIES: Final[frozenset[str]] = frozenset({"sam2", "sam2_video"})
"""``model_type`` values this build serves with the point-prompted adapter.

**Two spellings of one architecture, and the second is not a door held open for
later.** The published SAM 2 checkpoints — including the one the connection form
suggests — declare ``sam2_video``, and ``transformers`` loads such a checkpoint
into the image model deliberately, saying so as it does: *"loading a
``sam2_video`` checkpoint into ``Sam2Model``"*. Naming only ``sam2`` sends the
commonest point-prompt model in the product to the detector adapter, which then
refuses a click with a sentence about text prompts.

Whole models only. The locked ``transformers`` also registers
``sam2_vision_model`` and ``sam2_hiera_det_model``, which are the encoder halves
a full config nests rather than checkpoints anything can prompt. A connection
naming one of those is refused below, not handed to an adapter that would look
for a mask decoder and find none.
"""

DETECTOR_FAMILIES: Final[frozenset[str]] = frozenset({"grounding-dino", "mm-grounding-dino"})
"""``model_type`` values this build serves with the text-prompted adapter.

Narrower than "everything ``AutoModelForZeroShotObjectDetection`` accepts", and
measured rather than assumed. ``transformers_provider`` post-processes with
``post_process_grounded_object_detection(outputs, input_ids, …, text_threshold=…)``
— this family's signature. The other zero-shot detectors the locked
``transformers`` registers take a different one, with no ``input_ids`` and no
``text_threshold``, so listing them here would claim a support that fails inside
a post-processor instead of in a refusal a reader can act on.
"""

SUPPORTED_FAMILIES: Final[frozenset[str]] = SEGMENTER_FAMILIES | DETECTOR_FAMILIES
"""Every ``model_type`` this build has an adapter for, and what a refusal lists.

Derived rather than written a third time, so a family added to one set above
cannot be missing from the sentence that tells somebody what they may use.
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
            of that kind, or of that declared model type. The message names what
            this build does run.
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

    **A family this build does not serve is refused, never approximated.** There
    is no fallback adapter, because a fallback answers with the wrong adapter's
    vocabulary: a point-prompt model read as a detector refuses a click by saying
    the model "answers text prompts", which is a confident sentence about some
    other model. An honest "this build has no adapter for that model type" is
    worth more than a guess that is right most of the time.
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
    family = family_of(connection, cache_dir=cache_dir)
    if family in SEGMENTER_FAMILIES:
        return LocalSamProvider(connection.model_id, connection.model_revision, **common)
    if family in DETECTOR_FAMILIES:
        return LocalTransformersProvider(connection.model_id, connection.model_revision, **common)
    raise InferenceConnectionNotRunnable(_no_adapter_for(connection, family))


def _no_adapter_for(connection: InferenceConnection, family: str) -> str:
    """Why nothing here can answer for that model, and what this build does run.

    Two openings and one remedy. A config that named a type this build has never
    heard of and a config that named nothing at all are different things to have
    happened — the first is a model choice, the second is usually damaged files —
    and a reader who is told which can tell whether to change the connection or
    to fetch it again.
    """
    supported = ", ".join(sorted(SUPPORTED_FAMILIES))
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


def family_of(connection: InferenceConnection, *, cache_dir: Path) -> str:
    """The ``model_type`` the downloaded config declares, or ``""`` if it cannot say.

    Read from the cache rather than from the network — ``local_files_only`` — for
    the same reason every other load in this package is: this product downloads
    weights when somebody asks it to and at no other time.

    An unreadable config answers ``""`` rather than raising: reading the files
    and deciding what to do about them are separate jobs, and this one only
    reports. ``""`` is not a family, so :func:`_local` refuses it — the same
    answer it gives a type nobody here serves, because "the config says nothing"
    and "the config says something unknown" leave the resolver equally unable to
    pick an adapter honestly.
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
