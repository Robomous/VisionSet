from typing import Annotated

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from visionset import __version__
from visionset.server.main import app, require_token

client = TestClient(app)


def test_health_returns_ok_and_version() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__}


def test_health_is_in_openapi_contract() -> None:
    assert "/health" in app.openapi()["paths"]


@pytest.fixture()
def protected_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("VISIONSET_DEV_TOKEN", "dev-secret")
    probe = FastAPI()

    @probe.get("/protected")
    async def protected(token: Annotated[str, Depends(require_token)]) -> dict[str, bool]:
        return {"ok": True}

    return TestClient(probe)


def test_auth_dependency_rejects_missing_token(protected_client: TestClient) -> None:
    assert protected_client.get("/protected").status_code == 401


def test_auth_dependency_rejects_wrong_token(protected_client: TestClient) -> None:
    response = protected_client.get("/protected", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_auth_dependency_accepts_dev_token(protected_client: TestClient) -> None:
    response = protected_client.get("/protected", headers={"Authorization": "Bearer dev-secret"})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
