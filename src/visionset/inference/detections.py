# usage: from visionset.inference import detect
"""Every instance of one class on one image, proposed and never written.

The deliberate plural beside :func:`~visionset.inference.suggest`: a point prompt
is about one object, and a mask that comes back in pieces is still that one
object. Several independent things are asked for in words, through a
``text_detect`` connection, and each answer is a candidate with its own score.

**Nothing is written.** This returns candidates and forgets them. Accepting some
of them is a later, ordinary annotation write by a caller that carries the
``model_ref`` and each candidate's own ``confidence``. The batch pre-label path
is not reached: no ``enter_unreviewed``, no progress move, no job.

**Mapping is pre-labeling's.** A region becomes a candidate only under
:func:`~visionset.inference.prelabel.mapped_class`, the rule a run writes by: its
label must name the phrase asked for, and its shape must be one the class admits
and the model declares. Anything else is dropped and counted, never widened or
relabeled. A region with no overlap with a measured asset is dropped the same way.

**No duplicate removal.** Two overlapping regions are two candidates. Spatial
overlap alone does not establish that two answers are one object, and the model
already applied whatever suppression it applies.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Final
from uuid import UUID

from visionset.inference.prelabel import (
    DEFAULT_MINIMUM_CONFIDENCE,
    RegionDrop,
    class_by_answer,
    mapped_class,
    shapes_prose,
    unsupported_prompt_message,
)
from visionset.inference.providers import ProviderPool, resident
from visionset.kernel.domain import (
    BboxGeometry,
    Geometry,
    GeometryType,
    PredictedRegion,
    PredictionRequest,
    PredictionTarget,
    TextPrompt,
    media_type_of,
    require_image,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.errors import GeometryNotProduced, UnsupportedPrompt
from visionset.kernel.ports import ModelProvider
from visionset.kernel.services import InferenceConnectionService, IngestService, WorkspaceService

MAXIMUM_CANDIDATES: Final = 100
"""The most candidates one answer carries. The rest are counted as ``over_limit``.

Past this a person is no longer choosing among proposals, and the lowest-scored
ones are the ones cut, because the order is by confidence first."""


@dataclass(frozen=True, slots=True)
class DetectionCandidate:
    """One thing the model found, as the class it would be written as.

    ``id`` is positional in the answer's order — ``c0`` is the most confident —
    and means nothing outside this answer.
    """

    id: str
    label_class: str
    label: str
    geometry: Geometry
    confidence: float


@dataclass(frozen=True, slots=True)
class DetectionDiscards:
    """How many regions the model answered with did not become candidates, by why."""

    unmapped_label: int = 0
    incompatible_geometry: int = 0
    out_of_bounds: int = 0
    below_minimum_confidence: int = 0
    over_limit: int = 0


@dataclass(frozen=True, slots=True)
class Detection:
    """What one detection request produced, and which model produced it."""

    model_ref: str
    phrase: str
    candidates: tuple[DetectionCandidate, ...] = ()
    discarded: DetectionDiscards = field(default_factory=DetectionDiscards)


def _anchor(geometry: Geometry) -> tuple[float, float]:
    """Top, then left — the tie-break between two equally confident candidates."""
    if isinstance(geometry, BboxGeometry):
        return (geometry.y, geometry.x)
    points = [(float(point[0]), float(point[1])) for point in getattr(geometry, "points", ())]
    if not points:
        return (0.0, 0.0)
    return (min(y for _, y in points), min(x for x, _ in points))


def candidates_from(
    regions: Iterable[PredictedRegion],
    *,
    phrase: str,
    label_class: str,
    admits: frozenset[GeometryType],
    width: int | None,
    height: int | None,
    minimum_confidence: float,
    limit: int = MAXIMUM_CANDIDATES,
) -> tuple[tuple[DetectionCandidate, ...], DetectionDiscards]:
    """The regions that can be written as ``label_class``, ordered and capped, and the rest counted.

    Order is confidence descending, then top, then left, then the model's own
    order. A model that ignored the confidence floor it was sent is held to it here.
    """
    classes = class_by_answer({phrase: label_class})
    kept: list[PredictedRegion] = []
    unmapped = incompatible = out_of_bounds = below = 0
    for region in regions:
        mapped = mapped_class(region, classes=classes, admits={label_class: admits})
        if mapped is RegionDrop.UNMAPPED_LABEL:
            unmapped += 1
        elif mapped is RegionDrop.INCOMPATIBLE_GEOMETRY:
            incompatible += 1
        elif not geometry_intersects_asset(region.geometry, width=width, height=height):
            out_of_bounds += 1
        elif region.confidence < minimum_confidence:
            below += 1
        else:
            kept.append(region)
    ordered = sorted(kept, key=lambda region: (-region.confidence, *_anchor(region.geometry)))
    candidates = tuple(
        DetectionCandidate(
            id=f"c{index}",
            label_class=label_class,
            label=region.label,
            geometry=region.geometry,
            confidence=region.confidence,
        )
        for index, region in enumerate(ordered[:limit])
    )
    return candidates, DetectionDiscards(
        unmapped_label=unmapped,
        incompatible_geometry=incompatible,
        out_of_bounds=out_of_bounds,
        below_minimum_confidence=below,
        over_limit=max(0, len(ordered) - limit),
    )


def detect(
    workspace: WorkspaceService,
    *,
    project_id: UUID,
    asset_id: UUID,
    connection_id: UUID,
    label_class: str,
    allowed: tuple[GeometryType, ...],
    phrase: str | None = None,
    minimum_confidence: float = DEFAULT_MINIMUM_CONFIDENCE,
    pool: ProviderPool | None = None,
) -> Detection:
    """Every instance of ``label_class`` the model finds on that image, as candidates.

    The phrase is the class's own name unless one is given, as a pre-label run
    asks each class under its name. ``allowed`` is the class's geometries, as the
    caller holds them; candidates come back only in those of them the model
    declares, and a request where none overlap is refused rather than answered
    empty, because no answer from that model could ever fill it.

    An empty ``candidates`` is a real answer: the model found nothing worth
    proposing, or nothing that this class can hold.

    Raises:
        InferenceConnectionNotFound: no such connection in this workspace.
        InferenceConnectionNotSetUp: a local connection whose weights are not here.
        InferenceConnectionNotRunnable: nothing in this build runs that kind of
            connection, or that model type.
        LocalInferenceUnavailable: the optional runtime is not installed.
        InferenceOutOfMemory: the device ran out of memory loading or running the model.
        UnsupportedPrompt: that connection's model answers places, not words.
        GeometryNotProduced: the model answers in no shape ``allowed`` names.
        ProjectNotFound: no such project.
        AssetNotFound: no such asset in that project.
        UnsupportedMedia: the asset is a point cloud, which a detector cannot read.
    """
    asked = (phrase if phrase is not None else label_class).strip() or label_class

    connection = InferenceConnectionService(workspace).get(connection_id)
    resolved = pool or resident()
    runner = resolved.get(connection, workspace_root=workspace.root)
    if not isinstance(runner, ModelProvider):
        raise UnsupportedPrompt(unsupported_prompt_message(connection.name))
    produces = resolved.served(connection, workspace_root=workspace.root).produces
    admits = frozenset(allowed) & produces
    if not admits:
        raise GeometryNotProduced(
            f"this model answers in {shapes_prose(produces)}, and class {label_class!r} "
            f"is asked for in {shapes_prose(frozenset(allowed))}; detect for a class that "
            "admits one of the model's shapes, or use a connection whose model draws this one"
        )

    ingest = IngestService(workspace)
    asset = require_image(ingest.asset(project_id, asset_id))
    with ingest.open_content(asset) as handle:
        content = handle.read()

    request = PredictionRequest(
        targets=(
            PredictionTarget(
                asset_id=asset.id, content=content, media_type=media_type_of(asset.format)
            ),
        ),
        prompt=TextPrompt(phrases=(asked,)),
        minimum_confidence=minimum_confidence,
    )
    answer = next(iter(runner.predict(request)), None)
    if answer is None:
        return Detection(model_ref=str(getattr(runner, "model_ref", "")), phrase=asked)

    candidates, discarded = candidates_from(
        answer.regions,
        phrase=asked,
        label_class=label_class,
        admits=admits,
        width=asset.width,
        height=asset.height,
        minimum_confidence=minimum_confidence,
    )
    return Detection(
        model_ref=answer.model_ref, phrase=asked, candidates=candidates, discarded=discarded
    )
