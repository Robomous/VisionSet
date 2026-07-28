"""FastAPI application. Run with: uvicorn visionset.server.main:app"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI

from visionset import __version__
from visionset.server.dependencies import WorkspaceHandle
from visionset.server.errors import UNIVERSAL_ERROR_RESPONSES, install_error_handlers

DESCRIPTION = "REST surface of the VisionSet SDK. The committed openapi.json is the contract."

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe. Public — no token required."""
    return {"status": "ok", "version": __version__}


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Close the workspace on shutdown, if a request ever opened one.

    Only the closing half. The handle itself is built in :func:`create_app`,
    because ``TestClient(app)`` used without its context manager never runs
    startup — and a handle that only existed after startup would simply be
    missing there.
    """
    yield
    handle: WorkspaceHandle = app.state.workspace_handle
    handle.close()


def create_app() -> FastAPI:
    """Build the application.

    A factory rather than a bare module-level literal, so a test or a future
    entry point can build an app with its own wiring. The module-level ``app``
    below stays regardless: ``scripts/export_openapi.py`` imports it by name,
    and so does ``uvicorn visionset.server.main:app``.

    It takes **no parameters**, and that is a decision rather than an omission.
    ``visionset ui`` starts this server by *import string* — import-linter forbids
    ``visionset.cli`` importing ``visionset.server``, and ``uvicorn --reload``
    requires the import-string form anyway — so an argument here would be
    unreachable from the only production caller. Production configures through
    the environment; tests configure through ``app.dependency_overrides``. One
    mechanism per audience, and no third.

    Building the workspace handle touches no disk: it is opened by the first
    request that needs it, so importing this module in a checkout with no
    workspace stays free.

    ``responses=`` is applied here rather than route by route on purpose. It
    puts ``ErrorBody`` in ``components.schemas`` and displaces FastAPI's
    generated ``HTTPValidationError``, so no route can quietly document a second
    error shape. 401 is deliberately not among them — ``/health`` is public and
    cannot 401 — so protected routers document it themselves.
    """
    app = FastAPI(
        title="Robomous VisionSet API",
        version=__version__,
        description=DESCRIPTION,
        responses=UNIVERSAL_ERROR_RESPONSES,
        lifespan=_lifespan,
    )
    app.state.workspace_handle = WorkspaceHandle()
    install_error_handlers(app)
    app.include_router(router)
    return app


app = create_app()
