"""Console script entry point: `visionset` (see [project.scripts] in pyproject.toml)."""

from __future__ import annotations

from typing import Annotated

import typer

from visionset import __version__
from visionset.cli.tokens import token_app
from visionset.cli.ui import ui

app = typer.Typer(
    name="visionset",
    help="Robomous VisionSet — local-first dataset creation for computer vision.",
    no_args_is_help=True,
)
app.add_typer(token_app, name="token")
# Registered here rather than decorated at its definition site: a ``@app.command()``
# in ``ui.py`` would have to import this module, which imports ``ui.py``. Typer
# reads a command's annotations out of its *defining* module's globals either
# way, which is what lets the shared ``WorkspaceOption`` alias resolve there.
app.command()(ui)


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(__version__)
        raise typer.Exit()


@app.callback()
def main(
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            help="Print the version and exit.",
            callback=_version_callback,
            is_eager=True,
        ),
    ] = False,
) -> None:
    """Robomous VisionSet CLI."""


@app.command()
def mcp() -> None:
    """Start the MCP server on stdio (stub)."""
    typer.echo("server would start here")
