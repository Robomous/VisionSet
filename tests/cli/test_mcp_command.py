"""``visionset mcp`` — resolving the workspace, then handing stdio to the child.

The command itself is four lines of real work, and all four are worth pinning:
the workspace is resolved with the full precedence, stated in the environment
*before* the child starts, refused at a terminal when it is not a workspace, and
the child is spawned rather than imported.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from visionset.cli import mcp as mcp_module
from visionset.cli.main import app
from visionset.kernel.services import WORKSPACE_ENV_VAR, WorkspaceService

runner = CliRunner()


class Spawn:
    """Records the one subprocess call, with the environment as it stood *inside* it.

    Snapshotting ``os.environ`` here rather than after the command returns is the
    whole point: asserting afterwards would only prove the variable was set at
    some point, and the claim worth making is that it was set before the server
    started.
    """

    def __init__(self, returncode: int = 0) -> None:
        self.returncode = returncode
        self.argv: list[str] | None = None
        self.env: dict[str, str] = {}

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        self.argv = argv
        self.env = dict(os.environ)
        return subprocess.CompletedProcess(argv, self.returncode)


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    # `setenv(..., "")`, never `delenv(..., raising=False)` — the latter records no
    # undo when the variable was already absent, and this command *writes* the
    # variable, so it would leak into every module collected after this one. An
    # empty value is what `resolve_workspace_root` and a shell both read as unset.
    monkeypatch.setenv(WORKSPACE_ENV_VAR, "")


@pytest.fixture
def spawn(monkeypatch: pytest.MonkeyPatch) -> Spawn:
    recorder = Spawn()
    # `subprocess.run` is patched directly: it is a documented public entry point,
    # so no seam had to be invented to make this testable.
    monkeypatch.setattr(subprocess, "run", recorder)
    return recorder


def _workspace(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    WorkspaceService.init(root).close()
    return root


def test_the_flag_names_the_workspace_and_the_child_is_told_before_it_starts(
    tmp_path: Path, spawn: Spawn
) -> None:
    root = _workspace(tmp_path)
    result = runner.invoke(app, ["mcp", "--workspace", str(root)])
    assert result.exit_code == 0
    assert spawn.env[WORKSPACE_ENV_VAR] == str(root)


def test_the_child_is_this_interpreter_running_the_server_module(
    tmp_path: Path, spawn: Spawn
) -> None:
    # Named rather than imported: import-linter forbids `visionset.cli` importing
    # `visionset.mcp`, and stdio has to be inherited by a real process anyway.
    root = _workspace(tmp_path)
    runner.invoke(app, ["mcp", "--workspace", str(root)])
    assert spawn.argv == [sys.executable, "-m", "visionset.mcp.main"]


def test_the_environment_variable_is_used_when_no_flag_is_given(
    tmp_path: Path, spawn: Spawn, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _workspace(tmp_path)
    monkeypatch.setenv(WORKSPACE_ENV_VAR, str(root))
    assert runner.invoke(app, ["mcp"]).exit_code == 0
    assert spawn.env[WORKSPACE_ENV_VAR] == str(root)


def test_the_working_directory_is_walked_upward_when_nobody_said(
    tmp_path: Path, spawn: Spawn, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _workspace(tmp_path)
    below = root / "deeper" / "still"
    below.mkdir(parents=True)
    monkeypatch.chdir(below)
    assert runner.invoke(app, ["mcp"]).exit_code == 0
    # The command applies the full precedence and then *states* it, so the child's
    # own resolver stops at branch 2 and the two cannot disagree.
    assert spawn.env[WORKSPACE_ENV_VAR] == str(root)


def test_the_flag_pointed_below_a_workspace_does_not_walk_up_to_it(
    tmp_path: Path, spawn: Spawn
) -> None:
    # This branch's own walk-negative, the sibling of `visionset ui`'s and of the
    # kernel's. A stated directory is somebody saying which workspace, and trading
    # it for its parent is how an agent is pointed at the wrong one.
    root = _workspace(tmp_path)
    below = root / "deeper"
    below.mkdir()
    result = runner.invoke(app, ["mcp", "--workspace", str(below)])
    assert result.exit_code == 1
    assert spawn.argv is None, "nothing should have been spawned"


def test_a_directory_that_is_not_a_workspace_is_refused_before_anything_spawns(
    tmp_path: Path, spawn: Spawn
) -> None:
    # The pre-flight open is real, not a check: a refusal here is one sentence at
    # exit 1, where inside the child it would be a JSON envelope nobody watches.
    result = runner.invoke(app, ["mcp", "--workspace", str(tmp_path)])
    assert result.exit_code == 1
    assert "Error:" in result.stderr
    assert spawn.argv is None


def test_the_refusal_names_a_remedy_a_person_at_a_terminal_can_use(
    tmp_path: Path, spawn: Spawn
) -> None:
    result = runner.invoke(app, ["mcp", "--workspace", str(tmp_path)])
    assert "--workspace" in result.stderr or WORKSPACE_ENV_VAR in result.stderr


def test_the_banner_goes_to_stderr_because_stdout_is_the_protocol(
    tmp_path: Path, spawn: Spawn
) -> None:
    # A single stray line on stdout would corrupt the JSON-RPC stream before the
    # first message. This is the assertion that keeps it that way.
    root = _workspace(tmp_path)
    result = runner.invoke(app, ["mcp", "--workspace", str(root)])
    assert result.stdout == ""
    assert str(root) in result.stderr


def test_the_childs_exit_code_is_this_commands_exit_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _workspace(tmp_path)
    monkeypatch.setattr(subprocess, "run", Spawn(returncode=3))
    assert runner.invoke(app, ["mcp", "--workspace", str(root)]).exit_code == 3


def test_no_workspace_sidecar_is_left_behind_for_the_child_to_recover(
    tmp_path: Path, spawn: Spawn
) -> None:
    # The pre-flight open closes again, which checkpoints the WAL. The child is
    # about to open the same file.
    root = _workspace(tmp_path)
    runner.invoke(app, ["mcp", "--workspace", str(root)])
    assert not (root / "visionset.db-wal").exists()


def test_the_command_is_listed_in_the_help() -> None:
    assert "mcp" in runner.invoke(app, ["--help"]).stdout


def test_the_cli_does_not_import_the_mcp_package() -> None:
    # The independence contract in prose, asserted where a reader will see it.
    # import-linter enforces it in CI; this fails at the point of the mistake.
    source = Path(mcp_module.__file__).read_text()
    assert "import visionset.mcp" not in source
    assert "from visionset.mcp" not in source
