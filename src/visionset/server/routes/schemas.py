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

from fastapi import Path, Query, status

from visionset.kernel.services import SchemaService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    DestructiveQuery,
    SchemaDiffOut,
    SchemaVersionCreate,
    SchemaVersionOut,
    SchemaVersionPage,
)

router = protected_router(prefix="/projects/{project_id}/schema", tags=["schemas"])

#: ``ge=1`` mirrors ``AnnotationSchema.version``'s own bound, so ``/versions/0``
#: is a 422 about the request rather than a 404 about a version that could never
#: have existed.
VersionPath = Annotated[int, Path(ge=1, description="A schema version, 1..N.")]

#: ``from`` is a Python keyword, so the query parameter is spelled out in an
#: alias and bound to a name that is not. The *wire* keeps the short spelling the
#: issue asked for; only the handler's parameter differs, which is the one place
#: an alias is free.
#:
#: ``ge=1`` for ``VersionPath``'s reason — mirroring the domain's own bound is the
#: standing rule, and without it ``from=0`` reaches ``SchemaService`` and comes
#: back as a 404 about a version that could never have existed.
FromVersionQuery = Annotated[
    int, Query(alias="from", ge=1, description="The version to compare *from*, 1..N.")
]
ToVersionQuery = Annotated[
    int, Query(alias="to", ge=1, description="The version to compare *to*, 1..N.")
]


@router.post("/versions", status_code=status.HTTP_201_CREATED, responses=documented(404, 409))
def create_schema_version(
    workspace: WorkspaceDep,
    project_id: UUID,
    body: SchemaVersionCreate,
    allow_destructive: DestructiveQuery = False,
) -> SchemaVersionOut:
    """Append the next version of the project's schema.

    The body is the whole proposed version; versions are never edited in place.

    `description` is this version's commit message — written once, here, and
    never afterwards, because a version is immutable and there is no route that
    edits one. Blank is legal and comes back as null. `created_at` is stamped by
    the server, so it is a response field and not a request one.

    `provenance` says which kind of work is publishing: `curated` for a version
    authored in a schema editor, `annotation` for one that fell out of adding a
    class while labeling. It is stored exactly as sent and never inferred, so a
    client with no opinion omits it and the version records null — which readers
    group with `curated`. It gates nothing and changes no behaviour; it exists so
    a version history can separate the milestones from the runs.

    Removing a class or an attribute answers 409 `DESTRUCTIVE_SCHEMA_CHANGE`
    until `allow_destructive=true` says so deliberately. If annotations already
    exist under an affected class it answers 409 `SCHEMA_CHANGE_WOULD_ORPHAN`
    instead, and **no flag overrides that one** — which is why a client branches
    on `code` and not on the status.
    """
    classes = [label_class.to_domain() for label_class in body.classes]
    created = SchemaService(workspace).create_version(
        project_id,
        classes,
        description=body.description,
        provenance=body.provenance,
        allow_destructive=allow_destructive,
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


@router.get("/compare", responses=documented(404))
def compare_schema_versions(
    workspace: WorkspaceDep,
    project_id: UUID,
    from_version: FromVersionQuery,
    to_version: ToVersionQuery,
) -> SchemaDiffOut:
    """What one version did to another: the kernel's own classification.

    A route rather than arithmetic a client could do for itself, because the rule
    is not obvious and there is exactly one correct spelling of it. Adding an
    *optional* attribute is additive while adding a *required* one is not;
    widening a `select` is additive and narrowing it is not; a rename reads as one
    removal plus one addition, because `Annotation.label_class` is matched by
    exact string too. A second implementation of that in a client would be free to
    drift from the one the API then enforces.

    `is_destructive` and `destructive_classes` are the verdict, and they are what
    to branch on — a client re-deriving them from `changes` is re-implementing the
    thing this endpoint exists to avoid. Destructive here means "an annotation
    that was valid under `from` may not be valid under `to`", which is what
    decides whether applying or re-pinning needs `allow_destructive=true`.

    Comparing a version with itself is an empty, non-destructive diff. Order
    matters: `from=1&to=2` and `from=2&to=1` are different questions, and the
    second is how you ask what going *back* would cost.

    Either version missing is 404 `SCHEMA_NOT_FOUND`; an unknown project is 404
    `PROJECT_NOT_FOUND`. Same status, two situations, told apart by `code`.
    """
    diff = SchemaService(workspace).compare(project_id, from_version, to_version)
    return SchemaDiffOut.of(diff)


@router.get("", responses=documented(404))
def get_active_schema(workspace: WorkspaceDep, project_id: UUID) -> SchemaVersionOut:
    """The version in force: the highest one.

    A project that has no schema yet answers 404 `SCHEMA_NOT_FOUND`, which is a
    different code from the 404 `PROJECT_NOT_FOUND` an unknown project gets.
    Same status, two situations.
    """
    return SchemaVersionOut.of(SchemaService(workspace).get_active(project_id))
