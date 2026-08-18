# usage: from visionset.inference import pre_label
"""Labeling a batch nobody has opened — the orchestration behind the background job.

**Here rather than in a handler, because every surface would need the same
thing.** A route, a command and a tool would each have to resolve a connection,
derive the prompt from a pinned schema, collect the untouched assets and write
what came back; that is four steps of policy, and policy shared by surfaces moves
down. It cannot move into ``visionset.kernel`` — running a model means torch —
so it lives here beside the adapters, exactly as ``suggest`` does.

**The schema is the prompt.** The phrases are the pinned schema's own class names,
so an answer maps back to the class it was asked under and nothing comes back that
has nowhere to be written. The cost is that class names have to be words a
zero-shot model understands, and that is the honest constraint rather than a
defect: a schema of opaque codes is refused up front instead of quietly returning
nothing.

**One asset is one transaction.** ``enter_unreviewed`` commits an asset's labels
and its move to ``review_pending`` together, so a run that dies has either not
touched an asset or fully entered it. That is also what makes a second run safe:
it collects the untouched assets again, and the ones already entered are no longer
among them.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Final
from uuid import UUID

from visionset.inference.providers import ProviderPool, resident
from visionset.kernel.domain import (
    PRE_LABELABLE_STATES,
    Annotation,
    AnnotationJob,
    AnnotationSchema,
    AssetPrediction,
    AssetProgress,
    GeometryType,
    PredictionRequest,
    PredictionTarget,
    TextPrompt,
    media_type_of,
    require_state,
)
from visionset.kernel.errors import SchemaHasNoDetectableClass, UnsupportedPrompt, WorkspaceCorrupt
from visionset.kernel.ports import ModelProvider
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    InferenceConnectionService,
    IngestService,
    SchemaService,
    WorkspaceService,
)

DEFAULT_MINIMUM_CONFIDENCE: Final = 0.35
"""The floor a run applies unless somebody sets one.

Read off the observed range for this kind of model rather than chosen for
roundness: a text-prompt detector scores *prompt affinity*, and on-domain that
score has been seen between 0.37 and 0.78. Sitting just under the observed floor
makes a first run recall-shaped, which is what shows somebody what the model
actually sees instead of an empty batch that reads as a broken feature. It is a
different scale from a point-prompted segmenter's mask quality, and the two must
never share a threshold.
"""


@dataclass(frozen=True, slots=True)
class PreLabelOutcome:
    """What one run did, in the terms a job row publishes."""

    assets_considered: int
    assets_labeled: int
    annotations_written: int
    #: What actually answered. ``None`` when nothing was asked.
    model_ref: str | None = None
    stopped_early: bool = False


def detectable_classes(schema: AnnotationSchema) -> tuple[str, ...]:
    """The class names a box can be written as, which are also the prompt.

    Public because the route asks it to refuse before enqueueing anything, and a
    second implementation of "which classes can hold a detection" is how a
    request that was accepted comes to fail inside a worker.
    """
    return tuple(
        label_class.name
        for label_class in schema.classes
        if GeometryType.BBOX in label_class.geometries
    )


def pre_label(
    workspace: WorkspaceService,
    *,
    batch_id: UUID,
    connection_id: UUID,
    minimum_confidence: float = DEFAULT_MINIMUM_CONFIDENCE,
    on_progress: Callable[[int, int], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
    pool: ProviderPool | None = None,
) -> PreLabelOutcome:
    """Ask a model about every untouched asset in a batch, and enter what it finds.

    The order of the lookups is the order of the refusals a caller most needs:
    the connection first, because "this build cannot run that kind" is an answer
    about a setup somebody is part-way through, then the batch's own state,
    then the schema, because a batch with nowhere to write a box is refused
    before a single image is read.

    Raises:
        InferenceConnectionNotFound: no such connection.
        InferenceConnectionNotSetUp: a local connection whose weights are absent.
        InferenceConnectionNotRunnable: nothing here runs that kind.
        UnsupportedPrompt: that connection's model answers places, not words.
        BatchNotFound: no such batch in this workspace.
        InvalidTransition: the batch is not open for annotation, so a model
            cannot pre-label it.
        WorkspaceCorrupt: the batch is open but pinned no schema version — a
            broken invariant, since approval is what pins one.
        SchemaHasNoDetectableClass: the pinned schema holds no box class.
    """
    connection = InferenceConnectionService(workspace).get(connection_id)
    runner = (pool or resident()).get(connection, workspace_root=workspace.root)
    if not isinstance(runner, ModelProvider):
        # Refused here rather than inside the adapter, because the adapter it
        # would reach has no `predict` to refuse from. The split between the two
        # ports is what makes this checkable before anything loads.
        raise UnsupportedPrompt(
            f"connection {connection.name!r} runs a model that answers places rather than "
            "words, so it cannot be asked what is in a picture; use a connection whose "
            "model declares text_detect"
        )

    batches = BatchService(workspace)
    batch = batches.get(batch_id)
    require_state(
        PRE_LABELABLE_STATES,
        batch.state,
        subject=f"batch {batch.name!r}",
        refusal="a model cannot pre-label it",
    )
    if batch.schema_version is None:
        # Unreachable through the checks above: approval is what pins a schema
        # version, and `require_state` has just established this batch is open
        # for annotation, which only follows approval. A `None` here is a
        # broken invariant rather than a missing schema.
        raise WorkspaceCorrupt(
            f"batch {batch.name!r} is {batch.state.value!r} but pinned no schema version; "
            "approval is what pins one, and it is never unset"
        )
    schema = SchemaService(workspace).get(batch.project_id, batch.schema_version)
    phrases = detectable_classes(schema)
    if not phrases:
        raise SchemaHasNoDetectableClass(
            f"schema version {schema.version} declares no class that a box can be written "
            f"as, so a detector has nowhere to put what it finds; add a class whose "
            f"geometries include bbox, or pre-label a batch pinned to one that has"
        )

    jobs = batches.jobs(batch_id)
    targets = _untouched(jobs)
    total = len(targets)
    annotations_service = AnnotationService(workspace)
    ingest = IngestService(workspace)

    considered = labeled = written = 0
    model_ref: str | None = None
    for job_id, asset_id in targets:
        # Between assets, which is the only place stopping is honest: the last
        # asset is committed and the next has not been touched.
        if should_stop is not None and should_stop():
            return PreLabelOutcome(considered, labeled, written, model_ref, stopped_early=True)

        asset = ingest.asset(batch.project_id, asset_id)
        with ingest.open_content(asset) as handle:
            content = handle.read()
        request = PredictionRequest(
            targets=(
                PredictionTarget(
                    asset_id=asset.id, content=content, media_type=media_type_of(asset.format)
                ),
            ),
            prompt=TextPrompt(phrases=phrases),
            minimum_confidence=minimum_confidence,
        )
        answer = next(iter(runner.predict(request)), None)
        considered += 1
        if answer is not None:
            model_ref = answer.model_ref
            proposed = _annotations_from(answer, asset_id=asset_id, schema_version=schema.version)
            if proposed:
                annotations_service.enter_unreviewed(job_id, proposed)
                labeled += 1
                written += len(proposed)
        if on_progress is not None:
            on_progress(considered, total)

    return PreLabelOutcome(considered, labeled, written, model_ref)


def _untouched(jobs: Sequence[AnnotationJob]) -> tuple[tuple[UUID, UUID], ...]:
    """Every ``(job, asset)`` nobody has worked, in a stable order.

    Read off the jobs rather than off the batch's membership, because the write
    needs the job that carries the asset and a batch of any size is partitioned
    into several.
    """
    return tuple(
        (job.id, asset_id)
        for job in jobs
        for asset_id, progress in job.progress.items()
        if progress is AssetProgress.UNANNOTATED
    )


def _annotations_from(
    answer: AssetPrediction, *, asset_id: UUID, schema_version: int
) -> list[Annotation]:
    """One label per region, carrying what produced it.

    ``schema_version`` is supplied because ``Annotation`` requires one; the
    service stamps the pinned value over it, which is what keeps a caller from
    claiming a version it does not get to choose.
    """
    return [
        Annotation(
            asset_id=asset_id,
            label_class=region.label,
            schema_version=schema_version,
            geometry=region.geometry,
            provenance="model",
            model_ref=answer.model_ref,
            confidence=region.confidence,
        )
        for region in answer.regions
    ]
