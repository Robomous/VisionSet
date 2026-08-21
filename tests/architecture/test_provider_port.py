"""The provider ports: a plugin contract, held to a plugin contract's rules.

The sibling of `test_model_provider_port.py` and deliberately not an extension of
it. That file bans a filesystem type from the two ports a model is *asked
through*, because a `Path` there claims a disk shared with whatever answers across
a network. Nothing here crosses one, so these are `Exporter`'s shape and name a
`Path` as freely as `Exporter.export` names its `dest`.

What replaces that ban is the rule that actually binds a plugin contract: a
provider must be **describable without the optional runtime**, since a base
install has to list what is installed.
"""

from __future__ import annotations

import ast
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import get_type_hints

import pytest

from visionset.kernel.domain import (
    CuratedModel,
    DownloadSize,
    GeometryType,
    ModelCapability,
    ServedFamily,
)
from visionset.kernel.ports import Provider, Runner, WeightsSource, model_provider, point_segmenter
from visionset.kernel.ports import provider as provider_port

PORT = Path(provider_port.__file__)

ALLOWED_PREFIXES = ("visionset.kernel.domain", "visionset.kernel.ports")
"""Wider than the model ports' single prefix by one entry, and that is the point:
`Provider.build` returns a union of the two runner ports, so it must name them."""


def imported_modules(source: Path) -> set[str]:
    """Parsed rather than grepped: a previous test in this area matched a word in
    its own prose."""
    tree = ast.parse(source.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


def test_the_port_imports_only_the_domain_the_runner_ports_and_the_standard_library() -> None:
    outside = {
        name
        for name in imported_modules(PORT)
        if name.split(".")[0] not in sys.stdlib_module_names
        and not name.startswith(ALLOWED_PREFIXES)
    }
    assert outside == set()


@pytest.mark.parametrize("library", ["torch", "transformers", "numpy", "accelerate", "PIL"])
def test_the_port_names_no_array_or_model_library(library: str) -> None:
    """Discovery reads the declarations before anything loads, so an array type in
    one would make listing providers need the optional runtime."""
    assert not any(name.split(".")[0] == library for name in imported_modules(PORT))


def test_this_port_is_not_swept_as_a_model_port() -> None:
    """If `provider.py` joins that file's `PORTS`, its `Path` fails the filesystem
    check — and the tempting repair is widening the ban, which would quietly stop
    protecting `ModelProvider`."""
    from tests.architecture import test_model_provider_port as model_ports

    assert set(model_ports.PORTS) == {"model_provider", "point_segmenter"}
    assert PORT not in set(model_ports.PORTS.values())


def test_a_provider_declares_families_as_a_closed_capability_mapping() -> None:
    """A `frozenset[str]` here would let a driver ship a family with no capability
    or no shape behind it, and prose saying otherwise can drift from the type."""
    assert get_type_hints(Provider)["families"] == Mapping[str, ServedFamily]


def test_a_provider_offers_curated_entries_as_an_immutable_sequence() -> None:
    assert get_type_hints(Provider)["curated"] == tuple[CuratedModel, ...]


def test_building_answers_with_either_runner_port() -> None:
    returned = get_type_hints(Provider.build)["return"]
    assert returned is Runner
    assert set(Runner.__value__.__args__) == {
        model_provider.ModelProvider,
        point_segmenter.PointSegmenter,
    }


def test_pricing_answers_in_the_domain_and_not_in_a_number() -> None:
    """A bare `int` would lose the file count and the pair it was measured for."""
    assert get_type_hints(WeightsSource.price)["return"] is DownloadSize


@pytest.mark.parametrize("protocol", [Provider, WeightsSource], ids=["Provider", "WeightsSource"])
def test_the_protocol_is_runtime_checkable(protocol: type) -> None:
    """`issubclass` against a protocol with data members raises, so an instance
    check is the only one available."""
    assert getattr(protocol, "_is_runtime_protocol", False)


def test_a_hosted_driver_is_a_provider_and_is_not_a_weights_source() -> None:
    """The discrimination the two-protocol split exists for. If `isinstance`
    answered `True` for both, a hosted provider would be asked to download weights
    it has no concept of."""

    class Hosted:
        provider_id = "test-hosted"
        families: Mapping[str, ServedFamily] = {
            "remote": ServedFamily(
                capability=ModelCapability.TEXT_DETECT, produces=frozenset({GeometryType.BBOX})
            )
        }
        curated: tuple[CuratedModel, ...] = ()

        def build(self, connection: object, *, workspace_root: Path) -> object:
            raise NotImplementedError

    hosted = Hosted()
    assert isinstance(hosted, Provider)
    assert not isinstance(hosted, WeightsSource)


def test_a_local_driver_satisfies_both() -> None:
    """Without this, a `Provider` nothing could satisfy would make the absence
    above pass for the wrong reason."""

    class Local:
        provider_id = "test-local"
        families: Mapping[str, ServedFamily] = {
            "sam2": ServedFamily(
                capability=ModelCapability.POINT_SUGGEST,
                produces=frozenset({GeometryType.POLYGON, GeometryType.BBOX}),
            )
        }
        curated: tuple[CuratedModel, ...] = ()

        def build(self, connection: object, *, workspace_root: Path) -> object:
            raise NotImplementedError

        def price(self, model_id: str, model_revision: str) -> object:
            raise NotImplementedError

        def family_of(self, connection: object, *, cache_dir: Path) -> str:
            raise NotImplementedError

        def fetch(self, connection: object, *, into: Path, on_bytes: object = None) -> Path:
            raise NotImplementedError

    local = Local()
    assert isinstance(local, Provider)
    assert isinstance(local, WeightsSource)
