# usage: from visionset.server.session import COOKIE_NAME, issue, presented, secret_for
"""The browser session: how the page this server served proves it is that page.

A workspace API token is the right credential for a *program* — another machine,
an agent, a script somebody wrote. It is the wrong one for the browser this
server just handed a bundle to, and asking for one there is what made the first
thing anybody saw a login form for their own files on their own disk.

So the server issues its own page a credential instead of demanding one. The
whole mechanism is a cookie handed out by ``GET /session``, and one extra place
:func:`~visionset.server.dependencies.require_token` is willing to look.

**Why a route rather than a ``Set-Cookie`` on the page itself.** Attaching it to
``/ui/`` is what #179 described, and it works in exactly one of the three
topologies this project ships. The compose stack's API never serves the bundle at
all — vite does, and nginx puts them on one origin — so a cookie set while
serving ``index.html`` would never be set there, and the docker half of #179's own
acceptance criteria could not pass. One route is asked for the credential by the
page after it loads, which is identical in all three, and costs one request on a
cold start. It is deliberately **not** a login endpoint: it trades nothing, takes
no input, and cannot be talked into issuing a session to a client that was not
already going to be given one.

**This does not lower the floor, and in one respect raises it.** The token it
replaces lived in ``sessionStorage``, which any script on the page can read; a
``HttpOnly`` cookie is one no script can. And ``SameSite=Strict`` means the
credential is never attached to a cross-site request at all — which closes, on
purpose, the one hole the absence of CORS leaves open by accident: a JSON body or
a ``DELETE`` provokes a preflight that fails, but ``POST /sources/images`` is
``multipart/form-data``, a CORS-simple request that needs no preflight, so a page
nobody here wrote could otherwise push files into a workspace.

**It is deliberately not a row in the token table.** ``visionset token list`` is
the list of credentials somebody minted for something, and a browser session is
not one of those: it should not be offered to an agent, it does not want a name,
and it is revoked by deleting a file rather than by a command. Keeping it out
also keeps ``TokenService`` honest — every row there was created by an explicit
act.

**It is a file rather than a process-local secret** because ``--reload`` restarts
the process on every edit, and a secret that died with it would sign a developer
out every time they saved. Server-owned workspace state, the posture ``uploads/``
and ``exports/`` already have; ``WorkspaceService.open`` requires only
``visionset.db``, so nothing in the kernel knows or cares that this file exists.
"""

from __future__ import annotations

import os
import secrets
from enum import StrEnum
from ipaddress import ip_address
from pathlib import Path
from typing import Final

from starlette.requests import Request
from starlette.responses import Response

from visionset.kernel.services import resolve_workspace_root

COOKIE_NAME: Final = "visionset_session"
"""The cookie the browser sends back. Not a token, and named so it does not read
like one in a request log."""

SESSION_FILENAME: Final = ".ui-session"
"""Where the secret is kept, inside the workspace it authenticates."""

MODE_ENV_VAR: Final = "VISIONSET_UI_SESSION"
"""Which clients may be issued a session. See :class:`SessionMode`."""

_SECRET_BYTES: Final = 32
"""256 bits from ``secrets.token_urlsafe``, the size ``TokenService`` mints."""


class SessionMode(StrEnum):
    """Who is allowed to be handed a browser session.

    A ``StrEnum`` rather than a bool because there are genuinely three answers and
    the third is not a corner case: a server behind a reverse proxy never sees a
    loopback peer, because the peer is the proxy.
    """

    AUTO = "auto"
    """A loopback peer that also *addressed* us as loopback. The default, and what
    makes ``--host 0.0.0.0`` safe without a second decision: a client on the LAN is
    not loopback, is issued nothing, and still needs a token somebody minted on
    purpose. Both halves are required — see
    :func:`_addressed_as_this_machine` for the attack the peer check alone does not
    stop."""

    ALWAYS = "always"
    """Every client. For a deployment whose front door is a proxy — the compose
    stack, where nginx is the peer and no request ever arrives from loopback.

    It gives up both checks, so the front door has to be the thing that is
    trusted: the port that reaches this server must not be open to the world,
    which is why the compose file publishes on ``127.0.0.1`` in the same breath as
    setting this."""

    NEVER = "never"
    """Nobody. The browser is treated like any other client and must present a
    token."""


def mode() -> SessionMode:
    """Read the mode from the environment, defaulting to the strict one.

    An unrecognised value is ``AUTO`` rather than an error: this is read while
    answering a request, and a typo in an environment variable should narrow what
    the server hands out, never take the server down.
    """
    raw = os.environ.get(MODE_ENV_VAR, "").strip().lower()
    return SessionMode(raw) if raw in set(SessionMode) else SessionMode.AUTO


def _is_loopback(host: str | None) -> bool:
    """Whether an address is this machine talking to itself.

    Parsed rather than compared against a list of spellings: ``127.0.0.1`` is one
    address out of a whole ``/8``, and ``::1`` has more than one way to write it.
    An unparseable or absent peer — which is what a test client and some ASGI
    servers report — is **not** loopback, so the strict answer is the default in
    the case nobody thought about.
    """
    if host is None:
        return False
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def _addressed_as_this_machine(request: Request) -> bool:
    """Whether the browser reached us by a name that means *this machine*.

    **This is the DNS-rebinding defence, and without it the peer check is not
    one.** A page on ``evil.com`` can point that name at ``127.0.0.1`` and then
    make requests to it: the connection is genuinely from loopback, so the peer
    address says yes — and because the browser considers the site to be
    ``evil.com`` throughout, ``SameSite=Strict`` says yes too. Both of the
    protections this module leans on are satisfied by an attack neither was
    looking at. What the attacker cannot forge is the ``Host`` header, because
    the browser sets it from the name in the address bar.

    So a session is issued only to ``localhost``, a loopback literal, or a
    ``*.localhost`` subdomain, which browsers resolve to loopback themselves.
    This is the same list Jupyter keeps for the same reason, and it is why
    reaching a loopback server by a machine name or a ``/etc/hosts`` alias asks
    for a token: that request is indistinguishable from the attack.
    """
    hostname = request.url.hostname
    if hostname is None:
        return False
    name = hostname.strip("[]").lower()
    return name == "localhost" or name.endswith(".localhost") or _is_loopback(name)


def eligible(request: Request) -> bool:
    """Whether this request may be handed a session cookie."""
    match mode():
        case SessionMode.NEVER:
            return False
        case SessionMode.ALWAYS:
            return True
        case SessionMode.AUTO:
            return _is_loopback(
                request.client.host if request.client else None
            ) and _addressed_as_this_machine(request)


def workspace_root() -> Path | None:
    """Where this server's workspace is, **without opening it**.

    The resolver is pure path arithmetic — an environment variable and an upward
    walk — so asking it costs nothing and, more importantly, opens no database.
    That matters twice. ``GET /session`` is public and unauthenticated, and a
    public route that opens a workspace is a public route that can be made to
    answer 500 ``NOT_A_WORKSPACE`` — or to run a migration — by anyone who can
    reach the port. And ``require_token`` must not acquire a dependency on the
    workspace, or a test overriding authentication alone would start needing one.

    ``None`` when there is no directory to keep a secret in, which is the same
    answer as "no session is possible here".
    """
    root = resolve_workspace_root()
    return root if root.is_dir() else None


def secret_for(root: Path) -> str:
    """The workspace's browser-session secret, created on first use.

    Written ``0600`` and created with ``O_EXCL`` — not because a race is likely
    with one server per workspace, but because the alternative is a window in
    which the file exists and is world-readable, and the cost of closing it is
    one flag. A lost race reads the winner's secret rather than raising: both
    processes then agree, which is the outcome anybody wanted.
    """
    path = root / SESSION_FILENAME
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        existing = ""
    if existing:
        return existing

    minted = secrets.token_urlsafe(_SECRET_BYTES)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return path.read_text(encoding="utf-8").strip()
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(minted)
    return minted


def presented(request: Request) -> str | None:
    """The session secret this request carries, if it carries one."""
    return request.cookies.get(COOKIE_NAME)


def issue(request: Request, response: Response) -> bool:
    """Attach the session cookie to a response, when the client may have one.

    Returns whether it did, which is what the route reports back — a browser that
    was refused should stop waiting and show the token form rather than send a
    request it already knows will be a 401.

    ``secure`` follows the scheme rather than being set unconditionally: a
    ``Secure`` cookie is dropped by the browser over plain http, which is every
    loopback deployment there is, so hardcoding it would mean the cookie is set,
    ignored, and the login form appears anyway with nothing in the logs to say
    why.

    No ``max_age``: it is a session cookie, and closing the browser ending the
    session is the behaviour ``sessionStorage`` already had.
    """
    root = workspace_root()
    if root is None or not eligible(request):
        return False
    response.set_cookie(
        COOKIE_NAME,
        secret_for(root),
        httponly=True,
        samesite="strict",
        secure=request.url.scheme == "https",
        path="/",
    )
    return True
