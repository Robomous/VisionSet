# usage: from visionset.server.routes import schemas
"""The annotation schema of a project, and its versions.

"Schema" here always means ``AnnotationSchema``. The pydantic classes this
module returns are *models*, and they live in ``server/models.py`` — the same
vocabulary ``kernel/domain/`` uses.

The active version is the collection's **parent** (``GET .../schema``) rather
than a number a client has to guess, because "in force" is a property of the
schema and not of any particular version. Versions are 1..N and none of them is
ever edited, so there is no ``PUT`` and no ``DELETE`` here — the only write is
appending the next one.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import Path, status

from visionset.kernel.services import SchemaService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    DestructiveQuery,
    SchemaVersionCreate,
    SchemaVersionOut,
    SchemaVersionPage,
)

router = protected_router(prefix="/projects/{project_id}/schema", tags=["schemas"])

#: ``ge=1`` mirrors ``AnnotationSchema.version``'s own bound, so ``/versions/0``
#: is a 422 about the request rather than a 404 about a version that could never
#: have existed.
VersionPath = Annotated[int, Path(ge=1, description="A schema version, 1..N.")]


@router.post("/versions", status_code=status.HTTP_201_CREATED, responses=documented(404, 409))
def create_schema_version(
    workspace: WorkspaceDep,
    project_id: UUID,
    body: SchemaVersionCreate,
    allow_destructive: DestructiveQuery = False,
) -> SchemaVersionOut:
    """Append the next version of the project's schema.

    The body is the whole proposed version; versions are never edited in place.

    Removing a class or an attribute answers 409 `DESTRUCTIVE_SCHEMA_CHANGE`
    until `allow_destructive=true` says so deliberately. If annotations already
    exist under an affected class it answers 409 `SCHEMA_CHANGE_WOULD_ORPHAN`
    instead, and **no flag overrides that one** — which is why a client branches
    on `code` and not on the status.
    """
    classes = [label_class.to_domain() for label_class in body.classes]
    created = SchemaService(workspace).create_version(
        project_id, classes, allow_destructive=allow_destructive
    )
    return SchemaVersionOut.of(created)


@router.get("/versions", responses=documented(404))
def list_schema_versions(workspace: WorkspaceDep, project_id: UUID) -> SchemaVersionPage:
    """Every version, oldest first. An empty page is the ordinary starting state."""
    found = SchemaService(workspace).list_versions(project_id)
    return SchemaVersionPage(
        items=[SchemaVersionOut.of(schema) for schema in found], total=len(found)
    )


@router.get("/versions/{version}", responses=documented(404))
def get_schema_version(
    workspace: WorkspaceDep, project_id: UUID, version: VersionPath
) -> SchemaVersionOut:
    """One version of a project's schema."""
    return SchemaVersionOut.of(SchemaService(workspace).get(project_id, version))


@router.get("", responses=documented(404))
def get_active_schema(workspace: WorkspaceDep, project_id: UUID) -> SchemaVersionOut:
    """The version in force: the highest one.

    A project that has no schema yet answers 404 `SCHEMA_NOT_FOUND`, which is a
    different code from the 404 `PROJECT_NOT_FOUND` an unknown project gets.
    Same status, two situations.
    """
    return SchemaVersionOut.of(SchemaService(workspace).get_active(project_id))
