# usage: from visionset.formats.registry import exporter, exporters
"""Finding the exporter a caller named.

The kernel cannot do this. ``ReleaseService.export`` takes an ``Exporter``
instance because import-linter forbids ``visionset.kernel`` from importing
``visionset.formats`` at all — so resolving a *name* to an implementation is
work for whoever composed the call, and this module is where that work lives.
Every surface reaches it the same way and none of them keeps its own map.

Discovery is ``importlib.metadata`` over the ``visionset.formats`` entry-point
group, never a hardcoded dict and never an ``if fmt == "coco"`` chain. That is
the whole plugin promise: a third-party distribution registers into the same
group and is indistinguishable from a built-in here.

The group carries importers too — they satisfy a different port, with ``read``
and no ``export`` — so what comes out is filtered by the port itself rather than
by a naming convention. ``Exporter`` is ``@runtime_checkable``, which is what
makes that one line of filtering possible; note the check is ``isinstance`` on an
*instance*, because ``issubclass`` against a protocol with data members raises.

Nothing is cached. Entry points are read from installed metadata, so the cost is
one scan and the alternative is a process that has to be restarted after an
install.
"""

from __future__ import annotations

from collections.abc import Mapping
from importlib.metadata import entry_points

from visionset.kernel.errors import ExportFormatNotFound
from visionset.kernel.ports import Exporter


def exporters() -> dict[str, Exporter]:
    """Every installed exporter, keyed by its own ``format_name``.

    Keyed by what the plugin calls itself rather than by its entry-point name.
    Those are two different strings and only one of them is the contract: the
    entry-point name is packaging metadata a distribution picks, while
    ``format_name`` is what a caller types and what ends up in a URL. A plugin
    whose two names disagree is reachable under the one it declares.
    """
    found: dict[str, Exporter] = {}
    for entry_point in entry_points(group="visionset.formats"):
        plugin = entry_point.load()()
        if isinstance(plugin, Exporter):
            found[plugin.format_name] = plugin
    return found


def pick(installed: Mapping[str, Exporter], format_name: str) -> Exporter:
    """One exporter out of a set already in hand, or say it is not there.

    Split from :func:`exporter` so the refusal has one wording no matter who
    scanned the entry points. A caller holding the mapping — the HTTP surface
    reaches it through a dependency, so that a test can substitute one — must not
    index it directly: a ``KeyError`` is outside the ``VisionSetError`` tree and
    would answer 500 to a caller who simply mistyped a format name.

    Raises:
        ExportFormatNotFound: nothing is installed under that name.
    """
    if format_name not in installed:
        known = ", ".join(sorted(installed)) or "none"
        raise ExportFormatNotFound(
            f"no exporter is installed for format {format_name!r}; installed formats: {known}"
        )
    return installed[format_name]


def exporter(format_name: str) -> Exporter:
    """The installed exporter registered under that name.

    Raises:
        ExportFormatNotFound: nothing is installed under it.
    """
    return pick(exporters(), format_name)
