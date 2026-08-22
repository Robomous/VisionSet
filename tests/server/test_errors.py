"""The API error contract: the table is exhaustive, and the handlers obey it.

Behaviour is exercised on throwaway probe apps, the pattern ``test_health.py``
established: mounting routes that raise on the real ``app`` would put them in
``openapi.json`` and trip the CI drift gate.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel
from tests.server._openapi import operations
from tests.server._probe import PROBE_PATH, StubAuthProvider, stubbed_app

from visionset.kernel import (
    AssetNotInJob,
    CorruptMedia,
    MediaToolUnavailable,
    ProjectNotFound,
    VisionSetError,
    WorkspaceBusy,
    WorkspaceCorrupt,
)
from visionset.kernel import errors as kernel_errors
from visionset.server.errors import (
    ERROR_RESPONSES,
    ERROR_RULES,
    OPAQUE_MESSAGE,
    RETRY_AFTER_SECONDS,
    UNMAPPED_CODE,
    ErrorBody,
    ErrorRule,
    documented,
    error_response,
    install_error_handlers,
    rule_for,
)
from visionset.server.main import app

# --- the table ------------------------------------------------------------

# Class name -> (status, code). Written out rather than computed, so a status
# change is a readable diff in a review instead of a silent one.
EXPECTED: dict[str, tuple[int, str]] = {
    # 404 — the caller named something that is not there
    "ProjectNotFound": (404, "PROJECT_NOT_FOUND"),
    "SchemaNotFound": (404, "SCHEMA_NOT_FOUND"),
    "SchemaDraftNotFound": (404, "SCHEMA_DRAFT_NOT_FOUND"),
    "BatchNotFound": (404, "BATCH_NOT_FOUND"),
    "JobNotFound": (404, "JOB_NOT_FOUND"),
    "IngestJobNotFound": (404, "INGEST_JOB_NOT_FOUND"),
    "BackgroundJobNotFound": (404, "BACKGROUND_JOB_NOT_FOUND"),
    "AssetNotFound": (404, "ASSET_NOT_FOUND"),
    "SourceNotFound": (404, "SOURCE_NOT_FOUND"),
    "DatasetNotFound": (404, "DATASET_NOT_FOUND"),
    "AnnotationNotFound": (404, "ANNOTATION_NOT_FOUND"),
    "ReleaseNotFound": (404, "RELEASE_NOT_FOUND"),
    "TokenNotFound": (404, "TOKEN_NOT_FOUND"),
    "InferenceConnectionNotFound": (404, "INFERENCE_CONNECTION_NOT_FOUND"),
    "AssetNotInBatch": (422, "ASSET_NOT_IN_BATCH"),
    "AssetNotInJob": (404, "ASSET_NOT_IN_JOB"),
    "AssetNotInDataset": (404, "ASSET_NOT_IN_DATASET"),
    "NoSplitRecipe": (404, "NO_SPLIT_RECIPE"),
    "ExportFormatNotFound": (404, "EXPORT_FORMAT_NOT_FOUND"),
    # A release naming bytes an export cannot use. 409 rather than 500 for
    # `UnserializableManifest`'s reason — the request is fine, the stored state is
    # not — so the message naming the asset reaches the caller.
    "ExportSourceUnreadable": (409, "EXPORT_SOURCE_UNREADABLE"),
    "InferenceConnectionNotDownloadable": (409, "INFERENCE_CONNECTION_NOT_DOWNLOADABLE"),
    "InferenceConnectionNotCheckable": (409, "INFERENCE_CONNECTION_NOT_CHECKABLE"),
    "InferenceConnectionNotTestable": (409, "INFERENCE_CONNECTION_NOT_TESTABLE"),
    "InferenceEndpointUnavailable": (502, "INFERENCE_ENDPOINT_UNAVAILABLE"),
    "WeightsDamaged": (409, "WEIGHTS_DAMAGED"),
    "InferenceConnectionNotSetUp": (409, "INFERENCE_CONNECTION_NOT_SET_UP"),
    "ThumbnailNotCached": (404, "THUMBNAIL_NOT_CACHED"),
    # 409 — well-formed request, the resource's state refuses it
    "ProjectNameTaken": (409, "PROJECT_NAME_TAKEN"),
    "ReleaseTagTaken": (409, "RELEASE_TAG_TAKEN"),
    "TokenNameTaken": (409, "TOKEN_NAME_TAKEN"),
    "InferenceConnectionNameTaken": (409, "INFERENCE_CONNECTION_NAME_TAKEN"),
    "WorkspaceAlreadyExists": (409, "WORKSPACE_ALREADY_EXISTS"),
    "WorkspaceNotEmpty": (409, "WORKSPACE_NOT_EMPTY"),
    "SchemaVersionConflict": (409, "SCHEMA_VERSION_CONFLICT"),
    "InvalidTransition": (409, "INVALID_TRANSITION"),
    "StaleWrite": (409, "STALE_WRITE"),
    "BatchNotEditable": (409, "BATCH_NOT_EDITABLE"),
    "BatchNotInAnnotation": (409, "BATCH_NOT_IN_ANNOTATION"),
    "JobFinished": (409, "JOB_FINISHED"),
    "BatchImmutable": (409, "BATCH_IMMUTABLE"),
    "AssetNotWritable": (409, "ASSET_NOT_WRITABLE"),
    "BatchNotComplete": (409, "BATCH_NOT_COMPLETE"),
    "JobNotComplete": (409, "JOB_NOT_COMPLETE"),
    "EmptyBatch": (409, "EMPTY_BATCH"),
    "EmptyRelease": (409, "EMPTY_RELEASE"),
    "ReleaseContentWouldViolateSchema": (409, "RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA"),
    "ConfirmationRequired": (409, "CONFIRMATION_REQUIRED"),
    "DestructiveSchemaChange": (409, "DESTRUCTIVE_SCHEMA_CHANGE"),
    "SchemaChangeWouldOrphan": (409, "SCHEMA_CHANGE_WOULD_ORPHAN"),
    "SchemaHasNoDetectableClass": (409, "SCHEMA_HAS_NO_DETECTABLE_CLASS"),
    "UnserializableManifest": (409, "UNSERIALIZABLE_MANIFEST"),
    "LossyExportNotConsented": (409, "LOSSY_EXPORT_NOT_CONSENTED"),
    # 422 — the payload itself is wrong
    "AnnotationNotFromModel": (422, "ANNOTATION_NOT_FROM_MODEL"),
    "InvalidName": (422, "INVALID_NAME"),
    "InferenceConnectionInvalid": (422, "INFERENCE_CONNECTION_INVALID"),
    "InvalidSchema": (422, "INVALID_SCHEMA"),
    "UnsupportedGeometry": (422, "UNSUPPORTED_GEOMETRY"),
    "InvalidAnnotation": (422, "INVALID_ANNOTATION"),
    "LabelClassNotInSchema": (422, "LABEL_CLASS_NOT_IN_SCHEMA"),
    "DisallowedGeometry": (422, "DISALLOWED_GEOMETRY"),
    "AnnotationGeometryOutOfBounds": (422, "ANNOTATION_GEOMETRY_OUT_OF_BOUNDS"),
    "DuplicateClassificationTag": (422, "DUPLICATE_CLASSIFICATION_TAG"),
    "MissingRequiredAttribute": (422, "MISSING_REQUIRED_ATTRIBUTE"),
    "UnknownAttribute": (422, "UNKNOWN_ATTRIBUTE"),
    "InvalidAttributeValue": (422, "INVALID_ATTRIBUTE_VALUE"),
    "InvalidPartition": (422, "INVALID_PARTITION"),
    "UnknownJobType": (422, "UNKNOWN_JOB_TYPE"),
    "MediaError": (422, "MEDIA_ERROR"),
    "UnsupportedMedia": (422, "UNSUPPORTED_MEDIA"),
    "CorruptMedia": (422, "CORRUPT_MEDIA"),
    "UnsupportedPrompt": (422, "UNSUPPORTED_PROMPT"),
    "PromptPointOutOfBounds": (422, "PROMPT_POINT_OUT_OF_BOUNDS"),
    # 503 — transient, and a wait genuinely helps
    "WorkspaceBusy": (503, "WORKSPACE_BUSY"),
    # 5xx — nothing the caller can fix
    "WorkspaceCorrupt": (500, "WORKSPACE_CORRUPT"),
    "NotAWorkspace": (500, "NOT_A_WORKSPACE"),
    "WorkspaceFormatTooNew": (500, "WORKSPACE_FORMAT_TOO_NEW"),
    "WorkspaceSchemaMismatch": (500, "WORKSPACE_SCHEMA_MISMATCH"),
    "EntityNotFound": (500, "ENTITY_NOT_FOUND"),
    "EntityAlreadyExists": (500, "ENTITY_ALREADY_EXISTS"),
    "ConstraintViolated": (500, "CONSTRAINT_VIOLATED"),
    "MediaToolUnavailable": (500, "MEDIA_TOOL_UNAVAILABLE"),
    "LocalInferenceUnavailable": (500, "LOCAL_INFERENCE_UNAVAILABLE"),
    "InferenceOutOfMemory": (500, "INFERENCE_OUT_OF_MEMORY"),
    "InferenceConnectionNotRunnable": (500, "INFERENCE_CONNECTION_NOT_RUNNABLE"),
}

# A code outlives the class name it was derived from. Rename a class and its
# code stays put: add the class here, do not change the string clients read.
RENAMED: dict[str, str] = {}


def declared_errors() -> dict[str, type[VisionSetError]]:
    """Every error class declared in ``kernel/errors.py``, base included.

    Read off the module rather than ``VisionSetError.__subclasses__()``: that
    only sees classes something has imported, and it also sees subclasses
    defined in other test modules, so the answer would depend on collection
    order.
    """
    return {
        name: obj
        for name, obj in vars(kernel_errors).items()
        if inspect.isclass(obj) and issubclass(obj, VisionSetError)
    }


def screaming_snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).upper()


def test_every_kernel_error_is_mapped_and_the_base_is_not() -> None:
    declared = set(declared_errors()) - {"VisionSetError"}
    assert {cls.__name__ for cls in ERROR_RULES} == declared
    # The base stays out so an unmapped error cannot inherit an answer and pass
    # this test by accident.
    assert VisionSetError not in ERROR_RULES


def test_the_status_and_code_of_every_error() -> None:
    resolved = {name: (rule.status, rule.code) for name, rule in _rules_by_name().items()}
    assert resolved == EXPECTED


def test_codes_are_unique() -> None:
    codes = [rule.code for rule in ERROR_RULES.values()]
    assert len(set(codes)) == len(codes)


def test_codes_still_match_their_class_names() -> None:
    drifted = {
        name: rule.code
        for name, rule in _rules_by_name().items()
        if name not in RENAMED and rule.code != screaming_snake(name)
    }
    assert drifted == {}


def test_every_mapped_error_can_be_constructed_with_one_argument() -> None:
    # ``MediaError`` is the only kernel error with a constructor; a second one
    # would break every caller that raises by message alone, this walk included.
    for cls in ERROR_RULES:
        assert isinstance(cls("boom"), VisionSetError)


def test_only_transient_errors_carry_a_retry_after() -> None:
    assert {cls.__name__ for cls, rule in ERROR_RULES.items() if rule.retry_after} == {
        "WorkspaceBusy"
    }


def test_message_exposure_is_opt_in_and_only_for_5xx() -> None:
    exposed = {cls.__name__ for cls, rule in ERROR_RULES.items() if rule.expose_message}
    assert exposed == {
        "WorkspaceBusy",
        "WorkspaceFormatTooNew",
        # A workspace whose schema is not the one it is stamped at. Opaque,
        # this is a 500 naming no cause on a route with no connection to the
        # problem, and the answer is only in the server's log — which was the
        # complaint. The message names the table and column instead.
        "WorkspaceSchemaMismatch",
        "MediaToolUnavailable",
        # The two deployment conditions inference can hit. Both
        # carry a remedy nobody can reconstruct from a generic sentence — the
        # exact `pip install` for one, and which connection kind this build has
        # no adapter for in the other — which is `MediaToolUnavailable`'s stated
        # licence and the only one this list takes.
        "LocalInferenceUnavailable",
        "InferenceConnectionNotRunnable",
        # The third condition of the machine rather than of the request. Its
        # message names the device that filled up and the ways off it, which is
        # a remedy nobody can reconstruct from a generic 500.
        "InferenceOutOfMemory",
        # The only 502 in the table, and exposed for the same reason as its
        # neighbours: the message names the endpoint and what it did, which is
        # the whole remedy.
        "InferenceEndpointUnavailable",
    }
    assert all(rule.status >= 500 for rule in ERROR_RULES.values() if rule.expose_message)


def test_rule_for_walks_the_mro() -> None:
    class Custom(ProjectNotFound):
        """A subclass declared outside kernel/errors.py inherits the family's answer."""

    rule = rule_for(Custom("x"))
    assert rule is not None
    assert (rule.status, rule.code) == (404, "PROJECT_NOT_FOUND")


def test_rule_for_declines_an_exception_it_does_not_know() -> None:
    assert rule_for(RuntimeError("x")) is None


def _rules_by_name() -> dict[str, ErrorRule]:
    return {cls.__name__: rule for cls, rule in ERROR_RULES.items()}


# --- the table, as the document publishes it ------------------------------

# ``docs/content/api.md`` is where a client author reads the inventory, and until now
# nothing held it to the code. It fell nineteen codes behind before anybody
# noticed, and syncing it was never the fix: an ungated mirror is a second
# spelling waiting to drift. These tests are the same exact-correspondence
# construction as ``test_the_status_and_code_of_every_error`` above, with the
# markdown as the other side — ``frontend/ui-core/src/tokens.test.ts`` is the
# precedent for holding a *document* this way. cf. #524.

DOCS = Path(__file__).resolve().parents[2] / "docs" / "content" / "api.md"

# The five codes the document lists that ``ERROR_RULES`` does not hold. None of
# them has a kernel class to map: FastAPI raises the first, Starlette's router
# the next two, the auth guard the fourth, and the last is what an exception no
# rule covers becomes. The document is the only place they are written down,
# which is why they are named here rather than derived.
FRAMEWORK_CODES = {
    "VALIDATION_ERROR",
    "NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "UNAUTHORIZED",
    "INTERNAL_ERROR",
}


def test_every_error_rule_appears_in_the_documented_table() -> None:
    documented = _documented_codes()
    undocumented = {(rule.code, rule.status) for rule in ERROR_RULES.values()} - documented
    assert undocumented == set()


def test_every_documented_code_still_exists() -> None:
    mapped = {(rule.code, rule.status) for rule in ERROR_RULES.values()}
    stale = {pair for pair in _documented_codes() if pair[0] not in FRAMEWORK_CODES} - mapped
    assert stale == set()


def test_the_published_message_table_matches_expose_message() -> None:
    published = set(
        re.findall(r"^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|", _section("The 5xx contract"), re.MULTILINE)
    )
    assert published == {rule.code for rule in ERROR_RULES.values() if rule.expose_message}


def _section(heading: str) -> str:
    """The body under a ``##`` heading, up to the next one of that level."""
    text = DOCS.read_text(encoding="utf-8")
    marker = f"\n## {heading}\n"
    if marker not in text:
        raise AssertionError(f"docs/content/api.md no longer has a '## {heading}' section")
    return re.split(r"^## ", text.split(marker, 1)[1], maxsplit=1, flags=re.MULTILINE)[0]


def _documented_codes() -> set[tuple[str, int]]:
    """``(code, status)`` pairs read off the status rows of the full table.

    Pairs rather than a mapping, so one code listed under two statuses arrives
    as two members and is caught, instead of one silently overwriting the other.
    """
    pairs: set[tuple[str, int]] = set()
    for line in _section("The full table").splitlines():
        row = re.match(r"\|\s*\*\*(\d{3})\*\*\s*\|(.+)\|", line)
        if row is None:
            continue
        status = int(row.group(1))
        pairs.update((code, status) for code in re.findall(r"`([A-Z][A-Z0-9_]+)`", row.group(2)))
    # An empty parse would make the second test vacuous — a deleted or reshaped
    # table must be a failure, not a gate that quietly stops guarding anything.
    if not pairs:
        raise AssertionError("the full table in docs/content/api.md parsed as no codes at all")
    return pairs


# --- the handlers ---------------------------------------------------------


class Payload(BaseModel):
    count: int


@pytest.fixture()
def probe() -> Iterator[TestClient]:
    """A throwaway app carrying one route per error path under test."""
    probe_app = FastAPI()
    install_error_handlers(probe_app)

    @probe_app.get("/missing")
    async def missing() -> None:
        raise ProjectNotFound("no project 'x'")

    @probe_app.get("/busy")
    async def busy() -> None:
        raise WorkspaceBusy("the workspace is held by another writer")

    @probe_app.get("/corrupt")
    async def corrupt() -> None:
        raise WorkspaceCorrupt("/srv/data/visionset.db is not a database")

    @probe_app.get("/no-ffmpeg")
    async def no_ffmpeg() -> None:
        raise MediaToolUnavailable("ffmpeg is not installed; brew install ffmpeg")

    @probe_app.get("/bad-media")
    async def bad_media() -> None:
        raise CorruptMedia("truncated at byte 12", name="/srv/incoming/clip.mp4")

    @probe_app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("a bug with a revealing message")

    @probe_app.get("/override")
    async def override() -> None:
        # The escape hatch: the same error is a 404 addressed as a sub-resource
        # and a 422 when the id arrived in a request body.
        return error_response(AssetNotInJob("asset 7 is not in this job"), status=422)

    @probe_app.post("/typed")
    async def typed(payload: Payload) -> dict[str, int]:
        return {"count": payload.count}

    # ``raise_server_exceptions=False`` is required: ServerErrorMiddleware always
    # re-raises after running the Exception handler, so the default client would
    # see the exception instead of the response.
    with TestClient(probe_app, raise_server_exceptions=False) as client:
        yield client


def test_a_domain_error_becomes_its_mapped_status_and_code(probe: TestClient) -> None:
    response = probe.get("/missing")
    assert response.status_code == 404
    assert response.json() == {
        "code": "PROJECT_NOT_FOUND",
        "message": "no project 'x'",
        "detail": None,
    }


def test_a_4xx_body_validates_as_the_declared_schema(probe: TestClient) -> None:
    assert ErrorBody.model_validate(probe.get("/missing").json()).code == "PROJECT_NOT_FOUND"


def test_workspace_busy_is_a_503_that_says_when_to_come_back(probe: TestClient) -> None:
    response = probe.get("/busy")
    assert response.status_code == 503
    assert response.headers["Retry-After"] == str(RETRY_AFTER_SECONDS)
    # Transient and actionable, so the message is exposed rather than swallowed.
    assert response.json()["message"] == "the workspace is held by another writer"


def test_a_mapped_500_is_opaque_but_keeps_its_code(
    probe: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level("ERROR"):
        response = probe.get("/corrupt")
    assert response.status_code == 500
    body = response.json()
    assert body["code"] == "WORKSPACE_CORRUPT"
    assert body["message"] == OPAQUE_MESSAGE
    assert "visionset.db" not in response.text  # the server's own path stays server-side
    incident_id = body["detail"]["incident_id"]
    # The message the client did not get is the one an operator greps for.
    assert incident_id in caplog.text
    assert "is not a database" in caplog.text


def test_an_error_whose_message_is_the_remedy_opts_out_of_opacity(probe: TestClient) -> None:
    response = probe.get("/no-ffmpeg")
    assert response.status_code == 500
    assert "brew install ffmpeg" in response.json()["message"]
    assert response.json()["detail"]["incident_id"]  # still incident-tracked


def test_a_media_error_reports_its_reason_and_never_its_path(probe: TestClient) -> None:
    response = probe.get("/bad-media")
    assert response.status_code == 422
    assert response.json()["detail"] == {"reason": "truncated at byte 12"}
    # ``str(exc)`` is "<name>: <reason>", so the message has to be the reason
    # alone — dropping the name from ``detail`` and leaving it here would hide
    # nothing at all.
    assert response.json()["message"] == "truncated at byte 12"
    assert "/srv/incoming" not in response.text


def test_an_unmapped_exception_is_a_500_that_reveals_nothing(probe: TestClient) -> None:
    response = probe.get("/boom")
    assert response.status_code == 500
    body = response.json()
    assert body["code"] == UNMAPPED_CODE
    assert body["message"] == OPAQUE_MESSAGE
    assert "revealing" not in response.text
    assert "Traceback" not in response.text


def test_a_route_may_override_the_table_without_losing_the_code(probe: TestClient) -> None:
    response = probe.get("/override")
    assert response.status_code == 422
    assert response.json()["code"] == "ASSET_NOT_IN_JOB"


def test_a_validation_failure_speaks_the_same_schema(probe: TestClient) -> None:
    response = probe.post("/typed", json={"count": "not a number"})
    assert response.status_code == 422
    body = ErrorBody.model_validate(response.json())
    assert body.code == "VALIDATION_ERROR"
    assert body.detail is not None
    assert body.detail["errors"]


def test_an_unknown_path_speaks_the_same_schema(probe: TestClient) -> None:
    # Starlette's router raises its *own* HTTPException here; a handler keyed on
    # fastapi's subclass would leave this answering {"detail": "Not Found"}.
    response = probe.get("/nothing-here")
    assert response.status_code == 404
    assert response.json() == {"code": "NOT_FOUND", "message": "Not Found", "detail": None}


def test_a_wrong_method_speaks_the_same_schema(probe: TestClient) -> None:
    response = probe.post("/missing")
    assert response.status_code == 405
    assert response.json()["code"] == "METHOD_NOT_ALLOWED"


# --- the 401 -------------------------------------------------------------


def test_a_401_carries_the_error_body_and_keeps_its_challenge() -> None:
    """Unchanged from when the provider was a module global, and asserted so.

    Built on a real ``create_app()`` probe now that ``require_token`` resolves
    its provider through the dependency graph; every assertion below is verbatim
    what this test made before that move, which is what proves the reshuffle
    changed no behaviour.

    The provider is stubbed rather than real because ``get_auth_provider``
    depends on ``get_workspace``: with no workspace configured the sub-dependency
    fails first and the answer is a 500, not a 401. ``test_auth.py`` covers that
    ordering deliberately; here it would only be in the way.
    """
    response = TestClient(stubbed_app(StubAuthProvider())).get(PROBE_PATH)
    assert response.status_code == 401
    assert response.json() == {
        "code": "UNAUTHORIZED",
        "message": "Invalid or missing bearer token",
        "detail": None,
    }
    # The challenge survives the reshaping — that is the whole reason the
    # handler forwards ``exc.headers``.
    assert response.headers["WWW-Authenticate"] == "Bearer"


# --- the contract in openapi.json ----------------------------------------


def test_the_error_body_is_the_only_error_schema_in_the_contract() -> None:
    schemas = app.openapi()["components"]["schemas"]
    assert "ErrorBody" in schemas
    # Declaring 422 at app level displaces FastAPI's generated model. If this
    # ever comes back, some route is documenting a second error shape.
    assert "HTTPValidationError" not in schemas
    assert "ValidationError" not in schemas


def test_every_route_documents_the_universal_error_responses() -> None:
    """Walked through the shared helper, which knows what an operation is.

    The hand-rolled loop this replaced iterated *every* key under a path item.
    OpenAPI allows non-operation keys there — ``parameters``, ``summary`` — and
    FastAPI emits none of them today, so it passed; the day one appeared it would
    have raised ``KeyError`` instead of failing with a sentence. ``_openapi.py``
    now owns that definition for both walks over this table.
    """
    for path, method, operation in operations(app.openapi()):
        declared = set(operation["responses"])
        assert {"422", "500", "503"} <= declared, f"{method.upper()} {path}"


@pytest.mark.parametrize("status", [401, 422, 500, 503])
def test_documented_refuses_a_status_no_route_owns(status: int) -> None:
    """The companion to the test above, which cannot tell provenance apart.

    That one proves every operation *declares* 422/500/503; it passes whether
    the app supplied them or a route repeated them. Seven routes repeated 422
    for as long as this file has existed, and nothing disagreed.
    """
    with pytest.raises(ValueError, match=str(status)):
        documented(status)


def test_documented_still_answers_the_statuses_a_route_does_own() -> None:
    assert documented(404, 409) == {404: ERROR_RESPONSES[404], 409: ERROR_RESPONSES[409]}
