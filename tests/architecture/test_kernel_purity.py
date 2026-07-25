"""The kernel boundary, enforced at runtime: importing the kernel in a fresh
process must not pull in any delivery framework."""

import subprocess
import sys

_PROBE = """
import sys
import visionset.kernel
import visionset.kernel.domain
import visionset.kernel.ports
import visionset.kernel.adapters
import visionset.kernel.services
forbidden = {"fastapi", "typer", "mcp", "uvicorn"}
loaded = forbidden & set(sys.modules)
assert not loaded, f"kernel import pulled in forbidden modules: {loaded}"
"""


def test_fresh_kernel_import_loads_no_frameworks() -> None:
    result = subprocess.run(
        [sys.executable, "-c", _PROBE],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
