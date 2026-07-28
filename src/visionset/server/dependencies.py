# usage: from visionset.server.dependencies import WorkspaceDep, protected_router
"""What every route is handed: the workspace it serves, and who is allowed in.

A module of its own rather than more of ``main.py``, and the reason is a cycle
rather than tidiness. Routes will live in their own modules and must import
``require_token``; ``main`` must import those modules to ``include_router`` them.
Put the dependencies in ``main`` and the arrow points both ways.

**The server serves exactly one workspace.** It is opened lazily, on the first
request that needs it, and kept for the life of the application — never at import
time, because ``scripts/export_openapi.py`` imports the module-level ``app`` in a
checkout that has no workspace, and CI runs it on every push.

**Every dependency here is ``def``, not ``async def``.** Opening a workspace and
verifying a token are blocking SQLite calls; an ``async def`` dependency runs on
the event loop and would stall it. A sync one gets the threadpool hop FastAPI
already gives sync routes, which is what the synchronous kernel wants anyway.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Annotated, Final

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.requests import Request

from visionset.kernel.ports import AuthProvider
from visionset.kernel.services import WorkspaceService
from visionset.server.errors import ERROR_RESPONSES

WORKSPACE_ENV_VAR: Final = "VISIONSET_WORKSPACE"
"""Which workspace this server serves.

Not a server-specific name on purpose: the CLI writes the tokens the server
reads, so the two have to agree on one spelling of "the workspace".
"""

bearer_scheme: Final = HTTPBearer(
    auto_error=False,
    description=(
        "A workspace API token, created with `visionset token create`. "
        "Sent as `Authorization: Bearer <token>`."
    ),
)
"""The one security scheme in the contract.

``auto_error=False`` so that a missing header, an empty credential and a
non-bearer scheme all arrive here as ``None`` and leave as the *same* 401 that an
unknown token gets. With ``auto_error=True`` FastAPI would raise its own
403-or-401 before ``require_token`` ran, and the three cases would be
distinguishable from outside — an oracle for nothing anybody needs to know.

It only reaches ``components.securitySchemes`` when a route depends on it, which
is why declaring it costs the committed spec nothing until the first protected
route lands.
"""


def resolve_workspace_root() -> Path:
    """The workspace root this server was pointed at.

    **Provisional. Issue #26 owns the real rule** — the ``--workspace`` flag, the
    environment variable and cwd detection, with a documented precedence that
    ``visionset ui`` and the flow commands all reuse. This is the smallest thing
    #26 can promote: it already reads the variable #26 will keep, so #26 replaces
    the *body* of this function and nothing importing it changes.

    Deliberately missing until then: the flag, because a server started by import
    string has no argv of its own; and the upward walk for a ``visionset.db`` in a
    parent directory.

    A constraint #26 should not discover late: import-linter forbids
    ``visionset.server`` importing ``visionset.cli``, so the promoted resolver
    cannot live in the CLI. It belongs beside ``DB_FILENAME`` in
    ``kernel/services/workspace_service.py``, which already owns the rule that the
    database file is what marks a directory as a workspace.

    Read once per open rather than per request: the workspace is opened once.
    """
    return Path(os.environ.get(WORKSPACE_ENV_VAR) or Path.cwd())


def _open_configured_workspace() -> WorkspaceService:
    return WorkspaceService.open(resolve_workspace_root())


class WorkspaceHandle:
    """One lazily opened workspace, shared by every request of one application.

    Held on ``app.state`` rather than in a module-level cache, and that placement
    is the whole design. A ``functools.lru_cache`` here would be three lines
    shorter and would keep one SQLite connection alive for an entire pytest
    process, shared between every app any test built — so each ``create_app()``
    gets its own handle instead, and two applications never share a workspace.

    Constructing one touches no disk. Only :meth:`get` does, and only from inside
    a request.
    """

    def __init__(self, open_workspace: Callable[[], WorkspaceService] | None = None) -> None:
        self._open = open_workspace or _open_configured_workspace
        self._workspace: WorkspaceService | None = None
        # Sync dependencies run in a threadpool, so two concurrent first requests
        # would otherwise race two ``WorkspaceService.open`` calls — and the loser
        # would leak an engine nothing ever closes.
        self._lock = threading.Lock()

    @property
    def is_open(self) -> bool:
        """Whether the workspace has actually been opened yet."""
        return self._workspace is not None

    def get(self) -> WorkspaceService:
        """The open workspace, opening it on the first call.

        Raises:
            NotAWorkspace: ``VISIONSET_WORKSPACE`` does not name a workspace.
            WorkspaceCorrupt: it names one that cannot be read.
            WorkspaceFormatTooNew: it was written by a later VisionSet.
        """
        if self._workspace is None:
            with self._lock:
                if self._workspace is None:
                    self._workspace = self._open()
        return self._workspace

    def close(self) -> None:
        """Release the workspace if one was ever opened. Safe to call twice."""
        workspace, self._workspace = self._workspace, None
        if workspace is not None:
            workspace.close()


def get_workspace(request: Request) -> WorkspaceService:
    """The workspace this application serves.

    Yields the *service*, never a unit of work: a transaction committed in a
    dependency's teardown fails after the response has started, which turns a
    ``WorkspaceBusy`` into ``RuntimeError: response already started`` instead of
    an ``ErrorBody``. See ``docs/api.md``.
    """
    handle: WorkspaceHandle = request.app.state.workspace_handle
    return handle.get()


def get_auth_provider(
    workspace: Annotated[WorkspaceService, Depends(get_workspace)],
) -> AuthProvider:
    """Whoever decides whether a token may operate this workspace.

    Its own dependency rather than an attribute read inside ``require_token``,
    because this is the seam a test overrides: ``app.dependency_overrides`` reach
    every sub-dependency recursively, so replacing this replaces authentication
    everywhere without a probe application.
    """
    return workspace.auth_provider


def require_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    auth_provider: Annotated[AuthProvider, Depends(get_auth_provider)],
) -> str:
    """Refuse the request unless it carries a live token of this workspace.

    Missing, malformed, unknown and revoked are **one** answer, deliberately: a
    401 that distinguished them would let anyone enumerate which credentials
    exist. The ``HTTPException`` is rendered as an ``ErrorBody`` by the handlers
    ``create_app`` installs, ``headers`` included — which is what keeps the
    ``WWW-Authenticate`` challenge on the response.
    """
    if credentials is None or not auth_provider.verify(credentials.credentials):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return credentials.credentials


WorkspaceDep = Annotated[WorkspaceService, Depends(get_workspace)]
"""The workspace, for a route that needs to build a service over it."""

TokenDep = Annotated[str, Depends(require_token)]
"""The presented token, for the rare route that needs the credential itself.

A route on a :func:`protected_router` is already guarded; this is only for one
that wants to *read* what it was given.
"""


def protected_router(*, prefix: str = "", tags: Sequence[str] | None = None) -> APIRouter:
    """A router whose every route requires a valid bearer token.

    The guard and the documented 401 travel together because a route that
    declares one without the other is a lie in ``openapi.json`` either way. Build
    every non-public router with this rather than repeating
    ``Depends(require_token)`` per route: "everything except ``/health``" should
    be a property of how routers are constructed, not a thing each reviewer has to
    notice.

    401 is deliberately **not** in ``UNIVERSAL_ERROR_RESPONSES`` and must not be
    added to it — ``/health`` is public and cannot 401 — and the guard is on the
    router rather than on the application for the same reason.
    """
    return APIRouter(
        prefix=prefix,
        # ``list[str | Enum]`` is what APIRouter declares and ``list`` is
        # invariant, so a ``list[str]`` cannot be passed straight through.
        tags=list(tags or []),
        dependencies=[Depends(require_token)],
        responses={401: ERROR_RESPONSES[401]},
    )
