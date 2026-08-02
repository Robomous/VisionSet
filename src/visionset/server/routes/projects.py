# usage: from visionset.server.routes import projects
"""Projects: the whole lifecycle, over HTTP.

Every handler is one call to ``ProjectService`` and one shaping step. A route
never translates an error — it raises the kernel's and stops, and the handlers
``create_app()`` installed turn it into an ``ErrorBody`` with a stable code. See
``docs/api.md``.

Handlers are ``def``, not ``async def``, and that is not a style choice: every
kernel call underneath is a blocking SQLite call, so a coroutine here would run
it on the event loop. A sync handler gets the threadpool hop FastAPI already
offers, which is what the synchronous kernel wants.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import status

from visionset.kernel.services import ProjectService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    ConfirmQuery,
    ProjectCreate,
    ProjectOut,
    ProjectPage,
    ProjectRename,
    ProjectStatsOut,
)

router = protected_router(prefix="/projects", tags=["projects"])


@router.post("", status_code=status.HTTP_201_CREATED, responses=documented(409))
def create_project(workspace: WorkspaceDep, body: ProjectCreate) -> ProjectOut:
    """Add a project and its empty dataset, both or neither."""
    return ProjectOut.of(ProjectService(workspace).create(body.name, body.description))


@router.get("")
def list_projects(workspace: WorkspaceDep) -> ProjectPage:
    """Every project in this workspace, in the order they were created."""
    found = ProjectService(workspace).list()
    return ProjectPage(items=[ProjectOut.of(project) for project in found], total=len(found))


@router.get("/{project_id}", responses=documented(404))
def get_project(workspace: WorkspaceDep, project_id: UUID) -> ProjectOut:
    """The project with that id."""
    return ProjectOut.of(ProjectService(workspace).get(project_id))


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


@router.patch("/{project_id}", responses=documented(404, 409))
def rename_project(workspace: WorkspaceDep, project_id: UUID, body: ProjectRename) -> ProjectOut:
    """Rename a project, and its dataset with it. The only field that moves."""
    return ProjectOut.of(ProjectService(workspace).rename(project_id, body.name))


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
