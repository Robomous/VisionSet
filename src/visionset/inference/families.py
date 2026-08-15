# usage: from visionset.inference import family_of, capabilities_of
"""What kind of model a connection points at, and what that lets it be asked.

Two questions with one answer between them. A model's family — the ``model_type``
its own config declares — decides which adapter can run it, and the *same* fact
decides what a caller may ask it for. Keeping both in one module is what stops
those two readings from drifting apart: the day a family is added to a set below,
it acquires an adapter and a declared capability in the same edit, because the
second is derived from the first rather than written beside it.

**The family is read from the model, never guessed from its name.** A model id is
something somebody typed; the config is something the publisher wrote. Matching on
the id gives a confident answer for every model this build has never heard of,
and the wrongness is invisible until an adapter fails somewhere inside a forward
pass.

**And the capability vocabulary is the kernel's, while the mapping is here.**
``ModelCapability`` is a domain word because whether a model takes points or words
is a fact about the product's tools; which ``model_type`` values *this build* can
serve is a fact about an optional runtime, and the kernel has no view of one. So
the enum is declared over there and this is the only place the two meet.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Final

from visionset.inference._extra import imported
from visionset.kernel.domain import InferenceConnection, ModelCapability

SEGMENTER_FAMILIES: Final[frozenset[str]] = frozenset(
    {"sam2", "sam2_video", "sam3", "sam3_tracker"}
)
"""``model_type`` values this build serves with the point-prompted adapter.

**Two spellings per architecture, and the second of each is not a door held open
for later.** The published SAM 2 checkpoints — including the one the connection
form suggests — declare ``sam2_video``, and ``transformers`` loads such a
checkpoint into the image model deliberately, saying so as it does: *"loading a
``sam2_video`` checkpoint into ``Sam2Model``"*. Naming only ``sam2`` sends the
commonest point-prompt model in the product to the detector adapter, which then
refuses a click with a sentence about text prompts.

The SAM 3 pair is the same shape for a sharper reason. ``sam3`` is what a
repository publishing the whole model declares, and that model answers *both*
concepts and points; ``sam3_tracker`` is what :class:`Sam3TrackerConfig` declares
in its own right, which is what a checkpoint publishing only the promptable half
would carry. Both are served here through the tracker classes, because the point
prompt is the only half this build asks for — see ``sam_provider._CLASSES``, where
that choice is made and argued. Asking such a connection with words is refused by
the adapter in the port's vocabulary, not answered by a model nobody selected.

Whole models only. The locked ``transformers`` registers a dozen further
``sam3_*`` types — ``sam3_vision_model``, ``sam3_detr_decoder``,
``sam3_mask_decoder`` and the rest, beside SAM 2's ``sam2_vision_model`` and
``sam2_hiera_det_model``. Those are the halves a full config nests rather than
checkpoints anything can prompt. A connection naming one of them is refused by
``provider_for``, not handed to an adapter that would look for a mask decoder and
find none.
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

CAPABILITY_BY_FAMILY: Final[Mapping[str, ModelCapability]] = {
    **dict.fromkeys(SEGMENTER_FAMILIES, ModelCapability.POINT_SUGGEST),
    **dict.fromkeys(DETECTOR_FAMILIES, ModelCapability.TEXT_DETECT),
}
"""Which prompt each family takes — derived from the sets, never listed again.

**The derivation is the guarantee.** Writing this out by hand would make it
possible to add a family to :data:`SEGMENTER_FAMILIES`, ship the adapter, and
leave the capability behind — and a model that runs but declares nothing is
invisible to every client that filters on the declaration. Deriving it means the
adapter and the declaration are the same edit.

It is a one-to-one map rather than a judgement because the split already exists
and is exactly this one: the two sets *are* "answers points" and "answers words",
which is why each has its own adapter.
"""


def capabilities_of(model_family: str | None) -> list[ModelCapability]:
    """What a model of that family can be asked for. Empty when nothing is known.

    Three inputs collapse to the empty list, and they are genuinely the same
    answer to a caller: ``None`` (nobody has read this connection's config),
    ``""`` (somebody read it and it declared nothing), and a family this build
    has no adapter for. In every one of them there is no request a client could
    make with any confidence, so there is no capability to declare. What
    separates them is the *remedy*, and a remedy belongs to the surface that has
    room for a sentence — not to a vocabulary a client switches on.

    A list rather than a member, for the wire's sake and for honesty: nothing
    says a family answers only one kind of prompt forever, and a client written
    against a list on the day one does will not have to change.
    """
    capability = CAPABILITY_BY_FAMILY.get(model_family or "")
    return [] if capability is None else [capability]


def family_of(connection: InferenceConnection, *, cache_dir: Path) -> str:
    """The ``model_type`` the downloaded config declares, or ``""`` if it cannot say.

    Read from the cache rather than from the network — ``local_files_only`` — for
    the same reason every other load in this package is: this product downloads
    weights when somebody asks it to and at no other time.

    An unreadable config answers ``""`` rather than raising: reading the files
    and deciding what to do about them are separate jobs, and this one only
    reports. ``""`` is not a family, so ``provider_for`` refuses it — the same
    answer it gives a type nobody here serves, because "the config says nothing"
    and "the config says something unknown" leave the resolver equally unable to
    pick an adapter honestly.

    Raises:
        LocalInferenceUnavailable: the optional runtime is not installed, so
            nothing here can read a config at all. Deliberately *not* folded into
            the ``""`` above: a build that cannot look has not looked, and a
            caller recording an answer must be able to tell that apart from a
            config that answered nothing.
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
