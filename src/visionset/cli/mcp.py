# usage: from visionset.cli.mcp import mcp
"""``visionset mcp`` — the front door for an agent: one command, the whole listing.

``ui.py``'s shape exactly, with a subprocess where that one has uvicorn, and the
same three decisions behind it.

**The server is named, never imported.** import-linter forbids ``visionset.cli``
importing ``visionset.mcp``, so the target is spelled as a module for the
interpreter to find. ``ui`` gets to hand uvicorn an import string; there is no
equivalent here, so this spawns ``python -m visionset.mcp.main`` and lets it
inherit stdin and stdout — which is the whole point, because those two streams
*are* the MCP transport. Nothing is captured, nothing is piped, and this process
does nothing but wait and pass on the exit code.

**Configuration travels by environment, because there is no other channel.** The
child takes no arguments, so the resolved workspace reaches it as
``VISIONSET_WORKSPACE``. This command applies the *full* four-branch precedence —
including the upward walk — and then **states** the answer, so the child's own
``resolve_workspace_root`` stops at branch 2 and the two cannot disagree.

**The workspace is opened and closed before the child exists.** Not a check but a
real ``open``: it runs the migration, so ``NotAWorkspace``, ``WorkspaceCorrupt``
and ``WorkspaceFormatTooNew`` land at a terminal as one sentence and exit 1 rather
than inside the agent's first tool call, where the answer is a JSON envelope
nobody is watching. Closing again matters for the same reason it does in ``ui``:
an uncheckpointed SQLite leaves ``visionset.db-wal`` behind, and the child is
about to open the file for itself.

**Nothing is printed on stdout, ever.** Stdout belongs to the JSON-RPC stream, so
a single stray line would corrupt the protocol before the first message. The
banner goes to stderr, which is where an MCP client collects a server's logs.

**A client normally spawns this itself** rather than a person running it, with
``VISIONSET_WORKSPACE`` set in the server entry's own ``env`` — see
``docs/mcp.md``. The flag is what makes the command usable by hand and testable.
"""

from __future__ import annotations

import os
import subprocess
import sys
from typing import Annotated, Final

import typer

from visionset import __version__
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.services import WORKSPACE_ENV_VAR

SERVER_MODULE: Final = "visionset.mcp.main"
"""What the child interpreter is told to run. See the module docstring for why."""

ALLOW_DESTRUCTIVE_ENV: Final = "VISIONSET_MCP_ALLOW_DESTRUCTIVE"
"""How ``--allow-destructive`` reaches the child.

A **literal**, not an import, for the same reason ``SERVER_MODULE`` above is one:
import-linter forbids ``visionset.cli`` importing ``visionset.mcp`` at all, so
this surface names its sibling by string or not at all.
``tests/cli/test_mcp_command.py`` imports both packages — a test may do what
neither package may — and asserts the two spellings agree.
"""


def mcp(
    workspace: WorkspaceOption = None,
    allow_destructive: Annotated[
        bool,
        typer.Option(
            "--allow-destructive",
            help="Also offer the tools that destroy data. Off by default.",
        ),
    ] = False,
) -> None:
    """Start the MCP server on stdio, serving this workspace to an agent.

    Speaks JSON-RPC on stdin and stdout, so run it from an MCP client rather than
    by hand. Every tool operates on the workspace resolved here, and no token is
    involved: an agent reaching this server is already inside the sandbox the
    workspace defines.

    Destructive tools — `delete_project` today — are **not offered** unless
    `--allow-destructive` is passed. A `confirm` parameter is documented in the
    same listing an agent reads before choosing, so it is an instruction rather
    than a gate; leaving the tool out of the listing is the only version of that
    gate a model cannot clear by itself. See `docs/mcp.md`.
    """
    with opened_workspace(workspace) as service:
        root = service.root
    os.environ[WORKSPACE_ENV_VAR] = str(root)
    # Stated rather than inherited, in both directions: a `1` left in the parent
    # environment must not quietly re-arm a server started without the flag.
    os.environ[ALLOW_DESTRUCTIVE_ENV] = "1" if allow_destructive else "0"

    typer.secho(f"VisionSet {__version__} — MCP server on stdio", err=True, bold=True)
    typer.echo(f"  workspace  {root}", err=True)
    typer.echo(
        f"  destructive tools  {'offered' if allow_destructive else 'not offered'}",
        err=True,
    )
    typer.echo("Press Ctrl+C to stop.", err=True)

    # `sys.executable`, not "python": a workspace's virtual environment is
    # frequently not what `python` resolves to on PATH, and the child has to be
    # the interpreter this command is already running under or it will not find
    # `visionset` at all.
    completed = subprocess.run([sys.executable, "-m", SERVER_MODULE], check=False)  # noqa: S603
    if completed.returncode:
        raise typer.Exit(code=completed.returncode)
