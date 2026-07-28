"""The acceptance walk: every documented operation but `/health` needs a token.

**Vacuous today, and deliberately committed anyway.** `/health` is the only
operation in the contract, so the walk takes its public branch once and asserts
nothing about authentication. It is a tripwire, not a check: it fires the moment
a route lands that did not come from `protected_router()`. The tests that prove
the walk can *fail* are what make a vacuous assertion worth having — without
them, "it passes" would be indistinguishable from "it looks at nothing".

The walk only sees *documented* operations. `/docs`, `/redoc` and
`/openapi.json` are `include_in_schema=False` and stay public by decision: the
spec is already a committed artifact in a public repository, and a contract you
must authenticate to read is a contract nobody generates a client from.
"""

from typing import Any

import pytest
from fastapi import APIRouter, Depends
from tests.server._openapi import assert_every_operation_is_protected, operations
from tests.server._probe import probe_app

from visionset.server.dependencies import require_token
from visionset.server.main import app, create_app


def test_every_documented_operation_except_health_requires_a_token() -> None:
    assert_every_operation_is_protected(app.openapi())


def test_the_committed_contract_has_no_security_scheme_yet() -> None:
    """Nothing is protected yet, so the scheme is not in the spec — by design.

    FastAPI collects security definitions per *route*, from its dependency tree.
    Declaring ``bearer_scheme`` at module level emits nothing; the scheme enters
    ``components`` with the first route that depends on it, which is why this PR
    moves ``openapi.json`` not at all and the first endpoint task moves it twice.
    """
    assert "securitySchemes" not in app.openapi().get("components", {})


def test_a_protected_route_declares_the_bearer_scheme_and_its_401() -> None:
    spec = probe_app().openapi()
    operation = spec["paths"]["/probe/whoami"]["get"]
    assert operation["security"] == [{"HTTPBearer": []}]
    assert "401" in operation["responses"]
    assert_every_operation_is_protected(spec)


def test_the_bearer_scheme_enters_the_spec_with_this_exact_shape() -> None:
    """Pinned here so the diff #27 commits is a decision already reviewed."""
    schemes = probe_app().openapi()["components"]["securitySchemes"]
    assert set(schemes) == {"HTTPBearer"}
    assert schemes["HTTPBearer"]["type"] == "http"
    assert schemes["HTTPBearer"]["scheme"] == "bearer"
    assert "visionset token create" in schemes["HTTPBearer"]["description"]


def test_the_walk_catches_a_route_that_forgot_the_token() -> None:
    """The failure this tripwire exists for: a route mounted the plain way."""
    leaky = create_app()

    @leaky.get("/leak")
    def leak() -> dict[str, bool]:
        return {"ok": True}

    with pytest.raises(AssertionError, match="declares no bearer security"):
        assert_every_operation_is_protected(leaky.openapi())


def test_the_walk_catches_a_protected_route_that_does_not_document_its_401() -> None:
    """Guarded but undocumented is still a lie in the contract.

    Which is why ``protected_router()`` carries the dependency and the 401
    together rather than leaving the second to each route.
    """
    undocumented = create_app()
    router = APIRouter(dependencies=[Depends(require_token)])

    @router.get("/quiet")
    def quiet() -> dict[str, bool]:
        return {"ok": True}

    undocumented.include_router(router)

    with pytest.raises(AssertionError, match="does not document its 401"):
        assert_every_operation_is_protected(undocumented.openapi())


def test_the_walk_catches_a_public_route_that_should_not_be_public() -> None:
    """``/health`` is exempt because it is listed, not because it is unguarded."""
    spec: dict[str, Any] = {
        "paths": {"/health": {"get": {"security": [{"HTTPBearer": []}], "responses": {}}}}
    }
    with pytest.raises(AssertionError, match="is public but declares security"):
        assert_every_operation_is_protected(spec)


def test_the_walk_skips_non_operation_keys_in_a_path_item() -> None:
    """OpenAPI allows them; a walk that assumed otherwise would raise, not fail.

    FastAPI emits none today, which is exactly why this is asserted against a
    hand-built spec rather than against the application.
    """
    spec: dict[str, Any] = {
        "paths": {
            "/health": {
                "summary": "not an operation",
                "parameters": [{"name": "trace", "in": "query"}],
                "get": {"responses": {}},
            }
        }
    }
    assert [method for _, method, _ in operations(spec)] == ["get"]
    assert_every_operation_is_protected(spec)
