"""VisionSet REST server (FastAPI) — a thin client of the kernel SDK.

The OpenAPI spec exported from this app (repo-root ``openapi.json``) is a
versioned public contract; the official UI has no private endpoints.

Failures are part of that contract. A route raises a kernel domain error and
``errors.py`` turns it into an ``ErrorBody`` with a stable machine ``code``;
routes do not translate errors themselves and never raise ``HTTPException`` for
something the kernel already has a name for. See ``docs/api.md``.
"""
