# usage: from visionset.cli.targets import target_app
"""``visionset target`` — which models this installation can export a release for.

The trainer's view of ``visionset format``: every installed format declares the
targets it writes for, and this lists them flattened, each with the format it
resolves to. Like ``format list`` it opens no workspace, because what is
installed is a fact about the process rather than about any dataset — and it
exists for the same reason: the valid values of ``export --target`` depend on
what somebody installed.
"""

from __future__ import annotations

from typing import Final

import typer

from visionset import wire
from visionset.cli._output import JsonOption, document, note, table
from visionset.formats import registry

target_app = typer.Typer(
    help="Inspect the models a release can be exported for.", no_args_is_help=True
)

_COLUMNS: Final = ("NAME", "LABEL", "FAMILY", "FORMAT", "TASKS", "GEOMETRIES")


@target_app.command("list")
def target_list(json_out: JsonOption = False) -> None:
    """List the export targets, by name, with the format each resolves to."""
    rows = wire.export_targets(registry.exporters())
    if json_out:
        document(wire.page(rows))
        return
    table(
        _COLUMNS,
        [
            (
                str(row["name"]),
                str(row["label"]),
                str(row["family"]),
                str(row["format"]),
                ",".join(row["tasks"]),
                ",".join(row["geometries"]),
            )
            for row in rows
        ],
    )
    if not rows:
        note("No export targets are installed.")
