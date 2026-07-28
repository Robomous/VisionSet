"""`/health`: the one public operation, and the one that must never need a token.

The auth tests this file used to carry moved to `test_auth.py` when the provider
stopped being a module global. What is left is the liveness probe itself, and the
claim that it stays reachable without a credential.
"""

from fastapi.testclient import TestClient

from visionset import __version__
from visionset.server.main import app

client = TestClient(app)


def test_health_returns_ok_and_version() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__}


def test_health_is_in_openapi_contract() -> None:
    assert "/health" in app.openapi()["paths"]


def test_health_needs_no_workspace() -> None:
    """Answered without opening anything, which is what makes it a liveness probe.

    A container is healthy before ``visionset init`` has ever run inside it, and
    a probe that opened the workspace would report a deployment fault as death.
    """
    client.get("/health")
    assert app.state.workspace_handle.is_open is False
