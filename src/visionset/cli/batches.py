# usage: from visionset.cli.batches import batch_app
"""``visionset batch`` — the lifecycle, and the gate into the trunk.

Six commands: ``list``, then the one-way walk ``approve`` → ``start`` →
``complete``, then ``promote``; ``pre-label`` invokes shared inference inline,
because a terminal has no dispatcher.

**There is no ``batch create``, and none of the membership commands.** A batch is
born from an ingest; curating one out of an arbitrary subset of assets has no
caller until a gallery exists to pick that subset in. ``BatchService`` still has
all four methods — this is a decision about the surface, not about the SDK, and
it is the same one the REST API made.

``--jobs-of N`` is the ``BySize`` partition, and no flag spells ``BySegments``.
That variant's own docstring says the caller has already decided the split, and
the only caller that ever holds an exact partition is a program — which has the
SDK and the API. It is also the one partition that can be *wrong*, with four
distinct refusals; asking somebody to type tuples of UUIDs past a shell's quoting
is a way to meet all four. If it is ever wanted it arrives as ``--segments
FILE.json`` and nothing here moves.

``promote`` lives under ``batch`` rather than under a dataset group because
``DatasetService.promote`` takes a *batch* id and derives the dataset from it —
the same reason its route hangs off ``/batches/{id}``.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated, Final
from uuid import UUID

import typer

from visionset import wire
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._resolve import ProjectOption, resolve_project
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.cli.inference import ConnectionArgument, _resolve
from visionset.inference import (
    DEFAULT_MINIMUM_CONFIDENCE,
    PreLabelExclusionReason,
    PreLabelPlan,
    pre_label,
    shapes_prose,
)
from visionset.kernel.domain import SETTLED_PROGRESS, AssetProgress, BySize, Partition
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    InferenceConnectionService,
    JobService,
    ProjectService,
    WorkspaceService,
)

batch_app = typer.Typer(help="Move batches through the annotation lifecycle.", no_args_is_help=True)

BatchArgument = Annotated[UUID, typer.Argument(help="The batch, by id.")]
"""The batch a command acts on. Ids only — batch names are not unique.

Module-level for the ``get_type_hints`` reason ``WorkspaceOption`` is.
"""

_COLUMNS: Final = ("ID", "NAME", "STATE", "SCHEMA", "ASSETS", "ANNOTATED", "SETTLED")

_NO_SCHEMA: Final = "-"
"""What a draft shows: approval is what pins a version, and only ``repin`` moves it."""

_ACTOR: Final = "cli"
"""Who the dataset change log records for a promotion made at a terminal."""


def _echo(batch_id: UUID, state: str, json_out: bool, payload: dict[str, object]) -> None:
    """One shape for the four lifecycle commands: the batch, or a line and its id."""
    if json_out:
        document(payload)
        return
    note(f"Batch {batch_id} is now {state}.")
    typer.echo(str(batch_id))


def _promoted(service: WorkspaceService, project_id: UUID) -> frozenset[UUID]:
    """The trunk's current membership, read once for the whole answer.

    The same cost model REST and MCP use: one query per invocation rather than
    one per batch, because ``asset_ids`` is already in hand and the rest is a set
    intersection.
    """
    dataset = ProjectService(service).get_dataset(project_id)
    return DatasetService(service).member_asset_ids(dataset.id)


@batch_app.command("list")
def batch_list(
    project: ProjectOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """List a project's batches with where their assets have got to."""
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        batch_service = BatchService(service)
        batches = batch_service.list(resolved.id)
        jobs = JobService(service)
        # One progress read per batch, which is exactly what the REST listing
        # does. The counts are the point of the listing: a batch's name and state
        # do not say whether anybody has started on it.
        counts = [jobs.batch_progress(batch.id) for batch in batches]
        promoted = _promoted(service, resolved.id)
        # One queue read for the whole listing rather than one per batch — the
        # same cost model REST's listing uses.
        pre_label_runs = batch_service.pre_label_runs()
    if json_out:
        document(
            wire.page(
                [
                    wire.batch(b, c, promoted=promoted, pre_labeled=pre_label_runs.get(b.id))
                    for b, c in zip(batches, counts, strict=True)
                ]
            )
        )
        return
    table(
        _COLUMNS,
        [
            (
                str(batch.id),
                batch.name,
                batch.state.value,
                _NO_SCHEMA if batch.schema_version is None else str(batch.schema_version),
                str(len(batch.asset_ids)),
                str(count[AssetProgress.ANNOTATED]),
                str(sum(count[state] for state in SETTLED_PROGRESS)),
            )
            for batch, count in zip(batches, counts, strict=True)
        ],
    )
    if not batches:
        note(f"Project {resolved.name!r} has no batches yet.")


@batch_app.command("approve")
def batch_approve(
    batch: BatchArgument,
    jobs_of: Annotated[
        int | None,
        typer.Option(
            "--jobs-of",
            min=1,
            help="Cut into jobs of this many assets. Default: one job for the whole batch.",
        ),
    ] = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Freeze a batch's membership, pin the schema, and cut it into jobs.

    Approval is one-way. There is no route back to `draft`, because the jobs are
    already partitioned against the pinned schema version — and a later
    `schema apply` does not move that pin.
    """
    # ``min=1`` rather than a check in the body: ``BySize.size`` is ``gt=0``, and
    # a pydantic ``ValidationError`` from constructing one is not a
    # ``VisionSetError``, so Click has to refuse zero before the domain sees it.
    partition: Partition | None = None if jobs_of is None else BySize(size=jobs_of)
    with opened_workspace(workspace) as service:
        batches = BatchService(service)
        approved = batches.approve(batch, partition)
        counts = JobService(service).batch_progress(approved.id)
        job_count = len(batches.jobs(approved.id))
        promoted = _promoted(service, approved.project_id)
    if json_out:
        document(wire.batch(approved, counts, promoted=promoted))
        return
    note(
        f"Approved batch {approved.name!r} against schema version "
        f"{approved.schema_version}, in {job_count} job(s)."
    )
    typer.echo(str(approved.id))


@batch_app.command("start")
def batch_start(
    batch: BatchArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Open an approved batch for annotation."""
    with opened_workspace(workspace) as service:
        started = BatchService(service).start(batch)
        counts = JobService(service).batch_progress(started.id)
        promoted = _promoted(service, started.project_id)
    _echo(started.id, started.state.value, json_out, wire.batch(started, counts, promoted=promoted))


#: How each reason a class is left out of the prompt reads at a terminal.
#: Short, because they are joined inside a parenthesis beside the class name.
_EXCLUSION_PROSE: Final = {
    PreLabelExclusionReason.NO_PRODUCIBLE_GEOMETRY: "no shape this model produces",
    PreLabelExclusionReason.REQUIRED_ATTRIBUTE: "requires an attribute a prediction cannot supply",
}


def announce_plan(plan: PreLabelPlan) -> None:
    """Say what the run is about to ask for, and what it is leaving out.

    Printed before the first forward pass because that is when it is still
    actionable: a run that asks for two of a schema's five classes labels
    nothing under the other three, and afterwards there is only the silence to
    explain.
    """
    note(
        f"Asking for {len(plan.asked)} class(es): {', '.join(plan.asked)}; "
        f"what it finds lands as {shapes_prose(plan.produces)}."
    )
    if not plan.excluded:
        return
    left_out = "; ".join(
        f"{one.name} ({', '.join(_EXCLUSION_PROSE[reason] for reason in one.reasons)})"
        for one in plan.excluded
    )
    note(f"Not asking for {len(plan.excluded)} class(es): {left_out}.")


@batch_app.command("pre-label")
def batch_pre_label(
    batch: BatchArgument,
    connection: ConnectionArgument,
    minimum_confidence: Annotated[
        float,
        typer.Option(
            "--minimum-confidence",
            min=0.0,
            max=1.0,
            help="The floor a prediction must clear to be written, in [0, 1].",
        ),
    ] = DEFAULT_MINIMUM_CONFIDENCE,
    replace_model_labels: Annotated[
        bool,
        typer.Option(
            "--replace-model-labels",
            help="Also rewrite the model labels on frames still pre-labeled (nobody has "
            "touched them). Frames anyone edited, confirmed or skipped in this batch are "
            "never affected. Cannot be undone.",
        ),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Ask a model to label every untouched asset in an open batch.

    This blocks because a terminal has no dispatcher to claim an enqueued run.
    """
    with opened_workspace(workspace) as service:
        connections = InferenceConnectionService(service)
        outcome = pre_label(
            service,
            batch_id=batch,
            connection_id=_resolve(connections, connection),
            minimum_confidence=minimum_confidence,
            replace_model_labels=replace_model_labels,
            on_plan=announce_plan,
            on_progress=lambda done, total: note(f"Pre-labeling {done}/{total} asset(s)."),
        )
    if json_out:
        document(asdict(outcome))
        return
    replaced = (
        f", replaced {outcome.annotations_replaced} earlier model label(s)"
        if outcome.annotations_replaced
        else ""
    )
    note(
        f"Pre-labeled {outcome.assets_labeled} asset(s), "
        f"wrote {outcome.annotations_written} annotation(s){replaced}."
    )
    typer.echo(str(outcome.annotations_written))


@batch_app.command("complete")
def batch_complete(
    batch: BatchArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Close a batch, once every one of its jobs is complete.

    Derived means recomputed, not automatic: this reads the jobs and refuses
    while any is outstanding.
    """
    with opened_workspace(workspace) as service:
        batches = BatchService(service)
        completed = batches.complete(batch)
        counts = JobService(service).batch_progress(completed.id)
        promoted = _promoted(service, completed.project_id)
        pre_labeled = batches.latest_pre_label_job(completed.id)
    _echo(
        completed.id,
        completed.state.value,
        json_out,
        wire.batch(completed, counts, promoted=promoted, pre_labeled=pre_labeled),
    )


@batch_app.command("promote")
def batch_promote(
    batch: BatchArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Move a completed batch's finished assets into the project's dataset.

    A union against what is already there, so promoting twice adds nothing and
    logs nothing. Only `annotated` and `accepted` assets travel — a `skipped` one
    was a decision, and it is honoured.
    """
    with opened_workspace(workspace) as service:
        promoted = DatasetService(service).promote(batch, actor=_ACTOR)
    if json_out:
        document(wire.page([wire.asset(a) for a in promoted]))
        return
    note(f"Promoted {len(promoted)} asset(s) into the dataset.")
    for asset in promoted:
        typer.echo(str(asset.id))
