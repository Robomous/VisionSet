"""Prove the plugin surface: exporters are discoverable through importlib.metadata,
exactly the way a third-party `visionset-format-x` distribution would plug in."""

from importlib.metadata import EntryPoint, entry_points

from visionset.kernel.ports import Exporter


def _by_distribution(name: str) -> dict[str, EntryPoint]:
    return {
        ep.name: ep
        for ep in entry_points(group="visionset.formats")
        if ep.dist is not None and ep.dist.name == name
    }


def test_the_installed_distribution_registers_its_own_exporters_and_not_dummy() -> None:
    names = set(_by_distribution("visionset"))
    assert {"coco", "ultralytics"} <= names, names
    assert "dummy" not in names


def test_discovered_exporter_satisfies_the_port() -> None:
    exporter = _by_distribution("visionset")["coco"].load()()
    assert isinstance(exporter, Exporter)
    assert exporter.format_name == "coco"


def test_dummy_comes_from_the_test_only_distribution() -> None:
    exporter = _by_distribution("visionset-test-formats")["dummy"].load()()
    assert isinstance(exporter, Exporter)
    assert {target.name for target in exporter.targets} == {"dummy"}
