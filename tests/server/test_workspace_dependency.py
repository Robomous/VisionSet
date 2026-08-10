"""The workspace the server serves: opened once, lazily, per application.

The load-bearing property is negative — **importing this package must not open a
workspace** — because `scripts/export_openapi.py` imports the module-level `app`
in a checkout that has none, and the CI drift gate runs it on every push.
"""

import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._probe import PROBE_PATH, counting_handle, handle_for, probe_app, workspace_app

from visionset.kernel.services import TokenService, WorkspaceService
from visionset.server.dependencies import WORKSPACE_ENV_VAR, WorkspaceHandle, resolve_workspace_root
from visionset.server.main import create_app


@pytest.fixture()
def workspace_root(tmp_path: Path) -> Iterator[Path]:
    root = tmp_path / "ws"
    made = WorkspaceService.init(root)
    made.close()
    yield root


# --- nothing opens at import or at build time -------------------------------


def test_creating_the_app_opens_no_workspace() -> None:
    assert create_app().state.workspace_handle.is_open is False


def test_importing_the_module_level_app_opens_no_workspace(tmp_path: Path) -> None:
    """Run in a fresh process from a directory that is not a workspace.

    The `test_kernel_purity.py` pattern, and for the same reason: what is under
    test is what an *import* does, which cannot be observed from inside a process
    that has already imported. This is literally what the CI OpenAPI job does.
    """
    probe = (
        "from visionset.server.main import app\n"
        "assert app.state.workspace_handle.is_open is False\n"
        "assert '/health' in app.openapi()['paths']\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr


# --- opened once, and only once ---------------------------------------------


def test_the_workspace_is_opened_once_across_requests(workspace_root: Path) -> None:
    handle, calls = counting_handle(lambda: WorkspaceService.open(workspace_root))
    app = probe_app()
    app.state.workspace_handle = handle

    with TestClient(app) as client:
        for _ in range(3):
            client.get(PROBE_PATH)

    assert calls == [1]


def test_the_handle_opens_once_under_concurrent_first_calls(workspace_root: Path) -> None:
    """Sync dependencies run in a threadpool, so the first call really can race.

    Without the lock the loser's ``WorkspaceService`` is overwritten and its
    SQLite engine is never closed — a leak that no single-threaded test can see.
    """
    handle, calls = counting_handle(lambda: WorkspaceService.open(workspace_root))
    start = threading.Event()
    threads = [threading.Thread(target=lambda: (start.wait(), handle.get())) for _ in range(8)]
    for thread in threads:
        thread.start()
    start.set()
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive()

    assert calls == [1]
    handle.close()


def test_two_applications_do_not_share_a_workspace(workspace_root: Path) -> None:
    """The property that rules out a module-level cache."""
    first = workspace_app(workspace_root)
    second = workspace_app(workspace_root)
    assert first.state.workspace_handle is not second.state.workspace_handle


# --- shutdown ----------------------------------------------------------------


def test_shutdown_closes_the_workspace(workspace_root: Path) -> None:
    app = workspace_app(workspace_root)
    with TestClient(app) as client:
        client.get(PROBE_PATH)
        assert app.state.workspace_handle.is_open is True
    assert app.state.workspace_handle.is_open is False


def test_closing_a_handle_that_never_opened_is_safe() -> None:
    WorkspaceHandle().close()


def test_closing_twice_is_safe(workspace_root: Path) -> None:
    handle = handle_for(workspace_root)
    handle.get()
    handle.close()
    handle.close()


# --- resolution: the rule lives in the kernel now, re-exported here ----------
#
# These stay in the server's test file rather than moving to the kernel's with
# the rule. They pin two things at once now: that resolution still answers what
# the server needs, and that both names are still importable from
# ``visionset.server.dependencies`` — which is the half a refactor would break
# silently. The rule's own coverage lives in ``tests/kernel/test_workspace_service.py``.


def test_the_environment_variable_names_the_workspace_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv(WORKSPACE_ENV_VAR, str(tmp_path / "elsewhere"))
    assert resolve_workspace_root() == tmp_path / "elsewhere"


def test_the_workspace_defaults_to_the_working_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)
    monkeypatch.chdir(tmp_path)
    assert resolve_workspace_root() == tmp_path


def test_an_empty_environment_variable_falls_back_to_the_working_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An unset variable and one set to "" mean the same thing to a shell."""
    monkeypatch.setenv(WORKSPACE_ENV_VAR, "")
    monkeypatch.chdir(tmp_path)
    assert resolve_workspace_root() == tmp_path


def test_the_server_finds_a_workspace_above_its_working_directory(
    monkeypatch: pytest.MonkeyPatch, workspace_root: Path
) -> None:
    """The one behaviour the promotion gave the server, and it is deliberate.

    Without a shared resolver this answers 500 ``NOT_A_WORKSPACE``. One resolver means the
    server discovers a workspace the same way the CLI does; the asymmetry that
    keeps it safe is that a *stated* root — the variable here, ``--workspace``
    there — never walks.
    """
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)
    below = workspace_root / "logs"
    below.mkdir()
    monkeypatch.chdir(below)
    assert resolve_workspace_root() == Path.cwd().parent


def test_the_configured_workspace_is_the_one_that_is_served(
    monkeypatch: pytest.MonkeyPatch, workspace_root: Path
) -> None:
    """End to end through the environment, the way a deployment configures it."""
    served = WorkspaceService.open(workspace_root)
    issued = TokenService(served).create("ci")
    served.close()

    monkeypatch.setenv(WORKSPACE_ENV_VAR, str(workspace_root))
    with TestClient(probe_app()) as client:
        response = client.get(PROBE_PATH, headers={"Authorization": f"Bearer {issued.secret}"})
    assert response.status_code == 200


# --- a server pointed at nothing ---------------------------------------------


def test_a_server_pointed_at_a_non_workspace_answers_500_not_a_workspace(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A deployment fault, reported as one — and never as a 401.

    ``get_auth_provider`` depends on ``get_workspace``, so a misconfigured server
    fails before the credential is even looked at. That ordering is deliberate:
    resolving the provider outside the dependency graph would be the only way to
    check the token first, and it would take ``dependency_overrides`` with it.

    The path is in the log and not in the body, on ``NOT_A_WORKSPACE``'s rule that
    a 5xx message naming the server's own filesystem is the server's business.
    """
    monkeypatch.setenv(WORKSPACE_ENV_VAR, str(tmp_path / "nothing-here"))
    with TestClient(probe_app(), raise_server_exceptions=False) as client:
        response = client.get(PROBE_PATH, headers={"Authorization": "Bearer vst_whatever"})

    assert response.status_code == 500
    body = response.json()
    assert body["code"] == "NOT_A_WORKSPACE"
    assert body["detail"]["incident_id"]
    assert "nothing-here" not in response.text
    assert "nothing-here" in caplog.text
