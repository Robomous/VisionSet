# usage: from visionset.cli._errors import domain_errors
"""What a kernel refusal looks like at a terminal: one sentence, and an exit code.

The CLI's half of the contract ``server/errors.py`` keeps over HTTP, and
deliberately much smaller. A REST client branches on a machine-readable ``code``
because it is a program; a shell branches on zero versus non-zero, and a person
reads the sentence. So there is **one** non-zero code for the whole
``VisionSetError`` family rather than a table mapping each error to its own — a
second public contract to keep in sync with ``ERROR_RULES`` for a distinction no
caller makes. If a command ever needs "not found" told apart from "refused" by
exit status, the table goes here, beside the constant.

Three exit codes, and no others:

=====  =========================================================================
    0  the command did what it said
    1  a ``VisionSetError`` — one sentence on stderr, no traceback
    2  a usage error, raised and formatted by Click itself
=====  =========================================================================

**Nothing here prints to stdout.** Stdout is the command's *output* — the secret
from ``token create``, the rows from ``token list`` — so that redirecting it
captures data and nothing else.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Final

import typer

from visionset.kernel import (
    DestructiveSchemaChange,
    LossyExportNotConsented,
    NotAWorkspace,
    SchemaChangeWouldOrphan,
    VisionSetError,
)
from visionset.kernel.services import WORKSPACE_ENV_VAR

EXIT_DOMAIN_ERROR: Final = 1
"""Every ``VisionSetError``. See the module docstring for why it is not a table."""

EXIT_ANSWER_IS_NO: Final = 1
"""A command that asked a question and got "no" — ``release verify`` on damage.

The **same number** as ``EXIT_DOMAIN_ERROR``, and named separately so that the
second meaning is written down rather than inferred from a literal. This is
``grep``'s and ``diff``'s convention, and it is the only way a script can branch
on the answer without grepping the output — which is exactly the coupling
``--json`` exists to avoid. It does not stretch the contract: such a command
still prints one sentence on stderr and no traceback, which is what code 1 has
always described.

Merging the two constants would lose the distinction the day a caller wants
"could not check" told apart from "checked, and it is broken"; splitting the
*values* would mean a shell had to learn a table to answer "did that work?".
"""

_HINTS: Final[dict[type[BaseException], str]] = {
    # The kernel's sentence ends in "use WorkspaceService.init to create one",
    # which is a Python API a person at a terminal has no way to call. Rewriting
    # it in the kernel would bend a domain message toward one surface; a second
    # line here is the surface adding its own remedy, which is what a surface is
    # for.
    NotAWorkspace: f"Point at one with --workspace, or set {WORKSPACE_ENV_VAR}.",
    # The kernel's sentence says "re-run with allow_lossy", which is the *service*
    # parameter — a person at a terminal types `--allow-lossy`, and no amount of
    # reading the message tells them so. It also names the one command that
    # answers the question the refusal raises and the message cannot: the refusal
    # carries the report, and nothing on stderr prints it.
    LossyExportNotConsented: (
        "Re-run with --allow-lossy to accept the loss, or with --check to see "
        "exactly what it costs, class by class."
    ),
    # The kernel's sentence says "pass allow_destructive=True", which is the
    # *service* keyword — a person at a terminal types `--allow-destructive`, and
    # no amount of reading the message tells them so. `LossyExportNotConsented`
    # exactly, one refusal over.
    DestructiveSchemaChange: (
        "Re-run with --allow-destructive if narrowing the schema is what you meant."
    ),
    # The opposite hint, and the reason it is worth its own entry: this refusal
    # has **no** flag. Without a line saying so, the neighbouring
    # `--allow-destructive` reads as the obvious next thing to try — and it is
    # precisely the loop `SchemaChangeWouldOrphan` is declared outside
    # `DestructiveSchemaChange`'s hierarchy to prevent. The message already names
    # the classes and their counts; what it cannot say is that there is nothing
    # to pass.
    SchemaChangeWouldOrphan: (
        "There is no flag for this one. Delete or relabel those annotations "
        "first, or keep the class and change something else."
    ),
}
"""A remedy a *terminal* can act on, printed under the error's own sentence.

Walked by MRO, like ``server/errors.py`` walks ``ERROR_RULES``, so a subclass
inherits its nearest ancestor's hint. Sparse on purpose: most kernel messages
already carry their own remedy, and a hint that restates the message is noise.
"""


def _hint_for(exc: VisionSetError) -> str | None:
    for cls in type(exc).__mro__:
        hint = _HINTS.get(cls)
        if hint is not None:
            return hint
    return None


@contextmanager
def domain_errors() -> Iterator[None]:
    """Turn any kernel refusal into a readable line and a non-zero exit.

    ``typer.Exit`` rather than ``sys.exit``: Click catches it and ``CliRunner``
    records it as ``result.exit_code``, which is what makes the exit status
    assertable from a test instead of only from a subprocess.

    **Only ``VisionSetError`` is caught.** An ``OSError``, a ``KeyboardInterrupt``
    or a bug is not a refusal the CLI understands, and folding one into
    ``Error: [Errno 2] ...`` would hide the traceback that identifies it.
    """
    try:
        yield
    except VisionSetError as exc:
        typer.secho(f"Error: {exc}", err=True, fg=typer.colors.RED)
        hint = _hint_for(exc)
        if hint is not None:
            typer.echo(hint, err=True)
        raise typer.Exit(code=EXIT_DOMAIN_ERROR) from exc
