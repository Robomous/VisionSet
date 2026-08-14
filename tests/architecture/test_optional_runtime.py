"""The optional runtime stays optional, proved in a fresh interpreter.

`pyproject.toml` puts torch, torchvision, transformers, accelerate and
huggingface_hub in the `local-inference` extra, and `visionset/inference/_extra.py`
reaches every one of them from inside a function — torchvision by never naming it
at all, since it is `transformers` that imports it. Neither of those is
self-enforcing: a single module-level `import torch` anywhere under
`visionset.inference` would leave the metadata unchanged and make roughly two
gigabytes of CUDA wheels a condition of starting the server.

It is a condition of *starting* rather than of running a model because
`visionset.jobs` imports its handler modules at package import to populate the
registry, and the API process imports `visionset.jobs` in its lifespan — so the
download handler is on the startup path of every deployment, including the ones
that will never predict anything.

A subprocess, on `test_kernel_purity.py`'s terms: `sys.modules` in *this*
interpreter has already been filled by the rest of the suite, so the only honest
place to ask "what did importing this load?" is an interpreter that has imported
nothing else.

**And an environment where the five are installed, or this proves nothing.** Where
they are absent the assertion holds whatever the code does — a module-level
`import torch` would raise rather than register — so the run that gives this file
its meaning is CI's `inference-smoke` job, which installs the extra from the
lockfile and runs it there.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from visionset.inference import MODULES

#: Everything a deployment imports before it has done any work. The server's
#: application module, the job registry, and the inference package itself —
#: which is the one under test, and is imported here rather than assumed to be
#: pulled in by the other two.
_PROBE = """
import sys
import visionset
import visionset.server.main
import visionset.cli.main
import visionset.jobs
import visionset.inference
import visionset.inference.transformers_provider
import visionset.inference.weights

forbidden = {names}
loaded = forbidden & set(sys.modules)
assert not loaded, f"a base import pulled in the optional runtime: {{loaded}}"
"""


def test_a_base_install_imports_none_of_the_optional_runtime() -> None:
    result = subprocess.run(
        [sys.executable, "-c", _PROBE.format(names=set(MODULES))],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_importing_the_inference_package_asks_for_the_metal_cpu_fallback() -> None:
    """And does so *before* the array library could have been imported.

    ``PYTORCH_ENABLE_MPS_FALLBACK`` is read while torch initialises rather than
    when an unimplemented operator is reached, so setting it after a device has
    been resolved would be too late. The claim worth making is therefore about
    ordering, and the only interpreter that can answer it is one that has
    imported nothing else — in this one, the suite has already imported both.

    The probe deletes the variable first: a developer who exports it would
    otherwise be told the code sets it when nothing did.
    """
    probe = f"""
import os
import sys

os.environ.pop("PYTORCH_ENABLE_MPS_FALLBACK", None)
import visionset.inference

assert os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") == "1", "the fallback was not asked for"
loaded = {set(MODULES)} & set(sys.modules)
assert not loaded, f"the fallback was set after the runtime loaded: {{loaded}}"
"""
    result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_creating_the_application_loads_none_of_it_either() -> None:
    """Importing is not the whole of startup — `create_app()` runs too.

    A route module reaching for a provider at import, or a dependency resolving
    one eagerly, would not show up in the test above and would show up here.
    """
    probe = f"""
import sys
from visionset.server.main import create_app

app = create_app()
forbidden = {set(MODULES)}
loaded = forbidden & set(sys.modules)
assert not loaded, f"building the application pulled in the optional runtime: {{loaded}}"
"""
    result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_configuring_a_connection_loads_none_of_it_either(tmp_path: Path) -> None:
    """The kernel's connection service, driven for real in an interpreter of its own.

    "Creating a connection downloads nothing" is the boundary the inference slice
    exists to draw, and the honest form of it is transitive: not merely that the
    service names no runtime, but that nothing it reaches names one either. A
    caller does not stop at importing the module — it opens a workspace and
    writes a row — so the probe does that, and asks the question afterwards.

    **A fresh interpreter is not a stylistic choice here.** `sys.modules` is
    process-global, so in the suite's own process the answer is decided by
    whatever ran earlier: with the extra installed, the inference tests import the
    runtime legitimately, long before a test in `tests/kernel` could ask. Asked in
    a process that has imported nothing else, the same assertion answers about the
    code instead of about the collection order.
    """
    probe = f"""
import sys
from pathlib import Path

from visionset.kernel.domain import ConnectionType
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

workspace = WorkspaceService.init(Path({str(tmp_path / "ws")!r}), name="inference")
try:
    connections = InferenceConnectionService(workspace)
    made = connections.create(
        "local",
        connection_type=ConnectionType.LOCAL,
        model_id="some/model",
        model_revision="abc123",
        device="cpu",
        precision="fp32",
    )
    connections.get(made.id)
    connections.list()
finally:
    workspace.close()

forbidden = {set(MODULES)}
loaded = forbidden & set(sys.modules)
assert not loaded, f"configuring a connection pulled in the optional runtime: {{loaded}}"
"""
    result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_the_extra_is_declared_with_exactly_the_modules_the_guard_names() -> None:
    """The metadata and the guard say the same thing, or one of them is lying.

    `MODULES` is what the base import graph must stay clear of; the extra is what
    `pip install` puts there. A module in one and not the other is either a
    dependency nothing checks for or a check for something nobody installs.

    Compared on the *distribution* names normalised to their import names, which
    differ for exactly one of them — `huggingface-hub` installs
    `huggingface_hub`.
    """
    import tomllib

    metadata = tomllib.loads(
        (Path(__file__).resolve().parents[2] / "pyproject.toml").read_text(encoding="utf-8")
    )
    declared = metadata["project"]["optional-dependencies"]["local-inference"]
    names = {
        requirement.split(">")[0].split("=")[0].strip().replace("-", "_")
        for requirement in declared
    }
    assert names == set(MODULES)
