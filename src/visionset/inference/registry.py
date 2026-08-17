# usage: from visionset.inference.registry import installed, pick
"""Finding the drivers this installation has, and the one a family needs.

Discovery is ``importlib.metadata`` over the ``visionset.providers`` group, never
a hardcoded dict: a third-party distribution registers into the same group and is
indistinguishable from a built-in here.

**Installing a provider does not let a workspace predict.** Nothing here fetches
or loads anything, and no existing connection changes what it runs.

Nothing is cached, on ``formats/registry.py``'s reason: the alternative is a
process that has to be restarted after an install.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from importlib.metadata import entry_points
from typing import Final, Protocol

from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

from visionset import __version__
from visionset.kernel.domain import ModelCapability
from visionset.kernel.errors import InferenceConnectionNotRunnable
from visionset.kernel.ports import Provider

GROUP: Final = "visionset.providers"
DISTRIBUTION: Final = "visionset"
"""The name a plugin pins to say which VisionSet it was built for."""


class Publisher(Protocol):
    """The part of a distribution discovery reads."""

    @property
    def name(self) -> str: ...

    @property
    def requires(self) -> list[str] | None: ...


class Registration(Protocol):
    """The part of an entry point discovery reads.

    Narrow so a test can pass a plain object rather than install a distribution.
    """

    @property
    def name(self) -> str: ...

    @property
    def dist(self) -> Publisher | None: ...

    #: Resolves to the factory discovery calls with no arguments, on
    #: ``Exporter``'s terms: the entry point names a class, not an instance.
    def load(self) -> Callable[[], object]: ...


@dataclass(frozen=True)
class Skipped:
    """A registration that was not loaded, and why.

    Carried out rather than logged: a driver that vanishes silently makes the
    connection needing it refuse with "nothing serves that family", which sends
    somebody to look at their connection instead of at their install.
    """

    name: str
    reason: str


@dataclass(frozen=True)
class Discovery:
    providers: Mapping[str, Provider]
    skipped: tuple[Skipped, ...]


def installed(entries: Iterable[Registration] | None = None) -> Discovery:
    """Every usable provider, keyed by ``provider_id``.

    Keyed by what the plugin calls itself rather than by its entry-point name:
    those are two strings and only this one is the contract. ``entries`` is
    injectable so a test needs no installed distribution.
    """
    found: dict[str, Provider] = {}
    skipped: list[Skipped] = []
    for entry in entries if entries is not None else entry_points(group=GROUP):
        refusal = _incompatible(entry)
        if refusal is not None:
            skipped.append(Skipped(name=entry.name, reason=refusal))
            continue
        plugin = entry.load()()
        if isinstance(plugin, Provider):
            found[plugin.provider_id] = plugin
    return Discovery(providers=found, skipped=tuple(skipped))


def _incompatible(entry: Registration) -> str | None:
    """Why this must not be loaded here, or ``None``.

    Checked **before** ``load()``: a driver built against a contract this build no
    longer speaks otherwise fails inside a forward pass, as a stack trace.

    A plugin that pinned nothing is compatible — silence is not a refusal, and the
    in-tree providers ship *as* this distribution and so require nothing of it.

    The specifier decides exactly as pip's resolver would, which is the point: a
    backstop that disagreed with the thing it backs up would be a second gate. One
    consequence bites while this project is pre-1.0 — a prerelease sorts *before*
    its release, so ``>=0.0.1`` excludes ``0.0.1b2`` and a plugin must pin a
    prerelease floor (``>=0.0.1b1``) to be usable here at all.
    """
    publisher = entry.dist
    if publisher is None:
        return None
    for raw in publisher.requires or ():
        try:
            requirement = Requirement(raw)
        except InvalidRequirement:
            continue
        if canonicalize_name(requirement.name) != DISTRIBUTION:
            continue
        # A pin behind an extra or a marker that does not apply describes an
        # install nobody is running.
        if requirement.marker is not None and not requirement.marker.evaluate():
            continue
        if not requirement.specifier:
            continue
        try:
            running = Version(__version__)
        except InvalidVersion:
            return None
        if requirement.specifier.contains(running):
            return None
        return (
            f"provider {entry.name!r} was built for {raw!r} and this is VisionSet "
            f"{__version__}; install a build of the provider that supports it, or "
            "change the version of VisionSet this environment has"
        )
    return None


def capabilities(providers: Mapping[str, Provider]) -> Mapping[str, ModelCapability]:
    """Which prompt each served family takes, merged across drivers.

    Derived and written nowhere else, so an adapter and its declaration are one
    edit. A family two drivers disagree about is left out: there is no honest
    answer where the build cannot say which one would run it.
    """
    seen: dict[str, ModelCapability] = {}
    contested: set[str] = set()
    for provider in providers.values():
        for family, capability in provider.families.items():
            if family in seen and seen[family] is not capability:
                contested.add(family)
            seen.setdefault(family, capability)
    return {family: capability for family, capability in seen.items() if family not in contested}


def pick(providers: Mapping[str, Provider], family: str) -> Provider:
    """The one driver serving that family.

    Split from :func:`installed` so the refusal has one wording whoever scanned.

    Raises:
        InferenceConnectionNotRunnable: nothing serves that family, or more than
            one does. Both are answers about the installation rather than about a
            connection.
    """
    serving = sorted(
        provider_id for provider_id, provider in providers.items() if family in provider.families
    )
    if not serving:
        raise InferenceConnectionNotRunnable(_nothing_serves(providers, family))
    if len(serving) > 1:
        raise InferenceConnectionNotRunnable(
            f"model type {family!r} is served by more than one installed provider "
            f"({', '.join(serving)}), so this build cannot tell which one should run it; "
            "uninstall one of them"
        )
    return providers[serving[0]]


def _nothing_serves(providers: Mapping[str, Provider], family: str) -> str:
    """Why nothing runs that family, and what this installation does run.

    Two openings: a family nobody serves is a model choice, a config that declared
    nothing is usually damaged files, and the remedies differ.
    """
    served = ", ".join(sorted({family for p in providers.values() for family in p.families}))
    known = served or "no model types at all, because no provider is installed"
    if not family:
        return (
            "the downloaded config does not say what model type it is, so this build cannot "
            f"tell which provider would answer for it; it serves {known} — point the connection "
            "at one of those, or download its weights again if those files are damaged"
        )
    return (
        f"no installed provider serves model type {family!r}; this build serves {known} — "
        "point the connection at a model of one of those types"
    )
