"""Console script entry point: `visionset` (see [project.scripts] in pyproject.toml)."""

from __future__ import annotations

from typing import Annotated

import typer

from visionset import __version__
from visionset.cli.batches import batch_app
from visionset.cli.export import export
from visionset.cli.formats import format_app
from visionset.cli.inference import inference_app
from visionset.cli.ingest import backfill_thumbnails, ingest
from visionset.cli.init import init
from visionset.cli.jobs import job_app
from visionset.cli.mcp import mcp
from visionset.cli.preprocessing import recipe_app
from visionset.cli.projects import project_app
from visionset.cli.releases import release_app
from visionset.cli.schemas import schema_app
from visionset.cli.server import server
from visionset.cli.targets import target_app
from visionset.cli.tokens import token_app

app = typer.Typer(
    name="visionset",
    help="Robomous VisionSet — local-first dataset creation for computer vision.",
    no_args_is_help=True,
)

# Registration is in cycle order — make a workspace, make a project, give it a
# schema, put images in it, work through them, publish, export — and ``--help``
# keeps it, because Typer preserves declaration order rather than sorting. It
# keeps it *within each kind*: bare commands are listed before groups, so the
# listing reads as two passes over the cycle rather than one. That is Typer's
# own layout and not worth fighting; ``docs/content/cli.md``'s synopsis is where the
# cycle is shown in one sequence.
#
# Bare commands are registered here rather than decorated at their definition
# site: a ``@app.command()`` in ``server.py`` would have to import this module,
# which imports ``server.py``. Typer reads a command's annotations out of its
# *defining* module's globals either way, which is what lets the shared ``WorkspaceOption``
# and ``JsonOption`` aliases resolve there. The name is spelled out rather than
# derived from the function, so ``backfill-thumbnails`` is not a guess.
app.command("init")(init)
app.add_typer(project_app, name="project")
app.add_typer(schema_app, name="schema")
app.command("ingest")(ingest)
app.add_typer(batch_app, name="batch")
app.add_typer(job_app, name="job")
app.add_typer(release_app, name="release")
app.command("export")(export)
app.add_typer(format_app, name="format")
app.add_typer(target_app, name="target")
app.add_typer(recipe_app, name="recipe")
app.command("backfill-thumbnails")(backfill_thumbnails)
app.add_typer(token_app, name="token")
app.add_typer(inference_app, name="inference")
app.command()(server)
app.command()(mcp)


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
