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

import logging
import secrets
import threading
from collections.abc import Callable, Mapping, Sequence
from typing import Annotated, Final

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.requests import Request

from visionset.formats.registry import exporters
from visionset.inference.registry import registered
from visionset.jobs import JobRunner
from visionset.kernel.errors import VisionSetError
from visionset.kernel.ports import AuthProvider, Exporter, Provider
from visionset.kernel.services import (
    WORKSPACE_ENV_VAR as WORKSPACE_ENV_VAR,
)
from visionset.kernel.services import (
    WorkspaceService,
)
from visionset.kernel.services import (
    resolve_workspace_root as resolve_workspace_root,
)
from visionset.server import session
from visionset.server.errors import ERROR_RESPONSES
from visionset.server.settings import job_settings

# ``WORKSPACE_ENV_VAR`` and ``resolve_workspace_root`` are re-exported above
# rather than defined here — the redundant ``as`` aliases are the explicit
# re-export form, and are what keeps the unreferenced constant off ruff's F401.
#
# The rule lives in the kernel, beside ``DB_FILENAME``: import-linter forbids
# ``visionset.server`` importing ``visionset.cli``, so the one resolver the server
# and the CLI share can live in neither of them. Both names stay importable from
# this module because this is where the server's "which workspace do I serve?"
# question is documented, and a reader of the server should not have to know the
# answer lives elsewhere.
#
# With no ``VISIONSET_WORKSPACE`` set, a server started *below* a workspace serves
# that workspace rather than answering 500 ``NOT_A_WORKSPACE``. See
# ``docs/workspaces.md`` for the precedence and for why only that case walks.

_logger: Final = logging.getLogger(__name__)

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


def _open_configured_workspace() -> WorkspaceService:
    """The workspace this server was pointed at, resolved once and opened.

    A server started by import string has no argv of its own, so it never passes
    an explicit path: the environment variable and the upward walk are the two
    branches it can reach. Read once per open rather than per request — the
    workspace is opened once.
    """
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
            NotAWorkspace: nothing resolved to a workspace — neither
                ``VISIONSET_WORKSPACE`` nor the walk up from the working
                directory found one.
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


class DispatcherHandle:
    """One lazily built dispatcher, started and stopped by the application lifespan.

    ``WorkspaceHandle``'s shape, one layer up, and lazy for the same two reasons
    plus one of its own. The shared reasons: every probe application in
    ``tests/server`` replaces ``app.state.workspace_handle`` *after*
    ``create_app`` returns, so anything that resolved a workspace during
    construction would be bound to the wrong one; and
    ``scripts/export_openapi.py`` imports the module-level ``app`` in a checkout
    where the upward walk may well find a workspace, which must not be opened by
    an import.

    Its own reason: a ``ProcessPoolExecutor`` must not exist at import time. Under
    ``spawn`` a child re-executes its parent's ``__main__``, and a pool built
    while a module is still being imported is how that turns into a second
    application inside a worker.

    **A workspace that will not open is not fatal.** ``/health`` is public and
    answers without one, and the handle below is lazy precisely so a misconfigured
    server reports ``NOT_A_WORKSPACE`` per request rather than refusing to boot. So
    :meth:`start` logs and gives up, leaving :meth:`wake` a no-op — queued work
    simply does not run, which is the honest state of a server with no workspace.
    """

    def __init__(self, workspace: WorkspaceHandle) -> None:
        self._workspace = workspace
        self._runner: JobRunner | None = None

    @property
    def runner(self) -> JobRunner | None:
        """The dispatcher, or ``None`` if it was never started."""
        return self._runner

    def start(self) -> None:
        """Build the dispatcher over this application's workspace and run it."""
        if self._runner is not None:
            return
        settings = job_settings()
        try:
            workspace = self._workspace.get()
        except VisionSetError:
            _logger.warning(
                "no workspace to run background work in; queued jobs will not start",
                exc_info=True,
            )
            return
        runner = JobRunner(
            workspace.job_queue,
            workspace.root,
            event_bus=workspace.event_bus,
            workers=settings.job_workers,
            poll_interval_s=settings.job_poll_interval_s,
            progress_min_interval_s=settings.job_progress_min_interval_s,
        )
        runner.start()
        self._runner = runner

    def wake(self) -> None:
        """Nudge the dispatcher, if there is one. Safe to call when there is not.

        What a route calls after enqueueing. It is a hint rather than a
        requirement — a queued row is durable and the next dispatcher to run picks
        it up — which is exactly what lets this be a no-op instead of a branch at
        every call site.
        """
        if self._runner is not None:
            self._runner.wake()

    def stop(self) -> None:
        """Drain and release. Safe to call twice, and when nothing ever started."""
        runner, self._runner = self._runner, None
        if runner is not None:
            runner.stop()


def get_job_runner(request: Request) -> DispatcherHandle:
    """The dispatcher this application queues work on.

    Read off ``app.state`` and reached through a dependency rather than by routes
    touching ``request.app`` themselves, for the reason :func:`get_auth_provider`
    is its own dependency: this is the seam a test replaces, and
    ``dependency_overrides`` only reaches what the graph resolves.

    A route uses it for exactly one thing — :meth:`DispatcherHandle.wake`, so a
    launched job starts now rather than at the next poll. Enqueueing itself goes
    through ``workspace.job_queue``, because the row is durable state and the
    dispatcher is not: a runner that was never started still leaves a queued row
    for the next one to pick up.
    """
    handle: DispatcherHandle = request.app.state.job_runner
    return handle


def get_exporters() -> dict[str, Exporter]:
    """Every export format installed alongside this server, by name.

    The server resolves plugins because the kernel structurally cannot:
    import-linter forbids ``visionset.kernel`` from importing
    ``visionset.formats``, which is why ``ReleaseService.export`` takes an
    ``Exporter`` instance rather than a format name. This is the composition
    point for that, the way ``WorkspaceService`` is for the store adapters.

    A dependency rather than a direct call in the route, and for the reason
    :func:`get_auth_provider` is one: the only installed format writes nothing,
    so a test that could not substitute an exporter could not tell an export that
    worked from one that silently did nothing.

    Not held on ``app.state`` beside the workspace, because there is no resource
    here to keep — the scan reads installed metadata and holds no handle, and one
    per request is what makes a format installed into a running environment
    visible without a restart.
    """
    return exporters()


def get_providers() -> Mapping[str, Provider]:
    """Every inference driver installed alongside this server, by provider id.

    The kept scan rather than a fresh one, which is the registry's own decision
    and its stated cost: a driver installed while this process runs is not seen
    until it restarts. Reading it here would not change that — a second scan
    would still not see a driver whose entry point was written after the
    interpreter started reading metadata.

    A dependency rather than a call inside the route, for the reason
    :func:`get_exporters` is one: nothing in this repository can install a third
    party's driver, so a test that could not substitute one could only ever
    assert this listing against the three drivers that ship here — which is the
    one thing the route is not about.
    """
    return registered().providers


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
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    auth_provider: Annotated[AuthProvider, Depends(get_auth_provider)],
) -> str:
    """Refuse the request unless it carries a live credential of this workspace.

    Two credentials are accepted and they are not equals. A **bearer token** is
    what a program presents: minted by hand with ``visionset token create``,
    verified through :class:`~visionset.kernel.ports.AuthProvider`, revocable, and
    the only one that reaches a workspace this server did not hand the browser.
    A **session cookie** is what the page this server served presents, and it
    exists so that opening the app on your own machine does not begin by asking
    you for a credential to read your own files — see
    :mod:`visionset.server.session`.

    The bearer path is tried first, so a request carrying both is judged on the
    credential it went out of its way to send, and a stale cookie can never
    shadow a token somebody passed deliberately.

    Missing, malformed, unknown and revoked are **one** answer, deliberately, and
    that now spans both credentials: a 401 that distinguished them would let
    anyone enumerate which credentials exist, and one that distinguished *which
    kind* was rejected would say whether this server issues sessions at all. The
    ``HTTPException`` is rendered as an ``ErrorBody`` by the handlers
    ``create_app`` installs, ``headers`` included — which is what keeps the
    ``WWW-Authenticate`` challenge on the response.
    """
    if credentials is not None and auth_provider.verify(credentials.credentials):
        return credentials.credentials

    # Resolved in the body rather than injected, and only when a cookie was
    # actually sent. A ``Depends(get_workspace)`` here would be resolved by
    # FastAPI on *every* request before this function runs, which would make a
    # test that overrides authentication alone start needing a real workspace —
    # and would open one to answer a request that a bearer token already settled.
    offered = session.presented(request)
    root = session.workspace_root() if offered is not None else None
    # ``compare_digest`` rather than ``==``: the comparison is against a secret,
    # and the short-circuit in the ordinary operator leaks its length and its
    # matching prefix through timing. The same reasoning ``TokenService`` applies
    # to a digest, applied to the one credential that is not one.
    if (
        offered is not None
        and root is not None
        and secrets.compare_digest(offered, session.secret_for(root))
    ):
        return offered

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing bearer token",
        headers={"WWW-Authenticate": "Bearer"},
    )


WorkspaceDep = Annotated[WorkspaceService, Depends(get_workspace)]
"""The workspace, for a route that needs to build a service over it."""

RunnerDep = Annotated[DispatcherHandle, Depends(get_job_runner)]
"""The dispatcher, for a route that launches work rather than doing it."""

ExportersDep = Annotated[dict[str, Exporter], Depends(get_exporters)]
"""The installed export formats, for a route that lists or runs one."""

ProvidersDep = Annotated[Mapping[str, Provider], Depends(get_providers)]
"""The installed inference drivers, for a route that lists them."""

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
