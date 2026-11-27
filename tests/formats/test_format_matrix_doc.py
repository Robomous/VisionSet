"""The format matrix in `docs/content/architecture/backend/formats.md` is generated, and stays so.

The `test_target_catalog_doc.py` argument: CI regenerates and diffs through
`scripts/check.sh generated`, and this repeats it where the mistake is made.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

from visionset.formats.matrix import is_built_in
from visionset.formats.registry import exporters, importers

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "export_format_matrix.py"


@pytest.fixture(scope="module")
def script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("export_format_matrix", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _shipped(script: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    built_in_exporters = {name: one for name, one in exporters().items() if is_built_in(one)}
    built_in_importers = {name: one for name, one in importers().items() if is_built_in(one)}
    monkeypatch.setattr(script, "exporters", lambda: built_in_exporters)
    monkeypatch.setattr(script, "importers", lambda: built_in_importers)


def test_the_committed_table_matches_the_installed_formats(
    script: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    _shipped(script, monkeypatch)
    _, current, _ = script._split(script.DOCUMENT_PATH.read_text(encoding="utf-8"))
    assert current == script.render()


def test_every_installed_plugin_has_a_row_per_direction(script: ModuleType) -> None:
    rendered = script.render()
    for name in exporters():
        assert f"| `{name}`" in rendered and "| export |" in rendered, name
    rows = [line for line in rendered.splitlines() if line.startswith("| `")]
    assert len(rows) == len(exporters()) + len(importers())


def test_the_check_mode_reports_a_stale_table(
    script: ModuleType,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    stale = tmp_path / "formats.md"
    stale.write_text(f"before\n{script.BEGIN}\n| old |\n{script.END}\nafter\n", encoding="utf-8")
    monkeypatch.setattr(script, "DOCUMENT_PATH", stale)
    monkeypatch.setattr(script, "REPO_ROOT", tmp_path)

    assert script.main(["--check"]) == 1
    assert "stale" in capsys.readouterr().err

    assert script.main([]) == 0
    assert script.main(["--check"]) == 0
    written = stale.read_text(encoding="utf-8")
    assert written.startswith("before\n") and written.endswith("\nafter\n")
