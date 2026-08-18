# usage: from visionset.inference import pre_label
"""Labeling a batch nobody has opened — the orchestration behind the background job.

**Here rather than in a handler, because every surface would need the same
thing.** A route, a command and a tool would each have to resolve a connection,
derive the prompt from a pinned schema, collect the untouched assets and write
what came back; that is four steps of policy, and policy shared by surfaces moves
down. It cannot move into ``visionset.kernel`` — running a model means torch —
so it lives here beside the adapters, exactly as ``suggest`` does.

**The schema is the prompt.** The phrases are the pinned schema's own class names,
so a phrase a detector answers with is one a class was asked under — but a
text-prompted detector decodes token spans, not a choice from the phrase list, and
a span crossing a phrase boundary answers with text nobody asked for. That answer
is matched back case-insensitively and discarded when it names no phrase; it is
not written under either half. The cost is that class names have to be words a
zero-shot model understands, and that is the honest constraint rather than a
defect: a schema of opaque codes is refused up front instead of quietly returning
nothing.

**One asset is one transaction.** ``enter_unreviewed`` commits an asset's labels
and its move to ``pre_labeled`` together, so a run that dies has either not
touched an asset or fully entered it. That is also what makes a second run safe:
it collects the untouched assets again, and the ones already entered are no longer
among them.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final
from uuid import UUID

from visionset.inference.providers import ProviderPool, resident
from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationSchema,
    AssetPrediction,
    AssetProgress,
    Batch,
    GeometryType,
    PredictionRequest,
    PredictionTarget,
    TextPrompt,
    media_type_of,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.errors import (
    AssetNotWritable,
    SchemaHasNoDetectableClass,
    UnsupportedPrompt,
    WorkspaceCorrupt,
)
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
    #: Untouched at the run's snapshot, but worked by somebody before this run
    #: reached them. Passed over rather than an error, on the same idempotency
    #: argument that makes a second run safe.
    assets_skipped: int = 0
    #: Regions the model answered with a label that named no phrase asked for —
    #: a span decoded across a phrase boundary, most often. Discarded before an
    #: annotation is built rather than written and refused, so a run that drops
    #: a meaningful share of the model's output says so instead of reporting a
    #: clean success.
    regions_discarded: int = 0
    #: Regions whose geometry has no overlap with a measured asset. Kept
    #: separate from unmappable labels because their class mapping succeeded.
    regions_out_of_bounds: int = 0


def unsupported_prompt_message(connection_name: str) -> str:
    """The sentence a connection whose model answers places, not words, gets.

    A function rather than a literal, so the route that refuses before
    enqueueing and the orchestration that refuses inside the job raise the
    identical sentence without either retyping the other's copy.
    """
    return (
        f"connection {connection_name!r} runs a model that answers places rather than "
        "words, so it cannot be asked what is in a picture; use a connection whose "
        "model declares text_detect"
    )


def no_detectable_class_message(schema_version: int) -> str:
    """The sentence a schema with no class a detection can land on gets.

    True of both reasons :func:`detectable_classes` excludes a class — missing
    ``bbox`` or a required attribute a prediction cannot supply — because it
    describes the outcome rather than either cause.
    """
    return (
        f"schema version {schema_version} declares no class that a box can be written "
        f"as, so a detector has nowhere to put what it finds; add a class whose "
        f"geometries include bbox, or pre-label a batch pinned to one that has"
    )


def detectable_classes(schema: AnnotationSchema) -> tuple[str, ...]:
    """The class names a box can be written as, which are also the prompt.

    Public because the route asks it to refuse before enqueueing anything, and a
    second implementation of "which classes can hold a detection" is how a
    request that was accepted comes to fail inside a worker.

    A class is excluded for either of two reasons: it does not admit ``bbox``,
    or it declares a required attribute. A model's answer carries no attribute
    values, so a class demanding one is not a class a bare prediction could ever
    satisfy — excluding it here is what keeps that fact from surfacing as a
    write that fails deep inside a run instead of as a batch this function never
    offered.
    """
    return tuple(
        label_class.name
        for label_class in schema.classes
        if GeometryType.BBOX in label_class.geometries
        and not any(attribute.required for attribute in label_class.attributes)
    )


def require_detectable_schema(workspace: WorkspaceService, batch: Batch) -> AnnotationSchema:
    """The pinned schema of a batch already established as pre-labelable, or the refusal.

    The one read the route and the orchestration both need before they can go
    on — resolved here once so neither repeats the other's guard or drifts from
    it. ``batch`` is expected to have already passed
    :meth:`BatchService.require_pre_labelable`, which is what makes a ``None``
    pin unreachable rather than merely unlikely.

    Raises:
        WorkspaceCorrupt: the batch is open but pinned no schema version — a
            broken invariant, since approval is what pins one and it is never
            unset.
        SchemaHasNoDetectableClass: the pinned schema holds no class a
            detection could be written as.
    """
    if batch.schema_version is None:
        raise WorkspaceCorrupt(
            f"batch {batch.name!r} is {batch.state.value!r} but pinned no schema version; "
            "approval is what pins one, and it is never unset"
        )
    schema = SchemaService(workspace).get(batch.project_id, batch.schema_version)
    if not detectable_classes(schema):
        raise SchemaHasNoDetectableClass(no_detectable_class_message(schema.version))
    return schema


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

    An asset untouched when the run started but worked by somebody before the
    run reaches it is passed over, not fatal — the batch is open for
    annotation, so that is the normal case rather than a race. The run keeps
    going and ``PreLabelOutcome.assets_skipped`` says how many.

    A region whose label names no phrase asked for is passed over the same
    way: a text-prompted detector answers with decoded text, not a choice from
    the phrase list, and a merged answer is discarded rather than guessed onto
    either half. ``PreLabelOutcome.regions_discarded`` says how many.

    A region whose mapped geometry has no overlap with a measured asset is also
    passed over before the atomic write. ``PreLabelOutcome.regions_out_of_bounds``
    says how many; unmeasured assets remain eligible.

    Raises:
        InferenceConnectionNotFound: no such connection.
        InferenceConnectionNotSetUp: a local connection whose weights are absent.
        InferenceConnectionNotRunnable: nothing here runs that kind.
        UnsupportedPrompt: that connection's model answers places, not words.
        BatchNotFound: no such batch in this workspace.
        BatchNotInAnnotation: the batch is not open for annotation, so a model
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
        raise UnsupportedPrompt(unsupported_prompt_message(connection.name))

    batches = BatchService(workspace)
    batch = batches.require_pre_labelable(batch_id)
    schema = require_detectable_schema(workspace, batch)
    phrases = detectable_classes(schema)
    class_by_answer = _class_by_answer(phrases)

    jobs = batches.jobs(batch_id)
    targets = _untouched(workspace, jobs)
    total = len(targets)
    annotations_service = AnnotationService(workspace)
    ingest = IngestService(workspace)

    considered = labeled = written = skipped = discarded = out_of_bounds = 0
    model_ref: str | None = None
    for job_id, asset_id in targets:
        # Between assets, which is the only place stopping is honest: the last
        # asset is committed and the next has not been touched.
        if should_stop is not None and should_stop():
            return PreLabelOutcome(
                considered,
                labeled,
                written,
                model_ref,
                stopped_early=True,
                assets_skipped=skipped,
                regions_discarded=discarded,
                regions_out_of_bounds=out_of_bounds,
            )

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
            proposed, unmapped = _annotations_from(
                answer,
                asset_id=asset_id,
                schema_version=schema.version,
                class_by_answer=class_by_answer,
            )
            discarded += unmapped
            in_bounds = [
                annotation
                for annotation in proposed
                if geometry_intersects_asset(
                    annotation.geometry, width=asset.width, height=asset.height
                )
            ]
            out_of_bounds += len(proposed) - len(in_bounds)
            if in_bounds:
                try:
                    annotations_service.enter_unreviewed(job_id, in_bounds)
                except AssetNotWritable:
                    # The batch is `in_annotation`, so somebody working in it
                    # while this run is in flight is the normal case, not a
                    # race to report as a failure. Passing over an asset that
                    # moved underneath is the same decision as never having
                    # selected it — the run's own idempotency already makes
                    # that call for a second run; this is the first run
                    # discovering it needed to make the call too.
                    skipped += 1
                else:
                    labeled += 1
                    written += len(in_bounds)
        if on_progress is not None:
            on_progress(considered, total)

    return PreLabelOutcome(
        considered,
        labeled,
        written,
        model_ref,
        assets_skipped=skipped,
        regions_discarded=discarded,
        regions_out_of_bounds=out_of_bounds,
    )


def _untouched(
    workspace: WorkspaceService, jobs: Sequence[AnnotationJob]
) -> tuple[tuple[UUID, UUID], ...]:
    """Every ``(job, asset)`` nobody has worked, in a stable order.

    Read off the jobs rather than off the batch's membership, because the write
    needs the job that carries the asset and a batch of any size is partitioned
    into several.

    Progress alone does not prove untouched: ``annotated -> skipped ->
    unannotated`` is legal and deletes no labels, so an asset can read
    ``unannotated`` while a person's boxes still sit on it. Checking that it
    also carries no annotations is what makes this filter the same rule
    ``enter_unreviewed`` enforces, so such an asset is passed over silently
    here rather than reaching the run as a refusal.
    """
    candidates = [
        (job.id, asset_id)
        for job in jobs
        for asset_id, progress in job.progress.items()
        if progress is AssetProgress.UNANNOTATED
    ]
    with workspace.unit_of_work() as uow:
        return tuple(
            (job_id, asset_id)
            for job_id, asset_id in candidates
            if not uow.annotations.list(asset_id)
        )


def _class_by_answer(phrases: Sequence[str]) -> dict[str, str]:
    """The casefolded form of each phrase asked for, to the schema's own spelling.

    ``prompt_text`` casefolds every phrase into the prompt, so the answer arrives
    casefolded too; this is the one place both sides are compared, and it maps
    the match back to what a person actually named the class.
    """
    return {phrase.casefold(): phrase for phrase in phrases}


def _annotations_from(
    answer: AssetPrediction,
    *,
    asset_id: UUID,
    schema_version: int,
    class_by_answer: Mapping[str, str],
) -> tuple[list[Annotation], int]:
    """Regions mapped onto a class that was asked for, and how many could not be.

    A region's label is text a detector decoded from spans over the prompt
    string, not a choice from the phrases asked for — so a span crossing a
    phrase boundary answers with text that names no class. Matching is
    case-insensitive, against the same casefolding the prompt applied, and a
    match is written under the schema's spelling rather than the model's. A
    label matching nothing is dropped here, before an annotation is built:
    writing it under either half of a merged answer would be inventing an
    attribution nobody can check.

    ``schema_version`` is supplied because ``Annotation`` requires one; the
    service stamps the pinned value over it, which is what keeps a caller from
    claiming a version it does not get to choose.
    """
    annotations = []
    unmapped = 0
    for region in answer.regions:
        label_class = class_by_answer.get(region.label.casefold())
        if label_class is None:
            unmapped += 1
            continue
        annotations.append(
            Annotation(
                asset_id=asset_id,
                label_class=label_class,
                schema_version=schema_version,
                geometry=region.geometry,
                provenance="model",
                model_ref=answer.model_ref,
                confidence=region.confidence,
            )
        )
    return annotations, unmapped
