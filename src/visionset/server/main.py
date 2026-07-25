"""FastAPI application. Run with: uvicorn visionset.server.main:app"""

from __future__ import annotations

import os
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from visionset import __version__
from visionset.kernel.ports import AuthProvider


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
    """Bearer-token dependency for every future non-public endpoint."""
    if credentials is None or not _auth_provider.verify(credentials.credentials):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return credentials.credentials


app = FastAPI(
    title="Robomous VisionSet API",
    version=__version__,
    description="REST surface of the VisionSet SDK. The committed openapi.json is the contract.",
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe. Public — no token required."""
    return {"status": "ok", "version": __version__}
