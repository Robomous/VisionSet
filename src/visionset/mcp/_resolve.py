# usage: from visionset.mcp._resolve import ConnectionRef, ProjectRef, identifier
"""Parameter types and id parsing for tools that name a project or a connection.

Name-or-id resolution is the kernel's: ``ProjectService.resolve``,
``InferenceConnectionService.resolve`` and ``ReleaseService.resolve``. A person
reads an id off the previous command's output; an agent carries it in a context
window and will paraphrase one, so ``"road-signs"`` survives where ``9f2c...``
does not.

**Batches, jobs and assets are addressed by id and nothing else.** A batch has a
name but it is not unique, so resolving one by name would have to pick, and
picking is worse than refusing.

Unlike the CLI, a malformed UUID cannot arrive as a usage error at exit 2: an id
parameter is typed ``str`` on the wire either way. Each tool parses one through
:func:`identifier`, so a value that could not have named anything is refused in
the ordinary envelope rather than reaching the kernel as a puzzling ``*NotFound``.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from pydantic import Field

from visionset.kernel.errors import VisionSetError

ProjectRef = Annotated[
    str,
    Field(description="The project, by name (case-insensitive) or by id."),
]
"""``project``, for a tool scoped to one project.

Module-level so that ``inspect.signature(fn, eval_str=True)`` resolves it in the
importing module's globals under ``from __future__ import annotations``; an alias
built inside a function body would not resolve, and MCPServer would refuse the tool
at registration.
"""

ConnectionRef = Annotated[
    str,
    Field(description="The inference connection, by name (case-insensitive) or by id."),
]
"""``connection``, for a tool acting on one configured connection.

Module-level for ``ProjectRef``'s reason.
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
