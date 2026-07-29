# usage: from visionset.cli._output import JsonOption, document, note, table
"""How a command prints: columns for a person, JSON for a program, prose to stderr.

**Stdout is data; stderr is everything a person reads.** That rule predates this
module — ``token create`` put the secret alone on stdout so
``TOKEN=$(visionset token create --name ci)`` is exactly the secret — and this is
where it becomes the same three functions for every command. :func:`table` and
:func:`document` write to stdout and nothing else does; :func:`note` writes to
stderr and never competes with them.

``--json`` is declared **per command**, not on the root callback, for the identical
Click reason ``--workspace`` is (see ``_workspace.py``): a group's parser stops at
the first non-option token, so an option on ``@app.callback()`` would have to
*precede* the subcommand — ``visionset --json project list`` would work and
``visionset project list --json`` would fail with "No such option". Nobody types
the first one.

**Plain columns, never ``rich.table``.** Box drawing pads to ``$COLUMNS`` and
wraps, which makes output width-dependent and neither testable nor ``cut``-able.
The header prints even when there are no rows, so ``| tail -n +2`` is stable, and
**the first column of every listing is the id**, so ``awk '{print $1}'`` is stable
too — a name may hold internal whitespace, because ``normalize_name`` strips the
outside and deliberately preserves the middle.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Annotated, Any, Final

import typer

JsonOption = Annotated[
    bool,
    typer.Option("--json", help="Print one JSON document on stdout instead of columns."),
]
"""``--json``, for a command whose output a program might read.

Module-level so that ``get_type_hints`` resolves it in the importing module's
globals under ``from __future__ import annotations`` — the same constraint that
puts ``WorkspaceOption`` at module level. Bound to a parameter named ``json_out``
rather than ``json``, which would shadow the module every caller imports.
"""

TIMESTAMP_FORMAT: Final = "%Y-%m-%dT%H:%M:%SZ"
"""Seconds, UTC, no offset. A listing is read by a person; microseconds are not.

Deliberately **not** the format ``_json.py`` uses. That one has to agree with
pydantic's, because the JSON shapes are gated against the server's wire models;
this one has to be readable in a column. Sharing them would break the parity gate
in a way key-set comparison cannot see.
"""

NEVER: Final = "-"
"""What a column shows for a timestamp that has not happened."""


def moment(when: datetime | None) -> str:
    """A timestamp as a column shows it."""
    return NEVER if when is None else when.astimezone(UTC).strftime(TIMESTAMP_FORMAT)


def widths(columns: Sequence[str], rows: Sequence[Sequence[str]]) -> list[int]:
    """How wide each column has to be to hold its header and every cell."""
    return [max([len(header), *(len(row[i]) for row in rows)]) for i, header in enumerate(columns)]


def row(cells: Sequence[str], column_widths: Sequence[int]) -> str:
    """One line of a table: cells left-justified, two spaces apart, no trailing pad.

    ``strict=True`` on the zip is the guard: a row with the wrong number of cells
    raises here rather than silently losing its last column.
    """
    return "  ".join(
        cell.ljust(width) for cell, width in zip(cells, column_widths, strict=True)
    ).rstrip()


def table(columns: Sequence[str], rows: Sequence[Sequence[str]]) -> None:
    """Print a listing on stdout, header first, even when there are no rows."""
    column_widths = widths(columns, rows)
    typer.echo(row(columns, column_widths))
    for cells in rows:
        typer.echo(row(cells, column_widths))


def document(payload: Mapping[str, Any]) -> None:
    """Print one JSON document on stdout — the whole of ``--json``'s output.

    One document per invocation, not JSON-lines: a listing is a single value, so
    ``| jq '.items[]'`` works and a partial read is never mistaken for a whole one.

    ``json.dumps`` is called with **no** ``default=``, on purpose. A ``UUID``, a
    ``datetime`` or a ``Path`` reaching this function is a projection in ``_json``
    that forgot to encode a leaf, and that must be a ``TypeError`` a test catches
    rather than a silent ``str()`` nobody re-reads.
    """
    typer.echo(json.dumps(payload, indent=2))


def note(message: str) -> None:
    """Say something to the person, on stderr, where it survives a redirection."""
    typer.echo(message, err=True)
