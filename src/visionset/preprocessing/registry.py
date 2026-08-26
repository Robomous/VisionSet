# usage: from visionset.preprocessing.registry import driver, drivers, driver_for
"""Finding the driver that applies a recipe step.

``visionset.formats.registry``'s shape, one port over. The kernel takes
``PreprocessingDriver`` instances because import-linter forbids it from
importing this package, so resolving a step *kind* to an implementation is
work for whoever composed the call, and every surface reaches it here rather
than keeping its own map.

Discovery is ``importlib.metadata`` over the ``visionset.preprocessing``
entry-point group, never a hardcoded dict: a third-party distribution registers
into the same group and is indistinguishable from a built-in. What comes out
is filtered by the port itself — ``isinstance`` on an instance, because
``PreprocessingDriver`` is a ``@runtime_checkable`` protocol with a data
member — and keyed by every step kind the driver declares.

Nothing is cached. Entry points are read from installed metadata, so the cost
is one scan and the alternative is a process that must be restarted after an
install.
"""

from __future__ import annotations

from collections.abc import Mapping
from importlib.metadata import entry_points

from visionset.kernel.domain import Step
from visionset.kernel.ports import PreprocessingDriver
from visionset.kernel.ports import driver_for as kernel_driver_for

GROUP = "visionset.preprocessing"


def drivers() -> dict[str, PreprocessingDriver]:
    """Every installed driver, keyed by each step kind it applies.

    A driver declaring two kinds appears under both. Two drivers claiming one
    kind resolve to whichever the scan met last, as two exporters sharing a
    ``format_name`` do; the built-in pair claims one kind each.
    """
    found: dict[str, PreprocessingDriver] = {}
    for entry_point in entry_points(group=GROUP):
        plugin = entry_point.load()()
        if isinstance(plugin, PreprocessingDriver):
            for kind in plugin.step_kinds:
                found[kind] = plugin
    return found


def pick(installed: Mapping[str, PreprocessingDriver], step_kind: str) -> PreprocessingDriver:
    """One driver out of a set already in hand, or say none applies that kind.

    The kernel's own :func:`~visionset.kernel.ports.driver_for`, under the
    name the format registry uses for the same gesture, so the refusal has one
    wording whether the export seam or a surface asked.

    Raises:
        PreprocessingDriverNotFound: no installed driver applies ``step_kind``.
    """
    return kernel_driver_for(installed, step_kind)


def driver_for(installed: Mapping[str, PreprocessingDriver], step: Step) -> PreprocessingDriver:
    """The driver that applies this step, out of a set already in hand.

    Raises:
        PreprocessingDriverNotFound: no installed driver applies the step's kind.
    """
    return pick(installed, step.kind)


def driver(step_kind: str) -> PreprocessingDriver:
    """The installed driver for that step kind.

    Raises:
        PreprocessingDriverNotFound: no installed driver applies it.
    """
    return pick(drivers(), step_kind)
