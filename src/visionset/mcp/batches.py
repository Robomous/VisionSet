# usage: from visionset.mcp import batches
"""Batch tools: the one-way lifecycle, and the two listings that drive iteration.

``draft`` → ``approve`` → ``start`` → ``complete``, and there is no way back.
Approval freezes membership, pins the project's active schema version, and cuts
the batch into jobs; nothing after that can return it to a draft, because the
jobs are already partitioned against the pin.

**Membership editing is ``draft``-only.** ``add_batch_assets`` and
``remove_batch_assets`` are the twins of the REST routes, and an agent assembling
a batch out of assets it has already listed is the shape they serve. After
approval there is no
membership edit at all: the way to exclude an asset is ``set_asset_progress`` with
``skipped``, which keeps the decision on the record, and the tools say so where a
model will read it.

**Removing membership is not deleting an asset**, and both the tool name and its
description say so — the asset stays in its project and in every other batch. An
agent that reads "delete" and reaches for it to clean up a project would be doing
something no tool here can do.

``delete_batch`` is the module's one destructive tool and is registered **only**
under ``--allow-destructive``, with ``delete_project``, for the reason
``DESTRUCTIVE_TOOLS`` gives: when the caller is a model, ``confirm`` is a
parameter it reads in the same listing it chooses from, so the gate has to sit
somewhere the agent cannot reach. It destroys the *organisation* of work and
never the work — the
distinction the description leads with, because it is the one an agent is most
likely to get backwards.

``list_batch_jobs`` folds into ``get_batch``: a batch's jobs are how it is worked,
so an agent asking about a batch is about to ask about its jobs.

``jobs_of`` is the ``BySize`` partition and there is no way to spell
``BySegments``. That variant's own docstring says the caller has already decided
the split, and the only caller holding an exact partition is a program with the
SDK. It is also the one partition that can be *wrong*, with four distinct
refusals, and handing a model the chance to meet all four buys nothing.
"""

from __future__ import annotations

from typing import Annotated, Any, Final
from uuid import UUID

from pydantic import Field

from visionset import wire
from visionset.inference import (
    DEFAULT_MINIMUM_CONFIDENCE,
    PreLabelOutcome,
    PreLabelPlan,
    pre_label,
    prompt_plan,
    require_detectable_schema,
    select_pre_labelable,
)
from visionset.kernel.domain import AssetProgress, AssetSort, BySize, Partition
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    WorkspaceService,
)
from visionset.mcp._resolve import (
    ConnectionRef,
    ProjectRef,
    identifier,
    resolve_connection,
    resolve_project,
)
from visionset.mcp._workspace import opened_workspace

BatchRef = Annotated[str, Field(description="The batch, by id. Batch names are not unique.")]
"""The batch a tool acts on. Module-level for the ``inspect.signature`` reason."""

_ACTOR: Final = "mcp"
"""Who the dataset change log records for a promotion made by an agent."""


def _promoted(workspace: WorkspaceService, project_id: UUID) -> frozenset[UUID]:
    """The trunk's current membership, read once for the whole answer.

    The same cost model the REST routes use: one query per call rather than one
    per batch, because ``asset_ids`` is already in memory and the rest is a set
    intersection.
    """
    dataset = ProjectService(workspace).get_dataset(project_id)
    return DatasetService(workspace).member_asset_ids(dataset.id)


def _batch_payload(workspace: WorkspaceService, batch_id: UUID) -> dict[str, Any]:
    """The batch, its progress and its jobs — the shape most tools return."""
    batches = BatchService(workspace)
    batch = batches.get(batch_id)
    counts = JobService(workspace).batch_progress(batch.id)
    jobs = batches.jobs(batch.id)
    return {
        **wire.batch(
            batch,
            counts,
            promoted=_promoted(workspace, batch.project_id),
            pre_labeled=batches.latest_pre_label_job(batch.id),
        ),
        "jobs": [wire.job(j, batch_id=batch.id, batch_state=batch.state) for j in jobs],
    }


def create_batch(
    project: ProjectRef,
    name: Annotated[str, Field(description="What to call the batch.")],
    asset_ids: Annotated[
        list[str] | None,
        Field(description="Which of the project's assets to put in it. Omit to start empty."),
    ] = None,
) -> dict[str, Any]:
    """Start a draft batch over a chosen set of a project's assets.

    Most batches are born from an ingest run, which puts what it gathered into
    one — this is for the other case: curating a batch out of assets that are
    already in the project.

    A draft, so membership stays editable until `approve_batch` freezes it and
    pins the schema. To correct a batch that is already finished, use
    `create_correction_batch` instead: that one records the lineage.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        created = BatchService(workspace).create(
            resolved.id,
            name,
            [identifier(one, what="asset_id") for one in asset_ids or []],
        )
        return _batch_payload(workspace, created.id)


def add_batch_assets(
    batch_id: BatchRef,
    asset_ids: Annotated[
        list[str],
        Field(description="Which of the project's assets to put in the batch.", min_length=1),
    ],
) -> dict[str, Any]:
    """Put assets into a draft batch.

    Only while the batch is a draft: approval cuts it into jobs against a pinned
    schema, so an asset added afterwards would belong to no job. A batch past
    `draft` refuses this, and there is no flag that lifts it — check
    `allowed_actions` for `edit_membership` before offering it.

    Adding an asset the batch already holds is not an error and writes nothing.
    `changed` lists the ids this call actually added, so three ids of which two
    were already members reports one.
    """
    with opened_workspace() as workspace:
        change = BatchService(workspace).add_assets(
            identifier(batch_id, what="batch_id"),
            [identifier(one, what="asset_id") for one in asset_ids],
        )
        return {
            **_batch_payload(workspace, change.batch.id),
            "changed": [str(one) for one in change.changed],
        }


def remove_batch_assets(
    batch_id: BatchRef,
    asset_ids: Annotated[
        list[str],
        Field(description="Which assets to take out of the batch.", min_length=1),
    ],
) -> dict[str, Any]:
    """Take assets out of a draft batch. This does not delete anything.

    The asset stays in its project, keeps its annotations, and stays in every
    other batch that carries it; only this batch stops listing it. There is no
    tool that deletes an asset.

    Only while the batch is a draft, and after approval the refusal is the point:
    a job already describes work over that asset. From then on the way to exclude
    one is `set_asset_progress` with `skipped`, which records the decision instead
    of erasing it.

    An id the batch does not hold is ignored rather than refused; `changed`
    reports what actually went.
    """
    with opened_workspace() as workspace:
        change = BatchService(workspace).remove_assets(
            identifier(batch_id, what="batch_id"),
            [identifier(one, what="asset_id") for one in asset_ids],
        )
        return {
            **_batch_payload(workspace, change.batch.id),
            "changed": [str(one) for one in change.changed],
        }


def list_batches(project: ProjectRef) -> dict[str, Any]:
    """List a project's batches with where each one's assets have got to.

    The overview of outstanding work: `state` says whether a batch is open, and
    `progress.unannotated` says how much is left in it. A batch in
    `in_annotation` with unannotated assets is what `next_pending_assets` is for.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        batches = BatchService(workspace)
        found = batches.list(resolved.id)
        jobs = JobService(workspace)
        counts = [jobs.batch_progress(b.id) for b in found]
        promoted = _promoted(workspace, resolved.id)
        # One queue read for the whole listing rather than one per batch.
        pre_label_runs = batches.pre_label_runs()
    return wire.page(
        [
            wire.batch(b, c, promoted=promoted, pre_labeled=pre_label_runs.get(b.id))
            for b, c in zip(found, counts, strict=True)
        ],
    )


def get_batch(batch_id: BatchRef) -> dict[str, Any]:
    """Read one batch: its state, its schema pin, its progress and its jobs.

    `schema_version` is the contract every annotation in this batch is judged
    against, and it is null exactly while the batch is a draft. `jobs` is empty
    until the batch is approved — approval is what creates them.
    """
    with opened_workspace() as workspace:
        return _batch_payload(workspace, identifier(batch_id, what="batch_id"))


def approve_batch(
    batch_id: BatchRef,
    jobs_of: Annotated[
        int | None,
        Field(
            ge=1,
            description=(
                "Cut the batch into jobs of this many assets. Omit for one job "
                "covering the whole batch."
            ),
        ),
    ] = None,
) -> dict[str, Any]:
    """Freeze a batch, pin the project's active schema, and cut it into jobs.

    One-way: there is no route back to `draft`. Approval reads the project's
    *current* active schema version and records it on the batch, and a later
    `create_schema_version` does not move that pin — so approve after the schema
    is the one you want annotations judged against.

    Refuses if the batch has no assets, if it is not a draft, or if the project
    has no schema at all. Then call `start_batch` to open it for work.
    """
    # `ge=1` on the parameter rather than a check in the body: `BySize.size` is
    # `gt=0`, and constructing one with zero raises a pydantic ValidationError,
    # which is not a VisionSetError and would never reach the error envelope.
    partition: Partition | None = None if jobs_of is None else BySize(size=jobs_of)
    with opened_workspace() as workspace:
        approved = BatchService(workspace).approve(identifier(batch_id, what="batch_id"), partition)
        return _batch_payload(workspace, approved.id)


def start_batch(batch_id: BatchRef) -> dict[str, Any]:
    """Open an approved batch for annotation.

    Nothing may be written into a batch until this has been called: every
    annotation tool and `set_asset_progress` refuse while the batch is not
    `in_annotation`. Refuses if the batch has not been approved.
    """
    with opened_workspace() as workspace:
        started = BatchService(workspace).start(identifier(batch_id, what="batch_id"))
        return _batch_payload(workspace, started.id)


def get_pre_label_plan(batch_id: BatchRef) -> dict[str, Any]:
    """Which classes a pre-labeling run over this batch would ask a model about.

    Call this before `pre_label_batch`. That call blocks for minutes and this one
    is a single read, and what it answers decides whether the wait is worth it.

    **A run does not ask about every class the schema declares.** It asks about
    the ones a bare box prediction can be written as, and `asked_classes` is that
    list — it is the prompt itself, in the schema's own spelling.

    **`excluded_classes` names the rest, each with every reason it is left out.**
    `no_bbox_geometry` means the class admits no box, so a detection has no shape
    to land as. `required_attribute` means the class demands an attribute value,
    and a model's answer carries none. Both can hold against one class, which is
    why `reasons` is a list: a class told only that it admits no box, then given
    one, would stay absent from the next run's prompt with nothing saying why.

    Every class the pinned schema declares appears in exactly one of the two
    lists, and `schema_version` is the pin both were derived from — a re-pin
    changes both. A schema with nothing askable at all is refused here rather
    than answered with an empty prompt, exactly as `pre_label_batch` refuses
    it — as is a batch that is not `in_annotation`.

    No connection is involved: the prompt is a property of the pinned schema
    alone, so this answers the same lists whichever model is about to be asked.
    """
    with opened_workspace() as workspace:
        batch = BatchService(workspace).require_pre_labelable(identifier(batch_id, what="batch_id"))
        schema = require_detectable_schema(workspace, batch)
        return wire.pre_label_plan(prompt_plan(schema))


def _pre_label_outcome(outcome: PreLabelOutcome, plan: PreLabelPlan) -> dict[str, Any]:
    """The one outcome shape ``pre_label_batch`` and ``pre_label_project`` both report."""
    return {
        "assets_considered": outcome.assets_considered,
        "assets_labeled": outcome.assets_labeled,
        "annotations_written": outcome.annotations_written,
        "annotations_replaced": outcome.annotations_replaced,
        "model_ref": outcome.model_ref,
        "assets_skipped": outcome.assets_skipped,
        "regions_discarded": outcome.regions_discarded,
        "regions_out_of_bounds": outcome.regions_out_of_bounds,
        "plan": wire.pre_label_plan(plan),
    }


def pre_label_batch(
    batch_id: BatchRef,
    connection: ConnectionRef,
    minimum_confidence: Annotated[
        float,
        Field(
            ge=0.0,
            le=1.0,
            description=(
                "The floor a prediction must clear to be written, in [0, 1]. Tuned for a "
                "text-prompt model's prompt-affinity score — a point-prompt model's mask "
                "quality is a different scale and does not share a threshold with this."
            ),
        ),
    ] = DEFAULT_MINIMUM_CONFIDENCE,
    replace_model_labels: Annotated[
        bool,
        Field(
            description=(
                "Also rewrite the model labels on frames still `pre_labeled` — labels a "
                "model wrote and nobody has edited, confirmed or skipped — superseding them "
                "with this run's answer. Frames a person touched are never affected. This "
                "cannot be undone; read `get_batch`'s `progress.pre_labeled` first."
            )
        ),
    ] = False,
) -> dict[str, Any]:
    """Ask a model to label every untouched asset in a batch. This blocks until it is done.

    `download_connection_weights`'s pattern, not a shortcut: a stdio server has
    no background worker, so a tool that queued this work would answer with a
    job id nothing was ever going to claim — the API queues it instead, because
    the API has a dispatcher. This call runs one forward pass per untouched
    asset, so the wait is roughly that many times one image's inference time;
    for a batch of any size, expect minutes.

    **Interrupting is safe.** A run only ever writes to an asset nothing has
    touched, and commits one asset's labels in the same transaction as its move
    to `pre_labeled` — so a cut-off call has entered some prefix of the
    untouched assets and touched nothing else, and calling this again resumes
    with whatever is still untouched rather than starting over or double-writing
    what already landed.

    **Only assets nothing has touched — not merely assets reading
    `unannotated`.** An asset already `pre_labeled`, annotated, skipped,
    awaiting review or accepted is passed over, and so is an `unannotated` one
    that still carries annotations from a round that was skipped and later
    restored, since that sequence deletes no labels. A frame this tool already
    pre-labeled is therefore never re-asked about by a plain call, at any confidence.
    **`replace_model_labels` is the deliberate exception**: it also reaches every
    frame still `pre_labeled` and supersedes the model's labels there with this
    call's answer, one frame per transaction — a frame the model now finds
    nothing on returns to `unannotated`, and `annotations_replaced` in the
    result says how many labels went. A frame a person edited, confirmed or
    skipped is never touched either way. What is written lands at
    `pre_labeled`, never at `annotated` — nobody judged it, so it stays
    editable and out of the Dataset until somebody does. An asset somebody
    starts working while this call is still running is passed over the same
    way rather than failing the whole call; `assets_skipped` in the result
    says how many.

    **A region the model answered with a label that names no class asked for is
    discarded, not fatal.** A text-prompted detector answers with text decoded
    from spans over the prompt, not a choice from the classes it was asked
    about, so a span crossing the boundary between two phrases can answer with
    neither of them; `regions_discarded` in the result says how many.

    **A mapped region with no overlap with a measured asset is discarded
    separately.** `regions_out_of_bounds` in the result says how many; an
    asset without dimensions remains eligible.

    **The batch's pinned schema is the prompt.** The model is asked for each
    class the schema declares that a box can be written as; an answer naming one
    of those classes, matched case-insensitively, is written under the schema's
    own spelling. A schema whose classes are all polygons, polylines or tags —
    or whose box classes each require an attribute a prediction cannot supply —
    has nowhere for a detection to land and is refused before anything runs.

    `plan` in the result names both halves: `asked_classes` is what this run
    actually asked about, and `excluded_classes` names every class of the pinned
    schema it could not, each with every reason. `schema_version` is the pin
    both were derived from. Read it whenever
    `assets_labeled` is lower than expected — a run that asked about two of a
    schema's five classes labels nothing under the other three, and the counters
    alone cannot say so. `get_pre_label_plan` answers the same thing without
    running anything.

    Also refused before anything runs: a batch that is not `in_annotation`, a
    connection whose model answers places rather than words, and a deployment
    without the local runtime — with the install command in the message.
    """
    # Captured from the run rather than derived beside it: a plan read from the
    # schema separately could differ from the one the run prompted with, and
    # that it is the same list is the whole reason for reporting it.
    seen: list[PreLabelPlan] = []
    with opened_workspace() as workspace:
        resolved_connection = resolve_connection(workspace, connection)
        outcome = pre_label(
            workspace,
            batch_id=identifier(batch_id, what="batch_id"),
            connection_id=resolved_connection.id,
            minimum_confidence=minimum_confidence,
            replace_model_labels=replace_model_labels,
            on_plan=seen.append,
        )
    return _pre_label_outcome(outcome, seen[0])


def pre_label_project(
    project: ProjectRef,
    connection: ConnectionRef,
    minimum_confidence: Annotated[
        float,
        Field(
            ge=0.0,
            le=1.0,
            description="The floor a prediction must clear to be written, in [0, 1] — prompt "
            "affinity.",
        ),
    ] = DEFAULT_MINIMUM_CONFIDENCE,
    batch_ids: Annotated[
        list[str] | None,
        Field(
            description="Only these batches, in this order. Omit for every batch open for "
            "annotation."
        ),
    ] = None,
) -> dict[str, Any]:
    """Ask a model to label untouched assets across a project's open batches. Blocks until done.

    `pre_label_batch`, one batch after another: the batch stays the unit, each
    run writes what that tool writes and reports what it reports, and `items`
    holds one such outcome per batch with its `plan`; `annotations_written`
    is the total. Every batch of the project that is `in_annotation` is run,
    or exactly `batch_ids`.

    Refused whole before anything runs, so a call that started has a selection
    every batch of which can run: a named batch outside the project, a named
    batch that is not open, an empty `batch_ids`, a project with no open
    batch, or any selected batch whose pinned schema has no class a box can be
    written as — the message names that batch so it can be left out by name.
    Assets in no batch are not reached; cut a batch first (`create_batch`,
    `approve_batch`, `start_batch`).

    Interrupting is as safe as it is for one batch: some prefix of the
    selection is entered, asset by asset, and calling again resumes over what is
    still untouched.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        resolved_connection = resolve_connection(workspace, connection)
        selected = select_pre_labelable(
            workspace,
            resolved.id,
            None if batch_ids is None else [identifier(one, what="batch_id") for one in batch_ids],
        )
        items: list[dict[str, Any]] = []
        for batch in selected:
            seen: list[PreLabelPlan] = []
            outcome = pre_label(
                workspace,
                batch_id=batch.id,
                connection_id=resolved_connection.id,
                minimum_confidence=minimum_confidence,
                on_plan=seen.append,
            )
            items.append(
                {
                    "batch_id": str(batch.id),
                    "batch_name": batch.name,
                    **_pre_label_outcome(outcome, seen[0]),
                }
            )
    return {
        "items": items,
        "annotations_written": sum(item["annotations_written"] for item in items),
    }


def repin_batch(
    batch_id: BatchRef,
    allow_destructive: Annotated[
        bool,
        Field(
            description=(
                "Proceed even though the active version narrows what the pinned "
                "one allowed. Only set this after reading the refusal."
            )
        ),
    ] = False,
) -> dict[str, Any]:
    """Move a batch's schema pin onto the project's *current* active version.

    The pin does not follow the schema on its own, so a class you add with
    `create_schema_version` is invisible inside a batch that was approved before
    it — every annotation there is judged against the pinned version. This is how
    you make the new class usable without abandoning the batch, and it is the
    second half of "add a label class while annotating".

    Adding a class is additive and needs no flag. If the new version *narrows*
    what the pin allowed — a class removed, a geometry changed, an attribute made
    required — this refuses and tells you to retry with `allow_destructive`. If
    the batch already holds annotations under a class the change would break, it
    refuses with **no** `retry_with`: nothing overrides that, and the remedy is a
    wider schema version, not a louder yes.

    Legal only while the batch is `approved` or `in_annotation`. Re-pinning onto
    the version already pinned changes nothing. Annotations already written keep
    the version they were stamped with.
    """
    with opened_workspace() as workspace:
        repinned = BatchService(workspace).repin(
            identifier(batch_id, what="batch_id"), allow_destructive=allow_destructive
        )
        return _batch_payload(workspace, repinned.id)


def complete_batch(batch_id: BatchRef) -> dict[str, Any]:
    """Close a batch, once every one of its jobs is complete.

    Derived means recomputed, not automatic: this reads the jobs and refuses
    while any is outstanding, so complete the jobs first. A completed batch is
    what `promote_batch` requires.
    """
    with opened_workspace() as workspace:
        completed = BatchService(workspace).complete(identifier(batch_id, what="batch_id"))
        return _batch_payload(workspace, completed.id)


def create_correction_batch(
    batch_id: BatchRef,
    name: Annotated[str, Field(description="What to call the correction batch.")],
    asset_ids: Annotated[
        list[str] | None,
        Field(
            description=(
                "Which of the parent's assets to correct. Omit for all of them. "
                "Every id must be one the parent batch carried."
            )
        ),
    ] = None,
) -> dict[str, Any]:
    """Start a draft batch that corrects a completed one.

    A completed batch cannot be reopened — there is no transition back — so this
    is how settled work gets changed: a new batch over the same assets, recording
    `parent_batch_id` back to the one it corrects.

    Only from a completed batch. The `allowed_actions` on `get_batch` says
    `create_correction` exactly when this will be accepted.

    The correction is an ordinary draft: fill or trim its membership, then
    `approve_batch` it, which pins the project's **active** schema — not the
    parent's — which is the point of correcting under a contract that has moved
    on.
    """
    with opened_workspace() as workspace:
        created = BatchService(workspace).create_correction(
            identifier(batch_id, what="batch_id"),
            name,
            [identifier(one, what="asset_id") for one in asset_ids or []],
        )
        return _batch_payload(workspace, created.id)


def list_batch_assets(
    batch_id: BatchRef,
    limit: Annotated[
        int | None,
        Field(ge=1, description="How many assets to return. Omit for all of them."),
    ] = None,
    offset: Annotated[int, Field(ge=0, description="How many assets to skip.")] = 0,
    progress: Annotated[
        list[AssetProgress] | None,
        Field(description="Keep only assets in these states. An empty list means no filter."),
    ] = None,
    sort: Annotated[
        AssetSort,
        Field(
            description=(
                "'membership' (stored order) or 'confidence' (lowest model "
                "confidence first, unscored last)."
            )
        ),
    ] = AssetSort.MEMBERSHIP,
) -> dict[str, Any]:
    """List a batch's assets, with the job, progress and label summary each carries.

    The paged view of what is in a batch — a batch of fifty thousand frames is an
    ordinary thing, so page it. `total` is the size of what matched and does not
    change as you page; an offset past the end is an empty page, not an error.
    `annotation_count` is every label on the asset; `min_confidence` is the lowest
    score among the labels a model wrote, on that model's own scale, or null.

    `job_id` and `progress` are both null exactly while the batch is a draft,
    because a draft has no jobs, so a `progress` filter over a draft matches
    nothing. Use `get_asset_image` on any `id` here to see the pixels.
    """
    with opened_workspace() as workspace:
        resolved = identifier(batch_id, what="batch_id")
        service = BatchService(workspace)
        batch = service.get(resolved)
        placed, total = service.asset_page(
            resolved,
            progress=frozenset(progress) if progress else None,
            sort=sort,
            limit=limit,
            offset=offset,
        )
        items = [
            wire.batch_asset(
                one.asset,
                job_id=one.job_id,
                job_state=one.job_state,
                progress=one.progress,
                batch_state=batch.state,
                summary=one.summary,
            )
            for one in placed
        ]
    return {"items": items, "total": total}


def promote_batch(batch_id: BatchRef) -> dict[str, Any]:
    """Move a completed batch's finished assets into the project's dataset.

    The dataset is the trunk every release is cut from, so this is the step
    between annotating and publishing. Only `annotated` and `accepted` assets
    travel — a `skipped` one was a decision and it is honoured. Annotations come
    along with their assets.

    A union against what is already there: promoting the same batch twice adds
    nothing the second time and records nothing. Refuses if the batch is not
    complete.
    """
    with opened_workspace() as workspace:
        promoted = DatasetService(workspace).promote(
            identifier(batch_id, what="batch_id"), actor=_ACTOR
        )
    return wire.page([wire.asset(a) for a in promoted])


def delete_batch(
    batch_id: BatchRef,
    confirm: Annotated[
        bool,
        Field(
            description=(
                "Must be true to actually delete. False returns a refusal and changes nothing."
            )
        ),
    ] = False,
) -> dict[str, Any]:
    """Delete a batch and how its work was organised. Destructive; requires `confirm=true`.

    **The annotations survive.** Labels hang off assets rather than off batches,
    so this never deletes work; the assets stay in the project and in every other
    batch that carries them, and no image content is touched. What goes is the
    batch itself, its task groups, its jobs, and the per-asset progress on
    them — how the work was cut up and how far each frame had got.

    A `completed` batch cannot be deleted at all, and `confirm=true` does not
    change that. It is the record of what was labeled, against which pinned
    schema version, and what was deliberately skipped, which is what promotion
    and any later correction are read against. To revisit finished work, create a
    correction batch instead.

    Called without `confirm=true` it changes nothing and tells you so.
    """
    # The receipt is read **before** the delete, and it is the ordinary batch
    # payload rather than a fourth hand-written spelling of one: the jobs it
    # names are exactly what went. Read after, there would be nothing to read;
    # invented, it would be a shape nothing else in this surface produces. It
    # describes the batch as it was at the moment it was destroyed, including
    # `allowed_actions`, which is what a record of a past state is.
    with opened_workspace() as workspace:
        resolved = identifier(batch_id, what="batch_id")
        doomed = _batch_payload(workspace, resolved)
        BatchService(workspace).delete(resolved, confirm=confirm)
    return {"deleted": doomed}
