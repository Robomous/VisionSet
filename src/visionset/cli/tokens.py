# usage: from visionset.cli.tokens import token_app
"""``visionset token`` — create, list and revoke a workspace's API tokens.

Thin in the sense the architecture means it: each command resolves a workspace,
calls exactly one ``TokenService`` method, and prints. The rules — names unique
per workspace, the secret shown once, revocation one-way and idempotent — are the
kernel's, and not one of them is restated here.

**Stdout is data; stderr is everything a person reads.** ``token create`` puts the
secret on stdout as the only thing on it, so ``TOKEN=$(visionset token create
--name ci)`` is exactly the secret, and puts the shown-once warning on stderr so
the warning survives the redirection that most needs it. ``token list`` does the
same with its rows.

**Neither the secret nor its digest is ever printed by ``list``.** The columns are
named one at a time rather than dumped off the model, so a field added to
``Token`` cannot appear here by accident. A digest is not a secret, but it
verifies a guess offline, and a listing that prints one teaches a habit that ends
badly.
"""

from __future__ import annotations

from typing import Annotated, Final

import typer

from visionset.cli._output import moment, note, table
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.services import TokenService

token_app = typer.Typer(help="Manage API tokens.", no_args_is_help=True)

_COLUMNS: Final = ("NAME", "CREATED", "REVOKED")
"""NAME first, unlike every other listing, which leads with an id.

Kept as it is because a token has no id a person would ever type — ``revoke``
takes the name — and moving the column would break scripts for no gain. The
consequence is that ``awk '{print $1}'`` is not safe *here*, since a token name
may hold internal whitespace; ``docs/content/cli.md`` says so where it states the
id-first rule for the flow listings.
"""


@token_app.command("create")
def token_create(
    name: Annotated[str, typer.Option("--name", help="Human-readable token name.")],
    workspace: WorkspaceOption = None,
) -> None:
    """Issue an API token and print its secret — once."""
    with opened_workspace(workspace) as service:
        issued = TokenService(service).create(name)
        root = service.root
    note(f"Created token {issued.token.name!r} in {root}.")
    typer.echo(issued.secret)
    typer.secho(
        "This secret is shown once and cannot be recovered. Store it now.",
        err=True,
        fg=typer.colors.YELLOW,
    )


@token_app.command("revoke")
def token_revoke(
    name: Annotated[str, typer.Argument(help="The token to burn.")],
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Do not ask.")] = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Burn a token. Every client holding its secret stops working.

    Resolved by name in two calls rather than by a ``revoke_by_name`` the service
    does not have: the intermediate read is what lets this print the name it
    actually matched — token names are unique case-**insensitively** — and
    short-circuit one that is already dead. The window between the two calls is
    harmless, because there is no rename and a concurrent revoke makes the second
    call a no-op.
    """
    with opened_workspace(workspace) as service:
        tokens = TokenService(service)
        token = tokens.get_by_name(name)
        if token.revoked:
            # The kernel's no-op, surfaced. Exit 0, and do not ask: a retried
            # ``token revoke ci`` must be safe, and prompting to redo something
            # already done invites a "yes" that means nothing.
            note(f"Token {token.name!r} was already revoked at {moment(token.revoked_at)}.")
            return
        if not yes:
            # ``ConfirmationRequired`` exists because the kernel has no terminal;
            # this is the CLI's idiom for asking, and ``confirm=True`` below only
            # reports that some surface did. ``abort=True`` exits non-zero on "no"
            # *and* on EOF — a destructive command that cannot ask must not act.
            typer.confirm(
                f"Revoke token {token.name!r}? Every client holding its secret stops "
                "working, and this cannot be undone.",
                abort=True,
            )
        tokens.revoke(token.id, confirm=True)
        burned = token.name
    note(f"Revoked token {burned!r}.")


@token_app.command("list")
def token_list(workspace: WorkspaceOption = None) -> None:
    """List this workspace's tokens, revoked ones included. Never their secrets."""
    with opened_workspace(workspace) as service:
        rows = [
            (token.name, moment(token.created_at), moment(token.revoked_at))
            for token in TokenService(service).list()
        ]
        root = service.root
    # The header prints whether or not there are rows, so ``| tail -n +2`` is
    # stable; the "none" note goes to stderr, where notes go.
    table(_COLUMNS, rows)
    if not rows:
        note(f"No tokens in {root}.")
