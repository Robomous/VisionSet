# usage: from visionset.cli.jobs import job_app
"""``visionset job`` — the annotator's unit of work, driven from a shell.

Six commands, each one service call: ``list``, ``next``, ``progress``, ``start``,
``mark``, ``complete``.

``next`` and ``mark`` are not in #34's own list of deliverables, and without them
"the full cycle without touching Python" is not true — a batch cannot be
completed until every asset has settled, and nothing else here settles one.
``JobService.mark``'s docstring invites the second by name; the first is how a
shell learns which asset ids are still outstanding without this module rebuilding
the job-to-asset join the API does server-side.

**Say the wart out loud.** ``--progress annotated`` records that somebody labeled
an asset, and the CLI writes no labels — geometry comes from a canvas or a model,
not from typing. A release published off a batch driven this way carries
``annotation_count: 0``, and that is what its manifest honestly says. The command
exists because the *lifecycle* has to be reachable from a script, not because it
is how labelling is meant to happen.

Ids only, for jobs and assets both: neither has a name, and both ids come off the
previous command's stdout.
"""

from __future__ import annotations

from typing import Annotated, Final
from uuid import UUID

import typer

from visionset.cli import _json
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.domain import AssetProgress
from visionset.kernel.services import BatchService, JobService

job_app = typer.Typer(help="Drive annotation jobs.", no_args_is_help=True)

JobArgument = Annotated[UUID, typer.Argument(help="The annotation job, by id.")]
"""Module-level for the ``get_type_hints`` reason ``WorkspaceOption`` is."""

_COLUMNS: Final = ("ID", "STATE", "ASSETS")

_ASSET_COLUMNS: Final = ("ID", "CONTENT_HASH", "WIDTH", "HEIGHT")

_PROGRESS_COLUMNS: Final = tuple(state.value.upper() for state in AssetProgress) + ("TOTAL",)
"""Read off the enum, so a sixth state cannot be silently missing from the table."""

_UNKNOWN: Final = "-"
"""What an asset with no recorded dimensions shows."""


@job_app.command("list")
def job_list(
    batch: Annotated[UUID, typer.Option("--batch", help="The batch whose jobs to list.")],
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """List a batch's jobs, in segment order. A draft batch has none."""
    with opened_workspace(workspace) as service:
        jobs = BatchService(service).jobs(batch)
    if json_out:
        document(_json.page([_json.job(j, batch_id=batch) for j in jobs]))
        return
    table(_COLUMNS, [(str(j.id), j.state.value, str(len(j.progress))) for j in jobs])
    if not jobs:
        note(f"Batch {batch} has no jobs; approve it first.")


@job_app.command("next")
def job_next(
    job: JobArgument,
    count: Annotated[
        int,
        typer.Option("--count", "-n", min=1, help="How many to hand back."),
    ] = 10,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """The next assets of a job still awaiting annotation, in batch order.

    Order is the stored position, not insertion luck, so two callers asking for
    the next ten get the same ten.
    """
    # ``min=1`` because ``next_pending`` refuses a non-positive count with a bare
    # ``ValueError``, which would print a traceback rather than a sentence.
    with opened_workspace(workspace) as service:
        assets = JobService(service).next_pending(job, count)
    if json_out:
        document(_json.page([_json.asset(a) for a in assets]))
        return
    table(
        _ASSET_COLUMNS,
        [
            (
                str(a.id),
                a.content_hash,
                _UNKNOWN if a.width is None else str(a.width),
                _UNKNOWN if a.height is None else str(a.height),
            )
            for a in assets
        ],
    )
    if not assets:
        note(f"Job {job} has nothing left awaiting annotation.")


@job_app.command("progress")
def job_progress(
    job: JobArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """How many of a job's assets sit in each state."""
    with opened_workspace(workspace) as service:
        counts = JobService(service).job_progress(job)
    if json_out:
        document(_json.progress_counts(counts))
        return
    table(
        _PROGRESS_COLUMNS,
        [tuple(str(counts[state]) for state in AssetProgress) + (str(sum(counts.values())),)],
    )


@job_app.command("start")
def job_start(
    job: JobArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Take a pending job."""
    with opened_workspace(workspace) as service:
        service_jobs = JobService(service)
        started = service_jobs.start(job)
        batch = service_jobs.batch(started.id)
    if json_out:
        document(_json.job(started, batch_id=batch.id))
        return
    note(f"Job {started.id} is now {started.state.value}.")
    typer.echo(str(started.id))


@job_app.command("mark")
def job_mark(
    job: JobArgument,
    asset: Annotated[UUID, typer.Argument(help="The asset in that job.")],
    progress: Annotated[
        AssetProgress,
        typer.Option("--progress", help="Where the asset has got to."),
    ],
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Record where one asset of a job has got to.

    Marking a state the asset already holds is a no-op — but the batch gate
    fires first, so writing into a batch nobody opened is refused even when the
    value would not change.
    """
    with opened_workspace(workspace) as service:
        JobService(service).mark(job, asset, progress)
    if json_out:
        document(_json.asset_progress(asset, progress))
        return
    note(f"Asset {asset} is now {progress.value}.")


@job_app.command("complete")
def job_complete(
    job: JobArgument,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Close a job, once every one of its assets has settled.

    Settled means annotated, skipped or accepted — review is optional, so a
    reviewed-and-accepted asset and a plainly annotated one both count.
    Completing a job never completes its batch; `batch complete` derives that.
    """
    with opened_workspace(workspace) as service:
        service_jobs = JobService(service)
        completed = service_jobs.complete(job)
        batch = service_jobs.batch(completed.id)
    if json_out:
        document(_json.job(completed, batch_id=batch.id))
        return
    note(f"Job {completed.id} is now {completed.state.value}.")
    typer.echo(str(completed.id))
