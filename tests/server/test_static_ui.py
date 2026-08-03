"""Where the compiled UI bundle lives, and what it is not allowed to break.

The bundle is a git-ignored build artifact — `pnpm bundle:static` copies
`frontend/app/dist/` into `src/visionset/_static/`, and CI never runs it — so a
test that needed the committed bundle could only ever pass on the machine that
built one. Every test here that wants a real bundle writes its own into
`tmp_path` and monkeypatches `static_root` **before** calling `create_app()`;
that is what the seam is for.

The three tests marked below as guards are the point of the file. Two shapes were
tried and rejected before this one, and each failed in a way no assertion in the
existing suite would have caught quickly:

*   a catch-all ``Mount("/")`` matches every path, so it beats the *partial*
    match that yields a 405, and it shadows every route added after
    `create_app()` returns — which is how every probe app in this directory is
    built. `/probe/whoami` became a 500.
*   ``StaticFiles(..., check_dir=False)`` only suppresses the check in the
    constructor. Starlette re-checks on the first request and raises
    `RuntimeError`, which this package's catch-all handler renders as a 500 with
    an incident id — for the ordinary state of a checkout nobody has built a
    bundle in.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._probe import PROBE_PATH, StubAuthProvider, stubbed_app

from visionset.server.main import (
    BUNDLE_COMMAND,
    INDEX_FILENAME,
    UI_PREFIX,
    create_app,
    static_root,
)

MARKER = "built-by-a-test"


def _bundle(root: Path) -> Path:
    """A minimal build in the shape Vite emits: an index and one hashed chunk."""
    (root / "assets").mkdir(parents=True)
    (root / INDEX_FILENAME).write_text(
        f'<!doctype html><title>{MARKER}</title><script src="/app/assets/app.js"></script>'
    )
    (root / "assets" / "app.js").write_text("export const marker = 'built';")
    return root


def _served(monkeypatch: pytest.MonkeyPatch, root: Path) -> TestClient:
    """The real ``create_app()``, pointed at a bundle a test wrote.

    Patched *before* the application is built, because the mount is constructed
    once and holds the directory it was given.
    """
    monkeypatch.setattr("visionset.server.main.static_root", lambda: root)
    return TestClient(create_app(), raise_server_exceptions=False)


@pytest.fixture()
def bundled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    return _served(monkeypatch, _bundle(tmp_path))


# --- serving it ---------------------------------------------------------------


def test_the_root_lands_on_the_bundle(bundled: TestClient) -> None:
    response = bundled.get("/", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/app/"


def test_the_index_is_served_under_the_prefix(bundled: TestClient) -> None:
    response = bundled.get("/app/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert MARKER in response.text


def test_a_hashed_chunk_is_served_under_the_prefix(bundled: TestClient) -> None:
    response = bundled.get("/app/assets/app.js")
    assert response.status_code == 200
    assert "javascript" in response.headers["content-type"]
    assert response.headers["etag"]


def test_the_prefix_without_its_slash_redirects_to_it(bundled: TestClient) -> None:
    """Starlette's own mount behaviour, asserted because the banner prints ``/``.

    A person who types the bare prefix gets the app rather than a 404, and it
    costs nothing — but it is behaviour this file inherits rather than writes, so
    it is worth pinning where somebody would look for it.
    """
    response = bundled.get("/app", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"].endswith("/app/")


# --- refusing things ----------------------------------------------------------


def test_an_unknown_file_under_the_prefix_speaks_the_one_error_body(bundled: TestClient) -> None:
    response = bundled.get("/app/nope.js")
    assert response.status_code == 404
    assert response.json() == {"code": "NOT_FOUND", "message": "Not Found", "detail": None}


def test_a_path_that_climbs_out_of_the_bundle_is_refused(bundled: TestClient) -> None:
    """Percent-encoded, because httpx normalises a literal ``..`` away before sending."""
    response = bundled.get("/app/%2e%2e/%2e%2e/etc/passwd")
    assert response.status_code == 404


def test_a_wrong_method_on_the_root_is_a_405(bundled: TestClient) -> None:
    response = bundled.post("/")
    assert response.status_code == 405
    assert response.json()["code"] == "METHOD_NOT_ALLOWED"


# --- the checkout with no bundle, which is what CI runs ------------------------


def test_the_root_names_the_command_that_builds_the_bundle_when_there_is_none(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The remedy is the message, because ``/app/``'s own 404 names nothing."""
    client = _served(monkeypatch, tmp_path)
    response = client.get("/")
    assert response.status_code == 404
    assert BUNDLE_COMMAND in response.json()["message"]


def test_an_application_builds_when_no_bundle_was_ever_copied_in() -> None:
    """No monkeypatch: the real ``_static/``, in whatever state this checkout has it.

    The guard for ``check_dir=False``. A missing bundle must be a 404 that names
    a remedy, never a `RuntimeError` surfacing as a 500 with an incident id — and
    the application must build at all, since ``scripts/export_openapi.py`` imports
    the module-level one in a checkout that has never seen ``pnpm``.
    """
    client = TestClient(create_app(), raise_server_exceptions=False)
    assert client.get("/health").status_code == 200

    response = client.get("/", follow_redirects=False)
    if (static_root() / INDEX_FILENAME).is_file():
        assert response.status_code == 307
    else:
        assert response.status_code == 404
        assert BUNDLE_COMMAND in response.json()["message"]


# --- what the mount is not allowed to break -----------------------------------


def test_adding_the_bundle_did_not_turn_a_wrong_method_into_a_404(bundled: TestClient) -> None:
    """The guard against a catch-all mount.

    ``Mount("/")`` full-matches every path, so it wins over the partial match
    that produces this 405. ``docs/api.md`` publishes 405 in its status table.
    """
    response = bundled.post("/health")
    assert response.status_code == 405
    assert response.json()["code"] == "METHOD_NOT_ALLOWED"


def test_a_route_added_after_the_application_was_built_is_still_reachable() -> None:
    """The other half of the same guard, and the one that bit hardest.

    Every probe app in this directory is ``create_app()`` followed by
    ``include_router``, so a root mount installed inside the factory shadows
    routes that do not exist yet. A 401 here means the route was found and
    refused the missing credential; a 404 would mean the mount ate it.

    ``stubbed_app`` rather than ``probe_app``, because ``get_auth_provider``
    depends on the workspace: a bare probe run from a directory that is not one
    answers 500 ``NOT_A_WORKSPACE`` before it ever reaches the credential, which
    is #25's documented consequence and not what this test is about.
    """
    with TestClient(stubbed_app(StubAuthProvider())) as client:
        assert client.get(PROBE_PATH).status_code == 401


def test_neither_the_root_nor_the_bundle_appears_in_the_contract() -> None:
    """``openapi.json`` is the REST contract; where a browser finds HTML is not.

    A ``Mount`` is never an operation, and ``/`` is ``include_in_schema=False``.
    Together that is what keeps the drift gate and ``pnpm generate:client`` still
    across this whole change.
    """
    paths = create_app().openapi()["paths"]
    assert "/" not in paths
    assert not [path for path in paths if path.startswith("/app")]


def test_serving_the_bundle_opens_no_workspace(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Static files are not workspace state, and asking for them must not open one."""
    monkeypatch.setattr("visionset.server.main.static_root", lambda: _bundle(tmp_path))
    app = create_app()
    with TestClient(app) as client:
        assert client.get("/app/").status_code == 200
    assert app.state.workspace_handle.is_open is False


# --- the single-page deep-link fallback (#58) ---------------------------------


HTML = {"accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}
"""What a browser sends on a navigation. The whole rule turns on this header."""


def test_a_client_route_under_the_prefix_serves_the_index_so_a_reload_works(
    bundled: TestClient,
) -> None:
    """The deferral #33 wrote into ``_install_ui``'s docstring, discharged.

    ``/app/projects/abc`` is a route the router resolves in the browser; a reload on
    it is a real request for a path no file backs. Without this, refreshing any page
    but the index is a 404 — and so is every bookmark.
    """
    response = bundled.get("/app/projects/abc", headers=HTML)
    assert response.status_code == 200
    assert MARKER in response.text


def test_the_fallback_answers_200_rather_than_404_with_a_body(bundled: TestClient) -> None:
    """A page that renders correctly must not claim to be missing.

    A 404 status under a working document is a lie every crawler and every error
    reporter believes.
    """
    assert bundled.get("/app/anything/at/all", headers=HTML).status_code == 200


def test_a_client_that_does_not_claim_to_be_a_browser_still_gets_the_json_404(
    bundled: TestClient,
) -> None:
    """httpx sends ``*/*``, which is exactly why the substring test is the rule.

    Every other test in ``tests/server`` needed no change for this feature, and that
    is the evidence rather than a claim: an API client never asks for ``text/html``.
    """
    response = bundled.get("/app/projects/abc")
    assert response.status_code == 404
    assert response.json() == {"code": "NOT_FOUND", "message": "Not Found", "detail": None}


def test_the_api_keeps_its_own_404_even_for_a_browser(bundled: TestClient) -> None:
    """The API owns the root, so the fallback claims one prefix and nothing else.

    Answering HTML for an unknown ``/projects/nope`` would hide a real refusal from a
    client that mistyped a route — the same argument that put the bundle at ``/app``.
    """
    response = bundled.get("/no-such-route", headers=HTML)
    assert response.status_code == 404
    assert response.json() == {"code": "NOT_FOUND", "message": "Not Found", "detail": None}


def test_a_wrong_method_on_a_client_route_is_not_a_page_load(bundled: TestClient) -> None:
    response = bundled.post("/app/projects/abc", headers=HTML)
    assert response.status_code != 200


def test_a_405_is_still_a_405_for_a_browser(bundled: TestClient) -> None:
    """The fallback narrows on the status too, or every wrong method would render."""
    response = bundled.post("/", headers=HTML)
    assert response.status_code == 405
    assert response.json()["code"] == "METHOD_NOT_ALLOWED"


def test_a_checkout_with_no_bundle_does_not_pretend_to_have_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """``index.is_file()`` is checked per request, not at startup.

    ``_static/`` always exists — that is what makes the mount unconditional — but in
    a source checkout it holds only ``README.md``. Serving a file that is not there
    would be a ``RuntimeError`` inside an exception handler, which is the worst place
    in the application to raise one.
    """
    client = _served(monkeypatch, tmp_path)
    assert client.get("/app/projects/abc", headers=HTML).status_code == 404


def test_the_fallback_did_not_reach_the_contract() -> None:
    """An exception handler is not an operation, so both drift gates stay still."""
    spec = create_app().openapi()
    assert not any(path.startswith(UI_PREFIX) for path in spec["paths"])
