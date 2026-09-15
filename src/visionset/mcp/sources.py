# usage: from visionset.mcp import sources
"""Ingest tools: one directory in, one batch out. And what was registered before.

**Two parity candidates collapse into ``ingest``.** ``register_image_source``
and ``start_ingest`` are two tools describing one intention, and the split exists
in the kernel because a source outlives the run that reads it. An agent holding a
path does not care.

**There is no video tool, and there is deliberately no way to ask for one.** A
clip is decoded by the client that holds it — a browser, locally — and arrives
here as frames that were already images. An agent that hands this tool an ``.mp4``
gets a sentence saying so, because the alternative is an agent inventing a
workaround: re-encoding the clip itself, or shelling out to a decoder beside the
workspace, both of which would put bytes nobody audited into a dataset.

**A local path, never an upload.** ``server/uploads.py`` exists because HTTP has
bytes where the kernel has paths; an agent runs beside the workspace and has the
filesystem, so there is nothing to stage and that module must not grow a caller
here.

**The run is synchronous and there is nothing to poll**, which is why
``get_ingest_job``, ``list_ingest_jobs`` and ``resume_ingest`` are not tools. A
stdio server has no background worker: something has to do the decode, and
"resume" done by the agent would block for exactly as long as doing it in the
first place. The finished job comes back in the answer. If a call is cut off part
way, the remedy is to call ``ingest`` again — registration is idempotent on the
directory and content addressing means the re-run creates nothing it created
before. That is the same argument that gave the CLI no ``--resume``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Final

from pydantic import Field

from visionset import wire
from visionset.kernel.services import IngestService, SourceService
from visionset.mcp._errors import refused
from visionset.mcp._resolve import ProjectRef, resolve_project
from visionset.mcp._workspace import opened_workspace

#: What ``ingest`` answers when it is handed anything but a directory.
#:
#: It closes the door rather than only shutting it: an agent told "not supported"
#: looks for another way in, so the sentence says where video import actually
#: lives and that no tool here reaches it. True of a lone JPEG too, which is the
#: other way to arrive at this branch.
VIDEO_IS_A_BROWSER_IMPORT: Final = (
    "ingest takes a directory of still images. A video is imported in the browser, "
    "which decodes it on the user's own machine and uploads the frames: ask the user "
    "to open the project's Ingest screen in the VisionSet UI. No tool here decodes "
    "video, and re-encoding the clip yourself is not a substitute."
)


def ingest(
    project: ProjectRef,
    path: Annotated[
        str,
        Field(description="An absolute path on this machine to a directory of still images."),
    ],
    batch_name: Annotated[
        str | None,
        Field(description="Name the batch this run fills. Defaults to the source's own name."),
    ] = None,
) -> dict[str, Any]:
    """Register a directory of images and read it into one batch. Blocks until done.

    The directory is read top level only, in filename order, with no filter on
    the suffix — anything that is not a usable image is reported in `failures`
    and the run carries on.

    **Video is not ingested here.** A clip is imported through the browser, which
    decodes it on the user's machine and uploads the frames; pointed at one, this
    refuses and says so. There is no other tool for it.

    Assets are addressed by content, so ingesting the same bytes twice yields one
    asset. `created` counts new assets and `deduplicated` counts ones already
    known; both went into the batch. That is also why re-running this after an
    interrupted call is safe and nearly free.

    The `batch_id` it returns is what `approve_batch` takes next.

    `ingest_job_id` names *this run* and nothing else — there is no tool that
    reads it back, and it is not an annotation job. Annotation jobs do not exist
    yet at this point: `approve_batch` is what cuts them, and the ids it returns
    are the ones `get_job` and the rest of the loop take.

    Refuses before doing any work if the path does not exist or is not a
    directory.
    """
    source_path = Path(path)
    # Two refusals the kernel raises *outside* the VisionSetError tree, so
    # `guarded` would not catch them and the client would get a traceback's text
    # instead of an envelope: `canonical_path` resolves strictly
    # (FileNotFoundError) and `register_images` wants a directory
    # (NotADirectoryError).
    if not source_path.exists():
        return refused(f"no such path: {path}")
    if not source_path.is_dir():
        return refused(f"{path} is not a directory. {VIDEO_IS_A_BROWSER_IMPORT}")

    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        registered = SourceService(workspace).register_images(resolved.id, source_path)
        result = IngestService(workspace).ingest(registered.id, batch_name=batch_name)
    return {
        "source": wire.source(registered),
        # Not `job_id`: an agent reading that key tries it on `get_job` and is
        # refused, because the two words name different things and only one of
        # them is reachable. Observed on a real agent run.
        "ingest_job_id": str(result.job_id),
        "batch_id": str(result.batch_id),
        "created": result.created,
        "deduplicated": result.deduplicated,
        "failed": result.failed,
        "failures": [wire.ingest_failure(f) for f in result.failures],
    }


def list_sources(project: ProjectRef) -> dict[str, Any]:
    """List the origins registered in a project — the folders and clips it was built from.

    Use it to see what has already been ingested before ingesting again. `name`
    is the path's last component only; the full path is not published, because it
    describes this machine's disk and not anything a caller can act on. A video
    source — one a browser import created — carries what its decoder read off the
    clip and the rate it was decomposed at, under `video`.
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
