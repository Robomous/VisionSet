# usage: from visionset.server.routes import background_jobs
"""Background jobs: the generic polling surface, and the one place artifacts leave.

**The prefix is ``/background-jobs`` and not ``/jobs``, because ``/jobs`` is
taken.** ``routes/jobs.py`` serves annotation jobs there —
``GET /jobs/{job_id}`` answers a ``JobOut``, a slice of *human* work — and that is
a shipped contract in ``openapi.json``. Two different things wanted the same word;
the newer one gives way. It also reads consistently beside ``/ingest-jobs``, which
is the other launch-and-poll surface and the shape this one generalises.

**No launch route.** Nothing here creates a job, and that is deliberate: what work
means belongs to the resource it is about, so an export is launched from
``POST /releases/{id}/export`` and an ingest from
``POST /sources/{id}/ingest-jobs``. A generic ``POST /background-jobs`` taking a
type and a payload would be a remote-code surface with a token in front of it, and
the payloads are internal contracts that would become public the day one shipped.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Final
from uuid import UUID

from fastapi import HTTPException, Query, status
from fastapi.responses import FileResponse

from visionset.kernel.domain import BackgroundJob, BackgroundJobState
from visionset.kernel.errors import BackgroundJobNotFound
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import BackgroundJobOut, BackgroundJobPage

router = protected_router(prefix="/background-jobs", tags=["jobs"])

#: Suffix to content type, for the one route that serves a file a *handler* named.
#:
#: Indexed directly and kept small on purpose: this is not a general mime table,
#: it is the list of things a job in this product produces. A suffix absent here
#: is bytes, which is a true statement rather than a guess.
_ARTIFACT_MEDIA_TYPES: Final[dict[str, str]] = {".zip": "application/zip"}

StateQuery = Annotated[
    list[BackgroundJobState] | None,
    Query(
        description=(
            "Only jobs in these states. Repeat the parameter for several. "
            "Omitted, every job is returned."
        )
    ),
]


def _require(workspace: WorkspaceDep, job_id: UUID) -> BackgroundJob:
    """The job, or a 404 naming it.

    The port answers ``None`` rather than raising, because its other caller — the
    dispatcher — treats a vanished row as "stop" and would otherwise have to write
    a ``try``. Turning that into the domain error is this layer's job, and doing it
    once here is what keeps the three routes below from each spelling it.

    Raises:
        BackgroundJobNotFound: no such job in this workspace.
    """
    job = workspace.job_queue.get(job_id)
    if job is None:
        raise BackgroundJobNotFound(f"no background job {job_id} in this workspace")
    return job


@router.get("/{job_id}", responses=documented(404))
def get_background_job(workspace: WorkspaceDep, job_id: UUID) -> BackgroundJobOut:
    """Where a queued unit of work is now.

    The generic twin of `GET /ingest-jobs/{id}`, and the same contract:
    `processed` and `total` are written while the run is in flight, so this
    answers "where is it" rather than "where did it end". `total` is null when the
    work cannot know it in advance.

    Terminal states are `succeeded`, `failed` and `cancelled`. A finished job
    keeps its counters where they stopped; `error` says why a failure failed, and
    `result` carries whatever the work produced — for an export, the archive
    `GET /background-jobs/{id}/artifact` will hand back.
    """
    return BackgroundJobOut.of(_require(workspace, job_id))


@router.get("")
def list_background_jobs(workspace: WorkspaceDep, state: StateQuery = None) -> BackgroundJobPage:
    """Every job this workspace has run, newest first.

    Newest first because the caller is looking at what is happening now — the
    opposite order to the one the dispatcher claims in, which is oldest first.

    No paging parameters. The collection is bounded by how much work a workspace
    has ever queued, which is the same order of magnitude as its ingest runs, and
    `limit`/`offset` join `total` without a breaking change on the day one has a
    caller — the rule `docs/content/api.md` states for every collection here.
    """
    found = workspace.job_queue.list(states=state)
    return BackgroundJobPage(items=[BackgroundJobOut.of(job) for job in found], total=len(found))


@router.post("/{job_id}/cancel", responses=documented(404))
def cancel_background_job(workspace: WorkspaceDep, job_id: UUID) -> BackgroundJobOut:
    """Ask a job to stop, and answer with where that left it.

    **Two different things behind one verb, and the answer says which happened.**
    A `queued` job has not started, so it comes back `cancelled` outright. A
    `running` job is only *told*: `cancel_requested` becomes true, `state` stays
    `running`, and the work stops at the next point its handler considers safe —
    which for a job with no such point is not until it finishes. Nothing is ever
    killed mid-write.

    Cancelling a job that has already settled is a no-op that returns it
    unchanged, not a refusal: the caller wanted it stopped and it is stopped.

    200 rather than 202, because this answers with the state it produced rather
    than promising something later.
    """
    return BackgroundJobOut.of(workspace.job_queue.request_cancel(job_id))


@router.get(
    "/{job_id}/artifact",
    response_class=FileResponse,
    response_model=None,
    responses={
        **documented(404, 409),
        200: {
            # **Both.** A response the contract omits is a lie the generated
            # client inherits — the mistake `get_asset_content` made by declaring
            # two image types while `_media_type()` could also answer
            # `application/octet-stream`.
            # Today's only artifact is a zip; anything else falls back to the
            # generic type, and both are what a caller may actually receive.
            "content": {
                "application/zip": {"schema": {}},
                "application/octet-stream": {"schema": {}},
            },
            "description": "The file the job produced.",
        },
    },
)
def get_background_job_artifact(workspace: WorkspaceDep, job_id: UUID) -> FileResponse:
    """Download whatever the job left behind. Today that is an export archive.

    A **second route rather than bytes on the poll**, because the two are read on
    different schedules: a client polls this job every couple of seconds and wants
    JSON each time, and asks for the archive exactly once.

    The path comes from the job's own `result`, is **relative to the workspace
    root**, and is rejoined here — an absolute path is a server-side path, which
    is the rule that keeps `Source.path` and `Asset.uri` off the wire. It is also
    re-checked to be inside the root before anything is opened: the value has been
    through a JSON column, and a route that trusts a stored path to stay inside
    the directory it was written for is one bad row away from serving `/etc`.

    A job this workspace does not hold is 404 `BACKGROUND_JOB_NOT_FOUND`. There
    is a 404 for the artifact too — the job never produced one, or the file is
    gone, since an export directory is not garbage-collected but a workspace is a
    directory somebody can tidy — and a 409 while the job has not succeeded,
    because "not yet" and "never" are different answers and only one of them is
    worth retrying. Those last two carry the status's own name rather than a
    domain code: nothing about them is a state of the job that a client could
    branch on.
    """
    job = _require(workspace, job_id)
    if job.state is not BackgroundJobState.SUCCEEDED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"job {job_id} is {job.state} and has produced no artifact; "
                f"poll GET /background-jobs/{job_id} until it has succeeded"
            ),
        )
    relative = job.result.get("archive")
    if not isinstance(relative, str):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"job {job_id} produced no downloadable artifact",
        )
    root = workspace.root
    path = (root / relative).resolve()
    # `is_relative_to`, before `is_file`: the containment check must not be a
    # thing a missing file lets us skip.
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"the artifact for job {job_id} is no longer on disk",
        )
    return FileResponse(path, media_type=_media_type(path), filename=path.name)


def _media_type(path: Path) -> str:
    """What the bytes are, from the name the handler chose.

    Indexed off the suffix rather than sniffed, because the handler already knows
    — and rather than hardcoded, because this route is generic and the next
    artifact will not be a zip. An unrecognised suffix answers
    ``application/octet-stream``, which is honest: it says "bytes" rather than
    guessing, and it is what ``_media_type`` in ``routes/assets.py`` answers for
    an asset whose format was never probed.
    """
    return _ARTIFACT_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
