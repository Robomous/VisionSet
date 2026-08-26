"""The environment this process runs in can read VisionSet's own distribution metadata.

Not a statement about the wheel — `test_wheel.py` already proves the built artifact
*declares* its entry points, and it passed throughout the defect this module exists
for. Nor a statement about the repository's own venv, where the project is installed
and every such assertion is true by construction.

This is a statement about **the environment the server is actually started in**, and
it is meaningful only when run there. `[project.entry-points."visionset.formats"]`
and the distribution version live in the same `.dist-info` directory, so an
environment that reaches `visionset` by `sys.path` alone — importable, but not
installed — has neither. Format discovery then finds nothing and answers an honest
empty list, and `visionset.__version__` falls back to its not-installed sentinel.

That is one fact with two faces, which is why both are asserted here and in one
module: the dev image shipped with no `visionset` metadata at all, and the two
symptoms it produced (an empty Format combobox on the export dialog, and releases
stamped "VisionSet 0.0.0") looked like two unrelated bugs for exactly as long as
nobody checked that they had a single cause.

CI runs this module inside `docker/api.Dockerfile`'s image — see the `docker` job.
Running it only in the repository's venv is what left the gap.
"""

from importlib.metadata import entry_points

import visionset
from visionset.formats.registry import exporters

#: Registered in pyproject.toml and shipped with the distribution, so any
#: environment with VisionSet's metadata has all three. Deliberately not the whole
#: list: this asserts the plugin path works, not that the set never grows.
BUILT_IN_EXPORTERS = {"ultralytics", "yolov5-yaml", "coco", "voc"}


def test_the_built_in_exporters_are_discoverable_in_this_environment() -> None:
    """The entry-point group resolves where the server runs, not only in CI's venv."""
    names = {ep.name for ep in entry_points(group="visionset.formats")}
    missing = BUILT_IN_EXPORTERS - names
    assert not missing, (
        f"the {sorted(missing)} entry point(s) are not visible to this environment; "
        f"the visionset.formats group holds {sorted(names)}. VisionSet is importable "
        "here but its distribution metadata is not installed."
    )


def test_the_registry_resolves_the_built_in_exporters() -> None:
    """Past discovery: each plugin loads and satisfies the port it is keyed by.

    `exporters()` filters on `isinstance(plugin, Exporter)`, so a name in the group
    and a usable exporter are two different claims. This is the one the export
    dialog's list is built from.
    """
    installed = exporters()
    missing = BUILT_IN_EXPORTERS - set(installed)
    assert not missing, (
        f"the registry resolved no exporter for {sorted(missing)}; it found {sorted(installed)}"
    )


def test_the_distribution_resolves_its_own_version() -> None:
    """The other face of the same metadata, and the one a published release records.

    `ReleaseService.publish` stamps `__version__` into every release it writes, so
    an environment without metadata does not merely display "0.0.0" — it persists
    it, and no later fix rewrites a release that already carries it.
    """
    assert visionset.__version__ != "0.0.0", (
        "visionset.__version__ is the not-installed sentinel, so "
        "importlib.metadata cannot find this distribution"
    )
