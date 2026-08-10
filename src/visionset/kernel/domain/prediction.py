# usage: from visionset.kernel.domain import PredictionRequest, AssetPrediction
"""What a model is asked, and what it answers — in domain terms and nothing else.

These are the shapes :class:`~visionset.kernel.ports.ModelProvider` is written
over, and every one of them exists to keep a *tensor* out of that port's
signatures. A provider running in this process and a provider behind an HTTP
endpoint must be implementable against the identical protocol, so nothing here
may name a file, a device, a process, or an array library. That dual test applies
to the data here as much as to the port's methods.

**A request carries bytes, not a path.** The obvious spelling — hand the provider
an ``Asset`` and let it read the file — is exactly the one that fails the dual
test: a hosted provider has no filesystem in common with this machine, and a port
whose contract is "there is a file at this path" cannot be implemented remotely
at all. So the caller, which does have a ``BlobStore``, reads the bytes and the
port carries them. The cost is real (an image in memory per target) and it is the
right cost: it is what makes the same call work in both places.

**The invocation unit is a batch.** ``ModelProvider.predict`` used to take one
asset, which is simplest locally and worst remotely — a hosted service would pay
one round trip per image. A batch is the shape that serves both, and a local
provider is free to loop inside it. What size a batch should be is the caller's
question, not the port's: throughput was measured *decreasing* with batch size on
mixed-size images, so a caller on that profile sends one at a time, and one that
later measures otherwise sends more without any port change.

**Two ways to ask, and neither is a model's API.** A prompt is either words
(:class:`TextPrompt`) or a place on the image (:class:`PointPrompt`). That split
is about how a person expresses what they want, not about how any particular
architecture accepts it — the model-specific knobs (score thresholds per head,
tokenizer settings) stay in the adapter, and the only tuning the port carries is
:attr:`PredictionRequest.minimum_confidence`, which every model can honour.
A provider that cannot serve a prompt kind refuses it; it does not guess.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.domain.geometry import Geometry
from visionset.kernel.errors import PromptPointOutOfBounds


class PredictionTarget(BaseModel):
    """One image a provider is being asked about, and the id to answer under.

    ``asset_id`` travels for correlation only. A provider must never treat it as
    something it can look up — it has no store, by design — and a caller must
    never assume answers come back in the order it sent them, which is why the
    id is on the answer too.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset_id: UUID
    #: The image itself. See the module docstring for why this is not a path.
    content: bytes
    #: What the bytes are, so a provider need not sniff them. An IANA media type
    #: — ``image/jpeg``, ``image/png`` — because that is the one spelling that
    #: means the same thing to a local decoder and to an HTTP body.
    media_type: str


class TextPrompt(BaseModel):
    """Find the things these words name.

    Each phrase is asked for independently and answers under itself, so the
    caller gets back the phrase it wrote rather than a class index it would have
    to map. Phrases are the *prompt*, never the schema: whether a returned label
    is a class this project declares is a question for the write gate, and
    nothing here consults a schema.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["text"] = "text"
    phrases: tuple[str, ...] = Field(min_length=1)


class PointPrompt(BaseModel):
    """Find the thing under these points.

    ``positive`` says *this*; ``negative`` says *not that* — the second is what
    lets somebody carve a hole out of an over-eager first answer without
    starting over. Coordinates are in the asset's native reference frame, the
    same as every geometry in this domain: pixels for an image, floats because
    a click is not obliged to land on one.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["points"] = "points"
    positive: tuple[tuple[float, float], ...] = Field(min_length=1)
    negative: tuple[tuple[float, float], ...] = ()


def require_points_on_asset(prompt: PointPrompt, *, width: int | None, height: int | None) -> None:
    """Every point in the gesture is a place on that asset, or none of it is asked.

    A rule about the prompt rather than about the model, which is why it sits
    here beside :class:`PointPrompt` and not in any provider: a coordinate past
    the frame is meaningless to every model there will ever be, and the point of
    refusing it in one place is that no adapter has to remember to.

    **One bad point refuses the whole gesture.** Dropping it and answering the
    rest would answer a question the caller did not ask — a prompt with a point
    removed is a different prompt — and negatives are checked exactly like
    positives, because a *not that* pointing at nothing steers the answer just
    as wrongly as a *this* would.

    **The frame is inclusive at both ends.** The last row of pixels is part of
    the asset, and an exclusive rule would make the far edge a place where a
    press silently stopped working. The editor's own hit test draws the boundary
    the same way, and the two must agree or there is a coordinate one accepts
    and the other refuses. A non-finite coordinate falls out of the comparisons
    rather than being tested for, and is refused.

    An asset whose dimensions were never recorded is not checked. There is
    nothing to check against, and refusing every prompt on it would punish the
    caller for a gap in the asset's own metadata.

    Raises:
        PromptPointOutOfBounds: some point is not on an asset that size.
    """
    if width is None or height is None:
        return
    for which, points in (("positive", prompt.positive), ("negative", prompt.negative)):
        for x, y in points:
            if not (0.0 <= x <= width and 0.0 <= y <= height):
                raise PromptPointOutOfBounds(
                    f"the {which} point at ({x:g}, {y:g}) is not on this asset, which is "
                    f"{width} by {height} pixels; send coordinates with x in [0, {width}] "
                    f"and y in [0, {height}]"
                )


Prompt = Annotated[TextPrompt | PointPrompt, Field(discriminator="kind")]
"""How a caller says what it is looking for.

Discriminated on ``kind`` for the reason ``Geometry`` is discriminated on
``type``: a third way of asking arrives as one model plus one name in this union,
and no existing payload stops parsing.
"""


class PredictionRequest(BaseModel):
    """One question, over one batch of images.

    Frozen, because a provider must not be able to edit what it was asked — and
    because a caller retrying a chunk after a failure needs the request it sent,
    not the one a failed attempt left behind.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    targets: tuple[PredictionTarget, ...] = Field(min_length=1)
    prompt: Prompt
    #: Answers below this are not worth returning. The one piece of tuning the
    #: port carries, because it is the one every model can honour: a score in
    #: [0, 1] compared against the same score the answer publishes. Per-head
    #: thresholds are an adapter's business and are not expressible here on
    #: purpose — a caller that could set them would be configuring a model
    #: through a port that is supposed to hide which model it is.
    minimum_confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class PredictedRegion(BaseModel):
    """One thing a model claims to have found.

    ``geometry`` is the domain's own union, so a detection and a segment are the
    same type here — a box variant and a polygon variant of one field, rather
    than two parallel result shapes that every caller would have to branch on.

    ``label`` is the phrase or class the model answered with, **as it said it**.
    Nothing here maps it onto a project's schema: that is the write gate's job,
    and doing it in the port would make a provider need a schema it has no way to
    have.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    label: str
    confidence: float = Field(ge=0.0, le=1.0)
    geometry: Geometry


class AssetPrediction(BaseModel):
    """Everything a model found on one image, and which model found it.

    **Self-describing on purpose.** ``model_ref`` is on the answer rather than on
    the response as a whole because these arrive one at a time — ``predict``
    yields — so a caller may hold one of these long after the call that produced
    it, and an answer that could not say what produced it would be a provenance
    with a footnote.

    That string is the one an annotation carries: ``Annotation.model_ref``, copied
    onto the label at write time and denormalised on purpose, so deleting the
    connection it came from never breaks provenance. It is
    **not** an ``InferenceConnection.model_id`` — the connection names *which
    weights are configured*, and this names *what actually answered*.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset_id: UUID
    model_ref: str
    #: Empty is an ordinary answer and not a failure: a model asked for cats on a
    #: picture of a road has honestly found none.
    regions: tuple[PredictedRegion, ...] = ()
