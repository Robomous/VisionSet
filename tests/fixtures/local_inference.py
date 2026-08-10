# usage: from tests.fixtures.local_inference import require_local_inference, without_the_extra
"""Which half of the inference matrix this environment can run, decided once.

`visionset.inference` is written so that a base install is a working install: it
can create a local connection, list it, and be told exactly what to install
instead of raising an `ImportError` from a library the caller never named. Both
sides of that are tested — the refusals a machine without the runtime gives, and
the code that only exists when the runtime is there — so every such test needs to
know which environment it is in. That predicate lives here rather than in each
module that asks, because five of them used to spell it out and a sixth would
have spelled it slightly differently.

CI runs the two halves as two jobs. The `python` job installs the base
distribution deliberately, which is what makes the without-runtime tests real
there; `inference-smoke` installs the extra from the lock and sets
`VISIONSET_REQUIRE_LOCAL_INFERENCE=1`.

**What the variable does is turn a missing runtime from a skip into an error**,
the rule `VISIONSET_REQUIRE_FFMPEG` states for the video suite: a job that exists
to exercise the runtime and quietly exercised nothing looks exactly like a
passing one. It says nothing about a missing *GPU*, which is a separate and
permanent fact about a CI runner — see `require_local_inference`.
"""

from __future__ import annotations

import importlib.util
import os
from typing import Final

import pytest

from visionset.inference import INSTALL_COMMAND, MODULES

EXTRA_REQUIRED_ENV: Final = "VISIONSET_REQUIRE_LOCAL_INFERENCE"

EXTRA_MISSING_HINT: Final = (
    "the local-inference runtime is not installed here. Install it to run VisionSet's "
    "with-runtime tests: `uv sync --extra local-inference` in this repository, or "
    f"`{INSTALL_COMMAND}` against an installed distribution."
)

EXTRA_INSTALLED: Final[bool] = all(importlib.util.find_spec(name) is not None for name in MODULES)
"""Whether all five modules of the extra import here.

`find_spec` rather than an import: this is read at collection, and importing
torch to find out whether torch is installed would put two gigabytes on the
startup path of every test run that does not need it.
"""

without_the_extra: Final = pytest.mark.skipif(
    EXTRA_INSTALLED, reason="the local runtime is installed here"
)
"""For a test whose subject is the *refusal* a base install gives.

Never an error under `EXTRA_REQUIRED_ENV`, and that is the whole asymmetry:
these tests are the `python` job's, and their skipping in `inference-smoke` is
the job doing its job. A contributor who installs the extra must not get a red
suite for having it either.
"""


def require_local_inference() -> None:
    """Skip locally, fail where the runtime was supposed to be installed.

    `tests.fixtures.media.require_ffmpeg`, called from inside a test rather than
    at module level: the modules holding these tests hold the without-runtime
    half too, and a module-level skip would take the tests the `python` job
    exists to run along with them.

    **Missing runtime, not missing GPU.** A CI runner has no CUDA device and
    never will, so a test that needs one keeps skipping honestly under this
    variable — it asks for the runtime through this function and for the device
    separately, afterwards. A single condition covering both would make the job
    permanently red for the one reason nobody can fix.
    """
    if EXTRA_INSTALLED:
        return
    if os.environ.get(EXTRA_REQUIRED_ENV) == "1":
        raise RuntimeError(
            f"{EXTRA_MISSING_HINT} "
            f"({EXTRA_REQUIRED_ENV}=1 is set, so a missing runtime is an error, not a skip.)"
        )
    pytest.skip(EXTRA_MISSING_HINT)
