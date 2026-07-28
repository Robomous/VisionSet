# usage: from visionset.cli._workspace import WorkspaceOption, opened_workspace
"""Which workspace a command operates on, and its lifetime inside that command.

The **rule** lives in the kernel (``resolve_workspace_root``); this module is the
CLI's half of it — the flag that feeds the rule, and the ``with`` block that opens
and closes what it names. The rule cannot live here: import-linter forbids
``visionset.server`` importing ``visionset.cli``, and the server needs the same
answer.

``--workspace`` is declared **per command** rather than on the root callback, and
that is a Click fact rather than a preference. A group's parser stops at the first
non-option token, so an option on ``@app.callback()`` must *precede* the
subcommand: ``visionset --workspace X token create --name ci`` would work and
``visionset token create --name ci --workspace X`` would fail with "No such
option". Nobody types the first one. The alias below is how one flag is declared
once and still belongs to every command that needs it.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated

import typer

from visionset.cli._errors import domain_errors
from visionset.kernel.services import WORKSPACE_ENV_VAR, WorkspaceService, resolve_workspace_root

WorkspaceOption = Annotated[
    Path | None,
    typer.Option(
        "--workspace",
        "-w",
        help=(
            f"The workspace to operate on. Defaults to ${WORKSPACE_ENV_VAR}, then to "
            "the nearest workspace at or above the working directory."
        ),
        # No ``envvar=``. Click would read the variable itself and hand the
        # command a path indistinguishable from this flag — and the flag and the
        # variable are deliberately not the same case: neither walks upward, but
        # only one of them is what the resolver's precedence calls "explicit".
        # One function owns precedence; this is only how a path gets typed.
        #
        # No ``exists=True`` either. A Click path check exits 2 in Click's
        # wording, where the useful answer is ``NotAWorkspace``'s sentence and
        # its hint at exit 1.
    ),
]
"""``--workspace`` / ``-w``, for a command that needs an open workspace.

Module-level so that ``get_type_hints`` resolves it in the importing module's
globals under ``from __future__ import annotations``; an alias built inside a
function body would not resolve.
"""


@contextmanager
def opened_workspace(explicit: Path | None = None) -> Iterator[WorkspaceService]:
    """The workspace this command was pointed at, open for the length of the body.

    Closes on the way out, including when the body raised. A process that exits
    without checkpointing leaves ``visionset.db-wal`` beside the workspace for
    the next reader to recover, and a CLI runs often enough for that to matter.

    Domain errors from **both** the open and the body become one line on stderr
    and exit 1. ``close`` runs first, so the message is printed against a
    workspace that is already released.
    """
    with domain_errors():
        workspace = WorkspaceService.open(resolve_workspace_root(explicit))
        try:
            yield workspace
        finally:
            workspace.close()
