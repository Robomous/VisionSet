# usage: from visionset.cli.server import server
"""``visionset server`` — the front door: one command, the API and the app.

**The server is named, never imported.** ``uvicorn.run`` is handed the import
string ``visionset.server.main:app`` because import-linter forbids
``visionset.cli`` importing ``visionset.server``, and because ``--reload``
re-imports the application in a fresh worker *process* and so cannot be given an
object at all. The boundary and the feature want the same thing, which is why
there is no tension to manage here.

**Configuration travels by environment, because there is no other channel.**
``create_app()`` takes no parameters, and a reload worker is a different process,
so the resolved workspace reaches the server as ``VISIONSET_WORKSPACE``. This
command applies the *full* four-branch precedence — including the upward walk —
and then **states** the answer. The server's own ``resolve_workspace_root``
therefore stops at branch 2 and cannot disagree: one decision, made once, at the
surface a person is actually standing at.

**The workspace is opened and closed before uvicorn exists.** Not a check but a
real ``open``: it runs the migration, so a workspace behind the current format is
brought forward at a terminal that can print ``Error: ...`` and exit 1, rather
than inside the first HTTP request as a 500 with an incident id. ``NotAWorkspace``,
``WorkspaceCorrupt`` and ``WorkspaceFormatTooNew`` all land there. Closing again
is not politeness — an uncheckpointed SQLite leaves ``visionset.db-wal`` beside
the workspace, and the server is about to open it for itself.

**Nothing is printed on stdout.** The command has no data; the banner is prose
and goes to stderr with everything else a person reads.

**Shutdown belongs to uvicorn.** It installs its own SIGINT and SIGTERM handlers,
and the application's lifespan already stops the ingest worker and then closes the
workspace, in that order. Wrapping ``run`` in ``except KeyboardInterrupt`` here
would print over a shutdown that already worked.
"""

from __future__ import annotations

import os
from importlib import resources
from pathlib import Path
from typing import Annotated, Final

import typer
import uvicorn

from visionset import __version__
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.services import WORKSPACE_ENV_VAR

APP_IMPORT_STRING: Final = "visionset.server.main:app"
"""What uvicorn is told to import. See the module docstring for why it is a string."""

DEFAULT_HOST: Final = "127.0.0.1"
"""Loopback, not ``0.0.0.0``.

VisionSet is local-first and its tokens are minted per workspace by hand, so a
default that exposed a freshly created — and therefore un-tokened — workspace to
the local network would be a decision nobody made. ``--host 0.0.0.0`` is one flag
away, and it is what a container passes.
"""

DEFAULT_PORT: Final = 8000
"""Matches ``docker/compose.yaml`` and the base URL used throughout ``docs/content/``."""

_WILDCARD_HOSTS: Final = frozenset({"0.0.0.0", "::", ""})
"""Bind addresses that are not somewhere to browse. See :func:`_browsable`."""


def _browsable(host: str, port: int) -> str:
    """A URL somebody can paste, which is not always the address we bound.

    ``http://0.0.0.0:8000`` is what a naive banner prints and what no browser
    reliably opens. A wildcard bind includes loopback, so loopback is what gets
    advertised; an IPv6 literal gets its brackets back on the way out.
    """
    shown = "127.0.0.1" if host in _WILDCARD_HOSTS else host
    if ":" in shown:
        shown = f"[{shown}]"
    return f"http://{shown}:{port}/"


def _package_dir() -> Path:
    """The installed ``visionset`` package — the only thing ``--reload`` watches."""
    return Path(str(resources.files("visionset")))


def server(
    host: Annotated[str, typer.Option("--host", help="Address to bind.")] = DEFAULT_HOST,
    port: Annotated[int, typer.Option("--port", help="Port to bind.")] = DEFAULT_PORT,
    reload: Annotated[
        bool,
        typer.Option("--reload", help="Restart when the installed visionset package changes."),
    ] = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Serve the API and the UI from this workspace.

    The app is served at /app and the API at the root; / redirects to the app.
    A browser on this machine needs nothing: the server signs in the page it
    served. Every other client needs a token — `visionset token create`.

    No browser is opened: that is the wrong thing on a headless box or over SSH,
    which is most of where a dataset tool runs, and uvicorn.run offers no
    after-the-socket-binds callback to hang it on anyway. The URL is printed
    instead, and `--open` can be added the day somebody asks for it.
    """
    with opened_workspace(workspace) as service:
        root = service.root
    os.environ[WORKSPACE_ENV_VAR] = str(root)

    typer.secho(f"VisionSet {__version__}", err=True, bold=True)
    typer.echo(f"  workspace   {root}", err=True)
    typer.echo(f"  UI and API  {_browsable(host, port)}", err=True)
    # Named for who needs one, because the browser does not: a line reading "API
    # token" above a page that never asks for one is how somebody concludes they
    # must mint a credential before they can open their own files.
    typer.echo("  browser     signed in automatically", err=True)
    typer.echo("  API clients visionset token create --name <name>", err=True)
    typer.echo("Press Ctrl+C to stop.", err=True)

    uvicorn.run(
        APP_IMPORT_STRING,
        host=host,
        port=port,
        reload=reload,
        # Only while reloading, and that is not tidiness: uvicorn's Config logs
        # "Current configuration will not reload as not all conditions are met"
        # whenever reload_dirs is set and reload is off, which would be a warning
        # on every ordinary start. Scoped to the package because uvicorn's own
        # default is the *working directory* — and a development checkout's
        # working directory holds node_modules, .venv, and frequently the
        # workspace itself, so every SQLite write during an ingest would restart
        # the server underneath it.
        reload_dirs=[str(_package_dir())] if reload else None,
    )
