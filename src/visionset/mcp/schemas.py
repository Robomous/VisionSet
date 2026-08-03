# usage: from visionset.mcp import schemas
"""Schema tools: read the contract, propose a change, apply one.

**The domain's own ``LabelClass`` is the parameter type**, not a hand-written
body. That is the opposite call from the REST surface, and the reason is that the
two surfaces publish their input schemas to different readers. FastAPI copies a
model's docstring verbatim into ``openapi.json`` and turns a PEP 695 alias into a
named component, so ``server/models.py`` keeps its own spellings; FastMCP puts
the same docstrings into ``$defs`` on the tool's ``inputSchema``, where they are
the best guidance an agent gets about what a class *is*. Re-spelling the model
here would throw that away and add a second definition to keep in step.

**The one wart it inherits, stated rather than hidden**: a discriminated union's
tag carries a default in the domain — ``LabelClass.geometry`` does not, but
``Geometry`` and ``Partition`` do — so the generated schema shows ``type`` as
optional while pydantic needs it in the input dict to pick a variant. #29 fixed
that on the wire by dropping the defaults from its own bodies; here it is
answered in the tool description and pinned by a test, because the alternative is
the re-spelling this module exists to avoid.

``list_schema_versions`` folds into ``get_schema``: which versions exist is one
list of integers, and shipping a tool to fetch it is a round trip for something
that fits in the answer to "what is the schema".

``preview_schema_change`` gives ``SchemaService.preview`` its **first caller**.
It has been in the kernel since #6 and unrouted since #27 for want of one. An
agent is exactly the caller it was waiting for: plan-before-apply is how a model
finds out that a change it is about to make would orphan somebody's work, and
finding out *before* is the whole point.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from visionset import wire
from visionset.kernel.domain import LabelClass
from visionset.kernel.services import SchemaService
from visionset.mcp._resolve import ProjectRef, resolve_project
from visionset.mcp._workspace import opened_workspace

ClassesParam = Annotated[
    list[LabelClass],
    Field(
        description=(
            "The complete list of label classes the new version declares. This is "
            "the whole contract, not a patch: a class left out is a class removed."
        )
    ),
]
"""The proposed classes, for the two tools that take a whole schema.

Module-level for the ``inspect.signature`` reason :data:`ProjectRef` is.
"""


def get_schema(
    project: ProjectRef,
    version: Annotated[
        int | None,
        Field(ge=1, description="A specific version to read. Omit for the active (highest) one."),
    ] = None,
) -> dict[str, Any]:
    """Read a project's annotation schema — which classes exist and what each may carry.

    Read this before writing any annotation: `add_annotations` judges every label
    against the version its batch pinned, and a class name or geometry the schema
    does not declare is refused. `available_versions` lists every version ever
    created, oldest first; `active_version` is the highest, which is what the next
    `approve_batch` will pin.

    A project that has never had `create_schema_version` called on it has no
    schema at all, and this reports that rather than inventing an empty one.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        service = SchemaService(workspace)
        versions = service.list_versions(resolved.id)
        found = (
            service.get_active(resolved.id)
            if version is None
            else service.get(resolved.id, version)
        )
    return {
        "schema": wire.schema_version(found),
        "active_version": versions[-1].version,
        "available_versions": [v.version for v in versions],
    }


def preview_schema_change(project: ProjectRef, classes: ClassesParam) -> dict[str, Any]:
    """Say what applying these classes would change, without applying anything.

    Writes nothing. Use it before `create_schema_version` whenever you are
    changing an existing schema rather than creating the first one — it is the
    only way to find out that a change is destructive without attempting it.

    `is_destructive` true means the proposal narrows the contract: a class or an
    attribute is gone, or a geometry moved. `destructive_classes` names them.
    Applying it then needs `allow_destructive=true` — unless annotations already
    exist under one of those classes, in which case `create_schema_version`
    refuses outright and no flag overrides it. Adding classes or optional
    attributes is additive and needs no flag.

    Each entry of `classes` must carry `geometry` as one of the declared geometry
    types; matching against the current version is by exact class name, so
    renaming a class reads here as one removal plus one addition.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        diff = SchemaService(workspace).preview(resolved.id, classes)
    return wire.schema_diff(diff)


def create_schema_version(
    project: ProjectRef,
    classes: ClassesParam,
    description: Annotated[
        str | None,
        Field(
            description=(
                "Why this version exists, in one or two sentences. Written once "
                "and never editable afterwards — a version's commit message."
            )
        ),
    ] = None,
    allow_destructive: Annotated[
        bool,
        Field(
            description=(
                "Must be true to apply a change that removes or narrows something. "
                "Has no effect on an additive change."
            )
        ),
    ] = False,
) -> dict[str, Any]:
    """Create the next schema version from a complete list of classes.

    Versions are 1..N and never edited or deleted; this always inserts a new one
    and the highest becomes active. Batches already approved keep the version
    they pinned, so this does not retroactively change how existing work is
    judged.

    Send the whole contract every time — a class omitted is a class removed.
    Call `preview_schema_change` first if you are not creating the first version.

    `description` is this version's commit message: say what changed and why.
    It is stored verbatim and can never be edited, so write it as a record rather
    than as a note to yourself. Omitting it is legal.

    Three refusals to expect. A class bound to a geometry VisionSet has not
    implemented is rejected outright. A narrowing change is rejected until you
    pass `allow_destructive=true`. And a narrowing change that would orphan
    annotations already written under an affected class is rejected with **no**
    override at all — the remedy there is to keep the class, not to force the
    change.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        created = SchemaService(workspace).create_version(
            resolved.id,
            classes,
            description=description,
            allow_destructive=allow_destructive,
        )
    return wire.schema_version(created)
