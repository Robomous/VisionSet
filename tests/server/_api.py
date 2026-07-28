"""A real application, over a real workspace, holding a real token.

The opposite of `_probe.py`, and a separate module for that reason: a probe app
carries one *fake* route and must never be confused with the shipped route set,
while everything here exercises exactly what `openapi.json` describes. One
private module per concern is the `_probe.py` / `_openapi.py` precedent, and
there is still no `conftest.py` anywhere — each test module wraps these in its
own two-line fixture.

The workspace is initialised, a token minted through `TokenService`, and the
workspace closed again before the application opens it. That is the same
sequence `test_auth.py::test_a_persisted_token_authenticates` uses, and it is
what makes these tests exercise real authentication rather than an override.
"""

from pathlib import Path
from typing import Final

from fastapi import FastAPI
from fastapi.testclient import TestClient
from tests.server._probe import handle_for

from visionset.kernel.services import TokenService, WorkspaceService
from visionset.server.main import create_app
from visionset.server.runner import IngestRunner

TOKEN_NAME: Final = "api-tests"


def served_app(root: Path, *, runner: IngestRunner | None = None) -> FastAPI:
    """The shipped application, serving the workspace at ``root``.

    The handle is replaced rather than the environment patched, so the test says
    which workspace it means instead of relying on process-wide state. A
    ``runner`` is replaced the same way and for the same reason; the one
    ``create_app`` built has started no thread, so dropping it costs nothing.
    """
    app = create_app()
    app.state.workspace_handle = handle_for(root)
    if runner is not None:
        app.state.ingest_runner = runner
    return app


def api_workspace(root: Path) -> str:
    """Initialise a workspace at ``root``, mint a token, close it. Returns the secret."""
    workspace = WorkspaceService.init(root)
    try:
        return TokenService(workspace).create(TOKEN_NAME).secret
    finally:
        workspace.close()


def api_client(root: Path, *, runner: IngestRunner | None = None) -> TestClient:
    """A client for a fresh workspace at ``root``, authenticated on every request.

    Use it as a context manager: the lifespan is what closes the workspace and
    stops the ingest worker, and a `visionset.db-wal` left behind would outlive
    the test's ``tmp_path``.
    """
    secret = api_workspace(root)
    return TestClient(
        served_app(root, runner=runner), headers={"Authorization": f"Bearer {secret}"}
    )
