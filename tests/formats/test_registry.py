"""Turning a format name into a plugin, and refusing when there is no plugin.

The sibling of `test_entry_points.py`: that one asserts the group is reachable
and that what comes out satisfies the port, this one asserts the lookup built on
top of it behaves — including the filter that keeps importers out, which is the
part a reader would not expect a registry to need.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import pytest

from visionset.formats.registry import exporter, exporters, pick
from visionset.kernel.domain import Annotation, Manifest, Release
from visionset.kernel.errors import ExportFormatNotFound


class _AnImporter:
    """Satisfies ``Importer``, not ``Exporter`` — the shape the filter must drop."""

    format_name = "an-importer"

    def read(self, src: Path) -> Iterable[Annotation]:
        return []


class _AnExporter:
    format_name = "an-exporter"
    lossy = False

    def export(self, release: Release, manifest: Manifest, dest: Path) -> None:
        return None


def test_the_shipped_dummy_exporter_is_discovered() -> None:
    assert "dummy" in exporters()


def test_a_discovered_exporter_declares_whether_it_is_lossy() -> None:
    """The port widened in #30, so what discovery returns must carry the new member."""
    assert exporters()["dummy"].lossy is False


def test_exporters_are_keyed_by_what_they_call_themselves() -> None:
    """Not by their entry-point name: only one of the two is the caller's contract."""
    assert all(name == plugin.format_name for name, plugin in exporters().items())


def test_an_unknown_format_is_refused_by_name() -> None:
    with pytest.raises(ExportFormatNotFound) as refusal:
        exporter("coco")

    assert "coco" in str(refusal.value)


def test_the_refusal_lists_what_is_actually_installed() -> None:
    """So a caller who mistyped a name can see the one they meant."""
    with pytest.raises(ExportFormatNotFound) as refusal:
        pick({"writing": _AnExporter()}, "writting")

    assert "writing" in str(refusal.value)


def test_the_refusal_says_none_rather_than_nothing_when_none_are_installed() -> None:
    with pytest.raises(ExportFormatNotFound) as refusal:
        pick({}, "anything")

    assert "none" in str(refusal.value)


def test_picking_returns_the_instance_it_was_given() -> None:
    plugin = _AnExporter()

    assert pick({"an-exporter": plugin}, "an-exporter") is plugin


def test_an_importer_is_not_an_exporter() -> None:
    """The group carries both ports, and only one of them can be exported to.

    Asserted against the port directly rather than through ``exporters()``,
    because nothing registers an importer today — this is what would keep the
    filter honest on the day something does.
    """
    from visionset.kernel.ports import Exporter

    assert not isinstance(_AnImporter(), Exporter)
    assert isinstance(_AnExporter(), Exporter)


def test_a_plugin_missing_the_lossy_member_is_not_an_exporter() -> None:
    """The port's newest member is load-bearing, not decoration.

    A pre-#30 plugin declares ``format_name`` and ``export`` and nothing else;
    it must fail the check rather than reach ``ReleaseService.export`` and raise
    ``AttributeError`` where the consent gate should have been.
    """
    from visionset.kernel.ports import Exporter

    class _Outdated:
        format_name = "outdated"

        def export(self, release: Release, manifest: Manifest, dest: Path) -> None:
            return None

    assert not isinstance(_Outdated(), Exporter)
