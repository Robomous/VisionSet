"""FastAPI application. Run with: uvicorn visionset.server.main:app"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute

from visionset import __version__
from visionset.server.dependencies import WorkspaceHandle
from visionset.server.errors import UNIVERSAL_ERROR_RESPONSES, install_error_handlers
from visionset.server.routes import ROUTERS
from visionset.server.runner import IngestRunner

DESCRIPTION = "REST surface of the VisionSet SDK. The committed openapi.json is the contract."

router = APIRouter()


def operation_id(route: APIRoute) -> str:
    """The handler's own name, as the operation id.

    FastAPI's default is derived from the path
    (``get_schema_version_projects__project_id__schema_versions__version__get``),
    and an operation id becomes a *method name* in a generated client — so under
    the default, moving a path silently renames somebody's client method. The
    handler name is the stable thing, and it is what a reader of the spec would
    guess. ``tests/server/test_openapi_contract.py`` asserts no two collide,
    since uniqueness is no longer structural.
    """
    return route.name


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe. Public — no token required."""
    return {"status": "ok", "version": __version__}


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Stop the ingest worker and close the workspace, in that order.

    Only the closing half. Both objects are built in :func:`create_app`, because
    ``TestClient(app)`` used without its context manager never runs startup —
    and anything that only existed after startup would simply be missing there.

    The order is load-bearing: a run still in flight holds the workspace, so
    closing it first would pull the store out from under a worker mid-write.
    """
    yield
    runner: IngestRunner = app.state.ingest_runner
    runner.shutdown()
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
        generate_unique_id_function=operation_id,
    )
    app.state.workspace_handle = WorkspaceHandle()
    # Beside the handle and for the same reason — one per application, so two
    # apps in one pytest process never share a worker. Neither touches disk or
    # starts a thread until a request asks it to.
    app.state.ingest_runner = IngestRunner()
    install_error_handlers(app)
    app.include_router(router)
    for resource in ROUTERS:
        app.include_router(resource)
    return app


app = create_app()
