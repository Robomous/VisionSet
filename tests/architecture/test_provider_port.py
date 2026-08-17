"""The provider ports: a plugin contract, held to a plugin contract's rules.

The sibling of `test_model_provider_port.py`, and deliberately not an extension of
it. That file sweeps the two ports a model is *asked through*, and bans a
filesystem type from their signatures because a `Path` there would be a claim
about a disk shared with whatever answers — which is exactly what a hosted adapter
cannot have.

Nothing here crosses a network. A `Provider` is discovered, described and asked to
build in this process, and what it builds is where the network question starts. So
these are `Exporter`'s shape: a local plugin the composition root holds, naming a
`Path` as freely as `Exporter.export` names its `dest`, and absent from that
file's `PORTS` list for the same reason `Exporter` is.

What replaces the banned-import rule is the rule that actually binds a plugin
contract: it must be **describable without the optional runtime**. A base install
starts a server and a worker with no model library present and still has to list
what is installed, so a port that named an array library — or an implementation
that imported one to answer its own name — would break the listing rather than the
prediction, in a place nothing else in the suite looks.
"""

from __future__ import annotations

import ast
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import get_type_hints

import pytest

from visionset.kernel.domain import CuratedModel, DownloadSize, ModelCapability
from visionset.kernel.ports import Provider, Runner, WeightsSource, model_provider, point_segmenter
from visionset.kernel.ports import provider as provider_port

PORT = Path(provider_port.__file__)

ALLOWED_PREFIXES = ("visionset.kernel.domain", "visionset.kernel.ports")
"""What this port may name.

Wider than the model ports' single prefix by exactly one entry, and the entry is
the point: `Provider.build` returns a union of the two runner ports, so it must
name them. That is a dependency in the safe direction — the thing that *builds* a
runner knowing what a runner is — rather than the coupling the other file
prevents, which is a runner learning how its caller is organised.
"""


def imported_modules(source: Path) -> set[str]:
    """Every module name this file imports, from its syntax tree.

    Parsed rather than grepped, on the other file's lesson: a previous test in
    this area matched a word in its own prose, because "does this module import X"
    is a question about import statements and not about text.
    """
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
    """A provider must be able to describe itself on a base install.

    Discovery reads `provider_id`, `families` and `curated` before anything is
    loaded, so a contract that put an array type in one of those declarations
    would make listing the installed providers require the optional runtime — and
    the failure would land on a screen that has nothing to do with predicting.
    """
    assert not any(name.split(".")[0] == library for name in imported_modules(PORT))


def test_this_port_is_not_swept_as_a_model_port() -> None:
    """The divergence, asserted rather than left to a reader of two files.

    If `provider.py` ever joins that file's `PORTS`, its `Path` makes the
    filesystem check fail — and the tempting repair is to widen the ban's
    exception list, which would quietly stop protecting `ModelProvider`. Naming
    the split here means the next person meets the reasoning instead of the
    failure.
    """
    from tests.architecture import test_model_provider_port as model_ports

    assert set(model_ports.PORTS) == {"model_provider", "point_segmenter"}
    assert PORT not in set(model_ports.PORTS.values())


def test_a_provider_declares_families_as_a_closed_capability_mapping() -> None:
    """The derivation guarantee, asserted on the annotation.

    A `frozenset[str]` here would let a driver ship a family with no capability
    behind it — a model that runs while being invisible to every client filtering
    on what a connection can be asked. The mapping is what makes the adapter and
    the declaration one edit, and prose saying so can drift from the type.
    """
    assert get_type_hints(Provider)["families"] == Mapping[str, ModelCapability]


def test_a_provider_offers_curated_entries_as_an_immutable_sequence() -> None:
    assert get_type_hints(Provider)["curated"] == tuple[CuratedModel, ...]


def test_building_answers_with_either_runner_port() -> None:
    """`build` returns the union, so a segmenter and a detector need no second port."""
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
    """So discovery can check what it built, on an instance.

    `issubclass` against a protocol carrying data members raises, which is why
    this is the only check available and why the formats registry filters its
    shared group the same way.
    """
    assert getattr(protocol, "_is_runtime_protocol", False)


def test_a_hosted_driver_is_a_provider_and_is_not_a_weights_source() -> None:
    """The discrimination the whole two-protocol split exists for.

    This is the check the registry will make to decide whether a driver can be
    asked to price or fetch anything. If `isinstance` answered `True` for both, a
    hosted provider would be asked to download weights it has no concept of — and
    the split would be documentation rather than a mechanism.
    """

    class Hosted:
        provider_id = "test-hosted"
        families: Mapping[str, ModelCapability] = {"remote": ModelCapability.TEXT_DETECT}
        curated: tuple[CuratedModel, ...] = ()

        def build(self, connection: object, *, workspace_root: Path) -> object:
            raise NotImplementedError

    hosted = Hosted()
    assert isinstance(hosted, Provider)
    assert not isinstance(hosted, WeightsSource)


def test_a_local_driver_satisfies_both() -> None:
    """The positive half, so the absence above is a discrimination and not a bug.

    Without it, a `Provider` protocol that nothing could ever satisfy would make
    the previous test pass on its second assertion for the wrong reason.
    """

    class Local:
        provider_id = "test-local"
        families: Mapping[str, ModelCapability] = {"sam2": ModelCapability.POINT_SUGGEST}
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
