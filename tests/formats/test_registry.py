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
from visionset.kernel.domain import Annotation, GeometryType, Manifest, Release
from visionset.kernel.errors import ExportFormatNotFound
from visionset.kernel.ports import ContentReader


class _AnImporter:
    """Satisfies ``Importer``, not ``Exporter`` — the shape the filter must drop."""

    format_name = "an-importer"

    def read(self, src: Path) -> Iterable[Annotation]:
        return []


class _AnExporter:
    format_name = "an-exporter"
    lossy = False

    #: The capability declaration. Everything, so this double's *subject* stays
    #: what it was — the file it writes, or the flag it sets — rather than a
    #: geometry report nobody wrote this test for.
    supported_geometries = frozenset(GeometryType)
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        return None


def test_the_shipped_dummy_exporter_is_discovered() -> None:
    assert "dummy" in exporters()


def test_a_discovered_exporter_declares_whether_it_is_lossy() -> None:
    """Discovery must return a plugin carrying every member of the port."""
    assert exporters()["dummy"].lossy is False


def test_exporters_are_keyed_by_what_they_call_themselves() -> None:
    """Not by their entry-point name: only one of the two is the caller's contract."""
    assert all(name == plugin.format_name for name, plugin in exporters().items())


def test_an_unknown_format_is_refused_by_name() -> None:
    # A name nothing will ever register — a test whose subject is "not installed"
    # has to name something that stays that way.
    with pytest.raises(ExportFormatNotFound) as refusal:
        exporter("not-a-format")

    assert "not-a-format" in str(refusal.value)


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

    A plugin declaring only ``format_name`` and ``export``
    it must fail the check rather than reach ``ReleaseService.export`` and raise
    ``AttributeError`` where the consent gate should have been.
    """
    from visionset.kernel.ports import Exporter

    class _Outdated:
        format_name = "outdated"

        def export(
            self,
            release: Release,
            manifest: Manifest,
            dest: Path,
            *,
            content: ContentReader,
        ) -> None:
            return None

    assert not isinstance(_Outdated(), Exporter)
