# usage: from visionset.server.errors import ErrorBody, install_error_handlers
"""The API's error contract: one body, one table, one renderer.

Every error a client can receive — a kernel domain error, a framework
``HTTPException``, a request-validation failure, or an unhandled bug — is
rendered by :func:`error_response` into one :class:`ErrorBody`. Nothing in this
package may invent a second error shape.

**Clients branch on ``code``, never on the status.** Statuses are coarse by
design: ``DestructiveSchemaChange`` and ``SchemaChangeWouldOrphan`` are both
409, and the first is retryable with ``allow_destructive=True`` while the second
is not — a client that branched on 409 alone would retry the second one forever,
which is the loop that error's own docstring warns about. The per-class code is
the only thing that prevents it.

Three rules place a domain error, not fifty:

- **404** — the caller named something that is not there.
- **409** — the request is well-formed; the *resource's state* refuses it, and
  the remedy is to change that state and resubmit the identical request.
- **422** — the payload itself is wrong.

5xx is opaque by default: the body carries a generic sentence and an
``incident_id``, and the real message and traceback go to the log. Three errors
opt out, each because its message *is* the operator's remedy — see
``expose_message`` below.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any, Final
from uuid import uuid4

from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.utils import is_body_allowed_for_status_code
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from visionset.kernel import (
    AnnotationNotFound,
    AssetNotFound,
    AssetNotInJob,
    BatchNotComplete,
    BatchNotEditable,
    BatchNotFound,
    BatchNotInAnnotation,
    ConfirmationRequired,
    ConstraintViolated,
    CorruptMedia,
    DatasetNotFound,
    DestructiveSchemaChange,
    DisallowedGeometry,
    DuplicateClassificationTag,
    EmptyBatch,
    EmptyRelease,
    EntityAlreadyExists,
    EntityNotFound,
    ExportFormatNotFound,
    ExportSourceUnreadable,
    IngestJobNotFound,
    InvalidAnnotation,
    InvalidAttributeValue,
    InvalidName,
    InvalidPartition,
    InvalidSchema,
    InvalidTransition,
    JobNotComplete,
    JobNotFound,
    LabelClassNotInSchema,
    LossyExportNotConsented,
    MediaError,
    MediaToolUnavailable,
    MissingRequiredAttribute,
    NoSplitRecipe,
    NotAWorkspace,
    ProjectNameTaken,
    ProjectNotFound,
    ReleaseNotFound,
    ReleaseTagTaken,
    SchemaChangeWouldOrphan,
    SchemaNotFound,
    SchemaVersionConflict,
    SourceNotFound,
    ThumbnailNotCached,
    TokenNameTaken,
    TokenNotFound,
    UnknownAttribute,
    UnserializableManifest,
    UnsupportedGeometry,
    UnsupportedMedia,
    VisionSetError,
    WorkspaceAlreadyExists,
    WorkspaceBusy,
    WorkspaceCorrupt,
    WorkspaceFormatTooNew,
    WorkspaceNotEmpty,
)
from visionset.kernel.domain import ExportCompatibility
from visionset.server.models import ExportCompatibilityOut

_logger = logging.getLogger(__name__)
"""Never call ``logging.basicConfig`` here — records propagate to root, which
uvicorn configures. The kernel's event-bus logger follows the same rule."""

RETRY_AFTER_SECONDS: Final = 5
"""How long a client is told to wait after a 503.

Matched to the store's ``DEFAULT_BUSY_TIMEOUT_MS`` (5 s), *not* imported from
it: the server is not bound to one adapter. A ``WorkspaceBusy`` client has
already waited out that timeout losing to another writer, so a shorter hint
would aim a retry storm at the exact contention being reported.
"""

UNMAPPED_CODE: Final = "INTERNAL_ERROR"
"""The code for an exception no rule covers — a bug, by definition.

A *mapped* 5xx keeps its own code (``WORKSPACE_CORRUPT``), so the two are told
apart in a log without reading the message.
"""

OPAQUE_MESSAGE: Final = "The server failed to handle the request."


# Named ErrorBody rather than Error because it becomes a public identifier in
# the generated TypeScript client, where Error is taken. The docstring is short
# and plain on purpose: it is copied verbatim into openapi.json, so RST markup
# would ship as literal backticks to every consumer of the contract.
class ErrorBody(BaseModel):
    """The one error shape this API emits, at every status."""

    code: str = Field(
        description="Stable machine-readable code. Branch on this, not on the status."
    )
    message: str = Field(
        description="Human-readable sentence. Wording is not part of the contract."
    )
    detail: dict[str, Any] | None = Field(
        default=None,
        description="Extra structure whose shape depends on the code; absent when there is none.",
    )


@dataclass(frozen=True, slots=True)
class ErrorRule:
    """What one domain error becomes over HTTP."""

    status: int
    code: str
    retry_after: int | None = None
    """Emit a ``Retry-After`` header. Only for an error a *wait* actually helps."""
    expose_message: bool = False
    """5xx only: let ``str(exc)`` reach the client instead of the opaque sentence."""


# The table is complete: one entry per concrete subclass declared in
# ``kernel/errors.py``. ``VisionSetError`` itself is deliberately absent, and
# ``tests/server/test_errors.py`` asserts exact equality against that module —
# so a new kernel error fails the suite until somebody maps it on purpose.
#
# Codes are written out rather than derived from the class name. Derivation
# cannot drift, but a code is a public contract keyed to a Python identifier: a
# pure refactor rename would silently break every client and pass every test.
# A test asserts each literal equals the SCREAMING_SNAKE of its class today, so
# the drift protection survives without the fragility.
ERROR_RULES: Final[dict[type[VisionSetError], ErrorRule]] = {
    # --- 404: the caller named something that is not there ----------------
    ProjectNotFound: ErrorRule(404, "PROJECT_NOT_FOUND"),
    SchemaNotFound: ErrorRule(404, "SCHEMA_NOT_FOUND"),
    BatchNotFound: ErrorRule(404, "BATCH_NOT_FOUND"),
    JobNotFound: ErrorRule(404, "JOB_NOT_FOUND"),
    IngestJobNotFound: ErrorRule(404, "INGEST_JOB_NOT_FOUND"),
    AssetNotFound: ErrorRule(404, "ASSET_NOT_FOUND"),
    SourceNotFound: ErrorRule(404, "SOURCE_NOT_FOUND"),
    DatasetNotFound: ErrorRule(404, "DATASET_NOT_FOUND"),
    AnnotationNotFound: ErrorRule(404, "ANNOTATION_NOT_FOUND"),
    ReleaseNotFound: ErrorRule(404, "RELEASE_NOT_FOUND"),
    # Administering a token an operator named, never failing to authenticate
    # with one: a token that does not verify raises nothing at all, so this 404
    # can never become an oracle for which secrets exist.
    TokenNotFound: ErrorRule(404, "TOKEN_NOT_FOUND"),
    # A job's assets are fixed at approval, so an asset outside the segment is
    # a sub-resource that does not exist — the "reads as missing, not as
    # forbidden" rule one scope down. A route that takes the asset id in a
    # *body* rather than a path should override to 422 via ``error_response``.
    AssetNotInJob: ErrorRule(404, "ASSET_NOT_IN_JOB"),
    # Not a 409: a release is immutable, so its state will never change and
    # "resolve the conflict and resubmit" is a promise that cannot be kept. The
    # docstring's remedy is a *different* release. The code is what tells this
    # apart from RELEASE_NOT_FOUND, which is the case codes exist for.
    NoSplitRecipe: ErrorRule(404, "NO_SPLIT_RECIPE"),
    # The caller named a format nothing is installed for — the SOURCE_NOT_FOUND
    # reading, not the MEDIA_TOOL_UNAVAILABLE one. This is not "the machine is
    # missing a tool it should have"; it is "there is no such thing here", and
    # ``GET /formats`` is what says which things there are.
    ExportFormatNotFound: ErrorRule(404, "EXPORT_FORMAT_NOT_FOUND"),
    # A preview that was never rendered, which is not damage: a thumbnail hash is
    # a cache key, so NULL is an ordinary state with three causes and one remedy.
    # A 404 rather than an empty 200 because the caller asked for a specific
    # thing that is not there, and because the remedy is real — a backfill.
    ThumbnailNotCached: ErrorRule(404, "THUMBNAIL_NOT_CACHED"),
    # --- 409: well-formed request, the resource's state refuses it ---------
    ProjectNameTaken: ErrorRule(409, "PROJECT_NAME_TAKEN"),
    ReleaseTagTaken: ErrorRule(409, "RELEASE_TAG_TAKEN"),
    TokenNameTaken: ErrorRule(409, "TOKEN_NAME_TAKEN"),
    WorkspaceAlreadyExists: ErrorRule(409, "WORKSPACE_ALREADY_EXISTS"),
    WorkspaceNotEmpty: ErrorRule(409, "WORKSPACE_NOT_EMPTY"),
    # Retryable, but immediately rather than after a wait — a re-read lands on
    # N + 2 — so no Retry-After. Which codes are retryable is documented in
    # docs/api.md; a `retryable` field on the public body would widen it for one case.
    SchemaVersionConflict: ErrorRule(409, "SCHEMA_VERSION_CONFLICT"),
    InvalidTransition: ErrorRule(409, "INVALID_TRANSITION"),
    BatchNotEditable: ErrorRule(409, "BATCH_NOT_EDITABLE"),
    BatchNotInAnnotation: ErrorRule(409, "BATCH_NOT_IN_ANNOTATION"),
    BatchNotComplete: ErrorRule(409, "BATCH_NOT_COMPLETE"),
    JobNotComplete: ErrorRule(409, "JOB_NOT_COMPLETE"),
    EmptyBatch: ErrorRule(409, "EMPTY_BATCH"),
    EmptyRelease: ErrorRule(409, "EMPTY_RELEASE"),
    ConfirmationRequired: ErrorRule(409, "CONFIRMATION_REQUIRED"),
    DestructiveSchemaChange: ErrorRule(409, "DESTRUCTIVE_SCHEMA_CHANGE"),
    SchemaChangeWouldOrphan: ErrorRule(409, "SCHEMA_CHANGE_WOULD_ORPHAN"),
    # Not a 422: the request body is valid, and the defect is in state that was
    # written and stored long before — a NaN coordinate only surfaces when a
    # release tries to freeze it. The remedy is "fix the annotation and publish
    # again", which is change-the-state-and-resubmit.
    UnserializableManifest: ErrorRule(409, "UNSERIALIZABLE_MANIFEST"),
    # Retryable with a flag, like DESTRUCTIVE_SCHEMA_CHANGE and unlike
    # SCHEMA_CHANGE_WOULD_ORPHAN — which is precisely why a client must branch on
    # the code and never on the 409. Not a 422: the request is well formed and the
    # format is genuinely installed; what refuses is the pairing of this format
    # with a caller who has not said the loss is acceptable.
    LossyExportNotConsented: ErrorRule(409, "LOSSY_EXPORT_NOT_CONSENTED"),
    # A release naming bytes that are gone or will not decode. 409 for
    # ``UnserializableManifest``'s reason — the request is fine and the stored
    # state is not — and the message is exposed by being a 4xx at all, which is
    # the point: it names the asset, and the remedy is `GET /releases/{id}/verify`
    # followed by restoring the blob.
    ExportSourceUnreadable: ErrorRule(409, "EXPORT_SOURCE_UNREADABLE"),
    # --- 422: the payload itself is wrong ----------------------------------
    InvalidName: ErrorRule(422, "INVALID_NAME"),
    InvalidSchema: ErrorRule(422, "INVALID_SCHEMA"),
    UnsupportedGeometry: ErrorRule(422, "UNSUPPORTED_GEOMETRY"),
    InvalidAnnotation: ErrorRule(422, "INVALID_ANNOTATION"),
    LabelClassNotInSchema: ErrorRule(422, "LABEL_CLASS_NOT_IN_SCHEMA"),
    DisallowedGeometry: ErrorRule(422, "DISALLOWED_GEOMETRY"),
    # 422 like its five siblings, not 409, and the split is the one this table is
    # built on. A 409 says "the resource's state refuses this; change the state
    # and resubmit" — but the state to change is the annotation set, and removing
    # the existing tag to add an identical one is not a remedy anybody wants. The
    # payload is what is wrong: it asks for something already true.
    DuplicateClassificationTag: ErrorRule(422, "DUPLICATE_CLASSIFICATION_TAG"),
    MissingRequiredAttribute: ErrorRule(422, "MISSING_REQUIRED_ATTRIBUTE"),
    UnknownAttribute: ErrorRule(422, "UNKNOWN_ATTRIBUTE"),
    InvalidAttributeValue: ErrorRule(422, "INVALID_ATTRIBUTE_VALUE"),
    InvalidPartition: ErrorRule(422, "INVALID_PARTITION"),
    MediaError: ErrorRule(422, "MEDIA_ERROR"),
    # Not a 415: every raise site reads a file *on disk* during ingest, and 415
    # is about the request's own Content-Type. On a future direct-upload route
    # 415 becomes right for one of this error's three readings and 413 for
    # another — which is what ``error_response(exc, status=...)`` is for.
    UnsupportedMedia: ErrorRule(422, "UNSUPPORTED_MEDIA"),
    CorruptMedia: ErrorRule(422, "CORRUPT_MEDIA"),
    # --- 503: transient, and a wait genuinely helps ------------------------
    WorkspaceBusy: ErrorRule(
        503, "WORKSPACE_BUSY", retry_after=RETRY_AFTER_SECONDS, expose_message=True
    ),
    # --- 5xx: nothing the caller can fix -----------------------------------
    WorkspaceCorrupt: ErrorRule(500, "WORKSPACE_CORRUPT"),
    # Deployment conditions, not client errors, and neither is transient — the
    # only licence for a 503 in the kernel is WorkspaceBusy's "transient, unlike
    # WorkspaceCorrupt … where corruption gets a hard failure".
    NotAWorkspace: ErrorRule(500, "NOT_A_WORKSPACE"),  # messages embed the server's own path
    WorkspaceFormatTooNew: ErrorRule(500, "WORKSPACE_FORMAT_TOO_NEW", expose_message=True),
    # A row missing where the store required one, or a primary-key collision on
    # a kernel-generated UUID: a programming error, per ProjectNotFound's
    # docstring ("a delivery surface turns it into a 404, not a 500" — said of
    # the *other* one).
    EntityNotFound: ErrorRule(500, "ENTITY_NOT_FOUND"),
    EntityAlreadyExists: ErrorRule(500, "ENTITY_ALREADY_EXISTS"),
    # Services pre-check rather than relying on the write to fail, and the two
    # that translate a constraint each own exactly one index — so anything
    # reaching here is a guard nobody wrote. Opaque as well as 500: the message
    # is ``str(exc.orig)``, raw SQLite text naming our own tables and columns.
    ConstraintViolated: ErrorRule(500, "CONSTRAINT_VIOLATED"),
    # Not a 503, despite being about availability: 503 promises transience, and
    # retrying never succeeds until an operator installs the binary. The message
    # is exposed because it carries the install hint, which its docstring calls
    # the whole reason the message exists.
    MediaToolUnavailable: ErrorRule(500, "MEDIA_TOOL_UNAVAILABLE", expose_message=True),
}

ERROR_RESPONSES: Final[dict[int | str, dict[str, Any]]] = {
    401: {"model": ErrorBody, "description": "Missing or invalid bearer token"},
    404: {"model": ErrorBody, "description": "No such resource"},
    409: {"model": ErrorBody, "description": "The resource's state refuses this request"},
    422: {"model": ErrorBody, "description": "The request payload is not processable"},
    500: {"model": ErrorBody, "description": "Unhandled server error, with an incident id"},
    503: {"model": ErrorBody, "description": "The workspace is busy; retry after the header says"},
}
"""Documented responses, keyed by status.

``create_app`` passes the *universal* subset at app level — see
``UNIVERSAL_ERROR_RESPONSES``. A route spreads the rest of these into its own
``responses=`` for the statuses it can actually produce: a public route cannot
401, and only a route addressing an id can 404.
"""

UNIVERSAL_ERROR_RESPONSES: Final[dict[int | str, dict[str, Any]]] = {
    status: ERROR_RESPONSES[status] for status in (422, 500, 503)
}
"""What any route can emit, applied at app level.

Declaring **422** here is load-bearing beyond documentation: it overrides
FastAPI's generated ``HTTPValidationError`` response, which keeps that model —
and the second error shape it implies — out of ``openapi.json`` entirely. This
is what makes "one error body, used everywhere" true by construction rather than
by every future route remembering.
"""


def documented(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """The responses to declare on a route, for the statuses it can produce.

    The sentence in :data:`ERROR_RESPONSES`' docstring, made executable — a route
    spreads exactly the statuses it can actually answer with, so a 404 in the
    contract means some caller really can name a thing that is not there. 401
    arrives from ``protected_router()`` and 422/500/503 from the app, so neither
    belongs in a call to this.
    """
    return {status: ERROR_RESPONSES[status] for status in statuses}


def rule_for(exc: BaseException) -> ErrorRule | None:
    """The rule for ``exc``, or ``None`` if nothing in the table covers it.

    Walks the MRO, so a subclass declared outside ``kernel/errors.py`` inherits
    its nearest mapped ancestor's answer — which is the same promise
    ``InvalidAnnotation`` and ``MediaError`` make in their own docstrings, that a
    surface can treat the whole family at once.
    """
    for cls in type(exc).__mro__:
        rule = ERROR_RULES.get(cls)
        if rule is not None:
            return rule
    return None


def _detail_for(exc: BaseException) -> dict[str, Any] | None:
    if isinstance(exc, MediaError):
        # ``reason`` only. ``name`` is "a path for a file on disk" from a
        # directory the *operator* pointed at, not the client — putting it in a
        # response body hands out server filesystem layout. Do not add it back.
        return {"reason": exc.reason}
    if isinstance(exc, LossyExportNotConsented) and isinstance(
        exc.compatibility, ExportCompatibility
    ):
        # The report, on the refusal itself — #65's second acceptance criterion.
        # A client that gets this 409 has everything it needs to render a consent
        # dialog without a second round trip, and it is the *same document*
        # ``GET /releases/{id}/export-compatibility`` returns and the export
        # writes into its own output. The ``isinstance`` is not defensive
        # padding: ``LossyExportNotConsented.compatibility`` is typed ``object |
        # None`` because ``kernel/errors.py`` may not import a domain model, so
        # this is where the type comes back.
        return {
            "compatibility": ExportCompatibilityOut.of(exc.compatibility).model_dump(mode="json")
        }
    if isinstance(exc, VisionSetError) and exc.index is not None:
        # Which item of a bulk request was refused. The kernel sets this on the
        # way out of a per-item loop; everything else leaves it ``None``, so the
        # key appears only where it means something. The *reason* is already the
        # message — repeating it here would be two spellings of one sentence.
        return {"index": exc.index}
    return None


def _message_for(exc: BaseException) -> str:
    if isinstance(exc, MediaError):
        # NOT ``str(exc)``, which is ``f"{name}: {reason}"`` — dropping ``name``
        # from ``detail`` while leaving it in the message would hide nothing.
        # The kernel already separated the two ("reason never repeats the
        # name"); this is the surface taking the half that is safe to publish.
        return exc.reason
    return str(exc)


def error_response(exc: BaseException, *, status: int | None = None) -> JSONResponse:
    """Render ``exc`` as an :class:`ErrorBody` response.

    ``status`` overrides the table for one call site. That escape hatch exists
    because a couple of domain errors legitimately differ by route — an asset id
    in a path is a 404 where the same id in a request body is a 422 — and the
    alternative is stray ``HTTPException``s that speak a different shape.
    """
    rule = rule_for(exc)
    code = rule.code if rule is not None else UNMAPPED_CODE
    resolved = status if status is not None else (rule.status if rule is not None else 500)

    detail = _detail_for(exc)
    if resolved >= 500:
        incident_id = uuid4().hex
        _logger.exception(
            "%s failed the request (incident %s)", type(exc).__name__, incident_id, exc_info=exc
        )
        message = _message_for(exc) if rule is not None and rule.expose_message else OPAQUE_MESSAGE
        detail = {**(detail or {}), "incident_id": incident_id}
    else:
        message = _message_for(exc)

    headers: dict[str, str] = {}
    if rule is not None and rule.retry_after is not None:
        headers["Retry-After"] = str(rule.retry_after)

    body = ErrorBody(code=code, message=message, detail=detail)
    return JSONResponse(body.model_dump(mode="json"), status_code=resolved, headers=headers)


_KNOWN_STATUSES: Final = frozenset(status.value for status in HTTPStatus)


# Handlers take ``Exception`` and narrow inside: Starlette's ``ExceptionHandler``
# is typed that way, and a narrower annotation is contravariance-incompatible —
# mypy rejects it at ``add_exception_handler``. Narrowing beats a ``type: ignore``.


async def _domain_error_handler(request: Request, exc: Exception) -> Response:
    return error_response(exc)


async def http_exception_handler(request: Request, exc: Exception) -> Response:
    """Render an ``HTTPException`` as the one error body.

    Public, unlike its three siblings, because :func:`visionset.server.main._install_ui`
    **replaces** this handler with one that falls through to it. Starlette keys the
    handler map by exception class, so the single-page deep-link fallback cannot be
    registered beside this one — it has to wrap it, and wrapping something private
    would be reaching into another module rather than using it.
    """
    assert isinstance(exc, HTTPException)
    headers = exc.headers  # keeps WWW-Authenticate on a 401
    if not is_body_allowed_for_status_code(exc.status_code):
        return Response(status_code=exc.status_code, headers=headers)
    code = HTTPStatus(exc.status_code).name if exc.status_code in _KNOWN_STATUSES else "HTTP_ERROR"
    body = ErrorBody(code=code, message=str(exc.detail))
    return JSONResponse(body.model_dump(mode="json"), status_code=exc.status_code, headers=headers)


async def _validation_error_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, RequestValidationError)
    # jsonable_encoder is not cosmetic: pydantic's ``ctx`` can hold objects json
    # cannot serialize. FastAPI's own handler does exactly this.
    body = ErrorBody(
        code="VALIDATION_ERROR",
        message="The request payload is not processable.",
        detail={"errors": jsonable_encoder(exc.errors())},
    )
    return JSONResponse(body.model_dump(mode="json"), status_code=422)


async def _unhandled_error_handler(request: Request, exc: Exception) -> Response:
    return error_response(exc, status=500)


def install_error_handlers(app: FastAPI) -> None:
    """Register the four handlers that make every error one shape.

    Also usable on a throwaway probe app, which is how this module is tested
    without adding routes to the real one and moving ``openapi.json``.
    """
    app.add_exception_handler(VisionSetError, _domain_error_handler)
    # Starlette's own class, NOT fastapi's. The router raises the Starlette one
    # for an unknown path and for a 405, and fastapi's is a *subclass* — keying
    # on the subclass would leave those two answering with FastAPI's default
    # ``{"detail": ...}`` while everything else answered with ErrorBody.
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    # This one lands in ServerErrorMiddleware, *outside* the user middleware
    # stack, so middleware added later (CORS, say) will not run on it. That is
    # why the mapped-5xx path above stays separate rather than being folded in.
    app.add_exception_handler(Exception, _unhandled_error_handler)
