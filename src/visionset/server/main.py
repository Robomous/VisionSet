"""FastAPI application. Run with: uvicorn visionset.server.main:app"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib import resources
from pathlib import Path
from typing import Final

from fastapi import APIRouter, FastAPI, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from visionset import __version__
from visionset.server import session
from visionset.server.dependencies import WorkspaceHandle
from visionset.server.errors import (
    UNIVERSAL_ERROR_RESPONSES,
    http_exception_handler,
    install_error_handlers,
)
from visionset.server.routes import ROUTERS
from visionset.server.runner import IngestRunner

DESCRIPTION = "REST surface of the VisionSet SDK. The committed openapi.json is the contract."

router = APIRouter()

UI_PREFIX: Final = "/app"
"""Where the compiled bundle lives in the URL space.

A prefix rather than the root, and the reason is that **the API already owns the
root**. ``/projects/{project_id}`` is a route in ``openapi.json``, so a
single-page app served from ``/`` could never own ``/projects/abc`` as one of its
*own* client routes: the API route matches first and answers
``404 PROJECT_NOT_FOUND``. That is not a limitation a later milestone can lift —
it is the consequence of an unprefixed API, which is a shipped contract. Picking
the prefix now costs one ``base`` line in ``frontend/app/vite.config.ts``;
picking it after the bundle ships costs a public URL migration.
"""

_STATIC_DIRNAME: Final = "_static"

INDEX_FILENAME: Final = "index.html"

BUNDLE_COMMAND: Final = "pnpm bundle:static"
"""What builds the bundle, named in the 404 that says nobody ever ran it."""


def static_root() -> Path:
    """The directory ``pnpm bundle:static`` copies the compiled UI into.

    A function rather than a module-level constant, and that is the test seam:
    ``_static/`` holds only ``README.md`` and ``.gitkeep`` in a fresh checkout —
    the bundle is a git-ignored build artifact and CI never builds one — so a
    test that needs a real bundle monkeypatches this and *then* calls
    :func:`create_app`. A constant would have frozen the answer at import time,
    where no test can reach it.

    ``importlib.resources`` rather than ``__file__`` arithmetic, because the
    directory is package *data*: ``[tool.hatch.build] artifacts`` in
    ``pyproject.toml`` is what puts it in the wheel. ``visionset`` is a regular
    package on a real filesystem, so ``files()`` hands back a ``Path`` and
    ``str()`` round-trips it exactly; the conversion exists because the
    *declared* return type is ``Traversable``, which ``StaticFiles`` will not
    accept and mypy is right to reject. A zipapp would need ``as_file`` — and a
    mount cannot live inside a temporary extraction — so if this distribution
    ever ships as one, this function is where that argument goes.
    """
    return Path(str(resources.files("visionset"))) / _STATIC_DIRNAME


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


@router.get("/session", include_in_schema=False)
async def browser_session(request: Request, response: Response) -> dict[str, bool]:
    """Hand the page this server served a credential for it, when it may have one.

    The one route in :mod:`visionset.server.session`'s design — see that module
    for why it is a route at all, and for who counts as "may".

    **Public, and it has to be**: the whole point is a browser that holds no
    credential yet. Nothing is disclosed by asking — the answer is a boolean about
    *this* request, not about the workspace — and a client that is not eligible
    gets ``{"issued": false}`` and the ordinary token form, which is the same
    answer it would get from a server with no workspace at all.

    **Out of ``openapi.json``, like ``/`` and the bundle mount.** The spec is the
    contract for a *program*, and a program authenticates with
    ``Authorization: Bearer``: it should never be handed a credential it did not
    mint and cannot revoke. Keeping the route out of the schema is also what keeps
    the committed spec and the generated client byte-identical across this change,
    which is one of #179's acceptance criteria.
    """
    return {"issued": session.issue(request, response)}


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


def _install_ui(app: FastAPI, root: Path) -> None:
    """Serve the compiled UI bundle under ``/app``, and land ``/`` on it.

    **One mount, on a directory that always exists.** ``_static/`` is tracked
    (``README.md`` and ``.gitkeep``); only its *contents* are git-ignored. That is
    what makes this mount unconditional. Mounting ``_static/assets`` instead would
    need an ``if .is_dir()`` guard, because that directory is absent everywhere a
    bundle was never built — and ``check_dir=False`` does **not** rescue it:
    Starlette re-checks on the first *request* and raises ``RuntimeError``, which
    this package's own catch-all handler turns into a 500 with an incident id. A
    missing bundle is not an incident.

    **Never a ``Mount("/")``.** A mount at the root returns ``Match.FULL`` for
    every path, so it wins over the *partial* match that produces a 405 — and,
    worse, it shadows every route added after :func:`create_app` returns, which is
    how every probe application in ``tests/server/`` is built. ``POST /health``
    stays a 405 ``METHOD_NOT_ALLOWED`` and ``/probe/whoami`` stays reachable
    precisely because this mount claims one prefix and nothing else.

    **Nothing here reaches ``openapi.json``.** A ``Mount`` is not an operation,
    and ``/`` is declared ``include_in_schema=False``: the spec is the *REST*
    contract, and where a browser finds HTML is not part of it. That is also what
    keeps the CI drift gate and ``pnpm generate:client`` still.

    **The single-page deep-link fallback**, which #33 deferred to "the milestone
    that owns a client-side router" and #58 is. ``/app/projects/abc`` is a client
    route the router resolves in the browser, but a *reload* on it is a real
    request for a path no file backs — so without a fallback, refreshing any page
    but the index is a 404, and so is every bookmark and every link somebody
    pastes into a chat.

    Three conditions, and each one keeps something alive:

    * **the path is under** :data:`UI_PREFIX` — the API owns the root, and
      answering HTML for an unknown ``/projects/nope`` would hide a real 404 from
      a client that mistyped a route;
    * **the method is ``GET``** — a ``POST`` to a client route is not a page load;
    * **``Accept`` literally contains ``text/html``** — httpx and every other API
      client send ``*/*``, so the JSON 404 the contract promises survives
      untouched. That substring test is why ``tests/server`` needed no change: its
      requests never claim to be a browser.

    It is installed by **replacing** the ``HTTPException`` handler and falling
    through to :func:`~visionset.server.errors.http_exception_handler` for
    everything else, because Starlette keys its handler map by exception class and
    two handlers for one class is the last one registered. Not middleware:
    ``@app.middleware("http")`` wraps the application in ``BaseHTTPMiddleware``,
    which buffers a ``StreamingResponse`` — and four routes stream (asset content,
    thumbnail, release manifest, export archive). Trading those for a 404 rule
    would be a real regression bought for nothing.

    **Nothing here reaches ``openapi.json`` either.** An exception handler is not
    an operation.
    """
    # `index_file`, not `index`: the redirect route below is `async def index`, and
    # a closure reads the *enclosing scope at call time* — so a name shared with a
    # function defined later in the same function body resolves to the function, and
    # the fallback answers 500 `AttributeError: 'function' object has no attribute
    # 'is_file'`. Three tests found it; the name is the fix.
    index_file = root / INDEX_FILENAME

    app.mount(UI_PREFIX, StaticFiles(directory=root, html=True), name="ui")

    async def spa_or_error(request: Request, exc: Exception) -> Response:
        if (
            isinstance(exc, StarletteHTTPException)
            and exc.status_code == status.HTTP_404_NOT_FOUND
            and request.method == "GET"
            and request.url.path.startswith(f"{UI_PREFIX}/")
            and "text/html" in request.headers.get("accept", "")
            and index_file.is_file()
        ):
            # 200, not 404: the browser is about to run a router that will resolve
            # the path itself, and a 404 status on a page that renders correctly is
            # a lie every crawler and every error reporter believes.
            return FileResponse(index_file)
        return await http_exception_handler(request, exc)

    # After install_error_handlers, and the order is the mechanism.
    #
    # Keyed on **Starlette's** ``HTTPException``, not FastAPI's — #31's trap, hit
    # again from the other side. The router raises the Starlette class for an
    # unknown path and ``StaticFiles`` raises it for a missing file, and FastAPI's
    # is a *subclass*: registering the subclass leaves both of those falling
    # through to the handler installed a moment ago, so the fallback never fires
    # for the only two things that produce the 404 it exists for. Three tests
    # failed on exactly that before this line said ``Starlette``.
    app.add_exception_handler(StarletteHTTPException, spa_or_error)

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    async def index() -> RedirectResponse:
        """Send a browser that typed the bare host to the bundle.

        A redirect rather than a second copy of ``index.html`` served here, so the
        application is loaded from exactly one URL and :data:`UI_PREFIX` can move
        without leaving a stale twin behind. ``GET`` and ``HEAD`` only — ``POST /``
        stays a 405 like every other wrong method.

        The 404 is the one thing a bare redirect could not do. In a source
        checkout nobody has run ``pnpm bundle:static`` in, ``/app/`` answers an
        anonymous "Not Found"; here the remedy *is* the message.
        """
        if not (root / INDEX_FILENAME).is_file():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=(
                    f"No UI bundle in this installation. Run `{BUNDLE_COMMAND}` in a source "
                    "checkout, or install the published wheel, which ships one."
                ),
            )
        return RedirectResponse(f"{UI_PREFIX}/")


def create_app() -> FastAPI:
    """Build the application.

    A factory rather than a bare module-level literal, so a test or a future
    entry point can build an app with its own wiring. The module-level ``app``
    below stays regardless: ``scripts/export_openapi.py`` imports it by name,
    and so does ``uvicorn visionset.server.main:app``.

    It takes **no parameters**, and that is a decision rather than an omission.
    ``visionset server`` starts this server by *import string* — import-linter forbids
    ``visionset.cli`` importing ``visionset.server``, and ``uvicorn --reload``
    requires the import-string form anyway — so an argument here would be
    unreachable from the only production caller. Production configures through
    the environment; tests configure through ``app.dependency_overrides``. One
    mechanism per audience, and no third.

    Building the workspace handle touches no disk: it is opened by the first
    request that needs it, so importing this module in a checkout with no
    workspace stays free. Mounting the UI does stat one directory that ships
    inside the package, which is a different thing from reaching for state a
    checkout may not have.

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
    # Last, and the ordering is documentation rather than a requirement: a mount
    # claiming one prefix collides with nothing above it. That independence is
    # the whole property _install_ui exists to buy.
    _install_ui(app, static_root())
    return app


app = create_app()
