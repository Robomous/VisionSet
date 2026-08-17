# usage: from visionset.inference import family_of, capabilities_of
"""What kind of model a connection points at, and what that lets it be asked.

Two questions with one answer between them. A model's family — the ``model_type``
its own config declares — decides which driver can run it, and the *same* fact
decides what a caller may ask it for. Neither is written here any more: each
installed driver declares the families it serves and the capability each one
takes, in one mapping, so an adapter and its declaration are the same edit.

**The family is read from the model, never guessed from its name.** A model id is
something somebody typed; the config is something the publisher wrote. Matching on
the id gives a confident answer for every model this build has never heard of,
and the wrongness is invisible until an adapter fails somewhere inside a forward
pass.

**The capability vocabulary is the kernel's, and it stays closed.** A driver maps
a family onto a member of ``ModelCapability`` and can never add one, so the set of
things a connection can be asked grows only with a release that ships the surface
rendering it.
"""

from __future__ import annotations

from pathlib import Path

from visionset.inference._extra import imported
from visionset.inference.registry import capabilities, registered
from visionset.kernel.domain import InferenceConnection, ModelCapability


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
    capability = capabilities(registered().providers).get(model_family or "")
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
