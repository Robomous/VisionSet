"""The kernel boundary, enforced at runtime: importing the kernel in a fresh
process must not pull in any delivery framework."""

import ast
import subprocess
import sys
from pathlib import Path

import visionset.kernel.domain

_PROBE = """
import sys
import visionset.kernel
import visionset.kernel.domain
import visionset.kernel.ports
import visionset.kernel.adapters
import visionset.kernel.services
import visionset.kernel.error_codes
forbidden = {
    "fastapi",
    "typer",
    "mcp",
    "uvicorn",
    "visionset.formats",
    "visionset.preprocessing",
    "visionset.tracking",
    "mlflow",
}
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


#: Sources of randomness or pixels the kernel's domain never reaches. Every draw
#: a recipe makes is derived from a digest, so a global random source would make
#: a variant unreproducible; an imaging library belongs to the drivers.
_DOMAIN_FORBIDDEN_IMPORTS = frozenset({"random", "secrets", "numpy", "PIL"})

#: The one domain module that draws from the operating system's CSPRNG, on
#: purpose: an access token must be unguessable, never reproducible.
_DOMAIN_CSPRNG_EXCEPTIONS = {"token.py": frozenset({"secrets"})}


def _imported_roots(source: str) -> set[str]:
    roots: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    return roots


def test_the_kernel_domain_imports_no_random_source_and_no_imaging_library() -> None:
    domain = Path(visionset.kernel.domain.__file__).parent
    offenders = {
        path.name: sorted(found)
        for path in sorted(domain.rglob("*.py"))
        if (
            found := (_imported_roots(path.read_text(encoding="utf-8")) & _DOMAIN_FORBIDDEN_IMPORTS)
            - _DOMAIN_CSPRNG_EXCEPTIONS.get(path.name, frozenset())
        )
    }
    assert not offenders, f"kernel domain modules import a random source or pixels: {offenders}"


def test_the_import_scan_sees_every_spelling_of_an_import() -> None:
    spellings = "import random\nfrom numpy import array\nimport PIL.Image as Image\n"
    assert _imported_roots(spellings) == {"random", "numpy", "PIL"}
