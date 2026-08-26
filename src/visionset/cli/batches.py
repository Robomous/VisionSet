# usage: from visionset.cli.batches import batch_app
"""``visionset batch`` — the lifecycle, and the gate into the trunk.

Six commands: ``list``, then the one-way walk ``approve`` → ``start`` →
``complete``, then ``promote``; ``pre-label`` invokes shared inference inline,
because a terminal has no dispatcher.

**A composed flag is two of those calls behind one command, never a new
transition.** ``approve --start`` and ``complete --promote`` make the first
call, and on its success the second; ``ingest --start`` reaches in here for the
same two. Each step commits on its own, so a refused second step leaves the
first one's state in place and the output names it — the kernel's own
``start`` requires only ``approved``, and ``promote`` only ``completed``, which
is what makes the pair safe to chain without any new rule.

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

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict
from typing import Annotated, Any, Final
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
    PreLabelOutcome,
    PreLabelPlan,
    open_jobs_of,
    pre_label,
    shapes_prose,
)
from visionset.kernel import VisionSetError
from visionset.kernel.domain import (
    SETTLED_PROGRESS,
    Asset,
    AssetProgress,
    Batch,
    BySize,
    GeometryType,
    Partition,
)
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

GeometryOption = Annotated[
    list[GeometryType] | None,
    typer.Option(
        "--geometry",
        help="Write only this shape of what the model answers; repeat for several. Omit for "
        "every shape the model produces. A shape the model does not produce is refused.",
    ),
]
"""Which of the model's shapes a pre-label run writes. Shared by both launches.

Module-level for the ``get_type_hints`` reason ``WorkspaceOption`` is.
"""


_COLUMNS: Final = ("ID", "NAME", "STATE", "SCHEMA", "ASSETS", "ANNOTATED", "SETTLED")

_NO_SCHEMA: Final = "-"
"""What a draft shows: approval is what pins a version, and only ``repin`` moves it."""

_ACTOR: Final = "cli"
"""Who the dataset change log records for a promotion made at a terminal."""


def _echo(batch_id: UUID, state: str, json_out: bool, payload: dict[str, object]) -> None:
    """One shape for a lifecycle move: the batch, or a line and its id."""
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


def batch_document(service: WorkspaceService, batch: Batch) -> dict[str, Any]:
    """One batch as ``--json`` prints it, with its progress and its trunk membership read."""
    counts = JobService(service).batch_progress(batch.id)
    pre_labeled = BatchService(service).latest_pre_label_job(batch.id)
    return wire.batch(
        batch, counts, promoted=_promoted(service, batch.project_id), pre_labeled=pre_labeled
    )


def approved_note(service: WorkspaceService, approved: Batch) -> None:
    """The line approval prints: the pin, and how many jobs it cut."""
    job_count = len(BatchService(service).jobs(approved.id))
    note(
        f"Approved batch {approved.name!r} against schema version "
        f"{approved.schema_version}, in {job_count} job(s)."
    )


@contextmanager
def second_step(step: str, batch_id: UUID, state: str) -> Iterator[None]:
    """A later step of a composed command: a refusal says where the batch stands.

    The earlier step has already committed, so the refusal's sentence alone would
    leave a reader guessing whether anything moved.
    """
    try:
        yield
    except VisionSetError:
        note(f"The {step} step refused; batch {batch_id} is {state}.")
        raise


def start_after_approval(service: WorkspaceService, approved: Batch) -> Batch:
    """The ``start`` half of a composed approval, for ``approve --start`` and ``ingest --start``."""
    with second_step("start", approved.id, approved.state.value):
        return BatchService(service).start(approved.id)


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
    start: Annotated[
        bool,
        typer.Option(
            "--start",
            help="Also open the batch for annotation once it is approved, as `batch start` would.",
        ),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Freeze a batch's membership, pin the schema, and cut it into jobs.

    Approval is one-way. There is no route back to `draft`, because the jobs are
    already partitioned against the pinned schema version — and a later
    `schema apply` does not move that pin.

    `--start` follows with `batch start`. Approval is committed before the start
    is attempted, so a start that is refused leaves an approved batch, and the
    output says so.
    """
    # ``min=1`` rather than a check in the body: ``BySize.size`` is ``gt=0``, and
    # a pydantic ``ValidationError`` from constructing one is not a
    # ``VisionSetError``, so Click has to refuse zero before the domain sees it.
    partition: Partition | None = None if jobs_of is None else BySize(size=jobs_of)
    with opened_workspace(workspace) as service:
        approved = BatchService(service).approve(batch, partition)
        if not json_out:
            approved_note(service, approved)
        final = start_after_approval(service, approved) if start else approved
        payload = batch_document(service, final)
    if json_out:
        document(payload)
        return
    if start:
        note(f"Batch {final.id} is now {final.state.value}.")
    typer.echo(str(final.id))


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


def selected_geometries(geometry: list[GeometryType] | None) -> frozenset[GeometryType] | None:
    """A repeated ``--geometry`` as the selection the run takes; unrepeated, every shape."""
    return None if geometry is None else frozenset(geometry)


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
    geometry: GeometryOption = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Ask a model to label every untouched asset in every open job of a batch.

    This blocks because a terminal has no dispatcher to claim an enqueued run.
    """
    with opened_workspace(workspace) as service:
        connection_id = _resolve(InferenceConnectionService(service), connection)
        BatchService(service).require_pre_labelable(batch)
        geometries = selected_geometries(geometry)
        items: list[tuple[UUID, PreLabelOutcome]] = []
        for job in open_jobs_of(service, batch):
            note(f"Job {job.id}:")
            outcome = pre_label(
                service,
                job_id=job.id,
                connection_id=connection_id,
                minimum_confidence=minimum_confidence,
                replace_model_labels=replace_model_labels,
                geometries=geometries,
                on_plan=announce_plan if not items else None,
                on_progress=lambda done, total: note(f"Pre-labeling {done}/{total} asset(s)."),
            )
            items.append((job.id, outcome))
    if not items:
        note("No open job to pre-label.")
        typer.echo("0")
        return
    written = sum(outcome.annotations_written for _, outcome in items)
    if json_out:
        document(
            {
                "items": [{"job_id": str(job_id), **asdict(outcome)} for job_id, outcome in items],
                "annotations_written": written,
            }
        )
        return
    for _, outcome in items:
        replaced = (
            f", replaced {outcome.annotations_replaced} earlier model label(s)"
            if outcome.annotations_replaced
            else ""
        )
        note(
            f"Pre-labeled {outcome.assets_labeled} asset(s), "
            f"wrote {outcome.annotations_written} annotation(s){replaced}."
        )
    typer.echo(str(written))


@batch_app.command("complete")
def batch_complete(
    batch: BatchArgument,
    promote: Annotated[
        bool,
        typer.Option(
            "--promote",
            help="Also move the finished assets into the dataset once the batch is closed, as "
            "`batch promote` would.",
        ),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Close a batch, once every one of its jobs is complete.

    Derived means recomputed, not automatic: this reads the jobs and refuses
    while any is outstanding.

    `--promote` follows with `batch promote`. With `--json` the document is then
    `{"batch": …, "promoted": …}` — the closed batch beside the page of assets
    that entered the dataset — and stdout otherwise stays the batch id alone.
    """
    with opened_workspace(workspace) as service:
        completed = BatchService(service).complete(batch)
        if not json_out:
            note(f"Batch {completed.id} is now {completed.state.value}.")
        entered: list[Asset] = []
        if promote:
            with second_step("promote", completed.id, completed.state.value):
                entered = DatasetService(service).promote(completed.id, actor=_ACTOR)
        payload = batch_document(service, completed)
    if json_out:
        if promote:
            document({"batch": payload, "promoted": wire.page([wire.asset(a) for a in entered])})
        else:
            document(payload)
        return
    if promote:
        note(f"Promoted {len(entered)} asset(s) into the dataset.")
    typer.echo(str(completed.id))


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
