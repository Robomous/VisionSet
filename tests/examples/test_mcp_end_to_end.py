"""The MCP end-to-end example, run as a smoke test.

M3's exit criterion turned into a regression guard for the leg an agent uses. The
`tests/mcp/` suite drives the protocol over a paired in-memory stream, which
proves the thirty-three tools; this proves the **transport** — that
`visionset mcp` spawns, that stdout carries JSON-RPC and nothing else, and that
the workspace reaches the server through the environment the command sets.
Before this existed, `tests/cli/test_mcp_command.py` mocked `subprocess.run`, so
no protocol byte had ever crossed that command.

The assertion worth the file is the coordinate one. An agent measures on a
preview and submits in the asset's own pixels, and getting that wrong produces
annotations that are individually plausible and uniformly wrong. So the example
does the multiplication and this asserts it had to.

The example is not part of the ``visionset`` package, so it is loaded from its
path rather than imported by name.
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "mcp_end_to_end.py"


@pytest.fixture(scope="module")
def example() -> Iterator[ModuleType]:
    spec = importlib.util.spec_from_file_location("mcp_end_to_end", EXAMPLE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered while it executes so dataclasses can resolve the module by
    # name; removed afterwards so the test leaves sys.modules as found.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        del sys.modules[spec.name]


@pytest.fixture(scope="module")
def summary(example: ModuleType, tmp_path_factory: pytest.TempPathFactory) -> Any:
    # Asserted, never skipped: the console script is the server this example
    # speaks to, and a silently skipped transport test looks like a passing one.
    assert shutil.which("visionset") is not None, "the visionset console script is not installed"
    return example.main(tmp_path_factory.mktemp("workspace") / "mcp-e2e")


def test_the_server_was_reached_over_a_real_pipe(summary: Any) -> None:
    """`visionset mcp` spawned, handed over the workspace, and listed its tools.

    Thirty-three: #35's thirty, plus `preview_schema_change`, `backfill_thumbnails`
    and #65's `check_export` — and *not* `delete_project`, which #108 moved out of
    the default listing. The example starts the server the way a client does, with
    no `--allow-destructive`, so what it counts is what an agent is offered.

    Asserting it exactly is deliberate: a tool that silently fails to register is
    logged and discarded by FastMCP rather than raised, so a count is the only
    thing that notices.
    """
    assert summary.tool_count == 33
    assert summary.project_id
    assert summary.schema_version == 1


def test_the_agent_measured_on_a_smaller_frame_than_it_labelled_in(summary: Any) -> None:
    """The finding that carries the milestone's AI-first claim.

    A 640x480 asset previews at 256 on its long edge — 256x192 — so the frame an
    agent sees is 2.5x smaller than the one its coordinates live in. If a future
    change made the preview full size, `scale` would be 1 and this example would
    stop demonstrating anything; that is what the strict inequality guards.
    """
    assert summary.native_size == (640, 480)
    assert summary.preview_size == (256, 192)
    assert summary.scale == pytest.approx(640 / summary.preview_size[0])
    assert summary.scale == pytest.approx(2.5)
    assert summary.scale > 1


def test_the_release_holds_what_was_annotated_and_verifies(summary: Any) -> None:
    """Two of four assets promoted, both labelled, and every blob still present."""
    assert summary.annotation_count == 2
    assert summary.promoted == 2
    assert summary.job_count == 2
    assert summary.verified is True
    assert summary.release_tag == "v1.0"
    assert len(summary.asset_ids) == 4


def test_a_declared_class_nobody_used_is_absent_from_the_statistics(summary: Any) -> None:
    """Which classes exist is the schema's answer; stats report what was labelled."""
    assert summary.stats_classes == ("sign",)


def test_the_export_wrote_where_it_was_told(summary: Any) -> None:
    """`export_release` takes a local path — an agent runs beside the filesystem."""
    assert summary.formats == ("coco", "dummy", "voc", "yolo")
    assert Path(summary.export_directory).is_dir()


def test_a_domain_refusal_arrives_as_a_result_and_names_no_retry(summary: Any) -> None:
    """The two-failure-shape rule, and the reason `retry_with` replaced a code.

    Reusing a tag is refused because a release is immutable — there is no flag
    that makes it work, so `retry_with` is null rather than absent. A client
    branching on a status alone would retry this forever.
    """
    assert summary.republish_retry_with is None
