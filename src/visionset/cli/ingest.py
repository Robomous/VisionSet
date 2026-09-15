# usage: from visionset.cli.ingest import backfill_thumbnails, ingest
"""``visionset ingest`` — a directory in, a batch out. And the preview backfill.

**The one command in the CLI that is two service calls**, and it earns it:
``SourceService.register_images`` records the origin and ``IngestService.ingest``
reads it, and nobody typing a path wants to say that twice.

**A video is refused here, by name.** Nothing in this process decodes one: a
clip is imported in the browser, which reads it locally and uploads the frames,
so the honest answer to ``visionset ingest drive.mp4`` is a sentence pointing at
that screen. Falling back to "treat it as an image" would put a refusal from a
decoder where a refusal from the product belongs.

Registering twice is free: registration is idempotent on the directory, so
running this again on the same folder finds the same source. Ingesting again is
nearly free too —
content addressing means a re-run creates no assets it created before — which
is also the remedy for the one
gap this command has: interrupting it leaves the job row at ``running``, and
there is no ``--resume``, because re-running does the right thing and needs no
new vocabulary.

**The run is synchronous, and nothing polls it.** The kernel writes progress to
the job row for a *second process* to read (that is what ``visionset server`` and
``GET /ingest-jobs/{id}`` are for); a CLI that queued the work would have no
worker to run it. So this blocks, says so on stderr first, and prints the batch
id when it is done.

**The batch id goes to stdout, alone** — it is what the next command in a script
needs, which is the whole one-datum rule::

    BATCH=$(visionset ingest ./incoming --project road-signs)

``--start`` keeps that rule and takes the batch through ``approve`` (one job)
and ``start`` in the same run, borrowing ``cli/batches.py``'s two halves so the
lines it prints are the ones those commands print. The ingest has committed
before approval is attempted; a project with no schema refuses there and leaves
the draft the ingest made, which the output names.

``backfill-thumbnails`` lives here rather than under a group because it has no
object group to join and it is the other half of what ingest writes: a preview is
a cache, so a missing one is a thing to fill in later rather than a failure to
report at the time.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Final

import typer

from visionset import wire
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._resolve import ProjectOption, resolve_project
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.cli.batches import (
    approved_note,
    batch_document,
    second_step,
    start_after_approval,
)
from visionset.kernel.domain import BatchState, IngestResult
from visionset.kernel.services import BatchService, IngestService, SourceService

_FAILURE_COLUMNS: Final = ("FILE", "KIND", "REASON")

#: What ``ingest`` says when it is handed something other than a directory.
#:
#: The video case is the one people will hit, so the sentence names it and names
#: where to go; it stays true of a lone JPEG, which is the other way to get here.
#: Shared with ``visionset.mcp.sources`` in intent only — each surface spells its
#: own remedy, because "open the Ingest screen" and "there is no tool for this"
#: are answers to different readers.
VIDEO_IS_A_BROWSER_IMPORT: Final = (
    "ingest takes a directory of still images. A video is imported in the browser: "
    "run `visionset server`, open the project's Ingest screen and choose the clip "
    "there — it is decoded on your machine and uploaded as frames. Nothing in this "
    "process decodes video."
)


def _report(result: IngestResult) -> None:
    """Say what the run did, on stderr, with the refused files named one per line.

    On stderr and never on stdout, which carries the batch id alone — a directory
    with one unreadable file still fills a batch, so
    ``BATCH=$(visionset ingest …)`` has to keep working through the report.
    """
    note(
        f"Ingested {result.created} new and {result.deduplicated} already-known "
        f"assets into batch {result.batch_id}."
    )
    if result.failures:
        note(f"{result.failed} file(s) could not be used:")
        for failure in result.failures:
            note(f"  {failure.name}  {failure.kind.value}  {failure.reason}")


def ingest(
    source: Annotated[
        Path,
        typer.Argument(
            exists=True,
            readable=True,
            help="A directory of still images.",
        ),
    ],
    project: ProjectOption,
    batch_name: Annotated[
        str | None,
        typer.Option(
            "--batch-name",
            help="Name the batch this run fills. Defaults to the source's own name.",
        ),
    ] = None,
    start: Annotated[
        bool,
        typer.Option(
            "--start",
            help="Also approve the batch as one job and open it for annotation, as "
            "`batch approve --start` would. With --json, prints the started batch.",
        ),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Register a directory of images and ingest it, into one batch.

    The directory is read top level only, sorted, with no filter on the suffix —
    anything that is not an image is reported per file and the run carries on.

    A video file is refused: importing one happens in the browser, which decodes
    it locally and uploads the frames.

    Files are addressed by content, so ingesting the same bytes twice gives one
    asset. That is what makes re-running this safe after an interruption.

    `--start` follows with `batch approve` (one job) and `batch start`. The
    ingest is committed before approval is attempted, so a refused approval — a
    project with no schema — leaves a draft batch, and the output names it.
    """
    if not source.is_dir():
        raise typer.BadParameter(f"{source} is not a directory. {VIDEO_IS_A_BROWSER_IMPORT}")

    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        registered = SourceService(service).register_images(resolved.id, source)
        note(f"Reading {registered.kind.value.replace('_', ' ')} {source}…")
        result = IngestService(service).ingest(registered.id, batch_name=batch_name)
        if start:
            if not json_out:
                _report(result)
            with second_step("approve", result.batch_id, BatchState.DRAFT.value):
                approved = BatchService(service).approve(result.batch_id, None)
            if not json_out:
                approved_note(service, approved)
            started = start_after_approval(service, approved)
            started_document = batch_document(service, started)

    if start:
        if json_out:
            document(started_document)
            return
        note(f"Batch {started.id} is now {started.state.value}.")
        typer.echo(str(started.id))
        return
    if json_out:
        document(
            {
                "source": wire.source(registered),
                "job_id": str(result.job_id),
                "batch_id": str(result.batch_id),
                "created": result.created,
                "deduplicated": result.deduplicated,
                "failed": result.failed,
                "failures": [wire.ingest_failure(f) for f in result.failures],
            }
        )
        return
    _report(result)
    typer.echo(str(result.batch_id))


def backfill_thumbnails(
    project: ProjectOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Render the missing previews of a project's assets.

    A preview is a cache, not an identity — its hash is in no release manifest
    and no verification recomputes it — so an asset whose bytes will not render
    keeps a null one and is reported here rather than having failed its ingest.
    Idempotent: assets that already have one are not re-rendered.

    `missing` and `unreadable` are different damage. The first is a content blob
    that is gone, which no preview pass can repair; the second is bytes that are
    there and will not decode.
    """
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        report = IngestService(service).backfill_thumbnails(resolved.id)
    if json_out:
        document(wire.thumbnail_backfill(report))
        return
    note(
        f"Examined {report.examined} asset(s) without a preview in {resolved.name!r}: "
        f"{len(report.filled)} filled, {len(report.missing)} with no content blob, "
        f"{len(report.unreadable)} unreadable."
    )
    if report.unreadable:
        table(
            _FAILURE_COLUMNS,
            [(f.name, f.kind.value, f.reason) for f in report.unreadable],
        )
