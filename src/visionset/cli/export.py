# usage: from visionset.cli.export import export
"""``visionset export`` — a release, an installed format, a directory.

The kernel takes a plugin instance; it does not find one. ``ReleaseService.export``
is handed an ``Exporter``, because import-linter forbids ``visionset.kernel``
importing ``visionset.formats`` — a plugin registry is discovery at runtime, and
the kernel is the part that must not do any. So resolving a *name* to a plugin is
the surface's job, and this module does it the one supported way:
``formats.registry.exporter(name)``, never a dict lookup, because a ``KeyError``
is outside the ``VisionSetError`` tree and would answer a typo with a traceback.

**``--allow-lossy`` is a third gate word, never folded into ``--yes``.** ``--yes``
guards destroying data and ``--allow-destructive`` guards narrowing a contract;
this guards emitting an incomplete *copy* of something that stays intact. Whether
a format is lossy is declared by the format, once, by whoever knows what it can
express — not asked per release, which would give a different answer as the data
drifts.

The destination is the caller's. It is created if missing and **never emptied**,
so a second export into the same directory leaves the first run's files there and
the counts describe the directory afterwards rather than this run alone.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from visionset import wire
from visionset.cli._output import JsonOption, document, note
from visionset.cli._resolve import ProjectOption, resolve_release
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.formats.registry import exporter
from visionset.kernel.services import ReleaseService


def export(
    project: ProjectOption,
    release: Annotated[str, typer.Option("--release", help="The release tag.")],
    # ``format_name``, not ``format``: the builtin would be shadowed for the rest
    # of the module. Typer takes the flag's spelling from the option, not the
    # parameter, so ``--format`` is unaffected.
    format_name: Annotated[
        str, typer.Option("--format", "-f", help="An installed exporter's name.")
    ],
    out: Annotated[
        Path,
        typer.Option(
            "--out",
            "-o",
            file_okay=False,
            help="Where to write. Created if missing; never emptied.",
        ),
    ],
    allow_lossy: Annotated[
        bool,
        typer.Option(
            "--allow-lossy",
            help="Accept a format that cannot carry everything the release holds.",
        ),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Write a release out in an installed format.

    `visionset format list` says which formats are installed. A name that is not
    among them is refused with the list, at exit 1.
    """
    with opened_workspace(workspace) as service:
        # Inside the block on purpose: ``ExportFormatNotFound`` is a
        # ``VisionSetError`` naming every installed format, and ``opened_workspace``
        # is what turns it into one sentence and exit 1.
        plugin = exporter(format_name)
        found = resolve_release(service, project, release)
        result = ReleaseService(service).export(found.id, plugin, out, allow_lossy=allow_lossy)
    if json_out:
        document(wire.export_result(result))
        return
    note(
        f"Exported {found.tag!r} as {result.format_name}: "
        f"{result.file_count} file(s), {result.total_bytes} byte(s)."
    )
    typer.echo(str(result.directory))
