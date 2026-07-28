"""Console script entry point: `visionset` (see [project.scripts] in pyproject.toml)."""

from __future__ import annotations

from typing import Annotated

import typer

from visionset import __version__
from visionset.cli.tokens import token_app

app = typer.Typer(
    name="visionset",
    help="Robomous VisionSet — local-first dataset creation for computer vision.",
    no_args_is_help=True,
)
app.add_typer(token_app, name="token")


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
def ui() -> None:
    """Start the VisionSet server and open the UI (stub)."""
    typer.echo("server would start here")


@app.command()
def mcp() -> None:
    """Start the MCP server on stdio (stub)."""
    typer.echo("server would start here")
