"""Which workspace a command operates on, end to end through the CLI.

The rule itself is covered in ``tests/kernel/test_workspace_service.py``; these
assert that a *command* reaches it — the flag is wired, the precedence survives
Click, and a command outside any workspace refuses in a way somebody can act on.

These assume no ancestor of ``tmp_path`` holds a ``visionset.db``. That holds
under pytest's temporary root; if one of them ever fails on a machine where
somebody made a workspace of ``/tmp``, this is the reason.
"""

from pathlib import Path

import pytest
from typer.testing import CliRunner

from visionset.cli.main import app
from visionset.kernel.services import WORKSPACE_ENV_VAR, TokenService, WorkspaceService

runner = CliRunner()


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def workspace_root(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    WorkspaceService.init(root).close()
    return root


def _token_names(root: Path) -> list[str]:
    workspace = WorkspaceService.open(root)
    names = [token.name for token in TokenService(workspace).list()]
    workspace.close()
    return names


# --- the flag -----------------------------------------------------------------


def test_the_workspace_flag_names_the_workspace(workspace_root: Path) -> None:
    result = runner.invoke(
        app, ["token", "create", "--name", "ci", "--workspace", str(workspace_root)]
    )
    assert result.exit_code == 0, result.output
    assert _token_names(workspace_root) == ["ci"]


def test_the_flag_may_follow_the_subcommand(workspace_root: Path) -> None:
    """The whole reason ``--workspace`` is per command rather than on the callback.

    A Click group stops parsing at the first non-option token, so an option
    declared on ``@app.callback()`` would have to *precede* ``token``, and this
    invocation — the one everybody actually types — would exit 2 with "No such
    option".
    """
    result = runner.invoke(app, ["token", "list", "--workspace", str(workspace_root)])
    assert result.exit_code == 0, result.output


def test_the_short_flag_works_too(workspace_root: Path) -> None:
    result = runner.invoke(app, ["token", "list", "-w", str(workspace_root)])
    assert result.exit_code == 0, result.output


# --- precedence ---------------------------------------------------------------


def test_the_environment_variable_names_the_workspace_when_no_flag_is_given(
    workspace_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(WORKSPACE_ENV_VAR, str(workspace_root))
    result = runner.invoke(app, ["token", "create", "--name", "ci"])
    assert result.exit_code == 0, result.output
    assert _token_names(workspace_root) == ["ci"]


def test_the_flag_wins_over_the_environment_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    flagged = tmp_path / "flagged"
    ambient = tmp_path / "ambient"
    for root in (flagged, ambient):
        WorkspaceService.init(root).close()
    monkeypatch.setenv(WORKSPACE_ENV_VAR, str(ambient))

    result = runner.invoke(app, ["token", "create", "--name", "ci", "-w", str(flagged)])

    assert result.exit_code == 0, result.output
    assert _token_names(flagged) == ["ci"]
    assert _token_names(ambient) == []


# --- discovery ----------------------------------------------------------------


def test_a_command_run_inside_a_workspace_finds_it(
    workspace_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(workspace_root)
    result = runner.invoke(app, ["token", "create", "--name", "ci"])
    assert result.exit_code == 0, result.output
    assert _token_names(workspace_root) == ["ci"]


def test_a_command_run_below_a_workspace_finds_the_one_above(
    workspace_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    below = workspace_root / "assets" / "raw"
    below.mkdir(parents=True)
    monkeypatch.chdir(below)

    result = runner.invoke(app, ["token", "create", "--name", "ci"])

    assert result.exit_code == 0, result.output
    assert _token_names(workspace_root) == ["ci"]


def test_the_flag_pointed_below_a_workspace_does_not_walk_up_to_it(
    workspace_root: Path,
) -> None:
    """A stated root is never traded for its parent — see the resolver's docstring."""
    below = workspace_root / "assets"
    below.mkdir()

    result = runner.invoke(app, ["token", "create", "--name", "ci", "-w", str(below)])

    assert result.exit_code == 1
    assert _token_names(workspace_root) == []


# --- refusals -----------------------------------------------------------------


def test_a_command_outside_any_workspace_exits_one_with_a_readable_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["token", "list"])

    assert result.exit_code == 1
    assert "not a VisionSet workspace" in result.stderr
    assert "--workspace" in result.stderr
    assert WORKSPACE_ENV_VAR in result.stderr
    assert result.stdout == ""
