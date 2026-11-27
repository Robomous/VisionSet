# usage: from visionset.server.routes import sources
"""Sources: offering a project some raw data, and launching a run over it.

Two routers, because a source is addressable on its own. The collection hangs
off the project that owns it (`ProjectService` is the door to a project, and a
source belongs to exactly one); the resource does not, because what hangs off
*it* — its ingest jobs — would otherwise sit four path segments deep for no gain.

**Registration is upload-only.** The kernel registers a directory source by path,
so these routes stage the bytes first (see ``server/uploads.py``) and register
the staged directory — a folder of stills, or a folder of point-cloud scans
together with the frame they are written in. There is no route that takes a
server-side path: it would hand every token holder an arbitrary-directory read,
and the two surfaces that legitimately hold real paths — the CLI and MCP — call
the SDK in-process and never come through here. It also has a quiet dividend:
because the server just wrote the files, `SourceService`'s ``FileNotFoundError``
and ``NotADirectoryError`` are unreachable, and those are plain Python exceptions
with no place in ``ERROR_RULES``.

**A clip is not registered here.** The server decodes no video: a video source is
opened as a session in ``routes/video_imports.py``, and its frames arrive as
ordinary images a client materialized locally.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
Reading a spooled upload is blocking I/O too.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import File, Form, Response, UploadFile, status

from visionset.jobs.ingest import JOB_TYPE as ingest_job_type
from visionset.jobs.ingest import payload_for as ingest_payload_for
from visionset.kernel.domain import BackgroundJobSpec, ScanFrame
from visionset.kernel.services import CalibrationService, IngestService, SourceService
from visionset.server.dependencies import RunnerDep, WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    WIRE_TEXT_MAX_LENGTH,
    CalibrationBody,
    FrameOccurrenceOut,
    FrameOccurrencePage,
    IngestJobOut,
    IngestJobPage,
    IngestStart,
    SourceCalibrationOut,
    SourceOut,
    SourcePage,
)
from visionset.server.uploads import stage

project_router = protected_router(prefix="/projects/{project_id}/sources", tags=["sources"])
router = protected_router(prefix="/sources", tags=["sources"])


@project_router.post("/images", status_code=status.HTTP_201_CREATED, responses=documented(404))
def register_image_source(
    workspace: WorkspaceDep,
    project_id: UUID,
    files: Annotated[list[UploadFile], File(description="The images, as one multipart part each.")],
    name: Annotated[
        str | None,
        Form(
            max_length=WIRE_TEXT_MAX_LENGTH,
            description=(
                "What to call the source. Without one it is named by its staged "
                "directory, whose basename is a content digest — 64 hex characters "
                "nobody can read. Registering the same files again with a new name "
                "renames the existing source rather than creating a second one."
            ),
        ),
    ] = None,
) -> SourceOut:
    """Offer a project a folder of stills.

    The parts are staged as one directory and that directory becomes the source.
    Uploading the same files again returns the **same** source rather than a
    second one: staging is content-addressed, so identical bytes under identical
    filenames land on the same path, and registration is idempotent on that path.

    Nothing is decoded here — what the files turn out to be is read at ingest,
    and a file that is not an image is reported there rather than refused now.

    `name` exists because the staged path's basename is a digest; a blank one is
    422 `INVALID_NAME`, refused by the kernel's own `InvalidName` — the domain
    already refuses with a mapped error, so no wire validator restates it. One
    longer than 255 characters is 422 `VALIDATION_ERROR`, a bound the domain
    does not have.
    """
    # ``capture_params`` is not on the wire. It is an opaque operator-supplied
    # mapping, and threading a JSON object through a multipart form is a
    # contract decision with no caller asking for it yet.
    staged = stage(workspace.root, files)
    return SourceOut.of(
        SourceService(workspace).register_images(project_id, staged.directory, display_name=name)
    )


@project_router.post(
    "/point-clouds", status_code=status.HTTP_201_CREATED, responses=documented(404, 409)
)
def register_point_cloud_source(
    workspace: WorkspaceDep,
    project_id: UUID,
    files: Annotated[
        list[UploadFile], File(description="The PCD and PLY scans, as one multipart part each.")
    ],
    frame: Annotated[
        ScanFrame,
        Form(
            description=(
                "The axis convention the scans and their 3D labels are written in: "
                "`lidar_flu` (x forward, y left, z up), `camera_rdf` (x right, "
                "y down, z forward) or `lidar_rfu` (x right, y forward, z up)."
            ),
        ),
    ],
    name: Annotated[
        str | None,
        Form(
            max_length=WIRE_TEXT_MAX_LENGTH,
            description=(
                "What to call the source; without one it is named by its staged "
                "directory's content digest. A new name for the same files renames "
                "the existing source."
            ),
        ),
    ] = None,
) -> SourceOut:
    """Offer a project a folder of point-cloud scans, declaring the frame they are written in.

    Staged and deduplicated exactly as `POST /projects/{project_id}/sources/images`
    is: the same files uploaded again return the **same** source. Nothing is
    parsed here — each file's format is read from its header at ingest, and a
    file that is not a PCD or PLY scan is reported there rather than refused now.

    Uploading the same files with another `frame` replaces the declaration,
    unless a scan of the source already holds a 3D label: that is 409
    `CALIBRATION_IN_USE`, because the label would be re-read in other axes.

    A missing `frame`, or one that is not `lidar_flu`, `camera_rdf` or
    `lidar_rfu`, is 422 `VALIDATION_ERROR`, as is a `name` longer than 255 characters; a blank
    `name` is 422 `INVALID_NAME`. An unknown project is 404 `PROJECT_NOT_FOUND`.
    """
    staged = stage(workspace.root, files)
    return SourceOut.of(
        SourceService(workspace).register_point_clouds(
            project_id, staged.directory, frame=frame, display_name=name
        )
    )


@project_router.get("", responses=documented(404))
def list_sources(workspace: WorkspaceDep, project_id: UUID) -> SourcePage:
    """Every source of that project, in registration order."""
    found = SourceService(workspace).list(project_id)
    return SourcePage(items=[SourceOut.of(source) for source in found], total=len(found))


@router.get("/{source_id}", responses=documented(404))
def get_source(workspace: WorkspaceDep, source_id: UUID) -> SourceOut:
    """The source with that id."""
    return SourceOut.of(SourceService(workspace).get(source_id))


@router.get("/{source_id}/occurrences", responses=documented(404))
def list_frame_occurrences(workspace: WorkspaceDep, source_id: UUID) -> FrameOccurrencePage:
    """Every frame occurrence of this source, in position order.

    An occurrence is one position of a clip's extraction grid and the asset it
    decoded to; identical frames at two positions are one asset at two
    occurrences. A source that is not a video, an image sequence or a
    point-cloud sequence has none. An unknown source is 404 `SOURCE_NOT_FOUND`.
    """
    found = SourceService(workspace).occurrences(source_id)
    return FrameOccurrencePage(items=[FrameOccurrenceOut.of(o) for o in found], total=len(found))


@router.get("/{source_id}/calibration", responses=documented(404))
def get_source_calibration(workspace: WorkspaceDep, source_id: UUID) -> SourceCalibrationOut:
    """The camera calibration stated for this source; `calibration` is null when none is.

    An unknown source is 404 `SOURCE_NOT_FOUND`.
    """
    found = CalibrationService(workspace).source_calibration(source_id)
    return SourceCalibrationOut.of(source_id, found)


@router.put("/{source_id}/calibration", responses=documented(404, 409))
def set_source_calibration(
    workspace: WorkspaceDep, source_id: UUID, body: CalibrationBody
) -> SourceCalibrationOut:
    """State the camera behind every frame of this source, replacing any already stated.

    Replacing it with a different calibration is refused with 409
    `CALIBRATION_IN_USE` while an asset inheriting it holds 3D labels, which were
    drawn against it; stating the identical one again changes nothing. A
    point-cloud source, which has no camera, is 409 `CALIBRATION_NOT_APPLICABLE`.

    Every asset of the source that has no calibration of its own inherits it.
    Calibration is not part of the source's identity: registering the same files
    again returns this source with its calibration untouched.

    A calibration measured at a size other than a clip's stored frame size, or
    than an asset that would inherit it, is 422 `CALIBRATION_RESOLUTION_MISMATCH`.
    A rotation that is not a proper rotation, or a non-positive focal length, is
    422 `VALIDATION_ERROR`. An unknown source is 404 `SOURCE_NOT_FOUND`.
    """
    stored = CalibrationService(workspace).set_source_calibration(source_id, body.to_domain())
    return SourceCalibrationOut.of(stored.id, stored.calibration)


@router.delete(
    "/{source_id}/calibration",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=documented(404, 409),
)
def clear_source_calibration(workspace: WorkspaceDep, source_id: UUID) -> None:
    """Remove the source's calibration. Clearing one that is not there is a 204 too.

    Refused with 409 `CALIBRATION_IN_USE` while an asset inheriting it holds 3D
    labels, as is replacing it with a different one. An unknown source is 404
    `SOURCE_NOT_FOUND`.
    """
    CalibrationService(workspace).clear_source_calibration(source_id)


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
    shape. Unreadable files land in `failures` and do not fail the run; only a
    condition that stops the run reaching any further file at all is reported in
    `error`.

    **Only a folder of stills is run here.** This server holds no decoder, so a
    `video` source has nothing it could read: a clip is decoded by the client
    that holds the file and its frames are posted to
    `POST /projects/{project_id}/video-imports` instead. Asking for a run over
    one is 422 `UNSUPPORTED_MEDIA`.

    `batch_id` puts what this run gathers into a batch that already exists,
    which is how a second source joins the first one's batch. It has to be a
    draft — an approved batch has been cut into jobs already, so adding to it is
    409 `BATCH_NOT_EDITABLE` — and an unknown one is 404 `BATCH_NOT_FOUND`. Both
    are answered here, before the job row is written, as is 404
    `SOURCE_NOT_FOUND` for the source this run would read. `batch_name` names a new batch instead,
    and one that is blank once stripped is 422 `INVALID_NAME`, one longer than
    255 characters 422 `VALIDATION_ERROR`; passing neither uses the source's own name,
    and then a run that finds nothing new creates no batch. A run that read nothing
    never creates one. Either way the completed job's `batch_id` stays null.
    """
    job = IngestService(workspace).enqueue(
        source_id,
        batch_id=None if body is None else body.batch_id,
        batch_name=None if body is None else body.batch_name,
    )
    # Two rows for one run, and the ingest job is still the one a client polls.
    # ``enqueue`` above wrote it and made every refusal a caller can act on; this
    # queues the *work*, whose handler calls ``resume`` — which is exactly what
    # ``pending`` was reserved for. See ``visionset/jobs/ingest.py``.
    workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=ingest_job_type,
            payload=ingest_payload_for(job.id),
            idempotent=True,
        )
    )
    runner.wake()
    response.headers["Location"] = f"/ingest-jobs/{job.id}"
    return IngestJobOut.of(job)


@router.get("/{source_id}/ingest-jobs", responses=documented(404))
def list_ingest_jobs(workspace: WorkspaceDep, source_id: UUID) -> IngestJobPage:
    """Every run of that source, in the order they were asked for."""
    found = IngestService(workspace).list(source_id)
    return IngestJobPage(items=[IngestJobOut.of(job) for job in found], total=len(found))
