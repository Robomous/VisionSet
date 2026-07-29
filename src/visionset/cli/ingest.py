# usage: from visionset.cli.ingest import backfill_thumbnails, ingest
"""``visionset ingest`` — a path in, a batch out. And the preview backfill.

**The one command in the CLI that is two service calls**, and it earns it.
``SourceService`` has two registration methods because a clip needs a rate and a
probe while a folder needs neither; ``IngestService`` has one ``ingest`` because
the source already carries the kind, the path and the rate. A person typing a
path does not want to say which of the two it is, and does not have to — the
dispatch is ``path.is_dir()``.

Registering twice is free: registration is idempotent on
``(kind, path, extraction_fps)``, so running this again on the same folder finds
the same source. Ingesting again is nearly free too — content addressing means a
re-run creates no assets it created before — which is also the remedy for the one
gap this command has: interrupting it leaves the job row at ``running``, and
there is no ``--resume``, because re-running does the right thing and needs no
new vocabulary.

**The run is synchronous, and nothing polls it.** The kernel writes progress to
the job row for a *second process* to read (that is what ``visionset ui`` and
``GET /ingest-jobs/{id}`` are for); a CLI that queued the work would have no
worker to run it. So this blocks, says so on stderr first, and prints the batch
id when it is done.

**The batch id goes to stdout, alone** — it is what the next command in a script
needs, which is the whole one-datum rule::

    BATCH=$(visionset ingest ./incoming --project road-signs)

``backfill-thumbnails`` lives here rather than under a group because it has no
object group to join and it is the other half of what ingest writes: a preview is
a cache, so a missing one is a thing to fill in later rather than a failure to
report at the time.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Final

import typer

from visionset.cli import _json
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._resolve import ProjectOption, resolve_project
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.domain import IngestResult
from visionset.kernel.ports import DEFAULT_EXTRACTION_FPS
from visionset.kernel.services import IngestService, SourceService

_FAILURE_COLUMNS: Final = ("FILE", "KIND", "REASON")


def _report(result: IngestResult) -> None:
    """Say what the run did, on stderr, with the refused files named one per line."""
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
            help="A directory of stills, or a video file.",
        ),
    ],
    project: ProjectOption,
    fps: Annotated[
        float | None,
        typer.Option(
            "--fps",
            help=(
                "Frames per second to extract. Video sources only; defaults to "
                f"{DEFAULT_EXTRACTION_FPS}."
            ),
        ),
    ] = None,
    batch_name: Annotated[
        str | None,
        typer.Option(
            "--batch-name",
            help="Name the batch this run fills. Defaults to the source's own name.",
        ),
    ] = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Register a source and ingest it, into one batch.

    A directory is read top level only, sorted, with no filter on the suffix —
    anything that is not an image is reported per file and the run carries on.
    A video file is decomposed into frames at `--fps`.

    Files are addressed by content, so ingesting the same bytes twice gives one
    asset. That is what makes re-running this safe after an interruption.
    """
    # ``typer.Option`` can express ``min=`` but not Click's ``min_open``, so a
    # ``gt=0`` bound has to be checked here. It has to be checked *somewhere*:
    # ``SourceService.register_video`` refuses a non-positive rate with a bare
    # ``ValueError``, which is not a ``VisionSetError`` and would print a
    # traceback rather than a sentence.
    if fps is not None and fps <= 0:
        raise typer.BadParameter("--fps must be greater than zero")
    if fps is not None and source.is_dir():
        raise typer.BadParameter(
            f"--fps applies to a video source; {source} is a directory of stills"
        )

    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        sources = SourceService(service)
        if source.is_dir():
            registered = sources.register_images(resolved.id, source)
        else:
            registered = sources.register_video(
                resolved.id,
                source,
                extraction_fps=DEFAULT_EXTRACTION_FPS if fps is None else fps,
            )
        note(f"Reading {registered.kind.value.replace('_', ' ')} {source}…")
        result = IngestService(service).ingest(registered.id, batch_name=batch_name)

    if json_out:
        document(
            {
                "source": _json.source(registered),
                "job_id": str(result.job_id),
                "batch_id": str(result.batch_id),
                "created": result.created,
                "deduplicated": result.deduplicated,
                "failed": result.failed,
                "failures": [_json.ingest_failure(f) for f in result.failures],
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
        document(_json.thumbnail_backfill(report))
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
