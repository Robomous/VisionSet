"""`docs/content/error-codes.md` is generated, and these hold it to what the code answers."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

from visionset.kernel.error_codes import ERROR_CODES

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "export_error_codes.py"


@pytest.fixture(scope="module")
def script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("export_error_codes", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_the_committed_reference_matches_the_tables(script: ModuleType) -> None:
    assert script.OUTPUT_PATH.read_text(encoding="utf-8") == script.render()


def test_every_code_has_a_row(script: ModuleType) -> None:
    written = script.OUTPUT_PATH.read_text(encoding="utf-8")
    for code in ERROR_CODES.values():
        assert f"| `{code}` |" in written, code


def test_the_gate_words_are_published_as_retry_with(script: ModuleType) -> None:
    rows = {
        line.split("|")[1].strip(" `"): line
        for line in script.render().splitlines()
        if line.startswith("| `")
    }
    assert "`allow_lossy`" in rows["LOSSY_EXPORT_NOT_CONSENTED"]
    assert "`confirm`" in rows["CONFIRMATION_REQUIRED"]
    assert rows["BATCH_NOT_FOUND"].rstrip().endswith("|  |")
