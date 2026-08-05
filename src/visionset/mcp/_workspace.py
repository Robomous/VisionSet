# usage: from visionset.mcp._workspace import opened_workspace
"""Which workspace the tools operate on, and how long it stays open.

The rule is the kernel's (``resolve_workspace_root``) and this module is the MCP
surface's half of it — which is nothing but the ``with`` block, because there is
no flag to feed it.

**No tool takes a ``workspace`` parameter.** Threading one through every
tools would put a path an agent has no way to know into every call, and an agent
that guessed wrong would be writing into a workspace nobody pointed it at. The
answer comes from the environment instead: an MCP client names the server in its
own configuration and sets ``VISIONSET_WORKSPACE`` there, which is what
``visionset mcp --workspace`` does on its behalf. That lands every server on
precedence branch 2, or on branch 3's upward walk from whatever directory the
client happened to spawn it in.

**The workspace is opened per call and closed again**, unlike the HTTP server,
which builds one handle in ``create_app()`` and keeps it. Three reasons, and the
first is the one that decided it:

1. There is no module-level mutable state, so every tool is testable in isolation
   with nothing but ``monkeypatch.setenv`` — where a process-lifetime handle
   would have to be torn down between tests and would leak a workspace into the
   next module when a test forgot.
2. SQLite has one writer. A stdio server that held the file between calls would
   keep ``visionset server`` and a second agent out of a workspace nobody is using.
3. ``close()`` checkpoints the WAL, so a client that disappears mid-session
   leaves no ``visionset.db-wal`` behind.

What it costs is a file open and a migration check per call, which is the same
work ``visionset`` does per command.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from visionset.kernel.services import WorkspaceService, resolve_workspace_root


@contextmanager
def opened_workspace() -> Iterator[WorkspaceService]:
    """The configured workspace, open for the length of the body.

    Closes on the way out, including when the body raised. Refusals from the
    open itself — ``NotAWorkspace``, ``WorkspaceCorrupt``,
    ``WorkspaceFormatTooNew`` — travel to the caller as the ordinary error
    envelope, because ``guarded`` wraps the whole tool and not just its middle.
    """
    workspace = WorkspaceService.open(resolve_workspace_root())
    try:
        yield workspace
    finally:
        workspace.close()
