"""Console script entry point: `visionset` (see [project.scripts] in pyproject.toml)."""

from __future__ import annotations

from typing import Annotated

import typer

from visionset import __version__

app = typer.Typer(
    name="visionset",
    help="Robomous VisionSet — local-first dataset creation for computer vision.",
    no_args_is_help=True,
)
token_app = typer.Typer(help="Manage API tokens.", no_args_is_help=True)
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


@token_app.command("create")
def token_create(
    name: Annotated[str, typer.Option("--name", help="Human-readable token name.")],
) -> None:
    """Issue an API token (stub — see issue #26).

    Persistence landed with the kernel's ``TokenService``; wiring this command to
    it needs workspace resolution, which issue #26 owns along with ``token list``
    and ``token revoke``.

    Until then this refuses rather than printing something. It used to echo a
    plausible ``vst_...`` string that was never stored — harmless while nothing
    could authenticate, and actively misleading now that real tokens exist and
    that one would not be among them.
    """
    typer.echo(f"Cannot issue token {name!r} yet: the CLI has no workspace to write it to.")
    typer.echo("Token issuance lands in issue #26 (visionset token create/list/revoke).")
    raise typer.Exit(code=1)
