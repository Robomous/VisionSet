"""The acceptance walk: every documented operation but `/health` needs a token.

With `/health` as the only operation this is vacuous — the
walk takes its public branch once and asserts nothing about authentication. A
protected route
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

from visionset.server import models
from visionset.server.dependencies import require_token
from visionset.server.main import app, create_app

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_every_documented_operation_except_health_requires_a_token() -> None:
    assert_every_operation_is_protected(app.openapi())


def test_the_committed_contract_declares_the_bearer_scheme() -> None:
    """The first protected route puts it there.

    FastAPI collects security definitions per *route*, from its dependency tree.
    Declaring ``bearer_scheme`` at module level emits nothing, so the scheme was
    absent for as long as zero routes depend on it — which is why the export
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

    Written before the first protected route, so its diff was a decision already
    reviewed. It
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


# ---------------------------------------------------------------------------
# Unknown fields on the way in
# ---------------------------------------------------------------------------
#
# `extra="forbid"` is what turns a client's typo into a 422 instead of a silent
# no-op, and it is a rule about *request* models specifically. Responses go the
# other way on purpose: `frontend/ui-core/src/data/check.ts` accepts unknown keys
# so that an additive, backward-compatible field cannot break a page.
#
# The roster is derived rather than written down. A hand-kept list is how four
# models came to sit outside a convention the other twenty-two follow with
# nothing to notice it — so the walk below starts at every `requestBody` in the
# contract and follows `$ref` all the way down, which reaches a nested model such
# as `SuggestPoint` that no route names directly.


def _referenced(node: Any, into: set[str]) -> None:
    """Every component schema `node` names, at any depth."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            into.add(ref.rsplit("/", 1)[1])
        for value in node.values():
            _referenced(value, into)
    elif isinstance(node, list):
        for value in node:
            _referenced(value, into)


def request_schemas(spec: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every object schema a caller can put in a request body, transitively.

    Enums and scalars are excluded because `additionalProperties` says nothing
    about them, and so are the bodies FastAPI *synthesises* for multipart routes
    — `Body_register_image_source` and its sibling are built from a handler's
    parameters rather than declared in ``server/models.py``, so there is no
    ``model_config`` to put the rule on. Membership is decided by asking that
    module, so a model added there is covered the day it is added.
    """
    schemas = spec["components"]["schemas"]

    seeds: set[str] = set()
    for _, _, operation in operations(spec):
        if body := operation.get("requestBody"):
            _referenced(body, seeds)

    reachable: set[str] = set()
    pending = list(seeds)
    while pending:
        name = pending.pop()
        if name in reachable or name not in schemas:
            continue
        reachable.add(name)
        nested: set[str] = set()
        _referenced(schemas[name], nested)
        pending.extend(nested)

    return {
        name: schemas[name]
        for name in sorted(reachable)
        if schemas[name].get("type") == "object" and hasattr(models, name)
    }


def test_the_request_walk_finds_the_models_routes_name_and_the_ones_they_nest() -> None:
    """The roster is non-empty and reaches past the models a route names.

    Without this the parametrised test below would pass by iterating nothing,
    which is the failure mode a derived roster is most prone to. `SuggestPoint`
    is the witness for depth: no route mentions it, `SuggestRequest` nests it.
    """
    found = set(request_schemas(app.openapi()))

    assert {"ProjectCreate", "SuggestRequest", "SuggestPoint", "AttributeBody"} <= found
    assert len(found) > 20
    # Synthesised multipart bodies are reachable and deliberately not covered.
    assert not [name for name in found if name.startswith("Body_")]


@pytest.mark.parametrize("name", sorted(request_schemas(app.openapi())))
def test_every_request_model_forbids_unknown_fields(name: str) -> None:
    """One rule, one roster, no model quietly outside it.

    A field a caller misspells has to be refused rather than dropped: accepted
    and ignored, the caller gets a 200 and the old value, with nothing anywhere
    saying the edit did not take.
    """
    assert request_schemas(app.openapi())[name].get("additionalProperties") is False, (
        f"{name} accepts unknown fields; every other request model forbids them"
    )


OPEN_MARKER = "x-visionset-open"


def _enum_names(spec: dict[str, Any]) -> set[str]:
    return {name for name, schema in spec["components"]["schemas"].items() if "enum" in schema}


def _reference_positions(spec: dict[str, Any], names: set[str]) -> dict[str, set[str]]:
    """Where each named schema is referenced: as an array item, or as anything else."""
    found: dict[str, set[str]] = {name: set() for name in names}

    def walk(node: Any, *, inside_items: bool) -> None:
        if isinstance(node, list):
            for entry in node:
                walk(entry, inside_items=inside_items)
            return
        if not isinstance(node, dict):
            return
        ref = node.get("$ref")
        if isinstance(ref, str):
            name = ref.rsplit("/", 1)[1]
            if name in found:
                found[name].add("array" if inside_items else "scalar")
        for key, value in node.items():
            if key == "$ref":
                continue
            walk(value, inside_items=key in {"items", "prefixItems"})

    walk(spec["paths"], inside_items=False)
    walk(spec["components"]["schemas"], inside_items=False)
    return found


def _request_reachable(spec: dict[str, Any]) -> set[str]:
    """Every component schema a request body *or parameter* can reach, transitively.

    Distinct from :func:`request_schemas`, which seeds only from bodies and keeps
    objects. Both differences matter here: an enum is not an object, and the one
    array-valued site of ``BackgroundJobState`` is a query parameter.
    """
    schemas = spec["components"]["schemas"]

    seeds: set[str] = set()
    for _, _, operation in operations(spec):
        if body := operation.get("requestBody"):
            _referenced(body, seeds)
        for parameter in operation.get("parameters", []):
            _referenced(parameter, seeds)

    reachable: set[str] = set()
    pending = list(seeds)
    while pending:
        name = pending.pop()
        if name in reachable or name not in schemas:
            continue
        reachable.add(name)
        nested: set[str] = set()
        _referenced(schemas[name], nested)
        pending.extend(nested)
    return reachable


def test_a_vocabulary_is_open_exactly_when_its_shape_allows_it() -> None:
    """The two-way gate on ``x-visionset-open``.

    An open vocabulary tolerates a member an older client never compiled against,
    and the generated client's check passes one rather than refusing the whole
    response. That is only safe where every consumer *filters* instead of
    switching — a list — and it is only honest where the server never *accepts*
    the value, because pydantic keeps refusing an unknown member inbound and a
    request field documented open would be a lie.

    So the rule is the conjunction, and both halves earn their keep:
    ``BackgroundJobState`` and ``GeometryType`` are each referenced as an array
    item — in a query parameter, and in two request bodies — and the request half
    is the only thing keeping them closed.

    Stated in both directions on purpose. A vocabulary that satisfies the shape
    and lacks the marker is the mistake nobody would notice: it costs an older
    client the whole response over one added member.
    """
    spec = app.openapi()
    names = _enum_names(spec)
    positions = _reference_positions(spec, names)
    inbound = _request_reachable(spec)

    wrong: list[str] = []
    for name in sorted(names):
        marked = spec["components"]["schemas"][name].get(OPEN_MARKER) is True
        eligible = positions[name] == {"array"} and name not in inbound
        if marked != eligible:
            wrong.append(
                f"{name}: marked={marked}, referenced as {sorted(positions[name])}, "
                f"request-reachable={name in inbound}"
            )
    assert wrong == [], "\n".join(wrong)


def test_the_open_set_is_the_eight_the_client_was_generated_for() -> None:
    """The roster, so growing the set is a decision somebody makes on purpose.

    The gate above derives membership from shape and would stay green if the
    contract grew a ninth. This one makes that arrive as a decision here, in the
    same review as the ``openapi.json`` diff and the widened union it produces in
    the generated client.
    """
    open_names = {
        name
        for name, schema in app.openapi()["components"]["schemas"].items()
        if schema.get(OPEN_MARKER) is True
    }

    assert open_names == {
        "AssetAction",
        "BatchAction",
        "ConnectionAction",
        "JobAction",
        "ModelCapability",
        "PreLabelExclusionReason",
        "SuggestParameter",
        "Task",
    }
