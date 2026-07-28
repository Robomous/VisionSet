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

**No ``from __future__ import annotations`` here, and that is not an oversight.**
This package has a module called ``annotations``, and the future import binds
that very name to a ``__future__._Feature`` — so importing the submodule shadows
it and mypy reports the collision. Nothing in this file needs the deferred
evaluation anyway.
"""

from typing import Final

from fastapi import APIRouter

from visionset.server.routes import (
    annotations,
    batches,
    ingest,
    jobs,
    projects,
    schemas,
    sources,
)

# A module may contribute more than one router: ``sources`` and ``batches`` each
# have a collection under an owning project and a resource of their own, which is
# two prefixes.
ROUTERS: Final[tuple[APIRouter, ...]] = (
    projects.router,
    schemas.router,
    sources.project_router,
    sources.router,
    ingest.router,
    batches.project_router,
    batches.router,
    jobs.router,
    annotations.router,
)

__all__ = [
    "ROUTERS",
    "annotations",
    "batches",
    "ingest",
    "jobs",
    "projects",
    "schemas",
    "sources",
]
