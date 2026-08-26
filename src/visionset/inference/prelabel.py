# usage: from visionset.inference import pre_label
"""Labeling a job nobody has opened — the orchestration behind the background job.

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
among them. Asked to replace, it also reaches the frames it entered before and
supersedes them the same way, one frame per transaction, and nothing anybody
judged in this batch.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final
from uuid import UUID

from visionset.inference.providers import ProviderPool, resident
from visionset.kernel.domain import (
    OPEN_JOB_STATES,
    PRE_LABELABLE_STATES,
    Annotation,
    AnnotationJob,
    AnnotationSchema,
    AssetPrediction,
    AssetProgress,
    Batch,
    GeometryType,
    LabelClass,
    ModelCapability,
    PredictionRequest,
    PredictionTarget,
    ServedFamily,
    TextPrompt,
    media_type_of,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.domain.vocabulary import OpenVocabulary
from visionset.kernel.errors import (
    AssetNotWritable,
    BatchNotFound,
    BatchNotInAnnotation,
    GeometryNotProduced,
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
    JobService,
    ProjectService,
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
    #: Regions that could not be written as the class they named — a label
    #: naming no phrase asked for, or a shape the class does not admit or the
    #: model never declared. Discarded before an annotation is built rather
    #: than written and refused, so a run that drops a meaningful share of the
    #: model's output says so instead of reporting a clean success.
    regions_discarded: int = 0
    #: Regions whose geometry has no overlap with a measured asset. Kept
    #: separate from unmappable labels because their class mapping succeeded.
    regions_out_of_bounds: int = 0
    #: Model labels a replacing run superseded — rows that went so this run's
    #: could land. Zero for a run that was not asked to replace.
    annotations_replaced: int = 0


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


def shapes_prose(produces: frozenset[GeometryType]) -> str:
    """``a box``, ``a polygon``, ``a box or a polygon`` — the shapes, for a sentence."""
    names = {
        GeometryType.BBOX: "a box",
        GeometryType.POLYGON: "a polygon",
        GeometryType.POLYLINE: "a polyline",
        GeometryType.MASK: "a mask",
        GeometryType.KEYPOINTS: "keypoints",
        GeometryType.CLASSIFICATION_TAG: "a tag",
        GeometryType.CUBOID_3D: "a 3D cuboid",
        GeometryType.POLYLINE_3D: "a 3D polyline",
    }
    return " or ".join(
        names.get(shape, shape.value) for shape in sorted(produces, key=lambda shape: shape.value)
    )


def no_detectable_class_message(schema_version: int, produces: frozenset[GeometryType]) -> str:
    """The sentence a schema with no class this model's answer can land on gets.

    True of both reasons :func:`detectable_classes` excludes a class — no shape
    the model produces or a required attribute a prediction cannot supply —
    because it describes the outcome rather than either cause.
    """
    shapes = shapes_prose(produces)
    return (
        f"schema version {schema_version} declares no class that {shapes} can be written "
        f"as, so this model has nowhere to put what it finds; add a class whose "
        f"geometries include one of those, or pre-label a batch pinned to one that has"
    )


def effective_produces(
    declared: frozenset[GeometryType], selection: frozenset[GeometryType] | None
) -> frozenset[GeometryType]:
    """The shapes a run writes: the declaration, or the selection when it names a subset.

    The one narrowing site. Every reader of what a run writes — the schema
    gate, the plan, the per-class admission — takes this result, so a selection
    cannot reach one of them and miss another. ``None`` is the whole declared
    set, which is what every caller asked before a selection existed.

    Raises:
        GeometryNotProduced: the selection names a shape outside the
            declaration, or names no shape at all — either would be a run
            writing nothing and reporting success.
    """
    if selection is None:
        return declared
    shapes = shapes_prose(declared)
    if not selection:
        raise GeometryNotProduced(
            f"no shape selected for this run; choose at least one of {shapes}, or omit the "
            "selection to write every shape the model produces"
        )
    outside = selection - declared
    if outside:
        raise GeometryNotProduced(
            f"this model does not answer in {shapes_prose(frozenset(outside))}, only "
            f"{shapes}; choose from those, or omit the selection to write every shape "
            "the model produces"
        )
    return selection


class PreLabelExclusionReason(OpenVocabulary):
    """Why a schema's class is not among the words a run asks for.

    Open because it travels as a list a client renders member by member rather
    than switches on: a release that finds a third way a class cannot hold a
    detection must not cost an older client the whole plan, and the class it
    names is visibly left out whether or not that client can word the reason.
    """

    #: The class admits no shape the model produces, so an answer has nowhere to land.
    NO_PRODUCIBLE_GEOMETRY = "no_producible_geometry"
    #: The class declares a required attribute. A model's answer carries no
    #: attribute values, so a bare prediction has nothing to satisfy it with.
    REQUIRED_ATTRIBUTE = "required_attribute"


@dataclass(frozen=True, slots=True)
class PreLabelExcludedClass:
    """One class a run will not ask for, and every reason it will not.

    ``reasons`` is a sequence rather than a single value because both can hold
    at once, and a caller told only the first would add the shape to a class
    and watch it stay silently absent.
    """

    name: str
    reasons: tuple[PreLabelExclusionReason, ...]


@dataclass(frozen=True, slots=True)
class PreLabelPlan:
    """What a run over this schema would ask for, and what it would leave out.

    The two halves are derived together so they cannot disagree: every class the
    schema declares appears in exactly one of them, and the version they came
    from travels with them so a surface reporting the plan need not resolve the
    pin a second time.
    """

    #: The schema version both halves were derived from. A re-pin changes both.
    schema_version: int
    #: The prompt, in the schema's own declaration order.
    asked: tuple[str, ...]
    #: The shapes the model answers in — what the plan was derived against, and
    #: what a run writes.
    produces: frozenset[GeometryType]
    #: The rest, each with why — empty when the whole schema is askable.
    excluded: tuple[PreLabelExcludedClass, ...]


def _exclusions(
    label_class: LabelClass, produces: frozenset[GeometryType]
) -> tuple[PreLabelExclusionReason, ...]:
    """Every reason a bare prediction could not be written as this class."""
    reasons: list[PreLabelExclusionReason] = []
    if not (set(label_class.geometries) & produces):
        reasons.append(PreLabelExclusionReason.NO_PRODUCIBLE_GEOMETRY)
    if any(attribute.required for attribute in label_class.attributes):
        reasons.append(PreLabelExclusionReason.REQUIRED_ATTRIBUTE)
    return tuple(reasons)


def prompt_plan(schema: AnnotationSchema, produces: frozenset[GeometryType]) -> PreLabelPlan:
    """Split a schema into the classes a run asks for and the ones it cannot.

    The prompt on its own is not enough to work from: both exclusions are
    invisible in the result of a run, so somebody whose ``vehicle`` class
    requires a ``color`` finds no vehicles labeled and nothing saying why. Naming
    the left-out classes beside the asked-for ones puts the reason where the
    absence is, and it is derived here so every surface says the same thing.
    """
    asked: list[str] = []
    excluded: list[PreLabelExcludedClass] = []
    for label_class in schema.classes:
        reasons = _exclusions(label_class, produces)
        if reasons:
            excluded.append(PreLabelExcludedClass(name=label_class.name, reasons=reasons))
        else:
            asked.append(label_class.name)
    return PreLabelPlan(
        schema_version=schema.version,
        asked=tuple(asked),
        produces=produces,
        excluded=tuple(excluded),
    )


def detectable_classes(
    schema: AnnotationSchema, produces: frozenset[GeometryType]
) -> tuple[str, ...]:
    """The class names a shape the model produces can be written as, which are also the prompt.

    Public because the route asks it to refuse before enqueueing anything, and a
    second implementation of "which classes can hold a detection" is how a
    request that was accepted comes to fail inside a worker. It reads
    :func:`prompt_plan` for the same reason: the list a dialog shows and the
    list a run prompts with are one derivation, never two.
    """
    return prompt_plan(schema, produces).asked


def require_detectable_schema(
    workspace: WorkspaceService, batch: Batch, produces: frozenset[GeometryType]
) -> AnnotationSchema:
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
    if not detectable_classes(schema, produces):
        raise SchemaHasNoDetectableClass(no_detectable_class_message(schema.version, produces))
    return schema


def select_pre_labelable(
    workspace: WorkspaceService,
    project_id: UUID,
    produces: frozenset[GeometryType],
    batch_ids: Sequence[UUID] | None = None,
) -> list[Batch]:
    """The batches a project-wide run fans out over, or the refusal.

    ``batch_ids`` absent means every batch of the project that is open for
    annotation, in listing order; present means exactly those, in the order
    given. Refusals are whole: a named batch outside the project, a named
    batch not open, a project with no open batch, or any selected batch whose
    pin holds no class a shape the model produces can be written as — each
    refused up front, naming the batch, so a caller that got a list got one
    every surface can run as is.

    Raises:
        ProjectNotFound: no such project in this workspace.
        BatchNotFound: a named batch is not in this project.
        BatchNotInAnnotation: a named batch is not ``in_annotation``, the
            project has no open batch at all, or ``batch_ids`` is an empty list.
        WorkspaceCorrupt: an open batch pinned no schema version.
        SchemaHasNoDetectableClass: a selected batch's pinned schema holds no
            class a shape this model produces could be written as.
    """
    project = ProjectService(workspace).get(project_id)
    if batch_ids is not None and not batch_ids:
        raise BatchNotInAnnotation(
            f"no batch named for project {project.name!r}; pass at least one batch id, "
            "or omit batch_ids to run every batch open for annotation"
        )
    batches = BatchService(workspace)
    if batch_ids is None:
        selected = [one for one in batches.list(project_id) if one.state in PRE_LABELABLE_STATES]
    else:
        selected = []
        for batch_id in dict.fromkeys(batch_ids):
            batch = batches.get(batch_id)
            if batch.project_id != project_id:
                raise BatchNotFound(f"no batch {batch_id} in project {project.name!r}")
            selected.append(batches.require_pre_labelable(batch_id))
    if not selected:
        raise BatchNotInAnnotation(
            f"project {project.name!r} has no batch open for annotation; "
            "approve and start one, then ask again"
        )
    for batch in selected:
        try:
            require_detectable_schema(workspace, batch, produces)
        except SchemaHasNoDetectableClass as refusal:
            raise SchemaHasNoDetectableClass(f"batch {batch.name!r}: {refusal}") from refusal
    return selected


def open_jobs_of(workspace: WorkspaceService, batch_id: UUID) -> list[AnnotationJob]:
    """The batch's jobs a run may still be asked over, in segment order.

    What every fan-out iterates: a batch launch is one launch per open job,
    and a finished job is passed over rather than refused, because a batch
    finished half in the annotator is the ordinary case.
    """
    return [job for job in BatchService(workspace).jobs(batch_id) if job.state in OPEN_JOB_STATES]


def served_for(
    workspace: WorkspaceService, connection_id: UUID, *, pool: ProviderPool | None = None
) -> ServedFamily:
    """What the connection's model is asked for and answers in, refused unless it answers words.

    The one read a caller that must know the shapes before it runs anything
    makes — the plan, and the project-wide launch deciding which batches it can
    fan out over. Resolved, never built.

    Raises:
        InferenceConnectionNotFound: no such connection.
        InferenceConnectionNotSetUp: a local connection whose weights are absent.
        InferenceConnectionNotRunnable: nothing here runs that kind.
        UnsupportedPrompt: that connection's model answers places, not words.
    """
    connection = InferenceConnectionService(workspace).get(connection_id)
    declared = (pool or resident()).served(connection, workspace_root=workspace.root)
    if declared.capability is not ModelCapability.TEXT_DETECT:
        raise UnsupportedPrompt(unsupported_prompt_message(connection.name))
    return declared


def planned(
    workspace: WorkspaceService,
    *,
    batch_id: UUID,
    connection_id: UUID,
    geometries: frozenset[GeometryType] | None = None,
    pool: ProviderPool | None = None,
) -> PreLabelPlan:
    """The plan a run of that connection over that batch would prompt with, without running it.

    The same lookups in the same order as :func:`pre_label` — connection, then
    the selection, then batch, then schema — so a surface that reads this and
    then launches gets one set of refusals, not two. ``geometries`` narrows the
    plan to those of the model's shapes, exactly as it narrows the run; ``None``
    is every shape the model produces.

    Raises:
        InferenceConnectionNotFound: no such connection.
        InferenceConnectionNotSetUp: a local connection whose weights are absent.
        InferenceConnectionNotRunnable: nothing here runs that kind.
        UnsupportedPrompt: that connection's model answers places, not words.
        GeometryNotProduced: ``geometries`` names a shape the model does not
            produce, or no shape at all.
        BatchNotFound: no such batch in this workspace.
        BatchNotInAnnotation: the batch is not open for annotation, so a model
            cannot pre-label it.
        WorkspaceCorrupt: the batch is open but pinned no schema version — a
            broken invariant, since approval is what pins one.
        SchemaHasNoDetectableClass: the pinned schema holds no class a shape
            this model produces could be written as.
    """
    declared = served_for(workspace, connection_id, pool=pool)
    produces = effective_produces(declared.produces, geometries)
    batch = BatchService(workspace).require_pre_labelable(batch_id)
    schema = require_detectable_schema(workspace, batch, produces)
    return prompt_plan(schema, produces)


def pre_label(
    workspace: WorkspaceService,
    *,
    job_id: UUID,
    connection_id: UUID,
    minimum_confidence: float = DEFAULT_MINIMUM_CONFIDENCE,
    replace_model_labels: bool = False,
    geometries: frozenset[GeometryType] | None = None,
    on_plan: Callable[[PreLabelPlan], None] | None = None,
    on_progress: Callable[[int, int], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
    pool: ProviderPool | None = None,
) -> PreLabelOutcome:
    """Ask a model about every untouched asset in a job, and enter what it finds.

    The order of the lookups is the order of the refusals a caller most needs:
    the connection first, because "this build cannot run that kind" is an answer
    about a setup somebody is part-way through, then the job's own state and its
    batch's, then the schema, because a batch with nowhere to write what the
    model produces is refused before a single image is read.

    An asset untouched when the run started but worked by somebody before the
    run reaches it is passed over, not fatal — the batch is open for
    annotation, so that is the normal case rather than a race. The run keeps
    going and ``PreLabelOutcome.assets_skipped`` says how many.

    A region that could not be written as the class it named is passed over
    the same way — a label naming no phrase asked for, or a shape the class does
    not admit or the model never declared. A text-prompted detector answers
    with decoded text, not a choice from the phrase list, and a merged answer
    is discarded rather than guessed onto either half; a model declaring two
    shapes may answer in the one its class does not take.
    ``PreLabelOutcome.regions_discarded`` says how many.

    A region whose mapped geometry has no overlap with a measured asset is also
    passed over before the atomic write. ``PreLabelOutcome.regions_out_of_bounds``
    says how many; unmeasured assets remain eligible.

    ``replace_model_labels`` widens the run from untouched frames to every frame
    still ``pre_labeled`` — labels a model wrote and nobody has judged — and
    supersedes those labels with this run's answer, one frame per transaction.
    A frame anyone edited, confirmed or skipped in this batch is never touched,
    flagged or not. A frame the model now finds nothing on loses its stale
    labels and reads untouched again; ``PreLabelOutcome.annotations_replaced`` says how many
    labels went.

    ``geometries`` narrows what the run writes to those of the shapes the model
    declares: a region in any other shape is discarded and counted, and a class
    is asked for only when it admits one of the selected shapes. ``None`` is
    every shape the model produces. The selection is per run, not per class —
    a model answering both a box and a polygon for one region writes both
    unless one is left out here.

    ``on_plan`` is handed the prompt and the classes left out of it, once, after
    every refusal has passed and before the first forward pass — what a surface
    needs to say which classes a run will and will not ask for.

    Raises:
        InferenceConnectionNotFound: no such connection.
        InferenceConnectionNotSetUp: a local connection whose weights are absent.
        InferenceConnectionNotRunnable: nothing here runs that kind.
        UnsupportedPrompt: that connection's model answers places, not words.
        GeometryNotProduced: ``geometries`` names a shape the model does not
            produce, or no shape at all.
        JobNotFound: no such job in this workspace.
        BatchNotInAnnotation: the job's batch is not open for annotation, so a
            model cannot pre-label it.
        JobFinished: the job is completed.
        WorkspaceCorrupt: the batch is open but pinned no schema version — a
            broken invariant, since approval is what pins one.
        SchemaHasNoDetectableClass: the pinned schema holds no class a shape
            this model produces could be written as.
    """
    connection = InferenceConnectionService(workspace).get(connection_id)
    resolved = pool or resident()
    runner = resolved.get(connection, workspace_root=workspace.root)
    if not isinstance(runner, ModelProvider):
        # Refused here rather than inside the adapter, because the adapter it
        # would reach has no `predict` to refuse from. The split between the two
        # ports is what makes this checkable before anything loads.
        raise UnsupportedPrompt(unsupported_prompt_message(connection.name))
    declared = resolved.served(connection, workspace_root=workspace.root)
    produces = effective_produces(declared.produces, geometries)

    job, batch = JobService(workspace).require_pre_labelable(job_id)
    schema = require_detectable_schema(workspace, batch, produces)
    # Announced from inside the run rather than derived by the caller, so the
    # plan a surface reports is the one this run is about to prompt with and the
    # order the refusals above arrive in is left alone.
    plan = prompt_plan(schema, produces)
    if on_plan is not None:
        on_plan(plan)
    phrases = plan.asked
    class_by_answer = _class_by_answer(phrases)
    admits = {
        label_class.name: frozenset(label_class.geometries) & produces
        for label_class in schema.classes
    }

    targets = _targets(workspace, job, replace_model_labels=replace_model_labels)
    total = len(targets)
    annotations_service = AnnotationService(workspace)
    ingest = IngestService(workspace)

    considered = labeled = written = skipped = discarded = out_of_bounds = replaced = 0
    model_ref: str | None = None
    for asset_id, replacing in targets:
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
                annotations_replaced=replaced,
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
        in_bounds: list[Annotation] = []
        if answer is not None:
            model_ref = answer.model_ref
            proposed, dropped = _annotations_from(
                answer,
                asset_id=asset_id,
                schema_version=schema.version,
                class_by_answer=class_by_answer,
                admits=admits,
            )
            discarded += dropped
            in_bounds = [
                annotation
                for annotation in proposed
                if geometry_intersects_asset(
                    annotation.geometry, width=asset.width, height=asset.height
                )
            ]
            out_of_bounds += len(proposed) - len(in_bounds)
        if in_bounds or replacing:
            # A replacing frame goes through the door even with nothing to land:
            # the stale labels have to go, and only the door may take them.
            superseded = (
                sum(
                    1
                    for annotation in annotations_service.for_asset(job.id, asset_id)
                    if annotation.provenance == "model"
                )
                if replacing
                else 0
            )
            try:
                annotations_service.enter_unreviewed(
                    job.id, in_bounds, replacing={asset_id} if replacing else ()
                )
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
                replaced += superseded
                if in_bounds:
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
        annotations_replaced=replaced,
    )


def _targets(
    workspace: WorkspaceService,
    job: AnnotationJob,
    *,
    replace_model_labels: bool,
) -> tuple[tuple[UUID, bool], ...]:
    """Every ``(asset, replacing)`` this run will reach, in a stable order.

    Read off the job's own progress rather than off its batch's membership: a
    batch of any size is partitioned into several jobs, and only the one asked
    about is this run's to write into.

    Progress alone does not prove untouched: ``annotated -> skipped ->
    unannotated`` is legal and deletes no labels, so an asset can read
    ``unannotated`` while a person's boxes still sit on it. Checking that it
    also carries no annotations is what makes this filter the same rule
    ``enter_unreviewed`` enforces, so such an asset is passed over silently
    here rather than reaching the run as a refusal.

    A ``pre_labeled`` asset is a target only when the run was asked to replace,
    and is marked so: it goes through the door's replacing path, which is the
    only path that may remove what an earlier run wrote.
    """
    candidates = [
        (asset_id, progress is AssetProgress.PRE_LABELED)
        for asset_id, progress in job.progress.items()
        if progress is AssetProgress.UNANNOTATED
        or (replace_model_labels and progress is AssetProgress.PRE_LABELED)
    ]
    with workspace.unit_of_work() as uow:
        return tuple(
            (asset_id, replacing)
            for asset_id, replacing in candidates
            if replacing or not uow.annotations.list(asset_id)
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
    admits: Mapping[str, frozenset[GeometryType]],
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

    A region whose shape the matched class does not admit, or the model never
    declared, is dropped the same way. A model declaring both a box and a
    polygon may answer either for a class that takes only one, and a model
    that declares only one shape has nowhere to land a region of the other,
    even for a class that would otherwise admit it.

    ``schema_version`` is supplied because ``Annotation`` requires one; the
    service stamps the pinned value over it, which is what keeps a caller from
    claiming a version it does not get to choose.
    """
    annotations = []
    discarded = 0
    for region in answer.regions:
        label_class = class_by_answer.get(region.label.casefold())
        if label_class is None:
            discarded += 1
            continue
        if region.geometry.type not in admits[label_class]:
            discarded += 1
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
    return annotations, discarded
