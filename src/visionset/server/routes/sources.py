# usage: from visionset.server.routes import sources
"""Sources: offering a project some raw data, and launching a run over it.

Two routers, because a source is addressable on its own. The collection hangs
off the project that owns it (`ProjectService` is the door to a project, and a
source belongs to exactly one); the resource does not, because what hangs off
*it* — its ingest jobs — would otherwise sit four path segments deep for no gain.

**Registration is upload-only.** The kernel registers a source by path, so these
routes stage the bytes first (see ``server/uploads.py``) and register the staged
directory or file. There is no route that takes a server-side path: it would
hand every token holder an arbitrary-directory read, and the two surfaces that
legitimately hold real paths — the CLI and MCP — call the SDK in-process and
never come through here. It also has a quiet dividend: because the server just
wrote the file, `SourceService`'s ``FileNotFoundError`` and ``NotADirectoryError``
are unreachable, and those are plain Python exceptions with no place in
``ERROR_RULES``.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
Reading a spooled upload is blocking I/O too.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import File, Form, Response, UploadFile, status

from visionset.kernel.ports import DEFAULT_EXTRACTION_FPS
from visionset.kernel.services import IngestService, SourceService
from visionset.server.dependencies import RunnerDep, WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    IngestJobOut,
    IngestJobPage,
    IngestStart,
    SourceOut,
    SourcePage,
)
from visionset.server.uploads import stage

project_router = protected_router(prefix="/projects/{project_id}/sources", tags=["sources"])
router = protected_router(prefix="/sources", tags=["sources"])

#: The decomposition rate, as a multipart field. ``gt=0`` mirrors
#: ``VideoProvenance.extraction_fps``' own bound, which is what keeps
#: `SourceService`'s bare ``ValueError`` — outside the ``VisionSetError`` tree,
#: so a 500 — from ever being reachable over HTTP.
ExtractionFpsForm = Annotated[
    float,
    Form(gt=0, description="Frames per second to cut the clip at. One per second by default."),
]


@project_router.post("/images", status_code=status.HTTP_201_CREATED, responses=documented(404))
def register_image_source(
    workspace: WorkspaceDep,
    project_id: UUID,
    files: Annotated[list[UploadFile], File(description="The images, as one multipart part each.")],
) -> SourceOut:
    """Offer a project a folder of stills.

    The parts are staged as one directory and that directory becomes the source.
    Uploading the same files again returns the **same** source rather than a
    second one: staging is content-addressed, so identical bytes under identical
    filenames land on the same path, and registration is idempotent on that path.

    Nothing is decoded here — what the files turn out to be is read at ingest,
    and a file that is not an image is reported there rather than refused now.
    """
    # ``capture_params`` is not on the wire. It is an opaque operator-supplied
    # mapping, and threading a JSON object through a multipart form is a
    # contract decision with no caller asking for it yet.
    staged = stage(workspace.root, files)
    return SourceOut.of(SourceService(workspace).register_images(project_id, staged.directory))


@project_router.post("/video", status_code=status.HTTP_201_CREATED, responses=documented(404))
def register_video_source(
    workspace: WorkspaceDep,
    project_id: UUID,
    file: Annotated[UploadFile, File(description="The clip.")],
    extraction_fps: ExtractionFpsForm = DEFAULT_EXTRACTION_FPS,
) -> SourceOut:
    """Offer a project a clip, to be cut at `extraction_fps`.

    The clip is probed on the way in, so a file that is not a video, or one
    whose bytes will not decode, is 422 here rather than a run that fails later.

    The rate is part of what the source *is*: the same clip registered at 1 fps
    and again at 5 fps is two sources over one file, which is what makes "the
    same source yields the same assets" mean anything.
    """
    staged = stage(workspace.root, [file])
    source = SourceService(workspace).register_video(
        project_id, staged.only, extraction_fps=extraction_fps
    )
    return SourceOut.of(source)


@project_router.get("", responses=documented(404))
def list_sources(workspace: WorkspaceDep, project_id: UUID) -> SourcePage:
    """Every source of that project, in registration order."""
    found = SourceService(workspace).list(project_id)
    return SourcePage(items=[SourceOut.of(source) for source in found], total=len(found))


@router.get("/{source_id}", responses=documented(404))
def get_source(workspace: WorkspaceDep, source_id: UUID) -> SourceOut:
    """The source with that id."""
    return SourceOut.of(SourceService(workspace).get(source_id))


@router.post(
    "/{source_id}/ingest-jobs",
    status_code=status.HTTP_202_ACCEPTED,
    responses=documented(404, 409),
)
def start_ingest(
    workspace: WorkspaceDep,
    runner: RunnerDep,
    response: Response,
    source_id: UUID,
    body: IngestStart | None = None,
) -> IngestJobOut:
    """Launch a run over the source and answer at once with the job to poll.

    **202, not 201**: the row exists, the work does not. Poll
    `GET /ingest-jobs/{id}` — the `Location` header names it — and watch
    `processed` climb until `state` is `completed` or `failed`.

    A run that could not even be recorded is refused here; everything that goes
    wrong afterwards is reported *on the job*, which is the whole point of the
    shape. Unreadable files land in `failures` and do not fail the run; a
    missing ffmpeg does, in `error`.

    `batch_id` puts what this run gathers into a batch that already exists,
    which is how a second source joins the first one's batch. It has to be a
    draft — an approved batch has been cut into jobs already, so adding to it is
    409 `BATCH_NOT_EDITABLE` — and an unknown one is a 404. Both are answered
    here, before the job row is written. `batch_name` names a new batch instead;
    passing neither uses the source's own name.
    """
    ingest = IngestService(workspace)
    job = ingest.enqueue(
        source_id,
        batch_id=None if body is None else body.batch_id,
        batch_name=None if body is None else body.batch_name,
    )
    # ``resume``, not ``ingest``: the row is already there and ``pending`` is
    # exactly what ``resume`` picks up. Doing the whole call in the worker would
    # mean creating a second job.
    runner.submit(lambda: ingest.resume(job.id))
    response.headers["Location"] = f"/ingest-jobs/{job.id}"
    return IngestJobOut.of(job)


@router.get("/{source_id}/ingest-jobs", responses=documented(404))
def list_ingest_jobs(workspace: WorkspaceDep, source_id: UUID) -> IngestJobPage:
    """Every run of that source, in the order they were asked for."""
    found = IngestService(workspace).list(source_id)
    return IngestJobPage(items=[IngestJobOut.of(job) for job in found], total=len(found))
