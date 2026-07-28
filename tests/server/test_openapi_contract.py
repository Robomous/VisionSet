"""The acceptance walk: every documented operation but `/health` needs a token.

It was vacuous when #25 committed it — `/health` was the only operation, so the
walk took its public branch once and asserted nothing about authentication. #27
landed nine protected operations and it now has something to say. The tests that
prove the walk can *fail* stay regardless: without them, "it passes" would be
indistinguishable from "it looks at nothing".

The walk only sees *documented* operations. `/docs`, `/redoc` and
`/openapi.json` are `include_in_schema=False` and stay public by decision: the
spec is already a committed artifact in a public repository, and a contract you
must authenticate to read is a contract nobody generates a client from.

This module also pins the parts of the contract that no single endpoint owns:
the security scheme, the page envelope's naming, and the fact that the committed
`openapi.json` is the application's own output.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import APIRouter, Depends
from tests.server._openapi import assert_every_operation_is_protected, operations
from tests.server._probe import probe_app

from visionset.server.dependencies import require_token
from visionset.server.main import app, create_app

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_every_documented_operation_except_health_requires_a_token() -> None:
    assert_every_operation_is_protected(app.openapi())


def test_the_committed_contract_declares_the_bearer_scheme() -> None:
    """#27's first protected route put it there, exactly as #25 predicted.

    FastAPI collects security definitions per *route*, from its dependency tree.
    Declaring ``bearer_scheme`` at module level emits nothing, so the scheme was
    absent for as long as zero routes depended on it — which is why #25's export
    was byte-identical and this was the first task to move ``openapi.json``.
    The shape is the one the probe app pinned a task earlier.
    """
    schemes = app.openapi()["components"]["securitySchemes"]
    assert set(schemes) == {"HTTPBearer"}
    assert (
        schemes["HTTPBearer"]
        == probe_app().openapi()["components"]["securitySchemes"]["HTTPBearer"]
    )


def test_the_committed_openapi_matches_the_application() -> None:
    """The drift gate, run where the mistake is actually made.

    CI has its own job for this. Duplicating it here is deliberate: this one
    fails during ``uv run pytest``, in the same command a contributor was already
    running, instead of ten minutes later on a push.
    """
    committed = json.loads((REPO_ROOT / "openapi.json").read_text())

    assert committed == json.loads(json.dumps(app.openapi())), (
        "openapi.json is stale — run 'uv run python scripts/export_openapi.py'"
    )


def test_the_page_envelope_is_named_for_its_item_type() -> None:
    """Never ``Page_ProjectOut_``, which is what a parametrised generic emits.

    A component name becomes a type name in a generated client, so the concrete
    subclasses in ``server/models.py`` exist for exactly this line.
    """
    schemas = app.openapi()["components"]["schemas"]

    assert {
        "AnnotationPage",
        "AssetPage",
        "BatchAssetPage",
        "BatchPage",
        "DatasetChangePage",
        "FormatPage",
        "IngestJobPage",
        "JobPage",
        "ProjectPage",
        "ReleasePage",
        "SchemaVersionPage",
        "SourcePage",
    } <= set(schemas)
    assert not [name for name in schemas if name.startswith("Page")]


def test_no_operation_id_is_used_twice() -> None:
    """``generate_unique_id_function`` uses the handler name, so this is not free.

    FastAPI's default is path-derived and unique by construction; the handler
    name is stable across a path change, which is what a generated client wants,
    at the cost of needing this assertion.
    """
    ids = [operation["operationId"] for _, _, operation in operations(app.openapi())]

    assert len(ids) == len(set(ids)), sorted(ids)


def test_every_documented_operation_but_health_is_tagged() -> None:
    """Tags group a generated client's methods, so an untagged route is homeless."""
    for path, method, operation in operations(app.openapi()):
        if path == "/health":
            continue
        assert operation.get("tags"), f"{method.upper()} {path}"


def test_a_protected_route_declares_the_bearer_scheme_and_its_401() -> None:
    spec = probe_app().openapi()
    operation = spec["paths"]["/probe/whoami"]["get"]
    assert operation["security"] == [{"HTTPBearer": []}]
    assert "401" in operation["responses"]
    assert_every_operation_is_protected(spec)


def test_the_bearer_scheme_enters_the_spec_with_this_exact_shape() -> None:
    """The definition of the shape, still proven without touching the real app.

    Written in #25 so the diff #27 committed was a decision already reviewed. It
    stays on the probe app: this is what the scheme *is*, and the assertion above
    is that the shipped contract agrees.
    """
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
