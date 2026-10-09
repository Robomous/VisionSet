# usage: from visionset.cli._resolve import ProjectOption
"""The ``--project`` option every project-scoped command shares.

A person at a terminal types ``--project road-signs``, not a UUID they have to
find first. The dispatch (a well-formed UUID is an id, anything else is a name)
is ``ProjectService.resolve``, and the release equivalent is
``ReleaseService.resolve``; the two name rules are opposites and live beside the
indexes that enforce them.

**Batches, jobs and assets are addressed by id and nothing else.** A batch has a
name but it is not unique, so resolving one by name would have to pick, and
picking is worse than refusing.

A malformed id is Click's refusal at **exit 2**, not a kernel ``*NotFound`` at
exit 1: the same call the API makes, where a malformed UUID is 422 rather than
404. That is why the id-only parameters are typed ``UUID``.
"""

from __future__ import annotations

from typing import Annotated

import typer

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
