# usage: from visionset.mcp import projects
"""Project tools: create, list, read, delete.

``get_project`` folds three parity candidates into one call. ``get_project``,
``get_project_dataset`` and ``get_dataset`` are three round trips for facts an
agent invariably wants together — the dataset id is the handle every release tool
needs, and it is 1:1 with the project, so making an agent fetch it separately buys
nothing but a chance to lose it. The progress counts come along for the same
reason: "what is in this project and how far along is it" is one question.

``rename_project`` is **not** here. It is the only project write that changes
nothing an agent can observe going wrong, and a tool that exists only so a model
can fix a typo in a name it chose is list-padding.

``delete_project`` **is** here, and it is the widest of the two tools in this
surface that destroy data (``delete_batch`` is the other). It carries ``confirm``,
and like its sibling it is registered only under ``--allow-destructive``.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from visionset import wire
from visionset.kernel.services import JobService, ProjectService
from visionset.mcp._resolve import ProjectRef, resolve_project
from visionset.mcp._workspace import opened_workspace


def create_project(
    name: Annotated[
        str,
        Field(description="A name for the project, unique in this workspace case-insensitively."),
    ],
    description: Annotated[
        str | None, Field(description="Optional free text describing the project.")
    ] = None,
) -> dict[str, Any]:
    """Create a project, together with the empty dataset that is its trunk.

    Use this first: every other tool is scoped to a project. Returns the project
    and its dataset id. Refuses with a message if the name is blank or already
    taken — names are compared case-insensitively, so "Road-Signs" collides with
    "road-signs". A new project has no annotation schema; call
    `create_schema_version` before ingesting anything you intend to label.
    """
    with opened_workspace() as workspace:
        projects = ProjectService(workspace)
        created = projects.create(name, description)
        dataset = projects.get_dataset(created.id)
    return {"project": wire.project(created), "dataset": wire.dataset(dataset)}


def list_projects() -> dict[str, Any]:
    """List every project in this workspace, in creation order.

    Use this to discover what exists before naming one. Returns
    `{"items": [...], "total": n}`; an empty workspace is `total: 0` and not an
    error.
    """
    with opened_workspace() as workspace:
        projects = ProjectService(workspace).list()
    return wire.page([wire.project(p) for p in projects])


def get_project(project: ProjectRef) -> dict[str, Any]:
    """Read a project, its dataset id, and how far its annotation work has got.

    The one call that answers "what is this and where does it stand". `progress`
    counts every asset in the project by state, across all its batches, so
    `unannotated` is what is left to do. `dataset.id` is the handle
    `dataset_stats`, `publish_release` and `list_releases` take.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        dataset = ProjectService(workspace).get_dataset(resolved.id)
        counts = JobService(workspace).project_progress(resolved.id)
    return {
        "project": wire.project(resolved),
        "dataset": wire.dataset(dataset),
        "progress": wire.progress_counts(counts),
    }


def delete_project(
    project: ProjectRef,
    confirm: Annotated[
        bool,
        Field(
            description=(
                "Must be true to actually delete. False returns a refusal and changes nothing."
            )
        ),
    ] = False,
) -> dict[str, Any]:
    """Delete a project and everything under it. Destructive; requires `confirm=true`.

    Takes with it the schema versions, sources, assets, annotations, batches,
    jobs, the dataset and every release — irreversibly, and with no undo. The
    image bytes themselves survive in the workspace's blob store, because content
    is shared and addressed by hash, but nothing points at them any more.

    Called without `confirm=true` it changes nothing and tells you so; that
    refusal is the intended way to check what you are about to do. An unknown
    project is reported as missing whether or not `confirm` was passed.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        ProjectService(workspace).delete(resolved.id, confirm=confirm)
    return {"deleted": wire.project(resolved)}
