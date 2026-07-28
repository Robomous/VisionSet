"""`visionset ui`: what uvicorn is told, and what happens before it is told anything.

Nothing here starts a server. `uvicorn.run` is replaced by a recorder, which is
patching the boundary rather than standing in for it — `uvicorn.run` is a
documented public entry point, so there is no invented seam to keep honest.

The recorder snapshots `os.environ` **inside itself**. That is the whole
technique for the export tests: asserting the variable afterwards would only
prove it was set at some point, and the claim worth making is that it was set
*before* the server started.

One landmine, and it is the reason this module does not copy the neighbouring
`_no_ambient_workspace` fixture verbatim: `monkeypatch.delenv(..., raising=False)`
records **no undo** when the variable was already absent, so the variable this
command exports would survive into every later test module. `setenv` always
records one, and an empty value is the same thing as an unset one both to
`resolve_workspace_root` and to a shell.

These assume no ancestor of `tmp_path` holds a `visionset.db`, like the sibling
module.
"""

import os
from pathlib import Path

import pytest
import uvicorn
from typer.testing import CliRunner

from visionset.cli.main import app
from visionset.cli.ui import APP_IMPORT_STRING
from visionset.kernel.services import WORKSPACE_ENV_VAR, WorkspaceService

runner = CliRunner()


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results.

    ``setenv`` rather than ``delenv``: see the module docstring. This command
    writes the variable, and only ``setenv`` records the undo that removes it.
    """
    monkeypatch.setenv(WORKSPACE_ENV_VAR, "")


@pytest.fixture()
def workspace_root(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    WorkspaceService.init(root).close()
    return root


@pytest.fixture()
def started(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """What ``uvicorn.run`` was called with, and the environment it saw."""
    calls: list[dict[str, object]] = []

    def record(target: str, **kwargs: object) -> None:
        calls.append({"target": target, "env": dict(os.environ), **kwargs})

    monkeypatch.setattr(uvicorn, "run", record)
    return calls


# --- what uvicorn is told -----------------------------------------------------


def test_the_server_is_named_by_import_string_and_never_handed_an_object(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    """The runtime half of the independence contract.

    import-linter proves this module never *imports* the server; this proves it
    does not reach one some other way. It is also what ``--reload`` requires,
    since a worker process cannot be handed an application object.
    """
    result = runner.invoke(app, ["ui", "--workspace", str(workspace_root)])
    assert result.exit_code == 0, result.output
    assert started[0]["target"] == APP_IMPORT_STRING == "visionset.server.main:app"
    assert isinstance(started[0]["target"], str)


def test_it_binds_loopback_on_port_8000_by_default(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    runner.invoke(app, ["ui", "--workspace", str(workspace_root)])
    assert started[0]["host"] == "127.0.0.1"
    assert started[0]["port"] == 8000


def test_it_binds_the_host_and_port_it_was_given(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    runner.invoke(
        app, ["ui", "--host", "0.0.0.0", "--port", "9999", "--workspace", str(workspace_root)]
    )
    assert started[0]["host"] == "0.0.0.0"
    assert started[0]["port"] == 9999


def test_reload_watches_the_installed_package_and_not_the_working_directory(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    """uvicorn's own default is the working directory, which here holds node_modules."""
    runner.invoke(app, ["ui", "--reload", "--workspace", str(workspace_root)])
    assert started[0]["reload"] is True
    watched = started[0]["reload_dirs"]
    assert isinstance(watched, list)
    assert Path(watched[0], "__init__.py").is_file()


def test_without_reload_no_directories_are_named(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    """uvicorn warns "configuration will not reload" whenever both are not set together."""
    runner.invoke(app, ["ui", "--workspace", str(workspace_root)])
    assert started[0]["reload"] is False
    assert started[0]["reload_dirs"] is None


# --- which workspace, and when ------------------------------------------------


def test_the_resolved_workspace_is_exported_before_the_server_starts(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    """The only channel there is: ``create_app()`` takes no parameters."""
    runner.invoke(app, ["ui", "--workspace", str(workspace_root)])
    env = started[0]["env"]
    assert isinstance(env, dict)
    assert env[WORKSPACE_ENV_VAR] == str(workspace_root)


def test_the_flag_wins_over_the_environment_variable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, started: list[dict[str, object]]
) -> None:
    flagged = tmp_path / "flagged"
    ambient = tmp_path / "ambient"
    for root in (flagged, ambient):
        WorkspaceService.init(root).close()
    monkeypatch.setenv(WORKSPACE_ENV_VAR, str(ambient))

    result = runner.invoke(app, ["ui", "--workspace", str(flagged)])
    assert result.exit_code == 0, result.output
    env = started[0]["env"]
    assert isinstance(env, dict)
    assert env[WORKSPACE_ENV_VAR] == str(flagged)


def test_a_command_run_below_a_workspace_exports_the_one_above(
    monkeypatch: pytest.MonkeyPatch, workspace_root: Path, started: list[dict[str, object]]
) -> None:
    """The walk survives the CLI and reaches the server, which cannot walk for itself.

    A server started by import string has no argv, so it would resolve from *its*
    working directory. This command decides once and states the answer.
    """
    below = workspace_root / "notes"
    below.mkdir()
    monkeypatch.chdir(below)

    result = runner.invoke(app, ["ui"])
    assert result.exit_code == 0, result.output
    env = started[0]["env"]
    assert isinstance(env, dict)
    assert env[WORKSPACE_ENV_VAR] == str(workspace_root)


def test_the_flag_pointed_below_a_workspace_does_not_walk_up_to_it(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    """A stated path is never traded for its parent, and this is the branch's own proof.

    The sibling of ``test_an_explicit_path_does_not_walk_upward`` in the kernel
    suite. Every surface that resolves a workspace owes one, because the flag is
    somebody *saying* which workspace — and serving the parent instead is how a
    server ends up handing out data from a directory nobody named.
    """
    below = workspace_root / "notes"
    below.mkdir()

    result = runner.invoke(app, ["ui", "--workspace", str(below)])
    assert result.exit_code == 1
    assert started == []


# --- refusing before anything starts ------------------------------------------


def test_outside_any_workspace_it_exits_one_and_never_starts_a_server(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, started: list[dict[str, object]]
) -> None:
    """Acceptance criterion: a clear error, not a stack trace, and no half-started server."""
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["ui"])
    assert result.exit_code == 1
    assert "not a VisionSet workspace" in result.stderr
    assert "--workspace" in result.stderr
    assert WORKSPACE_ENV_VAR in result.stderr
    assert "Traceback" not in result.stderr
    assert result.stdout == ""
    assert started == []


def test_the_preflight_leaves_no_write_ahead_log_beside_the_workspace(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    """The pre-flight opens for real, so it has to close for real.

    The server is about to open the same file; a checkpoint left behind is state
    the next reader has to recover before it can answer anything.
    """
    result = runner.invoke(app, ["ui", "--workspace", str(workspace_root)])
    assert result.exit_code == 0, result.output
    assert not (workspace_root / "visionset.db-wal").exists()
    assert not (workspace_root / "visionset.db-shm").exists()


# --- what a person sees -------------------------------------------------------


def test_the_banner_names_the_url_the_workspace_and_how_to_mint_a_token(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    result = runner.invoke(app, ["ui", "--workspace", str(workspace_root)])
    assert result.exit_code == 0, result.output
    assert "http://127.0.0.1:8000/" in result.stderr
    assert str(workspace_root) in result.stderr
    assert "visionset token create" in result.stderr


def test_nothing_is_printed_on_stdout(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    """Stdout is a command's data, and this command has none."""
    result = runner.invoke(app, ["ui", "--workspace", str(workspace_root)])
    assert result.exit_code == 0, result.output
    assert result.stdout == ""


def test_binding_every_interface_still_prints_a_url_a_browser_can_open(
    workspace_root: Path, started: list[dict[str, object]]
) -> None:
    """``http://0.0.0.0:8000`` is what a naive banner prints and what nothing opens."""
    result = runner.invoke(app, ["ui", "--host", "0.0.0.0", "--workspace", str(workspace_root)])
    assert "http://127.0.0.1:8000/" in result.stderr
    assert "http://0.0.0.0" not in result.stderr
