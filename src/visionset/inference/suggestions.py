# usage: from visionset.inference import suggest
"""One click, one suggestion — the orchestration behind the editor's gesture.

**Here rather than in a route, because every surface would need the same thing.**
A route, a command and a tool would each have to resolve a connection, read an
asset's bytes, run a segmenter and turn its mask into shapes the active class
admits; that is four steps of policy, and policy shared by surfaces moves down.
It cannot move all the way down into ``visionset.kernel`` — running a model means
torch — so it lives here, beside the adapters, exactly as ``fetch_weights`` does.

**This is where the pipeline runs, and that is the design.** The segmenter's
answer is a mask; which of its pieces become shapes, whether their holes are
closed and how many vertices survive are decisions somebody adjusts, so they
happen on this side of the port where a caller's parameters can reach them. No
parameter of the pipeline travels to the model.

**Nothing is written.** A suggestion is a proposal: this returns it and forgets
it, and the annotation it may become is created later through the ordinary write
path, by a caller that carries the ``provenance``, ``model_ref`` and
``confidence`` an accepted suggestion earns. The only thing that outlives the
call is the cached embedding, which is an optimisation and not a record.

**One asset, one prompt set.** Batch prediction is a separate path, and the shape
here says so: a single target in, a single answer out.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from visionset.inference.masks import Point, Shaped, shapes_from, target_kind
from visionset.inference.providers import ProviderPool, resident
from visionset.kernel.domain import (
    DEFAULT_DETAIL,
    Detail,
    GeometryType,
    PointPrompt,
    PredictionRequest,
    PredictionTarget,
    SuggestParameter,
    media_type_of,
    require_points_on_asset,
    suggest_parameters,
)
from visionset.kernel.errors import UnsupportedPrompt
from visionset.kernel.ports import PointSegmenter
from visionset.kernel.services import (
    InferenceConnectionService,
    IngestService,
    WorkspaceService,
)


@dataclass(frozen=True, slots=True)
class Suggestion:
    """What one click produced: the proposals, and which model made them.

    ``model_ref`` is present even when ``shapes`` is empty, because it is what an
    accepted suggestion has to carry and a caller that had to remember which
    connection it asked would be keeping a second copy of something the answer
    can simply state.

    ``confidence`` rides on the whole answer rather than on each shape: the model
    scored one mask, and the pieces the pipeline cut out of it are all that same
    claim seen in parts. Reporting a separate number per piece would invent
    precision the model never expressed.

    ``parameters`` is which settings have any effect on the kind of shape this
    request asked for. It is answered even when ``shapes`` is empty — a caller
    that adjusted its way into nothing needs the controls to adjust its way back
    out — which is why it is read from the *requested* kinds rather than from
    what came back.
    """

    model_ref: str
    shapes: tuple[Shaped, ...] = ()
    confidence: float = 0.0
    parameters: tuple[SuggestParameter, ...] = ()


def suggest(
    workspace: WorkspaceService,
    *,
    project_id: UUID,
    asset_id: UUID,
    connection_id: UUID,
    prompt: PointPrompt,
    allowed: tuple[GeometryType, ...],
    detail: Detail = DEFAULT_DETAIL,
    minimum_confidence: float = 0.0,
    pool: ProviderPool | None = None,
) -> Suggestion:
    """What the model proposes for that click, in shapes that class can hold.

    The order of the two lookups is the order of the refusals a caller most
    needs. The connection is resolved first because "no weights here yet" and
    "this build cannot run that kind" are answers about the *setup* somebody is
    part-way through, and getting them before an asset lookup means a caller
    fixing their configuration is not also told their asset is fine.

    An empty ``shapes`` is a real answer and not a failure: the model was asked
    about a patch of sky, or was not sure enough, or the shape it found cannot be
    expressed in the kinds this class admits, or the detail as set leaves
    nothing. Every one of those is "no suggestion", and none of them is an error
    somebody made.

    Raises:
        InferenceConnectionNotFound: no such connection in this workspace.
        InferenceConnectionNotSetUp: a local connection whose weights are not here.
        InferenceConnectionNotRunnable: nothing in this build runs that kind of
            connection, or that model type.
        LocalInferenceUnavailable: the optional runtime is not installed.
        UnsupportedPrompt: that connection's model answers words, not places.
        ProjectNotFound: no such project.
        AssetNotFound: no such asset in that project.
        PromptPointOutOfBounds: a point in the gesture is not on that asset.
    """
    kind = target_kind(allowed)
    # Read from what was *asked for*, not from what came back: an answer with
    # nothing in it still has to arrive with the controls that would change it.
    parameters = suggest_parameters(kind) if kind is not None else ()

    connection = InferenceConnectionService(workspace).get(connection_id)
    runner = (pool or resident()).get(connection, workspace_root=workspace.root)
    if not isinstance(runner, PointSegmenter):
        # A detector resolved for a pointing gesture. It is refused here rather
        # than inside the adapter because the adapter it would reach has no
        # `segment` to refuse from — the split between the two ports is what
        # makes this checkable before anything is loaded.
        raise UnsupportedPrompt(
            f"connection {connection.name!r} runs a model that answers words rather than "
            "places, so it has no way to interpret a click; use a connection whose model "
            "declares point_suggest"
        )

    ingest = IngestService(workspace)
    asset = ingest.asset(project_id, asset_id)
    # Before the bytes are read, because a prompt that names nowhere on this
    # asset is refused whether or not the file opens, and reading an image to
    # answer that would be work nobody asked for.
    require_points_on_asset(prompt, width=asset.width, height=asset.height)
    with ingest.open_content(asset) as handle:
        content = handle.read()

    request = PredictionRequest(
        targets=(
            PredictionTarget(
                asset_id=asset.id, content=content, media_type=media_type_of(asset.format)
            ),
        ),
        prompt=prompt,
        minimum_confidence=minimum_confidence,
    )
    # ``segment`` yields, and this slice asks about exactly one asset — so one
    # ``next`` is the whole of the answer. A segmenter that yielded nothing at
    # all would be breaking the port's contract rather than reporting no
    # findings, which is what the default guards against.
    answer = next(iter(runner.segment(request)), None)
    if answer is None or not answer.segments:
        return Suggestion(model_ref=_ref(runner), parameters=parameters)

    segment = answer.segments[0]
    at: tuple[Point, ...] = tuple(prompt.positive)
    shapes = shapes_from(segment.mask, allowed=allowed, detail=detail, at=at)
    return Suggestion(
        model_ref=answer.model_ref,
        shapes=tuple(shapes),
        confidence=segment.score,
        parameters=parameters,
    )


def _ref(runner: PointSegmenter) -> str:
    """The model reference for an answer that carried none.

    A segmenter that found nothing still yields an ``AssetSegmentation`` and that
    carries its own ``model_ref``, so this is only reached when the port yielded
    nothing at all. Every adapter here exposes ``model_ref`` as a property; a
    hosted one that did not would leave the field empty rather than fail, which
    is what the answer already says about a suggestion with nothing in it.
    """
    return str(getattr(runner, "model_ref", ""))
