# usage: uv run pytest tests/inference/test_provider_conformance.py
"""What every installed driver must prove, whoever wrote it.

One parametrised suite over the installation rather than a file per driver. The
three drivers this distribution ships are its first subjects and are not its
subject: an open provider set means the implementations are no longer all ours,
and a promise made in a port docstring binds nobody until something checks it on
every implementation present.

**The subjects are derived from what is installed, never listed.** A hand-written
list of drivers goes stale the day one is added, and then reports the suite total
while covering less than it did — so every case here is parametrised over
``registered().providers`` and over the families those drivers declare.

**Two ways this suite could pass by having nothing to say**, both guarded below
rather than trusted. An entry-point group that records nothing — a venv whose
metadata predates the last install — collects zero subjects for every
parametrised case. And a capability with no entry in the tables this suite
switches on exercises no runner at all.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping
from importlib.metadata import EntryPoint, entry_points
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from tests.fixtures.media import write_image

from visionset.inference.registry import GROUP, families_served, installed, registered
from visionset.kernel.domain import (
    ConnectionSetupState,
    ConnectionType,
    CuratedModel,
    InferenceConnection,
    ModelCapability,
    PointPrompt,
    PredictionRequest,
    PredictionTarget,
    TextPrompt,
)
from visionset.kernel.ports import ModelProvider, PointSegmenter, Provider

REGISTRATIONS: tuple[EntryPoint, ...] = tuple(entry_points(group=GROUP))
"""Every registration in the group, before discovery filters any of them.

Read separately from :data:`INSTALLED` because ``installed()`` drops what does
not satisfy the port and keys the rest by ``provider_id`` — so two of the claims
below cannot be made against its output at all.
"""

INSTALLED: Mapping[str, Provider] = registered().providers
DRIVERS: tuple[str, ...] = tuple(sorted(INSTALLED))

SERVED: tuple[tuple[str, str, ModelCapability], ...] = tuple(
    (provider_id, family, capability)
    for provider_id in DRIVERS
    for family, capability in sorted(INSTALLED[provider_id].families.items())
)
"""Every (driver, family, capability) this installation serves.

Derived from the declarations rather than written, which is the totality
guarantee: a family added to a driver becomes a subject of every case
parametrised over this, with nothing to remember.
"""

SERVED_IDS = tuple(f"{provider_id}:{family}" for provider_id, family, _ in SERVED)

COMMIT_LENGTH = 40

PROMPTS: Mapping[ModelCapability, PointPrompt | TextPrompt] = {
    ModelCapability.POINT_SUGGEST: PointPrompt(positive=((30.0, 24.0),)),
    ModelCapability.TEXT_DETECT: TextPrompt(phrases=("cat",)),
}
"""What each capability is asked with, and the whole of what this suite can ask."""

PORT_FOR: Mapping[ModelCapability, type] = {
    ModelCapability.POINT_SUGGEST: PointSegmenter,
    ModelCapability.TEXT_DETECT: ModelProvider,
}
"""Which runner port a declared capability implies.

The pair a driver is held to: declaring one and building the other refuses every
request in the wrong vocabulary — a confident sentence about some other model.
"""

SAYS_IT_TAKES: Mapping[ModelCapability, str] = {
    ModelCapability.POINT_SUGGEST: "point prompts",
    ModelCapability.TEXT_DETECT: "text prompts",
}
"""The words a refusal must contain to have named what the runner *does* take.

An "unsupported prompt" that named nothing leaves a client unable to offer the
thing that is supported.
"""


def is_a_commit(revision: str) -> bool:
    """Whether that revision pins a snapshot rather than pointing at one.

    Extracted so the rule has a negative case. ``CuratedModel`` refuses to be
    constructed with a branch, so no entry a shipped driver holds can ever be a
    failing subject — and a driver from outside this distribution satisfies the
    protocol with any tuple of objects carrying the right attributes, which is
    the installation the rule is for.
    """
    return len(revision) == COMMIT_LENGTH and all(
        character in "0123456789abcdef" for character in revision
    )


def wrongly_asked(capability: ModelCapability) -> tuple[PointPrompt | TextPrompt, ...]:
    """Every prompt this suite knows that a runner of that capability must refuse.

    Derived by exclusion rather than written as a swap, so a third capability
    arriving does not silently leave one pair unchecked.
    """
    return tuple(prompt for asked, prompt in PROMPTS.items() if asked is not capability)


def a_local_connection(*, model_id: str = "some/model", ready: bool) -> InferenceConnection:
    """A connection built directly rather than through the service.

    Nothing here needs a workspace: ``build`` is handed a domain value and a
    root, and a suite that opened a SQLite workspace per case to produce one
    would be testing the store.
    """
    return InferenceConnection(
        name="conformance",
        connection_type=ConnectionType.LOCAL,
        model_id=model_id,
        model_revision="abc123",
        device="cpu",
        precision="fp32",
        setup_state=ConnectionSetupState.READY if ready else ConnectionSetupState.NOT_SET_UP,
    )


def a_request(
    tmp_path: Path, *, prompt: PointPrompt | TextPrompt, targets: int = 1
) -> PredictionRequest:
    """A request over real PNG bytes, because a runner opens them."""
    content = write_image(tmp_path / "conformance.png", size=(60, 48)).read_bytes()
    return PredictionRequest(
        targets=tuple(
            PredictionTarget(asset_id=uuid4(), content=content, media_type="image/png")
            for _ in range(targets)
        ),
        prompt=prompt,
    )


def asking(runner: object) -> Callable[[PredictionRequest], Iterator[object]]:
    """The one method that runner's port declares.

    A caller narrows with ``isinstance`` because that is what a union of two
    ports asks of it, and this suite is the caller for every driver at once.
    """
    if isinstance(runner, PointSegmenter):
        return runner.segment
    assert isinstance(runner, ModelProvider), f"{type(runner).__name__} is neither port"
    return runner.predict


def a_snapshot(cache_dir: Path, *, model_id: str, revision: str, declaring: object) -> None:
    """Lay down a real hub cache entry, in the hub's real layout.

    Written rather than doubled, and that is load-bearing: what is being proved
    is what a reader reads off a disk, and a fake reader agrees with whatever the
    test already believes. Every test of the config read had doubled the reader
    away, which is exactly why a family a third-party driver serves came back
    unreadable for as long as it did.
    """
    org, _, name = model_id.partition("/")
    repo = cache_dir / f"models--{org}--{name}"
    snapshot = repo / "snapshots" / "deadbeef"
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "config.json").write_text(json.dumps(declaring), encoding="utf-8")
    (repo / "refs").mkdir(parents=True, exist_ok=True)
    (repo / "refs" / revision).write_text("deadbeef", encoding="utf-8")


# --- the suite's own coverage --------------------------------------------------


def test_the_group_records_the_drivers_this_distribution_ships() -> None:
    """Every parametrised case below draws its subjects from this scan, so a scan
    that finds nothing makes the whole suite green by covering nothing.

    The failure is ordinary and it does not look like a stale environment from
    the inside: entry-point metadata is written into the venv at install time and
    is never read from ``pyproject.toml``, so a checkout that changed the group
    leaves a venv answering with the old set, or with none at all. Re-syncing the
    environment is the repair.
    """
    assert {registration.name for registration in REGISTRATIONS} >= {
        "sam",
        "grounding-dino",
        "stub",
    }


def test_the_suite_knows_something_about_every_capability_the_kernel_defines() -> None:
    """One assertion over the three tables every behavioural case switches on.

    A capability the kernel gains and these do not name would be served, listed,
    and exercised by nothing — the quiet half of "closed capabilities", where the
    vocabulary grows and the suite silently stops covering all of it.
    """
    for table in (PROMPTS, PORT_FOR, SAYS_IT_TAKES):
        assert set(table) == set(ModelCapability)


def test_the_suite_names_every_family_the_installation_serves() -> None:
    """Totality rather than a count. A count floor catches a scan that stopped
    parsing; only this catches a subject list that went stale.
    """
    assert {(provider_id, family) for provider_id, family, _ in SERVED} == {
        (provider_id, family)
        for provider_id, driver in INSTALLED.items()
        for family in driver.families
    }


# --- what a driver declares ---------------------------------------------------


@pytest.mark.parametrize("registration", REGISTRATIONS, ids=[one.name for one in REGISTRATIONS])
def test_every_registration_in_the_group_loads_to_a_driver(registration: EntryPoint) -> None:
    """Asserted on the registration rather than on the scan's output, which
    filters — so the same claim made there could never fail.

    What can fail is a registration naming something that is not a driver: a
    moved class, a factory answering with a config, an entry point pointing at
    the module rather than at the class. Discovery drops it without a word, and
    the families it was supposed to serve simply never appear — which from the
    outside is indistinguishable from a driver nobody installed.
    """
    plugin = registration.load()()
    assert isinstance(plugin, Provider)


def test_no_two_registrations_claim_the_same_driver_id() -> None:
    """Read from the registrations for the same reason: the scan keys on the id,
    so a collision is already resolved by the time its output exists. What one
    would cost is in the characterisation case further down.
    """
    claimed = [registration.load()().provider_id for registration in REGISTRATIONS]
    assert sorted(claimed) == sorted(set(claimed))


@pytest.mark.parametrize("provider_id", DRIVERS)
def test_a_driver_calls_itself_something(provider_id: str) -> None:
    """A blank id is a driver no refusal can name, and it is what a contested
    family tells somebody to uninstall.
    """
    assert INSTALLED[provider_id].provider_id.strip()


@pytest.mark.parametrize("provider_id", DRIVERS)
def test_a_driver_declares_at_least_one_family_and_what_each_takes(provider_id: str) -> None:
    """``isinstance`` against the port checks that ``families`` is *present* and
    never what is in it — a driver whose values are plain strings satisfies the
    protocol and then declares capabilities no client can switch on.
    """
    families = INSTALLED[provider_id].families
    assert families, "a driver serving nothing is a driver nothing can resolve to"
    for family, capability in families.items():
        assert family.strip(), f"{provider_id} declares a blank family"
        assert isinstance(capability, ModelCapability), (
            f"{provider_id} maps {family!r} onto {capability!r}, which is not a "
            "member of the kernel's closed capability vocabulary"
        )


@pytest.mark.parametrize("provider_id", DRIVERS)
def test_every_curated_entry_names_a_family_its_own_driver_serves(provider_id: str) -> None:
    """The one rule ``CuratedModel`` cannot enforce for itself, because an entry
    cannot see the provider holding it. An entry naming a family its own driver
    does not serve is offered by a form and then refused at resolution.
    """
    driver = INSTALLED[provider_id]
    for entry in driver.curated:
        assert entry.family in driver.families, (
            f"{provider_id} offers {entry.model_id} as {entry.family!r}, which it "
            f"does not serve; it serves {', '.join(sorted(driver.families))}"
        )


@pytest.mark.parametrize("provider_id", DRIVERS)
def test_every_curated_entry_is_pinned_to_a_commit(provider_id: str) -> None:
    """A branch moves, so a hint beside one describes whatever it pointed at last
    week.
    """
    for entry in INSTALLED[provider_id].curated:
        assert is_a_commit(entry.model_revision), (
            f"{provider_id} offers {entry.model_id} at "
            f"{entry.model_revision!r}, which is not a commit"
        )


@pytest.mark.parametrize(
    "revision",
    ["main", "v1.0", "", "a" * 39, "a" * 41, "A" * COMMIT_LENGTH, "z" * COMMIT_LENGTH],
    ids=["a branch", "a tag", "empty", "too short", "too long", "upper case", "not hex"],
)
def test_a_moving_pointer_is_not_a_commit(revision: str) -> None:
    """The negative case the installation cannot supply.

    ``CuratedModel`` refuses to be constructed with any of these, so no shipped
    driver can hold a failing subject for the check above — and the check is not
    thereby pointless, because a driver from outside this distribution satisfies
    the protocol with any tuple of objects carrying the right attributes. This is
    what shows the predicate would notice one.
    """
    assert not is_a_commit(revision)


# --- what discovery cannot report --------------------------------------------


class Named:
    """A driver with nothing but a name and a declaration.

    Enough to satisfy the port, and no more: what the cases below are about is
    discovery, not building.
    """

    curated: tuple[CuratedModel, ...] = ()

    def __init__(self, provider_id: str, families: Mapping[str, ModelCapability]) -> None:
        self.provider_id = provider_id
        self.families = families

    def build(
        self, connection: InferenceConnection, *, family: str, workspace_root: Path
    ) -> object:
        raise NotImplementedError


class Recorded:
    """An entry point built by hand, so a case needs no installed distribution.

    ``installed(entries=…)`` takes exactly this, and that parameter is what makes
    the case below testable at all: a duplicate id is already resolved by the
    time ``registered()`` can be looked at. Installing a real distribution to
    reach it would change what every other test in this suite discovers.
    """

    def __init__(self, name: str, plugin: object, requires: list[str] | None = None) -> None:
        self.name = name
        self._plugin = plugin
        self.dist = SimpleNamespace(name=f"{name}-dist", requires=requires)

    def load(self) -> Callable[[], object]:
        return lambda: self._plugin


def test_two_drivers_claiming_one_id_is_not_something_a_scan_can_report() -> None:
    """Recorded rather than asserted away, because this is a gap and not a rule.

    The scan collects into a mapping keyed by ``provider_id``, so a second driver
    claiming a name replaces the first: the result holds one provider, no
    registration is reported skipped, and the replaced driver's families are gone
    with it. Nothing downstream can tell that apart from an installation that
    only ever had one — a family stops resolving and the reason is in neither the
    connection nor the error.

    The rule itself is asserted one section up, against the registrations, where
    a collision is still visible.
    """
    first = Named("acme", {"one": ModelCapability.POINT_SUGGEST})
    second = Named("acme", {"two": ModelCapability.POINT_SUGGEST})

    found = installed([Recorded("first", first), Recorded("second", second)])

    assert set(found.providers) == {"acme"}
    assert found.skipped == (), "no registration is reported as skipped"
    assert found.providers["acme"] is second, "the second silently replaces the first"
    assert "one" not in families_served(found.providers)
