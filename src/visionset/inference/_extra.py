# usage: from visionset.inference._extra import require, imported
"""The one place that knows the optional runtime is optional.

Everything heavy in this package — torch, torchvision, transformers, accelerate,
huggingface_hub — arrives through here, and it arrives **inside a function**.
That is the exception ``python-setup`` sanctions ("to keep an optional
dependency optional") and it is load-bearing rather than tidy: ``visionset.jobs``
imports its handler modules at package import to populate the registry, and the
API process imports ``visionset.jobs`` in its lifespan. A module-level ``import
torch`` anywhere under this package would therefore make two gigabytes of CUDA
wheels a condition of starting the server, on a machine that may have no
intention of running a model at all.

``tests/architecture/test_optional_runtime.py`` holds that line from the other
side: it imports the whole product in a fresh interpreter and fails if any of
them is in ``sys.modules`` afterwards.

**The message is the remedy.** ``MediaToolUnavailable`` states the rule this
follows — an error that merely says "unavailable" has told an operator nothing —
so the refusal carries the exact command, and the command is spelled once, here,
because the kernel deliberately does not know what the extra is called.
"""

from __future__ import annotations

from importlib import import_module
from types import ModuleType
from typing import Final

from visionset.kernel.errors import LocalInferenceUnavailable

EXTRA: Final = "local-inference"
"""The canonical spelling. Not ``autolabel``, which it supersedes, and not
``local_inference``: an extra is named the way it is typed."""

INSTALL_COMMAND: Final = f'pip install "visionset[{EXTRA}]"'
"""What to run. Quoted, because a bare ``visionset[local-inference]`` is a glob
in every shell somebody is likely to be holding."""

MODULES: Final[tuple[str, ...]] = (
    "torch",
    "torchvision",
    "transformers",
    "accelerate",
    "huggingface_hub",
)
"""Everything the extra brings, named so one test can walk the whole set.

Declared here rather than only in ``pyproject.toml`` because the two say
different things: the metadata says what gets installed, and this says what the
base import graph must stay clear of.

``torchvision`` is the one nothing in this package ever imports by name.
It is here because ``transformers`` imports it for us — ``Sam2ImageProcessor``
refuses to construct without it — and because both jobs this tuple does still
want it: it is as heavy as the rest and must stay off the base import graph, and
:func:`require` refusing early for it is the difference between this package's
install command and a ``transformers`` ``ImportError`` naming a library the
caller never asked for.
"""


def imported(name: str) -> ModuleType:
    """Import one of the optional modules, or refuse in the kernel's vocabulary.

    A plain ``ImportError`` escaping this package would reach a route as a 500
    with no code and a traceback naming a library the caller never asked for.
    This is the same translation ``InferenceConnectionService._built`` does for
    pydantic, one layer out.

    Raises:
        LocalInferenceUnavailable: the module is not installed. The message
            carries :data:`INSTALL_COMMAND`.
    """
    try:
        return import_module(name)
    except ImportError as exc:
        raise LocalInferenceUnavailable(
            f"running a model locally needs the {EXTRA!r} extra, and {name!r} is not "
            f"installed here. Install it with: {INSTALL_COMMAND}"
        ) from exc


def require() -> None:
    """Refuse now if the runtime is absent, so nothing else has to check.

    Called by a surface *before* it commits to work — the route before it
    enqueues, the command before it opens anything — on ``export_release``'s
    rule that a refusal a request can make is a refusal the request makes.
    Discovering a missing install inside a worker would put an install command
    on a failed row somebody has to go and find.
    """
    for name in MODULES:
        imported(name)
