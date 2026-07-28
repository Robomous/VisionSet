"""Building blocks for the server tests: probe apps, and a stand-in provider.

Plain functions rather than pytest fixtures, and there is deliberately still no
`conftest.py` anywhere in this repository — `tests/fixtures/media.py` is the
precedent, and each test module wraps what it needs in its own two-line fixture.

Every probe app is built by the **real** `create_app()`, never by a bare
`FastAPI()`. That is what makes a probe exercise the real handler set, the real
lifespan and the real router configuration; the only thing that must not happen
is mounting a route on the exported `app`, because it would land in
`openapi.json` and trip the CI drift gate.
"""

from collections.abc import Callable
from pathlib import Path
from typing import Final

from fastapi import FastAPI

from visionset.kernel.services import WorkspaceService
from visionset.server.dependencies import (
    TokenDep,
    WorkspaceHandle,
    get_auth_provider,
    protected_router,
)
from visionset.server.main import create_app

PROBE_PATH: Final = "/probe/whoami"
"""The one protected route the probe apps carry."""

KNOWN_TOKEN: Final = "vst_known-good-token"
"""What :class:`StubAuthProvider` accepts, for tests that do not want a workspace."""


class StubAuthProvider:
    """Accepts exactly one token, and counts what it was asked about."""

    def __init__(self, accepted: str = KNOWN_TOKEN) -> None:
        self.accepted = accepted
        self.presented: list[str] = []

    def verify(self, token: str) -> bool:
        self.presented.append(token)
        return token == self.accepted


def probe_app() -> FastAPI:
    """A real application carrying one protected route, mounted off the exported one."""
    app = create_app()
    router = protected_router(prefix="/probe", tags=["probe"])

    @router.get("/whoami")
    def whoami(token: TokenDep) -> dict[str, str]:
        return {"token": token}

    app.include_router(router)
    return app


def stubbed_app(provider: StubAuthProvider) -> FastAPI:
    """A probe app whose authentication is ``provider``, no workspace involved.

    Overriding ``get_auth_provider`` rather than ``require_token`` keeps the real
    credential handling under test — the header parsing, the challenge, the body
    — and replaces only the thing that would otherwise need a workspace on disk.
    """
    app = probe_app()
    app.dependency_overrides[get_auth_provider] = lambda: provider
    return app


def workspace_app(root: Path) -> FastAPI:
    """A probe app serving a real workspace at ``root``, opened lazily as usual.

    The handle is replaced rather than the environment patched, so the test says
    which workspace it means instead of relying on process-wide state.
    """
    app = probe_app()
    app.state.workspace_handle = handle_for(root)
    return app


def handle_for(root: Path) -> WorkspaceHandle:
    """A handle that opens the workspace at ``root`` when first asked."""
    return WorkspaceHandle(lambda: WorkspaceService.open(root))


def counting_handle(
    open_workspace: Callable[[], WorkspaceService],
) -> tuple[WorkspaceHandle, list[int]]:
    """A handle plus a one-element list counting how often it opened anything."""
    calls = [0]

    def opener() -> WorkspaceService:
        calls[0] += 1
        return open_workspace()

    return WorkspaceHandle(opener), calls
