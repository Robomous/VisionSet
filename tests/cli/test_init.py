"""``visionset init`` — the one command that creates rather than opens.

Three things it must get right and one it must never do: create where nothing is,
refuse where something already is, put the resolved root alone on stdout, and
**never walk upward** to find a place to create a workspace.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from visionset.cli.main import app
from visionset.kernel.services import WORKSPACE_ENV_VAR, WorkspaceService

runner = CliRunner()


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


# --- creating ----------------------------------------------------------------


def test_it_makes_a_workspace_a_later_command_can_open(tmp_path: Path) -> None:
    result = runner.invoke(app, ["init", str(tmp_path / "ws")])
    assert result.exit_code == 0, result.output
    WorkspaceService.open(tmp_path / "ws").close()


def test_the_resolved_root_is_the_only_thing_on_stdout(tmp_path: Path) -> None:
    # ``WS=$(visionset init ./ws)`` has to be exactly the path, so that the two
    # "what next" lines can still reach the person on stderr.
    result = runner.invoke(app, ["init", str(tmp_path / "ws")])
    assert result.stdout.strip() == str((tmp_path / "ws").resolve())
    assert "Created workspace" in result.stderr
    assert "visionset ui" in result.stderr


def test_it_names_the_workspace_after_its_directory(tmp_path: Path) -> None:
    runner.invoke(app, ["init", str(tmp_path / "robots")])
    with WorkspaceService.open(tmp_path / "robots") as service:
        assert service.workspace.name == "robots"


def test_name_overrides_the_directory(tmp_path: Path) -> None:
    runner.invoke(app, ["init", str(tmp_path / "ws"), "--name", "Field trial"])
    with WorkspaceService.open(tmp_path / "ws") as service:
        assert service.workspace.name == "Field trial"


def test_with_no_path_it_uses_the_working_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    here = tmp_path / "here"
    here.mkdir()
    monkeypatch.chdir(here)
    result = runner.invoke(app, ["init"])
    assert result.exit_code == 0, result.output
    assert (here / "visionset.db").is_file()


# --- refusing ----------------------------------------------------------------


def test_a_second_init_over_a_workspace_exits_one(tmp_path: Path) -> None:
    runner.invoke(app, ["init", str(tmp_path / "ws")])
    result = runner.invoke(app, ["init", str(tmp_path / "ws")])
    assert result.exit_code == 1, result.output
    assert result.stdout == ""
    assert "Error:" in result.stderr


def test_a_directory_holding_something_else_exits_one(tmp_path: Path) -> None:
    # The guard that stops a typo turning a home directory into a workspace.
    (tmp_path / "occupied").mkdir()
    (tmp_path / "occupied" / "notes.txt").write_text("mine", encoding="utf-8")
    result = runner.invoke(app, ["init", str(tmp_path / "occupied")])
    assert result.exit_code == 1, result.output
    assert not (tmp_path / "occupied" / "visionset.db").exists()


# --- what it must never do ---------------------------------------------------


def test_it_does_not_walk_up_to_an_existing_workspace(tmp_path: Path) -> None:
    # The sibling of the kernel's ``test_an_explicit_path_does_not_walk_upward``,
    # and the reason this command has a positional PATH rather than
    # ``--workspace``: naming where to *make* one must never be traded for its
    # parent, which is the one case where the trade is irreversible.
    runner.invoke(app, ["init", str(tmp_path / "outer")])
    below = tmp_path / "outer" / "nested"
    result = runner.invoke(app, ["init", str(below)])
    assert result.exit_code == 0, result.output
    assert (below / "visionset.db").is_file()


def test_it_ignores_the_environment_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # ``--workspace`` and ``$VISIONSET_WORKSPACE`` both say "operate on this one".
    # Neither answers "where should a new one go", so this command consults
    # neither, and the argument is the whole of its input.
    monkeypatch.setenv(WORKSPACE_ENV_VAR, str(tmp_path / "elsewhere"))
    result = runner.invoke(app, ["init", str(tmp_path / "ws")])
    assert result.exit_code == 0, result.output
    assert (tmp_path / "ws" / "visionset.db").is_file()
    assert not (tmp_path / "elsewhere").exists()


def test_it_leaves_no_write_ahead_log_behind(tmp_path: Path) -> None:
    # ``init`` hands back an *open* workspace; a command that forgot to close it
    # would strand ``visionset.db-wal`` for the next reader to recover.
    runner.invoke(app, ["init", str(tmp_path / "ws")])
    assert sorted(p.name for p in (tmp_path / "ws").iterdir()) == ["blobs", "visionset.db"]
