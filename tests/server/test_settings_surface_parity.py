"""REST, ``visionset --json`` and MCP publish the same settings, and never a secret in them.

Also the description edit, which the three surfaces reach through one kernel method.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Final

import pytest
from fastapi.testclient import TestClient
from tests.cli._flow import payload as cli_payload
from tests.cli._flow import runner
from tests.mcp._flow import call
from tests.mcp._flow import payload as mcp_payload
from tests.server._api import api_workspace, served_app

from visionset.cli.main import app
from visionset.jobs.settings import job_settings
from visionset.tracking import tracking_settings

_SECRETS: Final = (
    "uri-user-secret",
    "uri-password-secret",
    "uri-path-secret",
    "uri-query-secret",
    "uri-pw",
    "word-secret",
    "username-secret",
    "password-secret",
    "token-secret",
    "ca-path-secret",
    "client-path-secret",
)

_ENVIRONMENT: Final = {
    "VISIONSET_MLFLOW_ENABLED": "true",
    "VISIONSET_MLFLOW_EXPERIMENT": "roads",
    "MLFLOW_TRACKING_USERNAME": "username-secret",
    "MLFLOW_TRACKING_PASSWORD": "password-secret",
    "MLFLOW_TRACKING_TOKEN": "token-secret",
    "MLFLOW_TRACKING_SERVER_CERT_PATH": "/etc/ca-path-secret.pem",
    "MLFLOW_TRACKING_CLIENT_CERT_PATH": "/etc/client-path-secret.pem",
    "VISIONSET_JOB_PROGRESS_MIN_INTERVAL_S": "0.25",
}


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name, value in _ENVIRONMENT.items():
        monkeypatch.setenv(name, value)
    tracking_settings.cache_clear()
    job_settings.cache_clear()
    yield
    tracking_settings.cache_clear()
    job_settings.cache_clear()


def _cli_settings() -> tuple[dict[str, Any], str]:
    result = runner.invoke(app, ["settings", "--json"])
    assert result.exit_code == 0, result.output
    return json.loads(result.stdout), result.output


_CLEAN_SERVER: Final = {"scheme": "https", "host": "tracking.example", "port": 8443}


@pytest.mark.parametrize(
    ("uri", "server"),
    [
        ("https://tracking.example:8443/uri-path-secret", _CLEAN_SERVER),
        (
            "https://uri-user-secret:uri-password-secret@tracking.example:8443"
            "/uri-path-secret?key=uri-query-secret",
            None,
        ),
        ("https://uri-user-secret:uri-password-secret@tracking.example:8443", None),
        ("uri-user-secret:uri-password-secret@tracking.example:5000", None),
        ("uri-user-secret@tracking.example", None),
        ("http://uri-user-secret:12/uri-pw@tracking.example", None),
        ("https://uri-user-secret:pass/word-secret@tracking.example", None),
        ("https://uri-user-secret:uri-password-secret@x@tracking.example", None),
    ],
)
def test_every_surface_publishes_the_same_settings_and_no_secret(
    tmp_path: Path,
    configured: None,
    monkeypatch: pytest.MonkeyPatch,
    uri: str,
    server: dict[str, Any] | None,
) -> None:
    monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)
    root = tmp_path / "ws"
    token = api_workspace(root)
    with TestClient(served_app(root), headers={"Authorization": f"Bearer {token}"}) as client:
        response = client.get("/settings")
    cli, cli_output = _cli_settings()
    mcp_result = call("get_workspace_settings")
    mcp = mcp_payload(mcp_result)
    human = runner.invoke(app, ["settings"])

    assert response.status_code == 200
    rest = response.json()
    assert cli == rest
    assert mcp == rest

    tracking = rest["tracking"]
    assert tracking["enabled"] is True
    assert tracking["experiment"] == "roads"
    assert tracking["server"] == server
    if server is None:
        assert "carries" in tracking["problem"]
    assert tracking["auth"] == "basic"
    assert tracking["ca_bundle_configured"] is True
    assert tracking["client_certificate_configured"] is True
    assert rest["executor"]["variables"][2] == {
        "name": "VISIONSET_JOB_PROGRESS_MIN_INTERVAL_S",
        "value": 0.25,
        "default": 0.5,
    }

    published = {
        "rest": response.text,
        "cli --json": cli_output,
        "cli": human.output,
        "mcp": mcp_result.model_dump_json(),
    }
    for surface, text in published.items():
        leaked = [secret for secret in _SECRETS if secret in text]
        assert not leaked, f"{surface} published {leaked}"


def test_the_settings_route_needs_a_token(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    api_workspace(root)
    with TestClient(served_app(root)) as client:
        assert client.get("/settings").status_code == 401


def test_every_surface_edits_the_description_through_the_same_method(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "ws"
    token = api_workspace(root)
    with TestClient(served_app(root), headers={"Authorization": f"Bearer {token}"}) as client:
        made = client.post("/projects", json={"name": "roads", "description": "day"}).json()
        rest = client.patch(f"/projects/{made['id']}", json={"description": "night"}).json()

        monkeypatch.setenv("VISIONSET_WORKSPACE", str(root))
        cli = cli_payload(root, "project", "update", "roads", "--description", "dusk")
        mcp = mcp_payload(call("update_project", project="roads", description=""))

        final = client.get(f"/projects/{made['id']}").json()

    assert rest == {**made, "description": "night"}
    assert cli == {**made, "description": "dusk"}
    assert mcp == {**made, "description": None}
    assert final == mcp
