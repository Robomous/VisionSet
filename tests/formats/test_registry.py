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

from visionset.formats._targets import self_target
from visionset.formats.registry import exporter, exporters, pick
from visionset.kernel.domain import (
    Annotation,
    GeometryType,
    Manifest,
    Release,
    TargetFamily,
    Task,
)
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
    targets = self_target(format_name, supported_geometries)

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


def test_a_discovered_exporter_declares_its_targets() -> None:
    (target,) = exporters()["dummy"].targets

    assert target.name == "dummy"
    assert target.tasks == frozenset()


#: Every YOLO trainer this build addresses, with the tasks each accepts. The
#: catalog table in `docs/content/releases.md` is generated from the same
#: declarations, so a dropped or narrowed target would only ever show up
#: there as a diff nobody reads; this is the assertion that fails instead.
YOLO_TARGETS = {
    "yolo26": {
        Task.DETECT,
        Task.SEGMENT,
        Task.SEMANTIC,
        Task.DEPTH,
        Task.CLASSIFY,
        Task.POSE,
        Task.OBB,
    },
    "yolo12": {Task.DETECT, Task.SEGMENT, Task.CLASSIFY, Task.POSE, Task.OBB},
    "yolo11": {Task.DETECT, Task.SEGMENT, Task.CLASSIFY, Task.POSE, Task.OBB},
    "yolov10": {Task.DETECT},
    "yolov9": {Task.DETECT, Task.SEGMENT},
    "yolov8": {Task.DETECT, Task.SEGMENT, Task.CLASSIFY, Task.POSE, Task.OBB},
    "yolov7": {Task.DETECT},
    "yolov6": {Task.DETECT},
    "yolov5": {Task.DETECT, Task.SEGMENT, Task.CLASSIFY},
    "yolov3": {Task.DETECT},
}


def test_the_yolo_targets_are_exactly_these_ten_with_these_tasks() -> None:
    declared = {
        target.name: set(target.tasks)
        for plugin in exporters().values()
        for target in plugin.targets
        if target.family is not TargetFamily.OTHER
    }

    assert declared == YOLO_TARGETS


def test_a_yolo_target_carries_a_geometry_for_each_task_the_dialect_lays_out() -> None:
    """``segment`` without polygons, or ``classify`` without tags, is a task no export can reach."""
    behind = {
        Task.DETECT: GeometryType.BBOX,
        Task.SEGMENT: GeometryType.POLYGON,
        Task.CLASSIFY: GeometryType.CLASSIFICATION_TAG,
    }
    for plugin in exporters().values():
        for target in plugin.targets:
            for task, geometry in behind.items():
                if task in target.tasks:
                    assert geometry in target.supported_geometries, (target.name, task)


def test_every_installed_exporter_stays_discovered() -> None:
    """Discovery filters on the port, so one missing member silently drops a
    plugin from every surface — this is what would say which one."""
    assert set(exporters()) >= {
        "dummy",
        "ultralytics",
        "yolov5-yaml",
        "coco",
        "voc",
        "classification",
        "tusimple",
        "curvelanes",
        "bdd100k-lane",
        "culane",
        "openlane-2d",
    }


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

    assert pick({"an-exporter": plugin}, "an-exporter") == (plugin, None)


def test_the_former_yolo_name_still_picks_ultralytics_and_says_it_is_an_alias() -> None:
    """One release of grace: the plugin, and the marker a surface turns into a warning."""
    installed = exporters()

    plugin, deprecated_alias = pick(installed, "yolo")

    assert plugin is installed["ultralytics"]
    assert deprecated_alias == "yolo"
    assert pick(installed, "ultralytics") == (plugin, None)


def test_an_alias_is_not_a_key_of_the_format_list() -> None:
    assert "yolo" not in exporters()


def test_the_alias_still_refuses_when_its_target_is_not_installed() -> None:
    with pytest.raises(ExportFormatNotFound, match="'yolo'"):
        pick({"an-exporter": _AnExporter()}, "yolo")


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


def test_a_plugin_missing_the_targets_member_is_not_an_exporter() -> None:
    """An exporter with no target would be a format no target control can reach.

    Unlike ``_Outdated`` above, this plugin carries every *other* member of the
    port, so what fails the check is ``targets`` alone.
    """
    from visionset.kernel.ports import Exporter

    class _Targetless:
        format_name = "targetless"
        lossy = False
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

    assert not isinstance(_Targetless(), Exporter)
