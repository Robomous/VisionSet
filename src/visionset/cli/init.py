# usage: from visionset.cli.init import init
"""``visionset init`` — make a workspace, which every other command needs.

Every other command takes a workspace that already exists, and finds it through
``resolve_workspace_root``. This one names where to *make* one, and that is why
it is the single command with no ``--workspace``: a positional ``PATH`` reads
correctly, and **nothing here walks upward**. Trading a stated directory for its
parent is how a workspace gets created in the wrong place — the argument that
kept the upward walk off the flag and the environment variable in the first
place, applied to the one operation where it would be irreversible.

It does not reuse ``opened_workspace()`` either, which opens an *existing*
workspace. It needs ``domain_errors()`` on its own, and a ``close()`` in a
``finally``, because ``init`` hands back a workspace that is **open** and a
process that leaves one open strands ``visionset.db-wal`` beside it.

**The root goes to stdout, alone**, on ``token create``'s rule: it is this
command's one piece of data, so ``WS=$(visionset init ./datasets)`` is exactly the
path and the two "what next" lines still reach the person on stderr. The path
printed is the *resolved* one, which is the useful answer — ``init .`` prints
where "." actually was.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from visionset.cli._errors import domain_errors
from visionset.cli._output import note
from visionset.kernel.services import WorkspaceService


def init(
    path: Annotated[
        Path,
        typer.Argument(help="Where to create the workspace. Created if missing."),
    ] = Path(),
    name: Annotated[
        str | None,
        typer.Option("--name", help="The workspace's name. Defaults to the directory's own."),
    ] = None,
) -> None:
    """Create a workspace here, or at PATH.

    The directory may be missing or empty; anything else is refused, so a typo
    can never turn somebody's home directory into a workspace. Creating one where
    a workspace already sits is refused too — the remedy is to use it, not to
    make a second.
    """
    with domain_errors():
        workspace = WorkspaceService.init(path, name=name)
        try:
            root = workspace.root
            created = workspace.workspace.name
        finally:
            workspace.close()
    note(f"Created workspace {created!r} at {root}.")
    typer.echo(str(root))
    note("Next: visionset token create --name <name>, then visionset ui.")
