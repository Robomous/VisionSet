"""Prove the plugin surface: exporters are discoverable through importlib.metadata,
exactly the way a third-party `visionset-format-x` distribution would plug in."""

from importlib.metadata import entry_points

from visionset.kernel.ports import Exporter


def test_dummy_exporter_is_discoverable_via_entry_points() -> None:
    eps = entry_points(group="visionset.formats")
    names = {ep.name for ep in eps}
    assert "dummy" in names, f"expected 'dummy' in visionset.formats entry points, got {names}"


def test_discovered_exporter_satisfies_the_port() -> None:
    (ep,) = [ep for ep in entry_points(group="visionset.formats") if ep.name == "dummy"]
    exporter_cls = ep.load()
    exporter = exporter_cls()
    assert isinstance(exporter, Exporter)
    assert exporter.format_name == "dummy"
