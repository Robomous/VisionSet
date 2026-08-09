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
"""

from __future__ import annotations

import subprocess
import sys

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
    from pathlib import Path

    metadata = tomllib.loads(
        (Path(__file__).resolve().parents[2] / "pyproject.toml").read_text(encoding="utf-8")
    )
    declared = metadata["project"]["optional-dependencies"]["local-inference"]
    names = {
        requirement.split(">")[0].split("=")[0].strip().replace("-", "_")
        for requirement in declared
    }
    assert names == set(MODULES)
