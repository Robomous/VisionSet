"""The export-target table in `docs/content/releases.md` is generated, and this keeps it so.

The `tests/mcp/test_tool_reference.py` argument: the CI step that regenerates
and diffs is the gate, and duplicating it as a test is deliberate, because the
mistake is made during `uv run pytest` and that is where it should surface.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

from visionset.formats.registry import exporters

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "export_target_catalog.py"


@pytest.fixture(scope="module")
def script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("export_target_catalog", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_the_committed_table_matches_the_installed_catalog(script: ModuleType) -> None:
    document = script.DOCUMENT_PATH.read_text(encoding="utf-8")
    _, current, _ = script._split(document)
    assert current == script.render()


def test_every_installed_target_has_a_row(script: ModuleType) -> None:
    rendered = script.render()
    for exporter in exporters().values():
        for target in exporter.targets:
            assert f"| `{target.name}` |" in rendered, target.name


def test_the_check_mode_reports_a_stale_table(
    script: ModuleType,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    stale = tmp_path / "releases.md"
    stale.write_text(f"before\n{script.BEGIN}\n| old |\n{script.END}\nafter\n", encoding="utf-8")
    monkeypatch.setattr(script, "DOCUMENT_PATH", stale)
    monkeypatch.setattr(script, "REPO_ROOT", tmp_path)

    assert script.main(["--check"]) == 1
    assert "stale" in capsys.readouterr().err

    assert script.main([]) == 0
    assert script.main(["--check"]) == 0
    written = stale.read_text(encoding="utf-8")
    assert written.startswith("before\n") and written.endswith("\nafter\n")
