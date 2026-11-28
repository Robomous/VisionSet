# usage: from visionset.server.routes import projects
"""Projects: the whole lifecycle, over HTTP.

Every handler is one call to ``ProjectService`` and one shaping step. A route
never translates an error — it raises the kernel's and stops, and the handlers
``create_app()`` installed turn it into an ``ErrorBody`` with a stable code. See
``docs/content/api.md``.

Handlers are ``def``, not ``async def``, and that is not a style choice: every
kernel call underneath is a blocking SQLite call, so a coroutine here would run
it on the event loop. A sync handler gets the threadpool hop FastAPI already
offers, which is what the synchronous kernel wants.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import status

from visionset.kernel.services import JobService, ProjectService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    ConfirmQuery,
    ProgressCounts,
    ProjectCreate,
    ProjectListItemOut,
    ProjectOut,
    ProjectPage,
    ProjectStatsOut,
    ProjectUpdate,
)

router = protected_router(prefix="/projects", tags=["projects"])


@router.post("", status_code=status.HTTP_201_CREATED, responses=documented(409))
def create_project(workspace: WorkspaceDep, body: ProjectCreate) -> ProjectOut:
    """Add a project and its empty dataset, both or neither."""
    # A project created this instant has no batches, so its preview is settled.
    return ProjectOut.of(ProjectService(workspace).create(body.name, body.description), None)


@router.get("")
def list_projects(workspace: WorkspaceDep) -> ProjectPage:
    """Every project in this workspace, in the order they were created, each with its digest."""
    service = ProjectService(workspace)
    found = service.list()
    previews = service.previews()
    digests = service.digests()
    # The three reads are three units of work, so a project deleted between them
    # has no digest. It is left out of this answer rather than refusing the whole
    # listing, and `total` counts what the page holds.
    items = [
        ProjectListItemOut.listed(project, previews.get(project.id), digests[project.id])
        for project in found
        if project.id in digests
    ]
    return ProjectPage(items=items, total=len(items))


@router.get("/{project_id}", responses=documented(404))
def get_project(workspace: WorkspaceDep, project_id: UUID) -> ProjectOut:
    """The project with that id."""
    service = ProjectService(workspace)
    return ProjectOut.of(service.get(project_id), service.preview(project_id))


@router.get("/{project_id}/stats", responses=documented(404))
def get_project_stats(workspace: WorkspaceDep, project_id: UUID) -> ProjectStatsOut:
    """What the project holds, counted — overall and per label class.

    Counts **everything ingested**, whatever batch it landed in and whether or
    not anybody has promoted it. `GET /datasets/{dataset_id}/stats` is the
    sibling that counts the curated trunk, and the two disagree by design: a
    project mid-annotation has assets here and none there.

    `class_count` is what the active schema version declares, so a project that
    has just authored an ontology and labeled nothing reports its classes.
    `annotated_pct` is `0` for a project with no assets, never `null`.

    `classes` lists only classes somebody has actually used, ordered by name.
    """
    return ProjectStatsOut.of(ProjectService(workspace).stats(project_id))


@router.get("/{project_id}/progress", responses=documented(404))
def get_project_progress(workspace: WorkspaceDep, project_id: UUID) -> ProgressCounts:
    """How many of the project's assets sit in each annotation state, across every batch.

    The project-wide sibling of `GET /jobs/{job_id}/progress`; `unannotated` is
    what is left to do. Every state is a field, including the ones nobody is in,
    and a project with no batches reports zeros. An unknown project is 404
    `PROJECT_NOT_FOUND`.
    """
    return ProgressCounts.of(JobService(workspace).project_progress(project_id))


@router.patch("/{project_id}", responses=documented(404, 409))
def update_project(workspace: WorkspaceDep, project_id: UUID, body: ProjectUpdate) -> ProjectOut:
    """Rename a project, change its description, or both.

    An omitted or null field is left alone. A new name renames the project's
    dataset with it; a blank description clears it.
    """
    service = ProjectService(workspace)
    updated = service.update(project_id, name=body.name, description=body.description)
    return ProjectOut.of(updated, service.preview(project_id))


@router.delete(
    "/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=documented(404, 409),
)
def delete_project(
    workspace: WorkspaceDep, project_id: UUID, confirm: ConfirmQuery = False
) -> None:
    """Remove a project and everything under it.

    Metadata only: content blobs are shared and are never deleted. Without
    `confirm=true` this answers 409 `CONFIRMATION_REQUIRED` and destroys nothing.
    """
    # ``confirm`` goes straight to the service. Refusing it here would be a
    # second copy of a rule the kernel already owns, and the kernel's refusal is
    # what carries the code.
    ProjectService(workspace).delete(project_id, confirm=confirm)
