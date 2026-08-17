# usage: from visionset.mcp import schemas
"""Schema tools: read the contract, propose a change, apply one.

**The domain's own ``LabelClass`` is the parameter type**, not a hand-written
body. That is the opposite call from the REST surface, and the reason is that the
two surfaces publish their input schemas to different readers. FastAPI copies a
model's docstring verbatim into ``openapi.json`` and turns a PEP 695 alias into a
named component, so ``server/models.py`` keeps its own spellings; MCPServer puts
the same docstrings into ``$defs`` on the tool's ``inputSchema``, where they are
the best guidance an agent gets about what a class *is*. Re-spelling the model
here would throw that away and add a second definition to keep in step.

**The one wart it inherits, stated rather than hidden**: a discriminated union's
tag carries a default in the domain — ``LabelClass.geometries`` does not, but
``Geometry`` and ``Partition`` do — so the generated schema shows ``type`` as
optional while pydantic needs it in the input dict to pick a variant. The REST
surface fixes that by dropping the defaults from its own bodies; here it is
answered in the tool description and pinned by a test, because the alternative is
the re-spelling this module exists to avoid.

``list_schema_versions`` folds into ``get_schema``: which versions exist is one
list of integers, and shipping a tool to fetch it is a round trip for something
that fits in the answer to "what is the schema".

``preview_schema_change`` is where ``SchemaService.preview`` earns its place: an
agent is the caller plan-before-apply was waiting for, because it is how a model
finds out that a change it is about to make would orphan somebody's work — and
finding out *before* is the whole point.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from visionset import wire
from visionset.kernel.domain import DraftLabelClass, LabelClass, SchemaProvenance
from visionset.kernel.services import SchemaDraftService, SchemaService
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

KindParam = Annotated[
    SchemaProvenance,
    Field(
        description=(
            "Which draft to read or write. A project holds at most one draft per "
            "kind. Leave it at 'curated' unless you are specifically working the "
            "draft an annotation session opened."
        )
    ),
]
"""Which of a project's (at most two) drafts a call names."""

DraftClassesParam = Annotated[
    tuple[DraftLabelClass, ...],
    Field(
        description=(
            "The whole draft, replacing whatever it held. A class may be "
            "incomplete — no name yet, no geometry yet — a draft is where that is "
            "allowed. Sending only the classes you are adding deletes everyone "
            "else's: read the draft first and send the full list back."
        )
    ),
]
"""The proposed draft classes, permissive where :data:`ClassesParam` is strict."""

NoteParam = Annotated[
    str,
    Field(
        description=(
            "The version message this draft will publish under. Replaces "
            "whatever note the draft carried, the way `classes` does."
        )
    ),
]
"""The draft's version message, written and overwritten like its classes."""

RevisionParam = Annotated[
    int | None,
    Field(
        description=(
            "The revision you last read. Omit only to create a draft that does "
            "not exist yet — omitting it against an existing draft is refused, "
            "and so is a revision that is no longer current. Read the draft again "
            "and resend on top of what is there."
        )
    ),
]
"""The optimistic-concurrency token for :func:`set_schema_draft`."""

PublishRevisionParam = Annotated[
    int,
    Field(
        description=(
            "The draft's current revision, from `get_schema_draft` or the last "
            "`set_schema_draft`. Required — publishing is named, not assumed."
        )
    ),
]
"""The required revision :func:`publish_schema_draft` must be told."""

AllowDestructiveParam = Annotated[
    bool,
    Field(
        description=(
            "Must be true to publish a change that removes or narrows something. "
            "Has no effect on an additive change, and none at all on a change "
            "that would orphan existing annotations — that one is refused outright."
        )
    ),
]
"""Whether a narrowing publish is allowed to proceed."""


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


def compare_schema_versions(
    project: ProjectRef,
    from_version: Annotated[int, Field(ge=1, description="The version to compare from, 1..N.")],
    to_version: Annotated[int, Field(ge=1, description="The version to compare to, 1..N.")],
) -> dict[str, Any]:
    """Say what one schema version did to another. Writes nothing.

    The sibling of `preview_schema_change`, asked about two versions that already
    exist rather than about classes you are proposing. Both return the same
    classification, so read that tool's description for what additive and
    destructive mean.

    The caller this exists for is `repin_batch`. A batch is judged against the
    version it pinned at approval, so before moving that pin, compare the pinned
    version with the active one — `get_batch` gives you the first and `get_schema`
    the second. `is_destructive` false means the re-pin needs no flag; true means
    it does, and `destructive_classes` names what would break.

    Order matters: comparing 1 to 2 and 2 to 1 are different questions. Comparing
    a version with itself is an empty diff.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        diff = SchemaService(workspace).compare(resolved.id, from_version, to_version)
    return wire.schema_diff(diff)


def preview_schema_change(project: ProjectRef, classes: ClassesParam) -> dict[str, Any]:
    """Say what applying these classes would change, without applying anything.

    Writes nothing. Use it before `create_schema_version` whenever you are
    changing an existing schema rather than creating the first one — it is the
    only way to find out that a change is destructive without attempting it.

    `diff.is_destructive` true means the proposal narrows the contract: a class or
    an attribute is gone, or a class lost one of its geometries.
    `diff.destructive_classes` names them, and applying it then needs
    `allow_destructive=true`. Adding classes, optional attributes, or another
    geometry to a class is additive and needs no flag.

    **`is_refused` is the answer no flag changes.** True means annotations already
    exist under a class this proposal drops, so `create_schema_version` refuses
    outright however you call it; `blockers` names each such class with how many
    annotations and how many assets it carries. Do not retry with
    `allow_destructive=true` — that flag answers a different refusal, and retrying
    is a loop. Either keep the class, or delete the annotations `blockers` counts
    and preview again.

    Advisory: nothing is locked. Somebody can label a class between this call and
    the publish, in which case the publish refuses and that refusal is the
    authoritative one.

    Each entry of `classes` must carry `geometries`, a non-empty list of declared
    geometry types — a class may be labeled as more than one shape. Matching
    against the current version is by exact class name, so renaming a class reads
    here as one removal plus one addition.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        preview = SchemaService(workspace).preview(resolved.id, classes)
    return wire.schema_change_preview(preview)


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
    provenance: Annotated[
        SchemaProvenance,
        Field(
            description=(
                "Which kind of work is publishing this version. Leave it at "
                "'curated' when you are designing the contract; pass 'annotation' "
                "only when you are adding a class you needed part-way through "
                "labeling an asset. It gates nothing — a version history uses it "
                "to separate the deliberate versions from the incidental ones."
            )
        ),
    ] = SchemaProvenance.CURATED,
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

    Versions are 1..N and never edited or deleted; this inserts a new one and the
    highest becomes active. Batches already approved keep the version they
    pinned, so this does not retroactively change how existing work is judged.

    Sending the classes already in force adds nothing and returns the version
    that was already active, so calling this to be sure is free.

    Send the whole contract every time — a class omitted is a class removed.
    Call `preview_schema_change` first if you are not creating the first version.

    `description` is this version's commit message: say what changed and why.
    It is stored verbatim and can never be edited, so write it as a record rather
    than as a note to yourself. Omitting it is legal.

    Three refusals to expect. A class naming a geometry VisionSet has not
    implemented is rejected outright. A narrowing change is rejected until you
    pass `allow_destructive=true`. And a narrowing change that would orphan
    annotations already written under an affected class is rejected with **no**
    override at all — the remedy there is to keep the class, not to force the
    change.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        published = SchemaService(workspace).create_version(
            resolved.id,
            classes,
            description=description,
            provenance=provenance,
            allow_destructive=allow_destructive,
        )
    return wire.schema_publication(published)


def get_schema_draft(
    project: ProjectRef, kind: KindParam = SchemaProvenance.CURATED
) -> dict[str, Any]:
    """Read the schema version this project is still writing.

    A project holds at most one draft per kind, and it is **shared**: everybody
    with access to this workspace sees the same one. There are no per-user
    drafts, because there are no users — so before writing a draft, read it, and
    treat what you find as somebody else's work in progress rather than yours.

    `draft` is null when nobody has started one, which is the ordinary state.

    Use this to compose a schema over several calls instead of holding classes in
    your own context: `set_schema_draft` writes what you have so far,
    `publish_schema_draft` turns it into a version. A draft may hold classes that
    are not finished — no name yet, no geometry yet — which `create_schema_version`
    would refuse outright.

    `revision` is what your next `set_schema_draft` or `publish_schema_draft` must
    pass. If it comes back changed from what you last wrote, somebody else edited
    the draft in between and your copy is stale.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        draft = SchemaDraftService(workspace).get(resolved.id, kind)
    return {"draft": None if draft is None else wire.schema_draft(draft)}


def set_schema_draft(
    project: ProjectRef,
    classes: DraftClassesParam,
    kind: KindParam = SchemaProvenance.CURATED,
    note: NoteParam = "",
    revision: RevisionParam = None,
) -> dict[str, Any]:
    """Write the whole draft, creating it when there is none.

    `classes` replaces the draft entirely — this is not an append. Read the draft
    first, add to what you find, and send the result; sending only your own
    classes deletes everybody else's.

    Classes may be incomplete. A class with no name, or with no geometry, is
    stored as given: that is what a draft is for. Every rule
    `create_schema_version` enforces is enforced by `publish_schema_draft`
    instead.

    `revision` is the revision you read. **Omit it only to create a draft that
    does not exist yet** — omitting it against an existing draft is refused,
    because a writer who has not read cannot know what it would destroy. Passing
    a revision that is no longer current is refused for the same reason. Both
    remedies are the same: read the draft again, redo your change on top of what
    is there, and resend.

    `note` is the version message the draft will publish under. It replaces
    whatever note the draft carried, like `classes` does.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        saved = SchemaDraftService(workspace).save(
            resolved.id, kind, classes=classes, note=note, expected_revision=revision
        )
    return wire.schema_draft(saved)


def clear_schema_draft(
    project: ProjectRef, kind: KindParam = SchemaProvenance.CURATED
) -> dict[str, Any]:
    """Throw the draft away without publishing it.

    Destroys work — possibly somebody else's, since the draft is shared — and
    nothing recovers it. Clearing a draft that is not there is not an error;
    `cleared` says which happened.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        removed = SchemaDraftService(workspace).discard(resolved.id, kind)
    return {"cleared": removed}


def publish_schema_draft(
    project: ProjectRef,
    revision: PublishRevisionParam,
    kind: KindParam = SchemaProvenance.CURATED,
    allow_destructive: AllowDestructiveParam = False,
) -> dict[str, Any]:
    """Turn the draft into the next schema version, and clear it.

    The classes published are the draft's own — you cannot publish something
    other than what `get_schema_draft` returns, which is the point of routing a
    publish through a draft at all. The draft's note becomes the version's commit
    message and its kind becomes the version's `provenance`.

    `revision` must be the draft's current one. If it is not, somebody edited the
    draft after you read it: nothing is published, and the remedy is to read it
    again and decide whether you still want to publish what is now there.

    A class that is not finished is refused with `classes.<n>` naming which. Fix
    it with `set_schema_draft` and publish again.

    Everything `create_schema_version` can refuse, this can refuse, with the same
    meanings: a change that narrows the contract needs `allow_destructive=true`,
    and a change that would orphan existing annotations is refused with **no**
    override — retrying that one with the flag is a loop. Use
    `preview_schema_change` on the draft's classes first if you are changing an
    existing schema.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        published = SchemaDraftService(workspace).publish(
            resolved.id, kind, expected_revision=revision, allow_destructive=allow_destructive
        )
    return wire.schema_publication(published)
