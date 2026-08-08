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
    assets,
    background_jobs,
    batches,
    datasets,
    formats,
    inference,
    ingest,
    jobs,
    projects,
    releases,
    schemas,
    sources,
)

# A module may contribute more than one router: ``sources``, ``batches``,
# ``datasets`` and ``releases`` each have a collection under an owning resource
# and a resource of their own, which is two prefixes.
#
# Order follows the shape of the data rather than the alphabet — a project, then
# what is registered into it, then what is cut out of it, then what is curated and
# frozen — so reading this list reads the pipeline. It has no effect on routing:
# every prefix here is distinct.
ROUTERS: Final[tuple[APIRouter, ...]] = (
    projects.router,
    schemas.router,
    sources.project_router,
    sources.router,
    ingest.router,
    assets.router,
    batches.project_router,
    batches.router,
    jobs.router,
    annotations.router,
    datasets.project_router,
    datasets.router,
    releases.project_router,
    releases.router,
    formats.router,
    # Outside the pipeline order too, and for its own reason: a connection is not
    # a stage of the data's life but a piece of this workspace's configuration,
    # which the pipeline reads rather than produces.
    inference.router,
    inference.suggestions,
    # Last, and outside the pipeline order above on purpose: a background job is
    # not a stage of the data's life, it is how some of those stages run. Reading
    # it into the sequence would suggest a place it does not have.
    background_jobs.router,
)

__all__ = [
    "ROUTERS",
    "annotations",
    "background_jobs",
    "assets",
    "batches",
    "datasets",
    "formats",
    "inference",
    "ingest",
    "jobs",
    "projects",
    "releases",
    "schemas",
    "sources",
]
