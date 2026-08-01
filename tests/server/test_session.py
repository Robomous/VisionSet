"""The browser session: who is signed in without typing anything, and who is not.

`GET /session` is the whole mechanism (#179), and almost everything worth
asserting about it is a *refusal*. Signing the local browser in is one test; the
other twelve are the cases where the server must go on asking for a token, because
every one of them is a way for this feature to hand somebody's workspace to
somebody else.

## Why the workspace arrives through the environment here

Every other module in this directory replaces `app.state.workspace_handle`, which
says which workspace it means without touching process-wide state. This one
cannot: the secret is a *file in the workspace directory*, and
`visionset.server.session` finds that directory with `resolve_workspace_root()` —
deliberately, because it must not open the database to answer a public route. So
the tests set `VISIONSET_WORKSPACE`, which is exactly what `visionset ui` and the
compose stack do, and the handle is pointed at the same path so the two halves
cannot disagree.

## What `client=` in a `TestClient` actually does

It sets `scope["client"]`, which is the peer address every ASGI server reports and
the only thing `auto` mode trusts about who is connecting. So the non-loopback
tests below are real requests through the real dependency graph arriving from a
real LAN address, not an assertion about a predicate.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Final

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from tests.server._probe import PROBE_PATH, counting_handle, handle_for, probe_app

from visionset.kernel.services import TokenService, WorkspaceService
from visionset.server.main import app as exported_app
from visionset.server.session import COOKIE_NAME, MODE_ENV_VAR, SESSION_FILENAME

SESSION_PATH: Final = "/session"

LAN: Final = ("192.168.1.42", 51234)
"""A peer that is emphatically not this machine."""

LOOPBACK: Final = ("127.0.0.1", 51234)

LOCAL_URL: Final = "http://localhost"
"""The ``Host`` a browser on this machine sends. A ``TestClient`` defaults to
``testserver``, which `auto` mode is right to refuse — see :func:`served`."""


@pytest.fixture()
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """An initialised workspace this server serves, named in the environment.

    Closed again before any request: the server opens its own, and two open
    handles on one SQLite file is not what any of these tests are about.
    """
    root = tmp_path / "ws"
    WorkspaceService.init(root).close()
    monkeypatch.setenv("VISIONSET_WORKSPACE", str(root))
    monkeypatch.delenv(MODE_ENV_VAR, raising=False)
    yield root


def served(root: Path, *, client: tuple[str, int] = LOOPBACK, https: bool = False) -> TestClient:
    """A probe application over ``root``, reached from ``client``.

    ``base_url`` is ``localhost`` rather than the ``testserver`` a ``TestClient``
    defaults to, because that name is the ``Host`` header — and a name this server
    cannot recognise as itself is exactly what `auto` mode refuses. The default
    would make every test here assert the rebinding refusal by accident.
    """
    base = LOCAL_URL.replace("http://", "https://") if https else LOCAL_URL
    return TestClient(_app(root), client=client, base_url=base)


def _app(root: Path) -> FastAPI:
    app = probe_app()
    app.state.workspace_handle = handle_for(root)
    return app


# --- who gets one ------------------------------------------------------------


def test_the_browser_on_this_machine_is_signed_in_without_typing_anything(
    workspace: Path,
) -> None:
    """#179's first acceptance criterion, at the level the server owns it."""
    with served(workspace) as client:
        assert client.get(SESSION_PATH).json() == {"issued": True}
        # No `Authorization` header anywhere in this request. The cookie the line
        # above set is in the client's jar and the browser sends it by itself.
        assert client.get(PROBE_PATH).status_code == 200


def test_a_client_on_the_network_is_not_signed_in(workspace: Path) -> None:
    """`--host 0.0.0.0` stays safe by default, and this is what makes it so.

    A real request from a real LAN address, through the real graph — the criterion
    asks for it verified rather than asserted, because a predicate tested in
    isolation proves nothing about which predicate the route calls.
    """
    with served(workspace, client=LAN) as client:
        answer = client.get(SESSION_PATH)
        assert answer.json() == {"issued": False}
        assert COOKIE_NAME not in answer.cookies
        assert client.get(PROBE_PATH).status_code == 401


def test_a_loopback_peer_reached_by_somebody_elses_name_is_not_signed_in(
    workspace: Path,
) -> None:
    """The DNS-rebinding case, and the reason the peer check is not enough alone.

    A page on `evil.com` that points the name at 127.0.0.1 connects *from*
    loopback: the peer says yes, and because the browser thinks the site is
    evil.com throughout, `SameSite=Strict` says yes too. The `Host` header is the
    one thing in the request the attacker's page cannot choose.
    """
    with served(workspace) as client:
        answer = client.get(SESSION_PATH, headers={"Host": "evil.example"})
        assert answer.json() == {"issued": False}
        assert COOKIE_NAME not in answer.cookies


def test_a_localhost_subdomain_is_this_machine(workspace: Path) -> None:
    """Browsers resolve `*.localhost` to loopback themselves, so it is not a name
    an attacker can point anywhere."""
    with served(workspace) as client:
        answer = client.get(SESSION_PATH, headers={"Host": "app.localhost"})
        assert answer.json() == {"issued": True}


@pytest.mark.parametrize("mode", ["always", "ALWAYS", " always "])
def test_always_signs_in_a_client_the_default_would_refuse(
    workspace: Path, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    """What the compose stack runs: behind a proxy, no request is ever loopback."""
    monkeypatch.setenv(MODE_ENV_VAR, mode)
    with served(workspace, client=LAN) as client:
        assert client.get(SESSION_PATH).json() == {"issued": True}
        assert client.get(PROBE_PATH).status_code == 200


def test_never_refuses_the_browser_on_this_machine(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(MODE_ENV_VAR, "never")
    with served(workspace) as client:
        assert client.get(SESSION_PATH).json() == {"issued": False}
        assert client.get(PROBE_PATH).status_code == 401


def test_a_typo_in_the_mode_narrows_rather_than_widens(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`alwyas` must not read as `always`, and must not take the server down.

    It is read while answering a request, so the failure mode of raising is a
    500 on a public route for a misspelt environment variable.
    """
    monkeypatch.setenv(MODE_ENV_VAR, "alwyas")
    with served(workspace, client=LAN) as client:
        assert client.get(SESSION_PATH).json() == {"issued": False}
    with served(workspace) as client:
        assert client.get(SESSION_PATH).json() == {"issued": True}


def test_a_server_with_no_workspace_issues_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """There is nowhere to keep the secret, which is the same answer as "no"."""
    monkeypatch.setenv("VISIONSET_WORKSPACE", str(tmp_path / "nothing-here"))
    monkeypatch.delenv(MODE_ENV_VAR, raising=False)
    app = probe_app()
    with TestClient(app, client=LOOPBACK, base_url=LOCAL_URL) as client:
        assert client.get(SESSION_PATH).json() == {"issued": False}


# --- the cookie itself -------------------------------------------------------


def test_the_cookie_is_httponly_samesite_strict_and_not_secure_over_http(
    workspace: Path,
) -> None:
    """Each flag is doing a job, and `Secure` is the one that must **not** be set.

    A `Secure` cookie is dropped by the browser over plain http — which is every
    loopback deployment there is — so setting it unconditionally would mean the
    cookie is issued, ignored, and the token form appears anyway with nothing
    anywhere saying why.
    """
    with served(workspace) as client:
        header = client.get(SESSION_PATH).headers["set-cookie"]
    assert header.startswith(f"{COOKIE_NAME}=")
    assert "HttpOnly" in header
    assert "SameSite=strict" in header.replace("samesite", "SameSite")
    assert "Path=/" in header
    assert "Secure" not in header


def test_the_cookie_is_secure_over_https(workspace: Path) -> None:
    with served(workspace, https=True) as client:
        assert "Secure" in client.get(SESSION_PATH).headers["set-cookie"]


def test_the_secret_is_a_file_in_the_workspace_readable_only_by_its_owner(
    workspace: Path,
) -> None:
    """`--reload` restarts the process on every edit; a secret that died with it
    would sign a developer out every time they saved."""
    with served(workspace) as client:
        client.get(SESSION_PATH)
    secret_file = workspace / SESSION_FILENAME
    assert secret_file.is_file()
    assert secret_file.stat().st_mode & 0o777 == 0o600


def test_a_restart_keeps_the_session(workspace: Path) -> None:
    """Two applications over one workspace, which is what a reload leaves behind."""
    with served(workspace) as first:
        first.get(SESSION_PATH)
        cookie = first.cookies[COOKIE_NAME]
    with served(workspace) as second:
        assert second.get(SESSION_PATH).cookies[COOKIE_NAME] == cookie
        assert second.get(PROBE_PATH).status_code == 200


def test_deleting_the_file_invalidates_the_session(workspace: Path) -> None:
    """The revocation mechanism, and the whole of it."""
    with served(workspace) as client:
        client.get(SESSION_PATH)
        assert client.get(PROBE_PATH).status_code == 200
        (workspace / SESSION_FILENAME).unlink()
        assert client.get(PROBE_PATH).status_code == 401


def test_a_session_is_not_a_row_in_the_token_table(workspace: Path) -> None:
    """`visionset token list` is the list of credentials somebody minted for
    something. A browser session is not one of those and must never appear there."""
    with served(workspace) as client:
        client.get(SESSION_PATH)
        assert client.get(PROBE_PATH).status_code == 200
    reopened = WorkspaceService.open(workspace)
    try:
        assert TokenService(reopened).list() == []
    finally:
        reopened.close()


# --- refusals stay indistinguishable -----------------------------------------


def test_a_wrong_cookie_is_the_same_401_as_no_credential_at_all(workspace: Path) -> None:
    """`docs/auth.md`'s no-oracle rule, extended to the second credential: the
    answer must not say which kind was rejected, or it says whether this server
    issues sessions at all."""
    with served(workspace) as client:
        nothing = client.get(PROBE_PATH)
        client.cookies.set(COOKIE_NAME, "not-the-secret")
        wrong = client.get(PROBE_PATH)
        client.cookies.clear()
        bad_token = client.get(PROBE_PATH, headers={"Authorization": "Bearer vst_nope"})
    assert nothing.status_code == wrong.status_code == bad_token.status_code == 401
    assert nothing.content == wrong.content == bad_token.content
    assert nothing.headers["www-authenticate"] == wrong.headers["www-authenticate"]


def test_a_token_still_authenticates_when_the_browser_holds_a_session(
    workspace: Path,
) -> None:
    """The bearer path is tried first, so a stale cookie can never shadow a
    credential somebody passed on purpose."""
    service = WorkspaceService.open(workspace)
    try:
        secret = TokenService(service).create("api").secret
    finally:
        service.close()
    with served(workspace) as client:
        client.cookies.set(COOKIE_NAME, "not-the-secret")
        answer = client.get(PROBE_PATH, headers={"Authorization": f"Bearer {secret}"})
    assert answer.status_code == 200
    assert answer.json() == {"token": secret}


# --- what it must not touch --------------------------------------------------


def test_asking_for_a_session_opens_no_workspace(workspace: Path) -> None:
    """A public route that opened the database could be made to run a migration —
    or to answer 500 `NOT_A_WORKSPACE` — by anyone who can reach the port."""
    app = probe_app()
    handle, opens = counting_handle(lambda: WorkspaceService.open(workspace))
    app.state.workspace_handle = handle
    with TestClient(app, client=LOOPBACK, base_url=LOCAL_URL) as client:
        assert client.get(SESSION_PATH).json() == {"issued": True}
    assert opens == [0]


def test_the_route_is_absent_from_the_contract() -> None:
    """The spec is what a *program* codes against, and a program authenticates
    with a token it minted. Keeping the route out of the schema is also what keeps
    the committed `openapi.json` and the generated client byte-identical."""
    assert SESSION_PATH not in exported_app.openapi()["paths"]
