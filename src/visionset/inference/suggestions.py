# usage: from visionset.inference import suggest
"""One click, one suggestion — the orchestration behind the editor's gesture.

**Here rather than in a route, because every surface would need the same thing.**
A route, a command and a tool would each have to resolve a connection, read an
asset's bytes, run a provider and narrow the answer to what the active class
admits; that is four steps of policy, and policy shared by surfaces moves down.
It cannot move all the way down into ``visionset.kernel`` — running a model means
torch — so it lives here, beside the adapters, exactly as ``fetch_weights`` does.

**Nothing is written.** A suggestion is a proposal: this returns it and forgets
it, and the annotation it may become is created later through the ordinary write
path, by a caller that carries the ``provenance``, ``model_ref`` and
``confidence`` an accepted suggestion earns (D4 on #424). The only thing that
outlives the call is the cached embedding, which is an optimisation and not a
record.

**One asset, one prompt set.** Batch invocation is #425's, and the shape here
says so: a single target in, a single answer out.
"""

from __future__ import annotations

from uuid import UUID

from visionset.inference.masks import DEFAULT_DETAIL, narrowed
from visionset.inference.providers import ProviderPool, resident
from visionset.kernel.domain import (
    AssetPrediction,
    GeometryType,
    PointPrompt,
    PredictedRegion,
    PredictionRequest,
    PredictionTarget,
    media_type_of,
)
from visionset.kernel.services import (
    InferenceConnectionService,
    IngestService,
    WorkspaceService,
)


def suggest(
    workspace: WorkspaceService,
    *,
    project_id: UUID,
    asset_id: UUID,
    connection_id: UUID,
    prompt: PointPrompt,
    allowed: tuple[GeometryType, ...],
    detail: float = DEFAULT_DETAIL,
    minimum_confidence: float = 0.0,
    pool: ProviderPool | None = None,
) -> AssetPrediction:
    """What the model proposes for that click, in a shape that class can hold.

    The order of the two lookups is the order of the refusals a caller most
    needs. The connection is resolved first because "no weights here yet" and
    "this build cannot run that kind" are answers about the *setup* somebody is
    part-way through, and getting them before an asset lookup means a caller
    fixing their configuration is not also told their asset is fine.

    An empty ``regions`` is a real answer and not a failure: the model was asked
    about a patch of sky, or was not sure enough, or the shape it found cannot be
    expressed in the kinds this class admits. Every one of those is "no
    suggestion", and none of them is an error somebody made.

    Raises:
        InferenceConnectionNotFound: no such connection in this workspace.
        InferenceConnectionNotSetUp: a local connection whose weights are not here.
        InferenceConnectionNotRunnable: nothing in this build runs that kind of
            connection, or that model type.
        LocalInferenceUnavailable: the optional runtime is not installed.
        UnsupportedPrompt: that connection's model answers words, not places.
        ProjectNotFound: no such project.
        AssetNotFound: no such asset in that project.
    """
    connection = InferenceConnectionService(workspace).get(connection_id)
    provider = (pool or resident()).get(connection, workspace_root=workspace.root)

    ingest = IngestService(workspace)
    asset = ingest.asset(project_id, asset_id)
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
    # ``predict`` yields, and this slice asks about exactly one asset — so one
    # ``next`` is the whole of the answer. A provider that yielded nothing at all
    # would be breaking the port's contract rather than reporting no findings,
    # which is what the default guards against.
    prediction = next(
        iter(provider.predict(request)),
        AssetPrediction(asset_id=asset.id, model_ref="", regions=()),
    )
    return prediction.model_copy(update={"regions": _in_kinds(prediction.regions, allowed)})


def _in_kinds(
    regions: tuple[PredictedRegion, ...], allowed: tuple[GeometryType, ...]
) -> tuple[PredictedRegion, ...]:
    """Every region the active class can actually hold, D3's rule applied.

    A region whose shape cannot be narrowed is dropped rather than offered in a
    kind the schema would refuse: the write that followed would fail validation,
    and a suggestion the product knows cannot be accepted is worse than no
    suggestion at all.
    """
    kept = []
    for region in regions:
        geometry = narrowed(region.geometry, allowed=allowed)
        if geometry is not None:
            kept.append(region.model_copy(update={"geometry": geometry}))
    return tuple(kept)
