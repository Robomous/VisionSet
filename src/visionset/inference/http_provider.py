# usage: from visionset.inference import HTTP_PROVIDER_ID, HttpProvider, ask_endpoint
"""The driver for a connection whose model answers behind an HTTP endpoint.

**One URL, two verbs.** ``GET endpoint_url`` describes the endpoint —
``{"model_ref": …, "capability": …}`` — and ``POST endpoint_url`` predicts,
taking the domain's own ``PredictionRequest`` as JSON (image bytes base64) and
answering ``{"answers": [...]}`` with one answer per target, matched by
``asset_id``: an ``AssetPrediction`` for words, and for points the same shape
with ``segments`` of ``{"score", "mask"}`` where the mask is a base64 PNG at the
asset's size and any non-zero pixel is inside. No paths are joined and no
trailing slash matters, which is the whole reason it is one URL.

**The family an http connection records is the capability the endpoint
declared, verbatim.** A local connection's family is the ``model_type`` its
config declares, read literally; this is the same rule against a different
declaration. So :data:`HTTP_FAMILIES` maps each capability name onto itself,
and an endpoint declaring something this build does not know is refused when
it is asked rather than recorded and then refused on every request.

**The wrong prompt kind is refused here, before any request is made.** The
family tells the runner what the endpoint takes, so a detector handed points
refuses in the port's own vocabulary exactly as the local adapters do — a
round trip to be told the same thing would be a sentence about the network
wrapped around a sentence about the prompt.

**Every failure is one class**, :class:`InferenceEndpointUnavailable`, because
every reading — unreachable, a status, a body outside the contract — has the
same remedy: look at the endpoint. The message names it and what happened.

Transport is the standard library: a JSON request and a JSON answer need no
client library, and a dependency this package does not otherwise carry would
be a second thing to break for one ``POST``.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Final
from urllib import error
from urllib import request as urllib_request
from uuid import UUID

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from visionset.kernel.domain import (
    AssetPrediction,
    AssetSegmentation,
    CuratedModel,
    Geometry,
    InferenceConnection,
    ModelCapability,
    PointPrompt,
    PredictedRegion,
    PredictionRequest,
    PredictionTarget,
    SegmentedMask,
    TextPrompt,
)
from visionset.kernel.errors import (
    InferenceConnectionNotRunnable,
    InferenceEndpointUnavailable,
    UnsupportedPrompt,
)
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

HTTP_PROVIDER_ID: Final = "http"

DESCRIBE_TIMEOUT: Final = 10.0
PREDICT_TIMEOUT: Final = 120.0
# ponytail: one timeout for every endpoint; a per-connection timeout when
# somebody's model needs longer than two minutes for one batch.

HTTP_FAMILIES: Final[Mapping[str, ModelCapability]] = {
    ModelCapability.POINT_SUGGEST.value: ModelCapability.POINT_SUGGEST,
    ModelCapability.TEXT_DETECT.value: ModelCapability.TEXT_DETECT,
}


@dataclass(frozen=True, slots=True)
class EndpointAnswer:
    """What an endpoint said about itself, as it said it."""

    model_ref: str
    capability: str


class _Description(BaseModel):
    model_config = ConfigDict(extra="ignore")
    model_ref: str = Field(min_length=1)
    capability: str = Field(min_length=1)


class _RemoteRegion(BaseModel):
    model_config = ConfigDict(extra="ignore")
    label: str
    confidence: float = Field(ge=0.0, le=1.0)
    geometry: Geometry


class _RemotePrediction(BaseModel):
    model_config = ConfigDict(extra="ignore")
    asset_id: UUID
    model_ref: str = Field(min_length=1)
    regions: tuple[_RemoteRegion, ...] = ()


class _RemoteSegment(BaseModel):
    model_config = ConfigDict(extra="ignore")
    score: float = Field(ge=0.0, le=1.0)
    mask: str


class _RemoteSegmentation(BaseModel):
    model_config = ConfigDict(extra="ignore")
    asset_id: UUID
    model_ref: str = Field(min_length=1)
    segments: tuple[_RemoteSegment, ...] = ()


def _url_of(connection: InferenceConnection) -> str:
    url = connection.endpoint_url or ""
    if not url.startswith(("http://", "https://")):
        raise InferenceEndpointUnavailable(
            f"connection {connection.name!r} names {url!r} as its endpoint, which is not an "
            "http or https URL; nothing else is ever opened"
        )
    return url


def _exchange(url: str, *, payload: dict[str, Any] | None, timeout: float) -> Any:
    """One round trip, as parsed JSON, or the sentence for why not."""
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    asked = urllib_request.Request(
        url, data=data, headers=headers, method="GET" if data is None else "POST"
    )
    try:
        with urllib_request.urlopen(asked, timeout=timeout) as response:
            raw = response.read()
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace").strip()[:200]
        raise InferenceEndpointUnavailable(
            f"endpoint {url} answered {exc.code}" + (f": {detail}" if detail else "")
        ) from exc
    except (error.URLError, TimeoutError, OSError) as exc:
        reason = exc.reason if isinstance(exc, error.URLError) else exc
        raise InferenceEndpointUnavailable(
            f"endpoint {url} could not be reached: {reason}"
        ) from exc
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise InferenceEndpointUnavailable(
            f"endpoint {url} answered something that is not JSON"
        ) from exc


def _first_reason(exc: ValidationError) -> str:
    first = exc.errors()[0]
    where = ".".join(str(part) for part in first["loc"])
    return f"{where}: {first['msg']}" if where else str(first["msg"])


def describe(connection: InferenceConnection) -> EndpointAnswer:
    """Ask the endpoint what it is and what it answers. Records nothing.

    Raises:
        InferenceEndpointUnavailable: it could not be reached, or it described
            itself outside the contract.
    """
    url = _url_of(connection)
    body = _exchange(url, payload=None, timeout=DESCRIBE_TIMEOUT)
    try:
        described = _Description.model_validate(body)
    except ValidationError as exc:
        raise InferenceEndpointUnavailable(
            f"endpoint {url} described itself in a shape this build cannot read — it must answer "
            f'{{"model_ref": …, "capability": …}} ({_first_reason(exc)})'
        ) from exc
    return EndpointAnswer(model_ref=described.model_ref, capability=described.capability)


def _payload(request: PredictionRequest) -> dict[str, Any]:
    return {
        "prompt": request.prompt.model_dump(mode="json"),
        "minimum_confidence": request.minimum_confidence,
        "targets": [
            {
                "asset_id": str(target.asset_id),
                "media_type": target.media_type,
                "content": base64.b64encode(target.content).decode("ascii"),
            }
            for target in request.targets
        ],
    }


class _Remote:
    """What both runners share: the row, the reference, the round trip."""

    def __init__(self, connection: InferenceConnection) -> None:
        self._connection = connection

    @property
    def model_ref(self) -> str:
        """What is configured. Every answer carries what actually ran."""
        return f"{self._connection.model_id}@{self._connection.model_revision}"

    def _answers(self, request: PredictionRequest) -> tuple[str, list[Any]]:
        url = _url_of(self._connection)
        body = _exchange(url, payload=_payload(request), timeout=PREDICT_TIMEOUT)
        answers = body.get("answers") if isinstance(body, dict) else None
        if not isinstance(answers, list):
            raise InferenceEndpointUnavailable(f'endpoint {url} answered without an "answers" list')
        return url, answers


def _require_one_per_target(
    url: str, parsed: Sequence[object], targets: Sequence[PredictionTarget]
) -> None:
    """One parsed answer per target — checked after parsing, so a body that
    cannot be read raises the read failure rather than a count that is merely
    its symptom."""
    if len(parsed) != len(targets):
        raise InferenceEndpointUnavailable(
            f"endpoint {url} answered for {len(parsed)} of {len(targets)} targets"
        )


def _in_target_order[A](
    url: str,
    targets: Sequence[PredictionTarget],
    parsed: Sequence[A],
    asset_id_of: Callable[[A], UUID],
) -> Iterator[A]:
    """Exactly one answer per target, in the order asked, whatever order they came."""
    expected = [target.asset_id for target in targets]
    if len(set(expected)) != len(expected):
        yield from parsed
        return
    by_id = {asset_id_of(one): one for one in parsed}
    if set(by_id) != set(expected):
        raise InferenceEndpointUnavailable(
            f"endpoint {url} answered for targets it was not asked about, or missed some it was"
        )
    for asset_id in expected:
        yield by_id[asset_id]


class RemoteDetector(_Remote):
    """``ModelProvider`` over an endpoint that answers words with regions."""

    def predict(self, request: PredictionRequest) -> Iterator[AssetPrediction]:
        if not isinstance(request.prompt, TextPrompt):
            raise UnsupportedPrompt(
                f"{self.model_ref} answers text prompts; it was asked with "
                f"{request.prompt.kind!r}, which it has no way to interpret"
            )
        url, answers = self._answers(request)
        parsed: list[AssetPrediction] = []
        for raw in answers:
            try:
                remote = _RemotePrediction.model_validate(raw)
            except ValidationError as exc:
                raise InferenceEndpointUnavailable(
                    f"endpoint {url} answered a prediction this build cannot read "
                    f"({_first_reason(exc)})"
                ) from exc
            parsed.append(
                AssetPrediction(
                    asset_id=remote.asset_id,
                    model_ref=remote.model_ref,
                    regions=tuple(
                        PredictedRegion(label=r.label, confidence=r.confidence, geometry=r.geometry)
                        for r in remote.regions
                    ),
                )
            )
        _require_one_per_target(url, parsed, request.targets)
        yield from _in_target_order(url, request.targets, parsed, lambda one: one.asset_id)


class RemoteSegmenter(_Remote):
    """``PointSegmenter`` over an endpoint that answers points with masks."""

    def segment(self, request: PredictionRequest) -> Iterator[AssetSegmentation]:
        if not isinstance(request.prompt, PointPrompt):
            raise UnsupportedPrompt(
                f"{self.model_ref} answers point prompts; it was asked with "
                f"{request.prompt.kind!r}, which it has no way to interpret"
            )
        url, answers = self._answers(request)
        sizes = {target.asset_id: _size_of(target) for target in request.targets}
        parsed: list[AssetSegmentation] = []
        for raw in answers:
            try:
                remote = _RemoteSegmentation.model_validate(raw)
            except ValidationError as exc:
                raise InferenceEndpointUnavailable(
                    f"endpoint {url} answered a segmentation this build cannot read "
                    f"({_first_reason(exc)})"
                ) from exc
            size = sizes.get(remote.asset_id)
            if size is None:
                raise InferenceEndpointUnavailable(
                    f"endpoint {url} answered for targets it was not asked about, or missed "
                    "some it was"
                )
            parsed.append(
                AssetSegmentation(
                    asset_id=remote.asset_id,
                    model_ref=remote.model_ref,
                    segments=tuple(
                        SegmentedMask(mask=_rows_of(s.mask, url=url, size=size), score=s.score)
                        for s in remote.segments
                    ),
                )
            )
        _require_one_per_target(url, parsed, request.targets)
        yield from _in_target_order(url, request.targets, parsed, lambda one: one.asset_id)


def _size_of(target: PredictionTarget) -> tuple[int, int]:
    with Image.open(BytesIO(target.content)) as image:
        return image.size


def _rows_of(encoded: str, *, url: str, size: tuple[int, int]) -> list[bytes]:
    """A base64 PNG as rows of ``0``/``1`` bytes at exactly the asset's size.

    ``1`` and not ``255``: the pipeline scans a row with ``index(True)``, and
    any other truthy byte would be missed silently.
    """
    try:
        with Image.open(BytesIO(base64.b64decode(encoded, validate=True))) as image:
            lit = image.convert("L").point(lambda value: 1 if value else 0)
            width, height = lit.size
            flat = lit.tobytes()
    except Exception as exc:  # noqa: BLE001 — anything Pillow or base64 raises is one answer
        raise InferenceEndpointUnavailable(
            f"endpoint {url} answered a mask this build cannot decode; a mask is a base64 "
            f"PNG ({exc})"
        ) from exc
    if (width, height) != size:
        raise InferenceEndpointUnavailable(
            f"endpoint {url} answered a {width} by {height} mask for a {size[0]} by {size[1]} "
            "asset; a mask is the asset's own size"
        )
    return [flat[row * width : (row + 1) * width] for row in range(height)]


class HttpProvider:
    """The driver for this project's endpoint contract. Nothing to fetch."""

    provider_id: Final = HTTP_PROVIDER_ID
    families: Final = HTTP_FAMILIES
    curated: Final[tuple[CuratedModel, ...]] = ()

    def build(
        self, connection: InferenceConnection, *, family: str, workspace_root: Path
    ) -> RemoteSegmenter | RemoteDetector:
        capability = HTTP_FAMILIES.get(family)
        if capability is ModelCapability.POINT_SUGGEST:
            return RemoteSegmenter(connection)
        if capability is ModelCapability.TEXT_DETECT:
            return RemoteDetector(connection)
        raise InferenceConnectionNotRunnable(
            f"provider {HTTP_PROVIDER_ID!r} was asked to build for {family!r}, which it does not "
            f"serve; it serves {', '.join(sorted(HTTP_FAMILIES))}"
        )


def ask_endpoint(workspace: WorkspaceService, connection_id: UUID) -> InferenceConnection:
    """Ask a connection's endpoint what it answers, and record the answer.

    The body the route, the CLI and the MCP tool share, on ``fetch_weights``'s
    reasoning: two implementations of "what testing means" is how surfaces come
    to disagree. The gate runs first, then the question, then the record — so a
    refusal or an unreachable endpoint leaves the row exactly as it was.

    Raises:
        InferenceConnectionNotFound: no such connection.
        InferenceConnectionNotTestable: it has no endpoint to ask.
        InferenceEndpointUnavailable: the endpoint did not answer the contract,
            or declared a capability this build does not know.
    """
    connections = InferenceConnectionService(workspace)
    connection = connections.require_endpoint_testable(connection_id)
    answer = describe(connection)
    if answer.capability not in HTTP_FAMILIES:
        raise InferenceEndpointUnavailable(
            f"endpoint {connection.endpoint_url} declares it answers {answer.capability!r}, which "
            f"this build does not know; it knows {', '.join(sorted(HTTP_FAMILIES))}"
        )
    return connections.record_endpoint_answer(
        connection.id,
        model_family=answer.capability,
        provider_id=connection.provider_id or HTTP_PROVIDER_ID,
    )
