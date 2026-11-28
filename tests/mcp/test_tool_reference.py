"""Check completeness, gating and determinism of the MCP tool reference."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "export_mcp_tools.py"


@pytest.fixture(scope="module")
def script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("export_mcp_tools", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_every_advertised_tool_is_in_it(script: ModuleType) -> None:
    from visionset.mcp.main import DESTRUCTIVE_TOOLS, TOOLS

    written = script.OUTPUT_PATH.read_text(encoding="utf-8")
    for tool, _hints in TOOLS + DESTRUCTIVE_TOOLS:
        assert f"`{tool.__name__}`" in written, tool.__name__


def test_the_destructive_ones_are_marked_rather_than_omitted(script: ModuleType) -> None:
    """A reference that left them out would document something nobody runs.

    They exist, they work, and somebody starting the server with
    `--allow-destructive` needs to read about them — what the reference has to be
    clear about is that they are *not* in the default listing.
    """
    written = script.OUTPUT_PATH.read_text(encoding="utf-8")
    assert "## Offered only with `--allow-destructive`" in written
    assert "delete_project" in written.split("## Offered only")[1]
    assert "delete_project" not in written.split("## Offered only")[0]


def test_nothing_in_the_output_varies_between_runs(script: ModuleType) -> None:
    """No version, no timestamp — `generate_client.mjs`'s rule, for its reason.

    Anything that varies between two runs of an unchanged input fails the drift
    gate for a reason nobody chose.
    """
    assert script.render() == script.render()
    assert "0.0.1" not in script.BANNER
