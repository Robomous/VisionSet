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

from visionset.inference import providers as providers_module
from visionset.inference.registry import (
    GROUP,
    capabilities,
    families_served,
    installed,
    registered,
)
from visionset.inference.stub_provider import STUB_MODEL_ID
from visionset.kernel.domain import (
    AssetPrediction,
    AssetSegmentation,
    ConnectionSetupState,
    ConnectionType,
    CuratedModel,
    DownloadSize,
    InferenceConnection,
    ModelCapability,
    PointPrompt,
    PredictionRequest,
    PredictionTarget,
    SegmentedMask,
    TextPrompt,
)
from visionset.kernel.errors import InferenceConnectionNotRunnable, UnsupportedPrompt
from visionset.kernel.ports import ModelProvider, PointSegmenter, Provider, WeightsSource

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


# --- the drivers this suite brings with it ------------------------------------

ACME_FAMILY = "acme_seg"
"""A family no library in this build registers.

Chosen deliberately: ``transformers`` can only name a model type it registers
itself, so a family outside that set is the one case a third-party local driver
lives in and no shipped driver can stand in for.
"""

ACME_ENTRY = CuratedModel(
    model_id="acme/segmenter",
    model_revision="c" * COMMIT_LENGTH,
    family=ACME_FAMILY,
    hint="the family nothing here registers",
)


class EchoDetector:
    """A detector that looks at each target and reports finding nothing."""

    def __init__(self, *, model_ref: str) -> None:
        self.model_ref = model_ref

    def predict(self, request: PredictionRequest) -> Iterator[AssetPrediction]:
        if not isinstance(request.prompt, TextPrompt):
            raise UnsupportedPrompt(
                f"{self.model_ref} answers text prompts; it was asked with "
                f"{request.prompt.kind!r}, which it has no way to interpret"
            )
        for target in request.targets:
            # An empty answer is an answer. "Found nothing" and "was not looked
            # at" are different facts, and one of the checks below is the
            # difference.
            yield AssetPrediction(asset_id=target.asset_id, model_ref=self.model_ref)


class Echo:
    """A hosted driver: declares a family, declares no weights source.

    The proof that the contract admits hosting, and a stronger one than a
    half-finished real adapter — it is discovered, says what it serves, builds a
    runner and refuses the wrong prompt, with no weights anywhere. All three
    shipped drivers are hub-backed, so without this the branch "a driver that
    declares no weights source" never executes.
    """

    provider_id = "test-hosted-echo"
    families: Mapping[str, ModelCapability] = {"acme_hosted": ModelCapability.TEXT_DETECT}
    curated: tuple[CuratedModel, ...] = ()

    def __init__(self) -> None:
        self.built: list[str] = []

    def build(
        self, connection: InferenceConnection, *, family: str, workspace_root: Path
    ) -> EchoDetector:
        self.built.append(family)
        return EchoDetector(model_ref=f"{connection.model_id}@hosted")


class AcmeSegmenter:
    """A segmenter answering one small mask per target."""

    def __init__(self, *, model_ref: str) -> None:
        self.model_ref = model_ref

    def segment(self, request: PredictionRequest) -> Iterator[AssetSegmentation]:
        if not isinstance(request.prompt, PointPrompt):
            raise UnsupportedPrompt(
                f"{self.model_ref} answers point prompts; it was asked with "
                f"{request.prompt.kind!r}, which it has no way to interpret"
            )
        for target in request.targets:
            yield AssetSegmentation(
                asset_id=target.asset_id,
                model_ref=self.model_ref,
                segments=(SegmentedMask(mask=[[True, True], [True, True]], score=0.5),),
            )


class AcmeSeg:
    """A local third-party driver serving a family nothing here registers.

    It satisfies both protocols and prices its own curated entry without reaching
    a network, which makes it the only offline subject for "a driver that
    declares a weights source prices what it offers" — the built-in stand-in
    curates nothing, and the two real drivers price through the hub.
    """

    provider_id = "test-acme-seg"
    families: Mapping[str, ModelCapability] = {ACME_FAMILY: ModelCapability.POINT_SUGGEST}
    curated = (ACME_ENTRY,)

    def __init__(self) -> None:
        self.built: list[str] = []
        self.fetched = 0

    def build(
        self, connection: InferenceConnection, *, family: str, workspace_root: Path
    ) -> AcmeSegmenter:
        self.built.append(family)
        return AcmeSegmenter(model_ref=f"{connection.model_id}@{connection.model_revision}")

    def price(self, model_id: str, model_revision: str) -> DownloadSize:
        return DownloadSize(
            model_id=model_id, model_revision=model_revision, total_bytes=1024, file_count=1
        )

    def family_of(self, connection: InferenceConnection, *, cache_dir: Path) -> str:
        return ACME_FAMILY

    def fetch(
        self,
        connection: InferenceConnection,
        *,
        into: Path,
        on_bytes: Callable[[int], None] | None = None,
    ) -> Path:
        self.fetched += 1
        into.mkdir(parents=True, exist_ok=True)
        if on_bytes is not None:
            on_bytes(1024)
        return into


# --- declaring a weights source ------------------------------------------------


@pytest.mark.parametrize("provider_id", DRIVERS)
def test_declaring_a_weights_source_is_all_or_nothing(provider_id: str) -> None:
    """Two of the three methods satisfies neither the protocol nor a reader.

    ``isinstance`` answers False for a partial implementation, so the download
    path skips the driver entirely and the half that was written is called by
    nothing — a driver that looks able to fetch its own weights and never is.
    """
    driver = INSTALLED[provider_id]
    written = {name for name in ("price", "family_of", "fetch") if hasattr(driver, name)}
    assert not written or isinstance(driver, WeightsSource), (
        f"{provider_id} writes {sorted(written)} and does not satisfy WeightsSource"
    )


def test_a_hosted_driver_is_a_driver_and_is_not_a_weights_source() -> None:
    """The discrimination the two-protocol split exists for, on a subject that
    can actually fail it. If ``isinstance`` answered True for both, a hosted
    driver would be asked to download weights it has no concept of.
    """
    hosted = Echo()
    assert isinstance(hosted, Provider)
    assert not isinstance(hosted, WeightsSource)


def test_a_hosted_driver_is_discovered_and_declares_what_it_serves() -> None:
    """Driven through discovery rather than only constructed, because the claim
    is about the contract admitting a hosted driver and not about a class shape.

    It goes in through the injectable scan, which is what that parameter is for:
    installing a distribution to reach the same assertion would change what every
    other test in this suite discovers.
    """
    hosted = Echo()

    found = installed([Recorded("hosted", hosted)])

    assert found.providers == {hosted.provider_id: hosted}
    assert found.skipped == ()
    assert capabilities(found.providers) == {"acme_hosted": ModelCapability.TEXT_DETECT}
    assert families_served(found.providers) == frozenset({"acme_hosted"})


def test_resolution_cannot_reach_a_hosted_driver_in_this_release() -> None:
    """The end of the path, stated rather than left as a silence.

    A hosted connection is refused before any driver is looked at, so a
    discovered hosted driver has nothing that will route to it yet: the
    connection would have to name the provider it belongs to, and
    ``model_family`` is null on a hosted connection permanently because no
    weights ever arrive to read a config from. That gap is tracked as its own
    issue and is deliberately outside this suite; what conformance can say today
    is that the refusal is honest about the reason.
    """
    hosted = Echo()
    remote = InferenceConnection(
        name="conformance-hosted",
        connection_type=ConnectionType.HTTP,
        model_id="acme/hosted",
        model_revision="abc123",
        endpoint_url="https://example.invalid/v1",
    )

    with pytest.raises(InferenceConnectionNotRunnable, match="http connection"):
        providers_module.provider_for(remote, workspace_root=Path("/nonexistent"))

    assert hosted.built == [], "nothing routed to it, so it was never asked to build"


def test_a_driver_that_offers_a_checkpoint_can_price_it() -> None:
    """Priced on the one driver here that can answer offline.

    ``sam`` and ``grounding-dino`` price through the hub's file listing, which
    this suite must not reach — that path is driven against a doubled hub in
    ``tests/inference/test_download_size.py``. The built-in stand-in curates
    nothing, so it has no entry to price. This driver has both.
    """
    driver = AcmeSeg()
    assert isinstance(driver, WeightsSource)
    entry = driver.curated[0]

    priced = driver.price(entry.model_id, entry.model_revision)

    assert isinstance(priced, DownloadSize)
    assert (priced.model_id, priced.model_revision) == (entry.model_id, entry.model_revision)


def test_the_built_in_stand_in_prices_its_own_id_rather_than_refusing() -> None:
    """A refusal here would make the setup form unable to show a size for a
    connection it is perfectly able to create.
    """
    stub = INSTALLED["stub"]
    assert isinstance(stub, WeightsSource)

    priced = stub.price(STUB_MODEL_ID, "stub")

    assert (priced.total_bytes, priced.file_count) == (0, 0)


# --- what a driver builds ------------------------------------------------------


@pytest.mark.parametrize(("provider_id", "family", "capability"), SERVED, ids=SERVED_IDS)
def test_what_a_driver_builds_satisfies_the_port_its_capability_implies(
    provider_id: str, family: str, capability: ModelCapability, tmp_path: Path
) -> None:
    """The declaration and the object checked against each other, which is the
    only place the two meet.

    A driver declaring ``point_suggest`` and building a detector refuses every
    click by saying the model answers text prompts — a confident sentence about
    some other model, which is worse than a gap somebody notices.

    Built rather than resolved, and ``build`` loads nothing: this runs on a base
    install with no weights on the machine.
    """
    built = INSTALLED[provider_id].build(
        a_local_connection(ready=True), family=family, workspace_root=tmp_path
    )

    assert isinstance(built, PORT_FOR[capability]), (
        f"{provider_id} declares {family!r} as {capability.value} and built "
        f"{type(built).__name__}"
    )


@pytest.mark.parametrize(("provider_id", "family", "capability"), SERVED, ids=SERVED_IDS)
def test_a_runner_refuses_a_prompt_kind_it_does_not_take(
    provider_id: str, family: str, capability: ModelCapability, tmp_path: Path
) -> None:
    """Named rather than approximated. A refusal that said only "unsupported"
    would leave a client unable to offer the thing that *is* supported.

    This reaches every installed driver on a base install, because both shipped
    adapters check the prompt kind as their first statement, before they reach
    for the runtime. Both are also generators, so the refusal arrives when the
    iterator is advanced rather than when it is created — which is why every call
    here is wrapped in ``list``.
    """
    runner = INSTALLED[provider_id].build(
        a_local_connection(ready=True), family=family, workspace_root=tmp_path
    )
    ask = asking(runner)

    for prompt in wrongly_asked(capability):
        with pytest.raises(UnsupportedPrompt) as refusal:
            list(ask(a_request(tmp_path, prompt=prompt)))
        assert SAYS_IT_TAKES[capability] in str(refusal.value), (
            f"{provider_id} refused {prompt.kind!r} without naming what it takes: {refusal.value}"
        )


# --- what a runner answers -----------------------------------------------------

ANSWERS_OFFLINE = frozenset({"stub"})
"""The installed drivers whose runner can answer without weights.

``sam`` and ``grounding-dino`` need a multi-gigabyte checkpoint to produce an
answer at all, so the two checks below cannot reach them here — their own suites
drive them against a stubbed runtime. Named as a set and asserted against the
installation, so the exemption cannot grow silently: a fourth driver arriving
fails the assertion below rather than quietly going unchecked.
"""

OFFLINE = ("stub", "test-hosted-echo", "test-acme-seg")
"""Every subject the two checks below run on, in a stable order."""


def offline_runners(tmp_path: Path) -> Mapping[str, tuple[object, ModelCapability]]:
    """A freshly built runner per offline subject, with the capability it serves.

    Built per case rather than once: the fakes record what they were asked, and a
    shared instance would make one case's assertions depend on another's order.
    """
    connection = a_local_connection(ready=True)
    built: dict[str, tuple[object, ModelCapability]] = {}
    for provider_id in sorted(ANSWERS_OFFLINE):
        driver = INSTALLED[provider_id]
        family, capability = sorted(driver.families.items())[0]
        built[provider_id] = (
            driver.build(connection, family=family, workspace_root=tmp_path),
            capability,
        )
    for fake in (Echo(), AcmeSeg()):
        family, capability = next(iter(fake.families.items()))
        built[fake.provider_id] = (
            fake.build(connection, family=family, workspace_root=tmp_path),
            capability,
        )
    return built


def test_only_the_drivers_that_need_weights_are_exempt_from_answering() -> None:
    """The exemption, stated so it cannot spread. A driver installed here that
    cannot answer offline is a decision to take, not a subject to drop.
    """
    assert set(INSTALLED) - ANSWERS_OFFLINE == {"sam", "grounding-dino"}


def test_the_offline_half_covers_every_runner_that_can_answer_here(tmp_path: Path) -> None:
    assert set(offline_runners(tmp_path)) == set(OFFLINE)


@pytest.mark.parametrize("subject", OFFLINE)
def test_every_answer_says_what_produced_it(subject: str, tmp_path: Path) -> None:
    """A provenance with a footnote is not a provenance. The reference is on each
    answer rather than on the response, because answers arrive one at a time.
    """
    runner, capability = offline_runners(tmp_path)[subject]

    answers = list(asking(runner)(a_request(tmp_path, prompt=PROMPTS[capability], targets=2)))

    assert answers, "a runner that answered nothing at all cannot be checked"
    for answer in answers:
        assert answer.model_ref.strip()


@pytest.mark.parametrize("subject", OFFLINE)
def test_exactly_one_answer_per_target_in_the_order_asked(subject: str, tmp_path: Path) -> None:
    """Two targets, so a runner answering only the first is red here rather than
    coincidentally right — and the identities are compared rather than the count,
    so answering the first one twice fails too.

    An answer carrying nothing found still counts: a click on empty sky and an
    image nobody looked at are different facts, and only the second is a gap.
    """
    runner, capability = offline_runners(tmp_path)[subject]
    request = a_request(tmp_path, prompt=PROMPTS[capability], targets=2)

    answers = list(asking(runner)(request))

    assert [answer.asset_id for answer in answers] == [
        target.asset_id for target in request.targets
    ]
