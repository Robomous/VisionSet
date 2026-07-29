# usage: from visionset.cli._resolve import ProjectOption, resolve_project, resolve_release
"""Turning what somebody typed into the thing they meant.

A person at a terminal types ``--project road-signs``, not a UUID they have to
find first. Two resources can be named that way and no more:

- a **project**, whose name is unique per workspace **case-insensitively**;
- a **release**, whose tag is unique per dataset and **case-sensitive**.

Those two rules are opposites, and neither is spelled here. ``get_by_name`` and
``get_by_tag`` are kernel reads for exactly that reason — the comparison belongs
beside the index that enforces it, and a surface re-deriving one from prose is a
second spelling free to drift. What this module owns is only the dispatch: a
well-formed UUID is an id, anything else is a name.

**Batches, jobs and assets are addressed by id and nothing else.** A batch has a
name but it is not unique — an ingest names one after its source, and re-ingesting
the same folder makes a second batch with a name just as good — so resolving one
by name would have to pick, and picking is worse than refusing. Their ids come
off the previous command's stdout, which is what the one-datum rule is for.

A malformed id is Click's refusal at **exit 2**, not a kernel ``*NotFound`` at
exit 1: the same call the API makes, where a malformed UUID is 422 rather than
404 because the request could not have named anything. That is why the id-only
parameters are typed ``UUID`` and this module is not involved.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

import typer

from visionset.kernel.domain import Project, Release
from visionset.kernel.services import ProjectService, ReleaseService, WorkspaceService

ProjectOption = Annotated[
    str,
    typer.Option("--project", "-p", help="The project, by name or by id."),
]
"""``--project`` / ``-p``, for a command scoped to one project.

Typed ``str`` rather than ``UUID`` precisely so a name gets through. The cost is
that a value which is neither reaches the kernel and comes back as
``ProjectNotFound`` at exit 1 — which is right, because unlike a malformed id it
*could* have named something.

Module-level for the ``get_type_hints`` reason ``WorkspaceOption`` is.
"""


def resolve_project(workspace: WorkspaceService, reference: str) -> Project:
    """The project that reference names, by id if it parses as one, else by name.

    A project whose *name* is a well-formed UUID string is unreachable by name.
    That is harmless: the same string reaches it as an id, and it is the same
    string either way.
    """
    projects = ProjectService(workspace)
    try:
        project_id = UUID(reference)
    except ValueError:
        return projects.get_by_name(reference)
    return projects.get(project_id)


def resolve_release(workspace: WorkspaceService, reference: str, tag: str) -> Release:
    """The release under that tag, in the dataset of the project that reference names.

    Two lookups rather than one, because a release tag is unique per *dataset*
    and a dataset is reached through its project. The intermediate read is not
    waste: it is what makes an unknown project say so, instead of reporting a
    perfectly good tag as missing.
    """
    project = resolve_project(workspace, reference)
    dataset = ProjectService(workspace).get_dataset(project.id)
    return ReleaseService(workspace).get_by_tag(dataset.id, tag)
