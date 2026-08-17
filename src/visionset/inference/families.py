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
pass. Read *literally*, too: the string the config declares, not the string some
library agrees to recognise, because the drivers that can serve it are whatever
this installation has and no one library knows that set.

**The capability vocabulary is the kernel's, and it stays closed.** A driver maps
a family onto a member of ``ModelCapability`` and can never add one, so the set of
things a connection can be asked grows only with a release that ships the surface
rendering it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Final

from visionset.inference._extra import imported
from visionset.inference.registry import capabilities, registered
from visionset.kernel.domain import InferenceConnection, ModelCapability

CONFIG_FILE: Final = "config.json"
"""The file in a snapshot that declares what the model is. The hub's own name for
it, and the one every published checkpoint carries."""


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

    **The declaration is read, not resolved.** ``AutoConfig`` would answer this
    question too, and it answers a narrower one: it can only name a type
    ``transformers`` itself registers, so a family an installed driver serves and
    ``transformers`` has never heard of comes back as ``""`` — the same answer as
    a config that says nothing. That turns a plugin's family into an unreadable
    one, and the refusal it produces tells somebody their downloaded files are
    damaged when the config in front of it declares exactly what they have.
    Discovery is open, so what is read here cannot be closed to the set one
    library knows.

    Raises:
        LocalInferenceUnavailable: the optional runtime is not installed, so
            nothing here can read a config at all. Deliberately *not* folded into
            the ``""`` above: a build that cannot look has not looked, and a
            caller recording an answer must be able to tell that apart from a
            config that answered nothing.
    """
    hub = imported("huggingface_hub")
    try:
        path = hub.try_to_load_from_cache(
            connection.model_id,
            CONFIG_FILE,
            cache_dir=str(cache_dir),
            revision=connection.model_revision,
        )
        # A miss is ``None`` and a known-absent file is a sentinel object; both
        # are "no config here", which is what the empty string says.
        if not isinstance(path, str):
            return ""
        declared = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — see the docstring: this is a fallback, not a handler
        return ""
    if not isinstance(declared, dict):
        return ""
    return str(declared.get("model_type", "") or "")
