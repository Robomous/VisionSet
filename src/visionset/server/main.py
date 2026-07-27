"""FastAPI application. Run with: uvicorn visionset.server.main:app"""

from __future__ import annotations

import os
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from visionset import __version__
from visionset.kernel.ports import AuthProvider
from visionset.server.errors import UNIVERSAL_ERROR_RESPONSES, install_error_handlers


class EnvTokenAuthProvider:
    """Dev-only AuthProvider: accepts the single token in $VISIONSET_DEV_TOKEN.

    Real token issuance/persistence lands in a later session behind the same port.
    """

    def verify(self, token: str) -> bool:
        expected = os.environ.get("VISIONSET_DEV_TOKEN")
        return expected is not None and token == expected


_auth_provider: AuthProvider = EnvTokenAuthProvider()
_bearer = HTTPBearer(auto_error=False)


async def require_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> str:
    """Bearer-token dependency for every future non-public endpoint.

    The ``HTTPException`` is rendered as an ``ErrorBody`` by the handler
    :func:`create_app` installs, headers included — which is what keeps the
    ``WWW-Authenticate`` challenge on the response.
    """
    if credentials is None or not _auth_provider.verify(credentials.credentials):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return credentials.credentials


DESCRIPTION = "REST surface of the VisionSet SDK. The committed openapi.json is the contract."

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe. Public — no token required."""
    return {"status": "ok", "version": __version__}


def create_app() -> FastAPI:
    """Build the application.

    A factory rather than a bare module-level literal, so a test or a future
    entry point can build an app with its own wiring. The module-level ``app``
    below stays regardless: ``scripts/export_openapi.py`` imports it by name,
    and so does ``uvicorn visionset.server.main:app``.

    ``responses=`` is applied here rather than route by route on purpose. It
    puts ``ErrorBody`` in ``components.schemas`` and displaces FastAPI's
    generated ``HTTPValidationError``, so no route can quietly document a second
    error shape.
    """
    app = FastAPI(
        title="Robomous VisionSet API",
        version=__version__,
        description=DESCRIPTION,
        responses=UNIVERSAL_ERROR_RESPONSES,
    )
    install_error_handlers(app)
    app.include_router(router)
    return app


app = create_app()
