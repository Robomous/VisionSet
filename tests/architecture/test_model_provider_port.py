"""`ModelProvider` stays implementable somewhere other than here.

#418's acceptance criterion is a dual test: every element of the port's shape
must hold for a runner in this process **and** for a service across a network.
Most of that is a design argument and lives in the port's docstring. One part of
it is mechanical, and this file is that part.

**What the port imports is what a hosted adapter has to satisfy.** A signature
naming a `Path` says there is a filesystem in common; one naming a tensor says
there is an array library in common; one naming a `ProgressReporter` or a
`JobQueue` says the caller is organised a particular way. None of those survives
a network. So the rule is narrow and checkable: the port module may import the
kernel's own domain, and the standard library, and nothing else.

Read by parsing rather than by grepping. A previous test in this area matched its
own docstring — the word it was searching for was in the prose above the code —
and the lesson is that "does this module import X" is a question about the import
statements and not about the text.
"""

from __future__ import annotations

import ast
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import get_type_hints

import pytest

from visionset.kernel.domain import AssetPrediction, PredictionRequest
from visionset.kernel.ports import model_provider

PORT = Path(model_provider.__file__)

ALLOWED_PREFIX = "visionset.kernel.domain"
"""The one first-party package the port may name.

Not `visionset.kernel` at large: importing another *port* would be the coupling
this file exists to prevent — it is how a progress channel or a queue would get
into a signature — and importing a service would invert the direction the whole
architecture runs in.
"""


def imported_modules(source: Path) -> set[str]:
    """Every module name this file imports, from its syntax tree.

    `ast.Import` and `ast.ImportFrom` both, and `ast.walk` rather than a scan of
    the top level, so an import tucked inside a function is seen too.
    """
    tree = ast.parse(source.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


def test_the_port_imports_only_the_domain_and_the_standard_library() -> None:
    outside = {
        name
        for name in imported_modules(PORT)
        if name.split(".")[0] not in sys.stdlib_module_names and not name.startswith(ALLOWED_PREFIX)
    }
    assert outside == set()


def test_the_port_names_no_filesystem_device_or_process_type() -> None:
    """The three things a hosted adapter cannot have in common with this machine.

    A `Path` in a signature is a claim about a shared filesystem, and it is the
    claim the previous placeholder's `predict(asset, schema)` made implicitly by
    handing over an `Asset` and letting the provider find the bytes. The current
    shape carries the bytes instead, which is what makes the same call work in
    both places.
    """
    banned = {"pathlib", "os", "subprocess", "multiprocessing", "socket", "tempfile"}
    assert imported_modules(PORT) & banned == set()


@pytest.mark.parametrize("library", ["torch", "transformers", "numpy", "accelerate", "PIL"])
def test_the_port_names_no_array_or_model_library(library: str) -> None:
    """Machine-enforced by import-linter for the whole kernel, and asserted here
    at the one module where a signature could smuggle one in as a type."""
    assert not any(name.split(".")[0] == library for name in imported_modules(PORT))


def test_the_protocol_takes_a_request_and_yields_answers() -> None:
    """The two reshapings #418 asked for, asserted on the annotations.

    Per-batch rather than per-asset, so a hosted provider pays one round trip for
    a chunk instead of one per image; an iterator rather than a materialised
    sequence, so a slow provider has somewhere to be and a caller has somewhere
    to report progress from. A prose docstring can drift from either; this
    cannot.
    """
    signature = get_type_hints(model_provider.ModelProvider.predict)
    assert signature["request"] is PredictionRequest
    assert signature["return"] == Iterator[AssetPrediction]


def test_the_protocol_is_runtime_checkable() -> None:
    """So the composition root's product can be asserted against it on an
    instance — the check `formats/registry.py` already relies on."""
    assert getattr(model_provider.ModelProvider, "_is_runtime_protocol", False)
