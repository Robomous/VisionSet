# usage: from visionset.mcp import sources
"""Ingest tools: one path in, one batch out. And what has been registered before.

**Four parity candidates collapse into ``ingest``.** ``register_image_source``,
``register_video_source`` and ``start_ingest`` are three tools describing one
intention, and the split exists in the kernel for a reason that does not reach
this far up: ``SourceService`` has two registration methods because a clip needs
a rate and a probe while a folder needs neither, and ``IngestService`` has one
``ingest`` because by then the source already carries the kind, the path and the
rate. An agent holding a path should not have to say which of the two it has —
the dispatch is ``path.is_dir()``, exactly as ``visionset ingest`` does it.

**A local path, never an upload.** ``server/uploads.py`` exists because HTTP has
bytes where the kernel has paths; an agent runs beside the workspace and has the
filesystem, so there is nothing to stage and that module must not grow a caller
here.

**The run is synchronous and there is nothing to poll**, which is why
``get_ingest_job``, ``list_ingest_jobs`` and ``resume_ingest`` are not tools. A
stdio server has no background worker: something has to do the decode, and
"resume" done by the agent would block for exactly as long as doing it in the
first place. The finished job comes back in the answer. If a call is cut off part
way, the remedy is to call ``ingest`` again — registration is idempotent on
``(kind, path, extraction_fps)`` and content addressing means the re-run creates
nothing it created before. That is the same argument that gave the CLI no
``--resume``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

from pydantic import Field

from visionset import wire
from visionset.kernel.ports import DEFAULT_EXTRACTION_FPS
from visionset.kernel.services import IngestService, SourceService
from visionset.mcp._errors import refused
from visionset.mcp._resolve import ProjectRef, resolve_project
from visionset.mcp._workspace import opened_workspace


def ingest(
    project: ProjectRef,
    path: Annotated[
        str,
        Field(
            description=(
                "An absolute path on this machine: a directory of still images, or "
                "a single video file."
            )
        ),
    ],
    fps: Annotated[
        float | None,
        Field(
            description=(
                "Frames per second to extract. Video sources only; defaults to "
                f"{DEFAULT_EXTRACTION_FPS}. Must be greater than zero."
            )
        ),
    ] = None,
    batch_name: Annotated[
        str | None,
        Field(description="Name the batch this run fills. Defaults to the source's own name."),
    ] = None,
) -> dict[str, Any]:
    """Register a source and read it into one batch. Blocks until the run finishes.

    A directory is read top level only, in filename order, with no filter on the
    suffix — anything that is not a usable image is reported in `failures` and
    the run carries on. A video file is decomposed into frames at `fps`, and the
    rate is part of what the source *is*: the same clip registered at 1 and at 5
    is two sources, deliberately.

    Assets are addressed by content, so ingesting the same bytes twice yields one
    asset. `created` counts new assets and `deduplicated` counts ones already
    known; both went into the batch. That is also why re-running this after an
    interrupted call is safe and nearly free.

    A damaged clip is read as far as its bytes go, and what came out is kept. It
    is counted in `partial` rather than in `failed`, and its `failures` entry
    carries `frames_produced` beside `frames_expected_estimate` — how much
    arrived, and roughly how much the container claimed. Those frames are already
    in the batch; the remedy is to ingest a good copy, which content addressing
    makes cheap. An ingest that read everything reports none of this.

    The `batch_id` it returns is what `approve_batch` takes next. A long video
    can make this call take minutes; there is no progress to poll from here.

    `ingest_job_id` names *this run* and nothing else — there is no tool that
    reads it back, and it is not an annotation job. Annotation jobs do not exist
    yet at this point: `approve_batch` is what cuts them, and the ids it returns
    are the ones `get_job` and the rest of the loop take.

    Refuses before doing any work if the path does not exist, if `fps` is not
    positive, or if `fps` was given for a directory of stills.
    """
    source_path = Path(path)
    # Three refusals the kernel raises *outside* the VisionSetError tree, so
    # `guarded` would not catch them and the client would get a traceback's text
    # instead of an envelope. `canonical_path` resolves strictly
    # (FileNotFoundError), `register_images` wants a directory
    # (NotADirectoryError), and `register_video` refuses a non-positive rate with
    # a bare ValueError.
    if not source_path.exists():
        return refused(f"no such path: {path}")
    if fps is not None and fps <= 0:
        return refused("fps must be greater than zero")
    if fps is not None and source_path.is_dir():
        return refused(f"fps applies to a video source, and {path} is a directory of stills")

    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        service = SourceService(workspace)
        if source_path.is_dir():
            registered = service.register_images(resolved.id, source_path)
        else:
            registered = service.register_video(
                resolved.id,
                source_path,
                extraction_fps=DEFAULT_EXTRACTION_FPS if fps is None else fps,
            )
        result = IngestService(workspace).ingest(registered.id, batch_name=batch_name)
    return {
        "source": wire.source(registered),
        # Not `job_id`: an agent that read that key tried it on `get_job` and was
        # refused, because the two words name different things and only one of
        # them is reachable. #36's transcript, s1/opus/2.
        "ingest_job_id": str(result.job_id),
        "batch_id": str(result.batch_id),
        "created": result.created,
        "deduplicated": result.deduplicated,
        "failed": result.failed,
        # Its own count, not a subset of `failed`: a damaged clip that put frames
        # in the batch is not a file the run could not use (#452).
        "partial": result.partial,
        "failures": [wire.ingest_failure(f) for f in result.failures],
    }


def list_sources(project: ProjectRef) -> dict[str, Any]:
    """List the origins registered in a project — the folders and clips it was built from.

    Use it to see what has already been ingested before ingesting again. `name`
    is the path's last component only; the full path is not published, because it
    describes this machine's disk and not anything a caller can act on. A video
    source carries the probe result and the extraction rate under `video`.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        registered = SourceService(workspace).list(resolved.id)
    return wire.page([wire.source(s) for s in registered])


def backfill_thumbnails(project: ProjectRef) -> dict[str, Any]:
    """Render the previews that are missing for a project's assets.

    `get_asset_image` serves a cached preview and refuses rather than rendering
    one on demand; this is the tool that refusal names. Ingest caches a preview
    for everything it writes, so a missing one means an asset that predates the
    cache or whose bytes would not render.

    Idempotent — assets that already have one are not re-rendered. `missing` and
    `unreadable` are different damage: the first is a content blob that is gone,
    which no preview pass can repair, and the second is bytes that are present
    and will not decode. Neither is a failure of this call.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        report = IngestService(workspace).backfill_thumbnails(resolved.id)
    return wire.thumbnail_backfill(report)
