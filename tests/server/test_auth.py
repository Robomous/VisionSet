"""Bearer authentication: one answer for every way of not being allowed in.

Two layers are exercised here. Most tests stub the provider through
`app.dependency_overrides` — the mechanism this issue exists to make possible,
and which had zero uses in this repository before it. The last two open a real
workspace and mint a real token, because "a persisted token authenticates" and
"a revoked one stops immediately" are claims about the whole path or about
nothing.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._probe import (
    KNOWN_TOKEN,
    PROBE_PATH,
    StubAuthProvider,
    stubbed_app,
    workspace_app,
)

from visionset.kernel.services import TokenService, WorkspaceService
from visionset.server.main import app


@pytest.fixture()
def provider() -> StubAuthProvider:
    return StubAuthProvider()


@pytest.fixture()
def client(provider: StubAuthProvider) -> Iterator[TestClient]:
    with TestClient(stubbed_app(provider)) as made:
        yield made


# --- refusals: all of them identical ---------------------------------------


@pytest.mark.parametrize(
    ("label", "headers"),
    [
        ("no header at all", {}),
        ("an unknown token", {"Authorization": "Bearer vst_nope"}),
        ("a bearer with no credential", {"Authorization": "Bearer"}),
        ("a non-bearer scheme", {"Authorization": "Basic dXNlcjpwYXNz"}),
        ("a bare token with no scheme", {"Authorization": KNOWN_TOKEN}),
    ],
)
def test_a_request_without_a_valid_token_is_refused(
    client: TestClient, label: str, headers: dict[str, str]
) -> None:
    assert client.get(PROBE_PATH, headers=headers).status_code == 401, label


def test_every_refusal_gives_byte_identical_answers(client: TestClient) -> None:
    """The no-oracle rule: a 401 must not say *why* it refused.

    A body that distinguished "no such token" from "revoked" from "malformed"
    would let anyone probe which credentials a workspace holds, one request at a
    time. One answer, so there is nothing to learn from asking.
    """
    missing = client.get(PROBE_PATH)
    unknown = client.get(PROBE_PATH, headers={"Authorization": "Bearer vst_nope"})
    malformed = client.get(PROBE_PATH, headers={"Authorization": "Basic nope"})

    assert len({missing.text, unknown.text, malformed.text}) == 1
    assert {missing.status_code, unknown.status_code, malformed.status_code} == {401}


def test_the_401_is_an_error_body_with_the_challenge(client: TestClient) -> None:
    response = client.get(PROBE_PATH)
    assert response.json() == {
        "code": "UNAUTHORIZED",
        "message": "Invalid or missing bearer token",
        "detail": None,
    }
    assert response.headers["WWW-Authenticate"] == "Bearer"


# --- acceptance -------------------------------------------------------------


def test_a_valid_token_reaches_the_route(client: TestClient) -> None:
    response = client.get(PROBE_PATH, headers={"Authorization": f"Bearer {KNOWN_TOKEN}"})
    assert response.status_code == 200
    assert response.json() == {"token": KNOWN_TOKEN}


def test_the_credential_is_passed_through_untouched(
    client: TestClient, provider: StubAuthProvider
) -> None:
    """No case folding and no prefix handling in the server.

    A token is bytes an operator was handed. Anything the server 'helpfully'
    normalizes is a character that stops mattering, which is entropy given away.
    """
    client.get(PROBE_PATH, headers={"Authorization": "Bearer vst_MiXeD-CaSe"})
    assert provider.presented == ["vst_MiXeD-CaSe"]


def test_health_needs_no_token(client: TestClient) -> None:
    assert client.get("/health").status_code == 200


def test_the_exported_app_is_not_the_one_under_test() -> None:
    """Probe routes live on a factory-built app, never on the exported one.

    Mounting them on ``app`` would put them in ``openapi.json`` and trip the CI
    drift gate — the reason this file builds its own applications at all.
    """
    assert PROBE_PATH not in app.openapi()["paths"]


# --- the override mechanism itself ------------------------------------------


def test_dependency_overrides_replace_authentication_without_a_probe_app() -> None:
    """The provider is a dependency, not a module global.

    Before this, swapping authentication meant a bare ``FastAPI()`` carrying a
    hand-written route — which exercised neither the real handlers nor the real
    router configuration. Overriding ``get_auth_provider`` reaches
    ``require_token`` through the graph, so the real thing is under test.
    """
    accepting = StubAuthProvider(accepted="only-this")
    with TestClient(stubbed_app(accepting)) as client:
        allowed = client.get(PROBE_PATH, headers={"Authorization": "Bearer only-this"})
        refused = client.get(PROBE_PATH, headers={"Authorization": "Bearer other"})
    assert (allowed.status_code, refused.status_code) == (200, 401)


def test_an_override_does_not_leak_between_applications(provider: StubAuthProvider) -> None:
    """Overrides live on the app, so two apps cannot contaminate each other."""
    permissive = stubbed_app(StubAuthProvider(accepted="anything"))
    strict = stubbed_app(provider)
    assert permissive.dependency_overrides != {}
    with TestClient(strict) as client:
        response = client.get(PROBE_PATH, headers={"Authorization": "Bearer anything"})
    assert response.status_code == 401


# --- against a real workspace ------------------------------------------------


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws")
    yield made
    made.close()


def test_a_persisted_token_authenticates(tmp_path: Path, workspace: WorkspaceService) -> None:
    """End to end: minted by the SDK, presented over HTTP, verified from the store."""
    issued = TokenService(workspace).create("ci")
    workspace.close()

    with TestClient(workspace_app(tmp_path / "ws")) as client:
        response = client.get(PROBE_PATH, headers={"Authorization": f"Bearer {issued.secret}"})
    assert response.status_code == 200
    assert response.json() == {"token": issued.secret}


def test_a_revoked_token_is_refused_immediately(
    tmp_path: Path, workspace: WorkspaceService
) -> None:
    """No restart, and no cache to invalidate.

    The same running application answers 200 and then 401 across one ``revoke``
    call made through a *different* handle on the same workspace — which is what
    an operator running ``visionset token revoke`` beside a live server does.
    """
    issued = TokenService(workspace).create("ci")
    workspace.close()

    with TestClient(workspace_app(tmp_path / "ws")) as client:
        header = {"Authorization": f"Bearer {issued.secret}"}
        assert client.get(PROBE_PATH, headers=header).status_code == 200

        beside = WorkspaceService.open(tmp_path / "ws")
        TokenService(beside).revoke(issued.token.id, confirm=True)
        beside.close()

        assert client.get(PROBE_PATH, headers=header).status_code == 401


def test_a_token_from_another_workspace_does_not_open_this_one(tmp_path: Path) -> None:
    served = WorkspaceService.init(tmp_path / "served")
    served.close()
    other = WorkspaceService.init(tmp_path / "other")
    issued = TokenService(other).create("ci")
    other.close()

    with TestClient(workspace_app(tmp_path / "served")) as client:
        response = client.get(PROBE_PATH, headers={"Authorization": f"Bearer {issued.secret}"})
    assert response.status_code == 401
