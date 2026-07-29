# usage: from visionset.mcp._resolve import resolve_project, resolve_release
"""Turning what an agent said into the thing it meant.

The same two resources the CLI can name, for the same reason and with the same
two opposite rules:

- a **project**, whose name is unique per workspace **case-insensitively**;
- a **release**, whose tag is unique per dataset and **case-sensitive**.

Neither comparison is spelled here. ``ProjectService.get_by_name`` and
``ReleaseService.get_by_tag`` are kernel reads precisely so the rule lives beside
the index that enforces it — a surface re-deriving one from prose is a second
spelling free to drift, and it would eventually pick the wrong one. What this
module owns is only the dispatch: a well-formed UUID is an id, anything else is a
name.

Name resolution matters more here than at a terminal, not less. A person reads an
id off the previous command's output; an agent carries it in a context window and
will paraphrase one given the chance. ``"road-signs"`` survives that and
``9f2c…`` does not.

**Batches, jobs and assets are addressed by id and nothing else.** A batch has a
name but it is not unique — an ingest names one after its source, and re-ingesting
the same folder makes a second batch with a name just as good — so resolving one
by name would have to pick, and picking is worse than refusing. Their ids come
back from the tool that created them.

Unlike the CLI, a malformed UUID cannot arrive as a usage error at exit 2: an id
parameter is typed ``str`` on the wire either way. Each tool parses one through
:func:`identifier`, so a value that could not have named anything is refused in
the ordinary envelope rather than reaching the kernel as a puzzling ``*NotFound``.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from pydantic import Field

from visionset.kernel.domain import Project, Release
from visionset.kernel.errors import VisionSetError
from visionset.kernel.services import ProjectService, ReleaseService, WorkspaceService

ProjectRef = Annotated[
    str,
    Field(description="The project, by name (case-insensitive) or by id."),
]
"""``project``, for a tool scoped to one project.

Module-level so that ``inspect.signature(fn, eval_str=True)`` resolves it in the
importing module's globals under ``from __future__ import annotations``; an alias
built inside a function body would not resolve, and FastMCP would refuse the tool
at registration.
"""


class MalformedIdentifier(VisionSetError):
    """A parameter that has to be an id is not one.

    A ``VisionSetError`` subclass rather than a bare ``ValueError`` so that
    ``guarded`` renders it as the ordinary envelope. It is deliberately **not** in
    ``kernel/errors.py``: the kernel takes ``UUID`` objects and cannot be handed a
    malformed one, so this is a fact about a surface whose arguments arrive as
    JSON strings, which is exactly the same call the API makes when it answers 422
    rather than 404 to an unparseable path segment.
    """


def identifier(value: str, *, what: str) -> UUID:
    """The UUID that string spells, or say it is not one.

    Raises:
        MalformedIdentifier: the value is not a well-formed UUID.
    """
    try:
        return UUID(value)
    except ValueError:
        raise MalformedIdentifier(
            f"{what} must be a UUID, and {value!r} is not one; "
            f"ids come back from the tool that created the thing"
        ) from None


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
    """The release under that tag, in the dataset of the project reference names.

    Two lookups rather than one, because a release tag is unique per *dataset*
    and a dataset is reached through its project. The intermediate read is not
    waste: it is what makes an unknown project say so, instead of reporting a
    perfectly good tag as missing.
    """
    project = resolve_project(workspace, reference)
    dataset = ProjectService(workspace).get_dataset(project.id)
    return ReleaseService(workspace).get_by_tag(dataset.id, tag)
