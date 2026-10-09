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
``incident_id``, and the real message and traceback go to the log. Six errors
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
    AnnotationGeometryOutOfBounds,
    AnnotationNotFound,
    AnnotationNotFromModel,
    AssetNotFound,
    AssetNotInBatch,
    AssetNotInDataset,
    AssetNotInJob,
    AssetNotWritable,
    AugmentationRequiresSplit,
    BackgroundJobNotFound,
    BatchImmutable,
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
    ExportTargetConflict,
    ExportTargetNotFound,
    FrameContentConflict,
    FrameOrdinalOutOfRange,
    FrameTimestampOffGrid,
    GeometryNotProduced,
    InferenceConnectionInvalid,
    InferenceConnectionModelFixed,
    InferenceConnectionNameTaken,
    InferenceConnectionNotCheckable,
    InferenceConnectionNotDownloadable,
    InferenceConnectionNotFound,
    InferenceConnectionNotRunnable,
    InferenceConnectionNotSetUp,
    InferenceConnectionNotTestable,
    InferenceEndpointUnavailable,
    InferenceOutOfMemory,
    IngestJobNotFound,
    InvalidAnnotation,
    InvalidAttributeValue,
    InvalidExportTarget,
    InvalidName,
    InvalidPartition,
    InvalidSchema,
    InvalidTransition,
    JobFinished,
    JobNotComplete,
    JobNotFound,
    LabelClassNotInSchema,
    LocalInferenceUnavailable,
    LossyExportNotConsented,
    MediaError,
    MissingRequiredAttribute,
    NoSplitRecipe,
    NotAWorkspace,
    PreprocessingDriverNotFound,
    PreprocessingRecipeNameTaken,
    PreprocessingRecipeNotFound,
    PreprocessingStepUnsupportedGeometry,
    ProjectNameTaken,
    ProjectNotFound,
    PromptPointOutOfBounds,
    ReleaseContentWouldViolateSchema,
    ReleaseNotFound,
    ReleaseTagTaken,
    SchemaChangeWouldOrphan,
    SchemaDraftNotFound,
    SchemaHasNoDetectableClass,
    SchemaNotFound,
    SchemaVersionConflict,
    SourceNotFound,
    StaleWrite,
    ThumbnailNotCached,
    TokenNameTaken,
    TokenNotFound,
    TooManyOpenVideoImports,
    UnknownAttribute,
    UnknownJobType,
    UnserializableManifest,
    UnsupportedGeometry,
    UnsupportedMedia,
    UnsupportedPrompt,
    VideoImportIncomplete,
    VideoImportNotFound,
    VideoImportNotOpen,
    VideoImportTooLarge,
    VisionSetError,
    WeightsDamaged,
    WorkspaceAlreadyExists,
    WorkspaceBusy,
    WorkspaceCorrupt,
    WorkspaceFormatTooNew,
    WorkspaceNotEmpty,
    WorkspaceSchemaMismatch,
)
from visionset.kernel.error_codes import ERROR_CODES, error_code, error_detail

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


@dataclass(frozen=True, slots=True)
class _Http:
    status: int
    retry_after: int | None = None
    expose_message: bool = False


# The table is complete: one entry per concrete subclass declared in
# ``kernel/errors.py``. ``VisionSetError`` itself is deliberately absent, and
# ``tests/server/test_errors.py`` asserts exact equality against that module —
# so a new kernel error fails the suite until somebody maps it on purpose.
#
# Only the HTTP half is decided here. The code is the kernel's
# (``visionset.kernel.error_codes``), so REST, the CLI and MCP publish one value.
_HTTP: Final[dict[type[VisionSetError], _Http]] = {
    # --- 404: the caller named something that is not there ----------------
    ProjectNotFound: _Http(404),
    SchemaNotFound: _Http(404),
    SchemaDraftNotFound: _Http(404),
    BatchNotFound: _Http(404),
    JobNotFound: _Http(404),
    IngestJobNotFound: _Http(404),
    VideoImportNotFound: _Http(404),
    BackgroundJobNotFound: _Http(404),
    AssetNotFound: _Http(404),
    SourceNotFound: _Http(404),
    DatasetNotFound: _Http(404),
    AnnotationNotFound: _Http(404),
    ReleaseNotFound: _Http(404),
    # Administering a token an operator named, never failing to authenticate
    # with one: a token that does not verify raises nothing at all, so this 404
    # can never become an oracle for which secrets exist.
    TokenNotFound: _Http(404),
    InferenceConnectionNotFound: _Http(404),
    # A job's assets are fixed at approval, so an asset outside the segment is
    # a sub-resource that does not exist — the "reads as missing, not as
    # forbidden" rule one scope down. A route that takes the asset id in a
    # *body* rather than a path should override to 422 via ``error_response``.
    # 422 rather than 404: the asset exists and the batch exists, and what is
    # wrong is the *pairing the body asked for* — a correction of a batch may only
    # name assets that batch carried. Its sibling `AssetNotInJob` is a 404 because
    # it is usually reached through a path segment; this one only ever arrives in
    # a list, which is a payload problem. The `docs/content/api.md` rule, applied.
    AssetNotInBatch: _Http(422),
    # 422 and not 409: the ordinal is a field of the payload and the session
    # did not move under the caller — the grid it was opened with has not
    # changed and will not, so there is no conflict to re-read and resolve.
    FrameOrdinalOutOfRange: _Http(422),
    # 422 for the same reason as its neighbour: the timestamp is a field of the
    # descriptor, and the grid it contradicts was fixed when the session opened.
    FrameTimestampOffGrid: _Http(422),
    # 422 for the same reason, one level up: the cut is a field of the payload
    # and nothing about the project refuses it, so there is no state to re-read.
    VideoImportTooLarge: _Http(422),
    AssetNotInJob: _Http(404),
    AssetNotInDataset: _Http(404),
    # Not a 409: a release is immutable, so its state will never change and
    # "resolve the conflict and resubmit" is a promise that cannot be kept. The
    # docstring's remedy is a *different* release. The code is what tells this
    # apart from RELEASE_NOT_FOUND, which is the case codes exist for.
    NoSplitRecipe: _Http(404),
    # The caller named a format nothing is installed for — the SOURCE_NOT_FOUND
    # reading, not "the machine is missing a tool it should have". It is "there
    # is no such thing here", and ``GET /formats`` says which things there are.
    ExportFormatNotFound: _Http(404),
    # The same reading one vocabulary over: the caller named a target no
    # installed exporter declares. No route raises it yet — the target routes are
    # not built — mapped anyway for BATCH_IMMUTABLE's reason: the
    # exact-correspondence test keeps this table total, and an unmapped kernel
    # error would answer 500 the day a route appears.
    ExportTargetNotFound: _Http(404),
    # A preview that was never rendered, which is not damage: a thumbnail hash is
    # a cache key, so NULL is an ordinary state with three causes and one remedy.
    # A 404 rather than an empty 200 because the caller asked for a specific
    # thing that is not there, and because the remedy is real — a backfill.
    ThumbnailNotCached: _Http(404),
    PreprocessingRecipeNotFound: _Http(404),
    # --- 409: well-formed request, the resource's state refuses it ---------
    ProjectNameTaken: _Http(409),
    ReleaseTagTaken: _Http(409),
    TokenNameTaken: _Http(409),
    InferenceConnectionNameTaken: _Http(409),
    PreprocessingRecipeNameTaken: _Http(409),
    WorkspaceAlreadyExists: _Http(409),
    WorkspaceNotEmpty: _Http(409),
    # Retryable, but immediately rather than after a wait — a re-read lands on
    # N + 2 — so no Retry-After. Which codes are retryable is documented in
    # docs/content/api.md; a `retryable` field on the public body would widen it for one case.
    SchemaVersionConflict: _Http(409),
    InvalidTransition: _Http(409),
    # Retryable immediately, like SCHEMA_VERSION_CONFLICT above and for the same
    # reason: the request was well formed and was refused by a state that moved
    # under it, so a re-read and a resubmit is the whole remedy. It has no flag,
    # deliberately — a "write anyway" would be the lost update this closes.
    StaleWrite: _Http(409),
    # The three video-import refusals a caller resolves by looking at the
    # session again: it is finished, it is short, or that ordinal is taken by
    # something else. None is retryable as sent, and none has a flag — see
    # their kernel docstrings for why a "commit anyway" cannot exist.
    VideoImportNotOpen: _Http(409),
    VideoImportIncomplete: _Http(409),
    FrameContentConflict: _Http(409),
    # 409 rather than 429: nothing is rate-limited here and no wait is being
    # asked for. The project holds as many open sessions as it may, which is a
    # state the caller resolves by committing or aborting one of its own.
    TooManyOpenVideoImports: _Http(409),
    BatchNotEditable: _Http(409),
    # No route reaches this yet — batch delete is SDK-only. Mapped anyway,
    # because the exact-correspondence test is what keeps the table honest, and
    # an unmapped kernel error would answer 500 the day a route appears.
    BatchImmutable: _Http(409),
    BatchNotInAnnotation: _Http(409),
    # 409 rather than 422 for the reason at the top of this block: the annotation
    # is well formed and would be accepted a moment earlier or after a progress
    # move. What refuses it is the asset's state, and the remedy is to change that
    # state and resubmit — which is exactly what 409 is for here.
    AssetNotWritable: _Http(409),
    # 422 rather than 409: this is a malformed payload rather than a resource in
    # the wrong state. A hand-made label sent through this door is never made
    # legal by a later state change, so there is nothing here to resubmit.
    AnnotationNotFromModel: _Http(422),
    # The job-level sibling of the two above, and 409 for their reason. Its
    # remedy is the one that is not a retry: nothing re-opens a completed job, so
    # a client that reads this code offers a correction batch rather than a
    # resubmit. Which is why it is its own code and not folded into either.
    JobFinished: _Http(409),
    BatchNotComplete: _Http(409),
    JobNotComplete: _Http(409),
    EmptyBatch: _Http(409),
    EmptyRelease: _Http(409),
    ReleaseContentWouldViolateSchema: _Http(409),
    ConfirmationRequired: _Http(409),
    DestructiveSchemaChange: _Http(409),
    SchemaChangeWouldOrphan: _Http(409),
    # The batch is well formed to pre-label; the pinned schema is what refuses —
    # no class it declares is one a detection can be written as. The remedy is to
    # pin a schema with a detectable class and resubmit, which is what 409 is for.
    SchemaHasNoDetectableClass: _Http(409),
    # Not a 422: the request body is valid, and the defect is in state that was
    # written and stored long before — a NaN coordinate only surfaces when a
    # release tries to freeze it. The remedy is "fix the annotation and publish
    # again", which is change-the-state-and-resubmit.
    UnserializableManifest: _Http(409),
    # Retryable with a flag, like DESTRUCTIVE_SCHEMA_CHANGE and unlike
    # SCHEMA_CHANGE_WOULD_ORPHAN — which is precisely why a client must branch on
    # the code and never on the 409. Not a 422: the request is well formed and the
    # format is genuinely installed; what refuses is the pairing of this format
    # with a caller who has not said the loss is acceptable.
    LossyExportNotConsented: _Http(409),
    # A release naming bytes that are gone or will not decode. 409 for
    # ``UnserializableManifest``'s reason — the request is fine and the stored
    # state is not — and the message is exposed by being a 4xx at all, which is
    # the point: it names the asset, and the remedy is `GET /releases/{id}/verify`
    # followed by restoring the blob.
    ExportSourceUnreadable: _Http(409),
    # The `download_weights` gate, refusing what `allowed_actions` had already
    # declined to declare. 409 rather than 404 because both readings are about
    # the resource as it stands — already set up, or a kind with no weights of
    # its own — and neither is a missing thing. Only the first is retryable after
    # a state change, which is why the *message* separates them and the code does
    # not: both answers say stop asking.
    InferenceConnectionNotDownloadable: _Http(409),
    # The same shape one action over, and it earns its own code because
    # the remedies differ: an `http` connection is told to stop asking, while a
    # `local` one at `not_set_up` is told to download first — a state change that
    # makes the identical request succeed. Folding it into NOT_DOWNLOADABLE would
    # give a client one code for two different next steps.
    InferenceConnectionNotCheckable: _Http(409),
    # The mirror of NOT_CHECKABLE: a `local` connection has no endpoint to ask,
    # and no state change gives it one. Its own code because the remedy — use
    # an http connection — is nothing NOT_CHECKABLE's reader would guess.
    InferenceConnectionNotTestable: _Http(409),
    InferenceConnectionModelFixed: _Http(409),
    # Raised by the integrity job rather than by a request, and it has a rule
    # because every declared error does — the table is total by test. 409 is the
    # honest status if a synchronous surface ever raises it: the resource is in a
    # state that refuses the request, and the state has already been corrected.
    WeightsDamaged: _Http(409),
    # Change-the-state-and-resubmit in its purest form: the state is
    # `setup_state`, the change is `download_weights`, and the identical request
    # then succeeds. Distinct from INFERENCE_CONNECTION_NOT_RUNNABLE below, which
    # no state change can fix — precisely the pair that proves a client must
    # branch on the code and never on the status.
    InferenceConnectionNotSetUp: _Http(409),
    # An augmenting recipe against a release published without a split recipe.
    # Change-the-state-and-resubmit: publish a release with a split and the
    # identical export succeeds.
    AugmentationRequiresSplit: _Http(409),
    # A recipe step meeting a geometry this release carries and the step cannot
    # move. LOSSY_EXPORT_NOT_CONSENTED's reading — a well-formed request refused
    # by the release's content — without the consent flag, because a label that
    # cannot follow its image is never something to consent to.
    PreprocessingStepUnsupportedGeometry: _Http(409),
    # --- 422: the payload itself is wrong ----------------------------------
    InvalidName: _Http(422),
    InferenceConnectionInvalid: _Http(422),
    InvalidSchema: _Http(422),
    UnsupportedGeometry: _Http(422),
    InvalidAnnotation: _Http(422),
    LabelClassNotInSchema: _Http(422),
    DisallowedGeometry: _Http(422),
    AnnotationGeometryOutOfBounds: _Http(422),
    # 422 like its five siblings, not 409, and the split is the one this table is
    # built on. A 409 says "the resource's state refuses this; change the state
    # and resubmit" — but the state to change is the annotation set, and removing
    # the existing tag to add an identical one is not a remedy anybody wants. The
    # payload is what is wrong: it asks for something already true.
    DuplicateClassificationTag: _Http(422),
    MissingRequiredAttribute: _Http(422),
    UnknownAttribute: _Http(422),
    InvalidAttributeValue: _Http(422),
    InvalidPartition: _Http(422),
    # 422 rather than 404: the type is part of the *payload* a surface built, so
    # a request naming one nothing runs is a malformed request rather than a
    # reference to something missing. In practice a route never lets one through
    # — every enqueue site names a type from the registry it imported — so this
    # exists for the dispatcher's sake and for a stale row written by a build
    # that knew one more handler.
    UnknownJobType: _Http(422),
    MediaError: _Http(422),
    # Not a 415: every raise site reads a file *on disk* during ingest, and 415
    # is about the request's own Content-Type. On a future direct-upload route
    # 415 becomes right for one of this error's three readings and 413 for
    # another — which is what ``error_response(exc, status=...)`` is for.
    UnsupportedMedia: _Http(422),
    CorruptMedia: _Http(422),
    # A detector asked by pointing, or a segmenter asked in words. The payload is
    # what is wrong — `DuplicateClassificationTag`'s reading — because nothing
    # about the connection needs to change and no wait helps: the remedy is a
    # different prompt or a different connection. No route reaches this yet;
    # mapped anyway, because the exact-correspondence test is what keeps this
    # table honest and an unmapped kernel error answers 500 the day one appears.
    UnsupportedPrompt: _Http(422),
    # A pre-label selection naming a shape the model does not answer in, or no
    # shape at all. 422 beside UNSUPPORTED_PROMPT for its reason: the request is
    # what is wrong, and the remedy is a different selection or none.
    GeometryNotProduced: _Http(422),
    # A click past the edge of the picture. 422 beside UNSUPPORTED_PROMPT and
    # not 404 with the asset's own code: the asset is real and was found, and
    # what is wrong is a coordinate in the body. Its own code rather than that
    # one because the remedies are opposites — UNSUPPORTED_PROMPT wants another
    # kind of prompt or another connection, this wants the same request with a
    # different point — and a client cannot tell them apart from a shared 422.
    PromptPointOutOfBounds: _Http(422),
    # --- 502: the other end did not answer the contract ---------------------
    # The first 502 in this table, and the only honest status for it: the
    # request was fine and this program is fine; the upstream an `http`
    # connection names did not answer, or answered outside the contract. Not a
    # 503 — nothing here promises a wait will help — and not a 500, because
    # nothing on this machine is wrong. Exposed because the message names the
    # endpoint and what it did, which is the whole remedy.
    InferenceEndpointUnavailable: _Http(502, expose_message=True),
    # --- 503: transient, and a wait genuinely helps ------------------------
    WorkspaceBusy: _Http(503, retry_after=RETRY_AFTER_SECONDS, expose_message=True),
    # --- 5xx: nothing the caller can fix -----------------------------------
    WorkspaceCorrupt: _Http(500),
    # Deployment conditions, not client errors, and neither is transient — the
    # only licence for a 503 in the kernel is WorkspaceBusy's "transient, unlike
    # WorkspaceCorrupt … where corruption gets a hard failure".
    NotAWorkspace: _Http(500),  # messages embed the server's own path
    WorkspaceFormatTooNew: _Http(500, expose_message=True),
    # Exposed for the reason the two above it are: the message *is* the remedy,
    # and it is one nobody can reconstruct. Opaque, this arrives as a 500 naming
    # no cause on a route with no connection to the real problem, and finding it
    # takes reading the server's log — which was the whole complaint.
    WorkspaceSchemaMismatch: _Http(500, expose_message=True),
    # A row missing where the store required one, or a primary-key collision on
    # a kernel-generated UUID: a programming error, per ProjectNotFound's
    # docstring ("a delivery surface turns it into a 404, not a 500" — said of
    # the *other* one).
    EntityNotFound: _Http(500),
    EntityAlreadyExists: _Http(500),
    # Services pre-check rather than relying on the write to fail, and the two
    # that translate a constraint each own exactly one index — so anything
    # reaching here is a guard nobody wrote. Opaque as well as 500: the message
    # is ``str(exc.orig)``, raw SQLite text naming our own tables and columns.
    ConstraintViolated: _Http(500),
    # An optional runtime that is not installed. Not a 503 despite being about
    # availability: 503 promises transience, and retrying never succeeds until
    # somebody installs the extra. The message is exposed because it carries the
    # exact `pip install`, which *is* the remedy — nobody can reconstruct it
    # from "unavailable".
    LocalInferenceUnavailable: _Http(500, expose_message=True),
    # The neighbour of LOCAL_INFERENCE_UNAVAILABLE, exposed for the same reason:
    # the message is the remedy, and this one names the device that filled up
    # along with the ways off it. Not a 503 despite sounding transient —
    # WorkspaceBusy holds the only licence for that in this table, and retrying
    # the same model on the same device fails the same way.
    InferenceOutOfMemory: _Http(500, expose_message=True),
    # A deployment condition too, and the distance from
    # INFERENCE_CONNECTION_NOT_SET_UP is the whole reason it is not a 409: there
    # is no state to change and no flag to pass. The remedy is a version of this
    # program that ships the adapter, so the message says which kind was asked
    # for rather than inviting a retry that cannot work.
    InferenceConnectionNotRunnable: _Http(500, expose_message=True),
    # A deployment condition on NOT_RUNNABLE's reading: two installed
    # distributions claim one target name, and no edit to the request changes
    # what is installed. No route raises it yet; mapped for BATCH_IMMUTABLE's
    # reason.
    ExportTargetConflict: _Http(500),
    # A defective installed plugin — a target promising geometries its own
    # exporter never writes — which is nothing a caller can fix. No route
    # raises it yet; mapped for BATCH_IMMUTABLE's reason.
    InvalidExportTarget: _Http(500),
    # A recipe step kind with no installed driver. The grammar admits only the
    # kinds this distribution ships drivers for, so a caller cannot reach this
    # by naming something wrong — the installation is missing a plugin it was
    # built with. LOCAL_INFERENCE_UNAVAILABLE's status and its exposed message,
    # which lists what is installed. No route raises it yet; mapped for
    # BATCH_IMMUTABLE's reason.
    PreprocessingDriverNotFound: _Http(500, expose_message=True),
}

ERROR_RULES: Final[dict[type[VisionSetError], ErrorRule]] = {
    cls: ErrorRule(http.status, ERROR_CODES[cls], http.retry_after, http.expose_message)
    for cls, http in _HTTP.items()
}

ERROR_RESPONSES: Final[dict[int | str, dict[str, Any]]] = {
    401: {"model": ErrorBody, "description": "Missing or invalid bearer token"},
    404: {"model": ErrorBody, "description": "No such resource"},
    409: {"model": ErrorBody, "description": "The resource's state refuses this request"},
    422: {"model": ErrorBody, "description": "The request payload is not processable"},
    500: {"model": ErrorBody, "description": "Unhandled server error, with an incident id"},
    502: {"model": ErrorBody, "description": "An http connection's endpoint did not answer"},
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


_ROUTE_MAY_NOT_DECLARE: Final[dict[int, str]] = {
    401: "protected_router()",
    422: "UNIVERSAL_ERROR_RESPONSES",
    500: "UNIVERSAL_ERROR_RESPONSES",
    503: "UNIVERSAL_ERROR_RESPONSES",
}
"""Statuses a route already carries, and what puts each one there."""


def documented(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """The responses to declare on a route, for the statuses it can produce.

    The sentence in :data:`ERROR_RESPONSES`' docstring, made executable — a route
    spreads exactly the statuses it can actually answer with, so a 404 in the
    contract means some caller really can name a thing that is not there. 401
    arrives from ``protected_router()`` and 422/500/503 from the app, so neither
    belongs in a call to this.

    Raises:
        ValueError: a status something else already supplies was passed. Raised
            here rather than asserted in a test because ``responses=`` is
            evaluated while the route is being decorated: a violating route
            cannot be imported, so app startup and every suite that touches the
            server is the gate.
    """
    for status in statuses:
        source = _ROUTE_MAY_NOT_DECLARE.get(status)
        if source is not None:
            raise ValueError(f"{status} is already declared by {source}; drop it from documented()")
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


def code_for(exc: BaseException) -> str | None:
    """The code ``exc`` would be answered under, or ``None`` if the table has none.

    What the job runner is handed, so a refusal settles under the same code
    whether it was answered to the request or happened inside the job the
    request queued. ``None`` rather than ``UNMAPPED_CODE`` for an unmapped
    exception: on the request path that is a 500 with an incident id, and on a
    job row a code nobody declared would be a fiction a client branched on.
    """
    return error_code(exc)


def _detail_for(exc: BaseException) -> dict[str, Any] | None:
    return error_detail(exc)


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
