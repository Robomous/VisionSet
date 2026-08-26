"""Turning a step kind into a driver, and refusing when nothing applies it.

The pre-processing twin of ``tests/formats/test_registry.py`` and
``test_entry_points.py``: the group is reachable through ``importlib.metadata``
the way a third-party driver distribution would reach it, what comes out
satisfies the port, and the lookup on top refuses with a message that lists
what is installed.
"""

from __future__ import annotations

from importlib.metadata import entry_points

import pytest

from visionset.kernel.domain import AugmentOp, AugmentStep, ResizeStep, ResizeStrategy, Step
from visionset.kernel.errors import PreprocessingDriverNotFound
from visionset.kernel.ports import PreprocessingDriver
from visionset.preprocessing.pillow import PillowAugmentDriver, PillowResizeDriver
from visionset.preprocessing.registry import GROUP, driver, driver_for, drivers, pick


class _NotADriver:
    """Registered under the group by mistake: no ``step_kinds``, so the port drops it."""

    def apply(self, step: Step, image: bytes, *, seed: bytes, variant: int) -> bytes:
        return image


class _Crop:
    step_kinds = frozenset({"crop"})

    def apply(self, step: Step, image: bytes, *, seed: bytes, variant: int) -> bytes:
        return image


def test_both_built_in_drivers_are_declared_in_the_entry_point_group() -> None:
    names = {entry_point.name for entry_point in entry_points(group=GROUP)}

    assert names >= {"pillow-resize", "pillow-augment"}


def test_a_discovered_driver_satisfies_the_port() -> None:
    for entry_point in entry_points(group=GROUP):
        plugin = entry_point.load()()
        assert isinstance(plugin, PreprocessingDriver), entry_point.name


def test_discovery_keys_every_step_kind_to_the_driver_that_applies_it() -> None:
    installed = drivers()

    assert set(installed) == {"resize", "augment"}
    assert isinstance(installed["resize"], PillowResizeDriver)
    assert isinstance(installed["augment"], PillowAugmentDriver)


def test_discovery_drops_what_does_not_satisfy_the_port() -> None:
    assert not isinstance(_NotADriver(), PreprocessingDriver)


def test_driver_for_resolves_a_step_by_its_kind() -> None:
    installed = drivers()
    resize = ResizeStep(strategy=ResizeStrategy.STRETCH, width=32, height=32)
    augment = AugmentStep(op=AugmentOp.HFLIP)

    assert driver_for(installed, resize) is installed["resize"]
    assert driver_for(installed, augment) is installed["augment"]
    assert driver("resize") is not None


def test_a_kind_nothing_applies_is_refused_naming_what_is_installed() -> None:
    crop = _Crop()

    with pytest.raises(PreprocessingDriverNotFound) as caught:
        pick({"crop": crop}, "resize")

    assert "'resize'" in str(caught.value)
    assert "crop" in str(caught.value)
    assert caught.value.installed == ("crop",)


def test_the_refusal_with_nothing_installed_says_so() -> None:
    with pytest.raises(PreprocessingDriverNotFound) as caught:
        pick({}, "augment")

    assert "none" in str(caught.value)
    assert caught.value.installed == ()
