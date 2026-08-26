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
from visionset.kernel.errors import PreprocessingDriverNotFound
from visionset.kernel.ports import PreprocessingDriver

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

    Split from :func:`driver` so the refusal has one wording no matter who
    scanned the entry points. A caller holding the mapping must not index it
    directly: a ``KeyError`` is outside the ``VisionSetError`` tree and would
    answer 500 with no message to a request the installation cannot serve.

    Raises:
        PreprocessingDriverNotFound: no installed driver applies ``step_kind``.
    """
    if step_kind not in installed:
        known = tuple(sorted(installed))
        raise PreprocessingDriverNotFound(
            f"no pre-processing driver is installed for step kind {step_kind!r}; "
            f"installed step kinds: {', '.join(known) or 'none'}",
            installed=known,
        )
    return installed[step_kind]


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
