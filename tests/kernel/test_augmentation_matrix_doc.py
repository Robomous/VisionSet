"""The augmentation table in `docs/content/preprocessing.md` is generated, and stays so.

The `test_target_catalog_doc.py` argument: CI regenerates and diffs through
`scripts/check.sh generated`, and this repeats it where the mistake is made.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

from visionset.kernel.domain import LabelKind

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "export_augmentation_matrix.py"


@pytest.fixture(scope="module")
def script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("export_augmentation_matrix", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_the_committed_table_matches_the_resolver(script: ModuleType) -> None:
    _, current, _ = script._split(script.DOCUMENT_PATH.read_text(encoding="utf-8"))
    assert current == script.render()


def test_every_kind_is_a_row_gated_ones_included(script: ModuleType) -> None:
    lines = script.render().splitlines()
    rows = [line for line in lines[3:] if line.startswith("| ")]
    assert len(rows) == len(LabelKind)
    assert any(row.startswith("| text (gated)") for row in rows)
