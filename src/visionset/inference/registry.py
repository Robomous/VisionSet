# usage: from visionset.inference.registry import registered, serving
"""Finding the drivers this installation has, and the one a family needs.

Discovery is ``importlib.metadata`` over the ``visionset.providers`` group, never
a hardcoded dict: a third-party distribution registers into the same group and is
indistinguishable from a built-in here.

**Installing a provider does not let a workspace predict.** Nothing here fetches
or loads anything, and no existing connection changes what it runs.

:func:`installed` caches nothing, and :func:`registered` keeps one scan for the
life of the process because a driver's declaration is read per connection row.
That is where this parts company with ``formats/registry.py``, and the cost is
named there: a driver installed while a server is running is not seen until it
restarts.
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
from visionset.kernel.domain import ModelCapability, ServedFamily
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


def served(providers: Mapping[str, Provider]) -> Mapping[str, ServedFamily]:
    """What each served family takes and answers in, merged across drivers.

    Derived and written nowhere else, so an adapter and its declaration are one
    edit. A family two drivers declare differently — in capability or in shape —
    is left out: there is no honest answer where the build cannot say which one
    would run it.
    """
    seen: dict[str, ServedFamily] = {}
    contested: set[str] = set()
    for provider in providers.values():
        for family, declared in provider.families.items():
            if family in seen and seen[family] != declared:
                contested.add(family)
            seen.setdefault(family, declared)
    return {family: declared for family, declared in seen.items() if family not in contested}


def capabilities(providers: Mapping[str, Provider]) -> Mapping[str, ModelCapability]:
    """Which prompt each served family takes — :func:`served`, read for one axis."""
    return {family: declared.capability for family, declared in served(providers).items()}


def families_served(providers: Mapping[str, Provider]) -> frozenset[str]:
    """Every family some installed driver serves — what a refusal lists."""
    return frozenset(family for provider in providers.values() for family in provider.families)


def serving(providers: Mapping[str, Provider], family: str) -> Provider | None:
    """The one driver serving that family, or ``None`` if none does.

    ``None`` rather than a raise for the empty case, because the sentence worth
    showing names the connection and the model it points at, and only the caller
    holding one can write it. A contested family *is* raised here: that answer is
    about the installation and reads the same whoever asked.

    Raises:
        InferenceConnectionNotRunnable: more than one installed driver serves it.
    """
    claimants = sorted(
        provider_id for provider_id, provider in providers.items() if family in provider.families
    )
    if not claimants:
        return None
    if len(claimants) > 1:
        raise InferenceConnectionNotRunnable(
            f"model type {family!r} is served by more than one installed provider "
            f"({', '.join(claimants)}), so this build cannot tell which one should run it; "
            "uninstall one of them"
        )
    return providers[claimants[0]]


def recorded(providers: Mapping[str, Provider], provider_id: str) -> Provider:
    """The driver a connection names, or why this installation has not got it.

    Raised rather than returned as ``None``, which is where this parts company
    with :func:`serving`: a family nothing serves needs the caller's connection
    to write a useful sentence, while a *named* driver that is absent is already
    the whole story — the row says who should run it and this installation does
    not have them.

    The missing-format treatment, and deliberately not a fallback to whoever
    happens to serve the same family: that would run the connection through a
    driver nobody chose, and quietly, which is the guessing the resolver exists
    to refuse.

    Raises:
        InferenceConnectionNotRunnable: no installed driver calls itself that.
    """
    driver = providers.get(provider_id)
    if driver is not None:
        return driver
    here = ", ".join(sorted(providers)) or "none at all"
    raise InferenceConnectionNotRunnable(
        f"this connection is served by provider {provider_id!r}, and no provider of that name "
        f"is installed here; this installation has {here} — install the distribution that "
        "provides it, or point the connection at a model one of these serves"
    )


_REGISTERED: list[Discovery] = []
"""The kept scan. A list because rebinding a module global from a function needs
a ``global`` statement, and a one-slot list makes the mutation local and the
reset obvious."""


def registered() -> Discovery:
    """The process-wide scan, kept rather than repeated.

    **This is where the formats registry's "nothing is cached" stops applying,
    and the reason is measured.** An exporter listing scans once per request; a
    driver's declaration is read *per connection row*, by both serializers that
    build a connection's `capabilities`. A scan costs 1.3 ms and a scan with
    ``load()`` costs 11 ms on this machine, so a workspace with a hundred
    connections would spend over a second of a listing on rediscovering the same
    plugins.

    The cost is that a driver installed while a process is running is not seen
    until it restarts, which is already true of a worker and is the ordinary
    expectation for a Python plugin.
    """
    if not _REGISTERED:
        _REGISTERED.append(installed())
    return _REGISTERED[0]


def reset() -> None:
    """Forget the kept scan. What a test does between cases."""
    _REGISTERED.clear()
