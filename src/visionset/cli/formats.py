# usage: from visionset.cli.formats import format_app
"""``visionset format`` — which exporters this installation actually has.

One command, and the only one besides ``init`` and ``--version`` that opens no
workspace: plugins are discovered from installed distributions through
``importlib.metadata``, which is a fact about the process rather than about any
dataset. Running it outside a workspace works, and that is the point — you ask
what is available *before* choosing an ``--format``.

It earns a command because the valid values of ``export --format`` depend on what
somebody installed, and without this the only way to find out is to guess and
read the refusal.

``lossy`` is declared by the format itself. A lossy exporter is not broken; it is
one whose file layout cannot express everything a release can hold — a bbox-only
format asked for a polygon — and ``export`` refuses it until ``--allow-lossy``.
"""

from __future__ import annotations

from typing import Final

import typer

from visionset import wire
from visionset.cli._output import JsonOption, document, note, table
from visionset.formats.registry import exporters

format_app = typer.Typer(help="Inspect installed export formats.", no_args_is_help=True)

_COLUMNS: Final = ("NAME", "LOSSY")


@format_app.command("list")
def format_list(json_out: JsonOption = False) -> None:
    """List the installed exporters, by name."""
    found = exporters()
    installed = [found[name] for name in sorted(found)]
    if json_out:
        document(wire.page([wire.export_format(p) for p in installed]))
        return
    table(_COLUMNS, [(p.format_name, "yes" if p.lossy else "no") for p in installed])
    if not installed:
        note("No exporters are installed.")
