# usage: from visionset.server.routes import ROUTERS
"""The resource routers.

``main.create_app`` includes every one of them, so adding a route module is one
import here and no edit to ``main.py``. A route module imports from
``dependencies``, ``errors`` and ``models`` — never from ``main``, which is the
cycle ``dependencies.py`` exists to prevent.

Every router in here is built with ``protected_router()``. ``/health`` is the one
public operation and it lives on ``main``'s own router;
``tests/server/_openapi.py`` keeps the list of public operations and the spec
walk that enforces it.
"""

from __future__ import annotations

from typing import Final

from fastapi import APIRouter

from visionset.server.routes import batches, ingest, projects, schemas, sources

# A module may contribute more than one router: ``sources`` has a collection
# under its owning project and a resource of its own, which is two prefixes.
ROUTERS: Final[tuple[APIRouter, ...]] = (
    projects.router,
    schemas.router,
    sources.project_router,
    sources.router,
    ingest.router,
    batches.router,
)

__all__ = ["ROUTERS", "batches", "ingest", "projects", "schemas", "sources"]
