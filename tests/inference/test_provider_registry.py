"""Discovery: which drivers this installation has, and which one a family gets.

The two failures worth a suite of their own are silent ones. A provider skipped
without a reason looks exactly like a provider nobody installed, and a family two
drivers claim resolves to whichever the scan happened to reach first.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from visionset.inference import registry
from visionset.kernel.domain import CuratedModel, ModelCapability
from visionset.kernel.errors import InferenceConnectionNotRunnable
from visionset.kernel.ports import Provider

POINT = ModelCapability.POINT_SUGGEST
TEXT = ModelCapability.TEXT_DETECT


class Driver:
    """A provider built by hand, so a test needs no installed distribution."""

    def __init__(self, provider_id: str, families: Mapping[str, ModelCapability]) -> None:
        self.provider_id = provider_id
        self.families = families
        self.curated: tuple[CuratedModel, ...] = ()

    def build(self, connection: object, *, workspace_root: Path) -> object:
        raise NotImplementedError


@dataclass
class FakeDist:
    name: str = "acme-provider"
    requires: list[str] | None = None


@dataclass
class FakeEntry:
    """An entry point that records whether it was ever loaded."""

    name: str
    provider: object
    dist: FakeDist | None = field(default_factory=FakeDist)
    loads: int = 0

    def load(self) -> object:
        self.loads += 1
        return lambda: self.provider


@pytest.fixture(autouse=True)
def _pinned_version(monkeypatch: pytest.MonkeyPatch) -> None:
    """A fixed running version, so these cases do not move when the repo does.
    Deliberately the shape this project actually ships: a pre-1.0 prerelease."""
    monkeypatch.setattr(registry, "__version__", "0.0.1b2")


def test_a_registered_driver_is_found_under_the_name_it_calls_itself() -> None:
    entry = FakeEntry("whatever-the-packaging-called-it", Driver("acme", {"sam2": POINT}))
    found = registry.installed([entry])
    assert set(found.providers) == {"acme"}
    assert found.skipped == ()


def test_something_registered_that_is_not_a_provider_is_ignored() -> None:
    """The group may one day carry more than one port, as `visionset.formats` does."""
    found = registry.installed([FakeEntry("junk", object())])
    assert found.providers == {}


class TestTheVersionBackstop:
    """pip checks a pin at install; this checks it at import, where `--no-deps`
    and an upgrade-in-place land."""

    def test_a_driver_built_for_this_version_loads(self) -> None:
        entry = FakeEntry(
            "acme",
            Driver("acme", {"sam2": POINT}),
            dist=FakeDist(requires=["visionset>=0.0.1b1,<0.1"]),
        )
        assert set(registry.installed([entry]).providers) == {"acme"}

    def test_a_prerelease_sorts_before_its_own_release(self) -> None:
        """Measured, not assumed, and it decides what a plugin author must write.

        `0.0.1b2 >= 0.0.1` is False, so an ordinary-looking pin excludes the very
        build it was written for. The check agrees with pip here deliberately — a
        backstop that disagreed with the thing it backs up would be a second gate
        — so while this project is pre-1.0 a plugin needs a prerelease floor.
        """
        entry = FakeEntry(
            "acme", Driver("acme", {"sam2": POINT}), dist=FakeDist(requires=["visionset>=0.0.1"])
        )
        found = registry.installed([entry])
        assert found.providers == {}
        assert "visionset>=0.0.1" in found.skipped[0].reason

    def test_a_driver_built_for_another_version_is_skipped_with_its_reason(self) -> None:
        entry = FakeEntry(
            "acme", Driver("acme", {"sam2": POINT}), dist=FakeDist(requires=["visionset>=9,<10"])
        )
        found = registry.installed([entry])
        assert found.providers == {}
        (skipped,) = found.skipped
        assert skipped.name == "acme"
        assert "visionset>=9,<10" in skipped.reason
        assert "0.0.1b2" in skipped.reason

    def test_a_skipped_driver_is_never_imported(self) -> None:
        """The reason the check runs before `load()`: an incompatible driver must
        not get to execute at all."""
        entry = FakeEntry(
            "acme", Driver("acme", {"sam2": POINT}), dist=FakeDist(requires=["visionset>=9,<10"])
        )
        registry.installed([entry])
        assert entry.loads == 0

    def test_one_incompatible_driver_does_not_take_the_others_down(self) -> None:
        good = FakeEntry("good", Driver("good", {"sam2": POINT}), dist=FakeDist(requires=[]))
        bad = FakeEntry(
            "bad", Driver("bad", {"dino": TEXT}), dist=FakeDist(requires=["visionset>=9,<10"])
        )
        found = registry.installed([good, bad])
        assert set(found.providers) == {"good"}
        assert [s.name for s in found.skipped] == ["bad"]

    @pytest.mark.parametrize(
        "requires",
        [
            pytest.param(None, id="no metadata at all"),
            pytest.param([], id="pins nothing"),
            pytest.param(["torch>=2"], id="pins something else"),
            pytest.param(["visionset"], id="names visionset without a specifier"),
            pytest.param(['visionset>=9,<10; extra == "dev"'], id="pinned behind an extra"),
        ],
    )
    def test_silence_is_not_a_refusal(self, requires: list[str] | None) -> None:
        """A distribution that never said which VisionSet it targets has told us
        nothing. Inventing a refusal out of that breaks every relaxed author — and
        the in-tree providers, which ship as this distribution."""
        entry = FakeEntry("acme", Driver("acme", {"sam2": POINT}), dist=FakeDist(requires=requires))
        assert set(registry.installed([entry]).providers) == {"acme"}

    def test_an_unparseable_requirement_is_stepped_over(self) -> None:
        entry = FakeEntry(
            "acme",
            Driver("acme", {"sam2": POINT}),
            dist=FakeDist(requires=["not a requirement at all", "visionset>=0.0.1b1,<0.1"]),
        )
        assert set(registry.installed([entry]).providers) == {"acme"}


class TestServingAFamily:
    def test_the_one_driver_serving_it_is_returned(self) -> None:
        drivers: dict[str, Provider] = {
            "sam": Driver("sam", {"sam2": POINT}),
            "dino": Driver("dino", {"grounding-dino": TEXT}),
        }
        found = registry.serving(drivers, "grounding-dino")
        assert found is not None
        assert found.provider_id == "dino"

    def test_a_family_nothing_serves_answers_none_rather_than_raising(self) -> None:
        """The sentence worth showing names the connection and the model it points
        at, and only the caller holding one can write it. `providers.py` does."""
        drivers: dict[str, Provider] = {"sam": Driver("sam", {"sam2": POINT})}
        assert registry.serving(drivers, "yolo") is None
        assert registry.serving(drivers, "") is None

    def test_a_family_two_drivers_claim_is_refused_naming_both(self) -> None:
        """Never last-wins. Guessing which driver runs somebody's weights is what
        this subsystem refuses to do everywhere else."""
        drivers: dict[str, Provider] = {
            "acme": Driver("acme", {"sam2": POINT}),
            "zeta": Driver("zeta", {"sam2": POINT}),
        }
        with pytest.raises(InferenceConnectionNotRunnable) as refusal:
            registry.serving(drivers, "sam2")
        assert "acme" in str(refusal.value)
        assert "zeta" in str(refusal.value)

    def test_a_contest_is_localised_to_the_family_it_is_about(self) -> None:
        """One colliding plugin must not break connections that have nothing to do
        with it."""
        drivers: dict[str, Provider] = {
            "acme": Driver("acme", {"sam2": POINT, "grounding-dino": TEXT}),
            "zeta": Driver("zeta", {"sam2": POINT}),
        }
        found = registry.serving(drivers, "grounding-dino")
        assert found is not None
        assert found.provider_id == "acme"

    def test_what_a_refusal_lists_is_what_the_drivers_declare(self) -> None:
        drivers: dict[str, Provider] = {
            "sam": Driver("sam", {"sam2": POINT, "sam2_video": POINT}),
            "dino": Driver("dino", {"grounding-dino": TEXT}),
        }
        assert registry.families_served(drivers) == frozenset(
            {"sam2", "sam2_video", "grounding-dino"}
        )


class TestTheKeptScan:
    def test_the_scan_is_kept_rather_than_repeated(self) -> None:
        """Measured, and the reason this diverges from the formats registry: the
        answer is read per connection row, not once per listing."""
        registry.reset()
        first = registry.registered()
        assert registry.registered() is first

    def test_resetting_forgets_it(self) -> None:
        registry.reset()
        first = registry.registered()
        registry.reset()
        assert registry.registered() is not first

    def test_the_three_shipped_drivers_are_discovered(self) -> None:
        """Through installed metadata, not a hardcoded list — the plugin promise."""
        registry.reset()
        assert set(registry.registered().providers) == {"sam", "grounding-dino", "stub"}


class TestMergingCapabilities:
    def test_every_served_family_says_what_it_takes(self) -> None:
        drivers: dict[str, Provider] = {
            "sam": Driver("sam", {"sam2": POINT, "sam3_video": POINT}),
            "dino": Driver("dino", {"grounding-dino": TEXT}),
        }
        assert registry.capabilities(drivers) == {
            "sam2": POINT,
            "sam3_video": POINT,
            "grounding-dino": TEXT,
        }

    def test_a_family_two_drivers_disagree_about_declares_nothing(self) -> None:
        """There is no honest answer where the build cannot say which would run
        it, and a wrong one decides which tool the editor offers."""
        drivers: dict[str, Provider] = {
            "acme": Driver("acme", {"sam2": POINT}),
            "zeta": Driver("zeta", {"sam2": TEXT}),
        }
        assert registry.capabilities(drivers) == {}

    def test_two_drivers_agreeing_about_a_family_still_declare_it(self) -> None:
        """Agreement is not a contest. `pick` still refuses the ambiguity, but what
        the family can be *asked* is not in doubt."""
        drivers: dict[str, Provider] = {
            "acme": Driver("acme", {"sam2": POINT}),
            "zeta": Driver("zeta", {"sam2": POINT}),
        }
        assert registry.capabilities(drivers) == {"sam2": POINT}
