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

from visionset.kernel.domain import SchemaProvenance
from visionset.kernel.errors import SchemaDraftNotFound
from visionset.kernel.services import SchemaDraftService, SchemaService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    BlockingAssetOut,
    BlockingAssetPage,
    DestructiveQuery,
    LimitQuery,
    OffsetQuery,
    SchemaChangePreviewOut,
    SchemaDiffOut,
    SchemaDraftBody,
    SchemaDraftOut,
    SchemaDraftPublish,
    SchemaPublicationOut,
    SchemaVersionCreate,
    SchemaVersionOut,
    SchemaVersionPage,
    window,
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
) -> SchemaPublicationOut:
    """Append the next version of the project's schema, and catch the open batches up.

    The body is the whole proposed version; versions are never edited in place.

    **A version that only widens the contract moves every open batch onto it**,
    in the same transaction, and `advanced_batches` names the ones that moved. A
    wider contract cannot invalidate a label already drawn, so nothing is at risk
    — which is exactly why a narrowing version moves nothing, `allow_destructive`
    or not. A batch is *open* if it is `approved` or `in_annotation`; a draft has
    no pin yet and takes the active version at approval, and a completed batch's
    pin is the record of what its work was judged against.

    `advanced_batches` is empty when nothing followed, which is ordinary. A client
    that renders "published" without it cannot tell a version that moved two
    batches from one that moved none.

    **Sending the classes that are already in force writes nothing.** The answer
    is the version that was already active, and it is not an error: the version
    a client holds afterwards is the one in force either way, which is the only
    thing it asked for. Identical means the classes match exactly — names,
    geometries, colours, attributes and order — so a colour change is a change
    and does publish a version.

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

    The third 409 is the one that *is* worth an immediate retry: two writers
    racing for the same next version number is `SCHEMA_VERSION_CONFLICT`, and
    resending the identical request re-reads the maximum and lands on the one
    after it. No flag is involved, and none is needed.
    """
    classes = [label_class.to_domain() for label_class in body.classes]
    published = SchemaService(workspace).create_version(
        project_id,
        classes,
        description=body.description,
        provenance=body.provenance,
        allow_destructive=allow_destructive,
    )
    return SchemaPublicationOut.of(published)


@router.post("/preview", responses=documented(404))
def preview_schema_change(
    workspace: WorkspaceDep, project_id: UUID, body: SchemaVersionCreate
) -> SchemaChangePreviewOut:
    """Say what publishing these classes would do, without publishing anything.

    Writes nothing, and answers both gates at once. `diff` is the classification
    `GET /compare` returns — whether this narrows the contract, and over which
    classes — so `diff.is_destructive` decides whether the publish needs
    `allow_destructive=true`.

    **`is_refused` is the answer no flag changes.** True means annotations already
    exist under a class this proposal drops, so `POST /versions` answers 409
    `SCHEMA_CHANGE_WOULD_ORPHAN` however it is called, and `blockers` names each
    such class with how many annotations and how many assets carry it. That is the
    **same structure** the refusal itself puts in `detail`, so one renderer serves
    the warning and the refusal. Retrying with `allow_destructive=true` against a
    refused preview is the loop `code` exists to prevent.

    A POST because the proposal is the whole class list and a class list does not
    belong in a query string. It is still a read: nothing is written, nothing is
    locked, and nothing is reserved. Somebody can label a class between this call
    and the publish, in which case the publish refuses and **that** refusal is the
    authoritative one — this removes the round trip that was doomed before it was
    sent, not the need to handle being refused.

    The body is the same shape `POST /versions` takes, so a client previews and
    publishes the identical document. `description` and `provenance` are accepted
    and ignored: neither enters a diff, and requiring a client to strip them would
    make the two calls differ for no reason.
    """
    classes = [label_class.to_domain() for label_class in body.classes]
    return SchemaChangePreviewOut.of(SchemaService(workspace).preview(project_id, classes))


@router.post("/blocking-assets", responses=documented(404))
def list_blocking_assets(
    workspace: WorkspaceDep,
    project_id: UUID,
    body: SchemaVersionCreate,
    limit: LimitQuery = None,
    offset: OffsetQuery = 0,
) -> BlockingAssetPage:
    """The frames behind `POST /preview`'s `blockers`, so a client can reach them.

    `preview` answers *how many* annotations block this proposal and under which
    classes; this answers *which frames carry them*, from the same walk, so a
    count and a listing of one narrowing cannot disagree.

    **The proposal is the whole class list, not a filter.** Which `(class, shape)`
    pairs are guarded is derived here from the diff, exactly as `preview` derives
    them — a client sending its own pairs could send a set the guard does not
    match, which is the disagreement this route exists to prevent.

    Each item names the frame, how many of *its* annotations the change would
    orphan, which blocking classes they carry, and every batch holding it.
    `batch_ids` is a list because an asset put in a batch and later in a
    correction of it is in both. A frame blocking under two classes is one item,
    so `total` is not the sum of `preview`'s per-class `assets`.

    `total` is every blocking frame, never the size of this page; an offset past
    the end is an empty list and a 200. An additive proposal blocks on nothing
    and answers an empty page.

    A POST for `preview`'s reason: a class list does not belong in a query
    string. It is still a read — nothing is written, nothing is locked — and
    `description` and `provenance` are accepted and ignored, so a client
    previews, lists and publishes the identical document.

    An unknown project is 404 `PROJECT_NOT_FOUND`.
    """
    classes = [label_class.to_domain() for label_class in body.classes]
    found = list(SchemaService(workspace).blocking_assets(project_id, classes))
    return BlockingAssetPage(
        items=[BlockingAssetOut.of(one) for one in window(found, limit=limit, offset=offset)],
        total=len(found),
    )


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


#: The draft's kind, in the path rather than a query, because it *identifies* one
#: of the two drafts a project can hold rather than filtering a collection. An
#: unknown word is a 422 about the request, which is what a path enum gives for
#: free.
KindPath = Annotated[SchemaProvenance, Path(description="Which kind of work the draft belongs to.")]


@router.get("/drafts/{kind}", responses=documented(404))
def get_schema_draft(workspace: WorkspaceDep, project_id: UUID, kind: KindPath) -> SchemaDraftOut:
    """The schema version this project is still writing, of that kind.

    A project holds at most one draft per kind and they are shared: there are no
    per-user drafts, because the workspace has no users — a credential is not a
    person. `curated` is the one a schema editor writes; `annotation` is the one
    that accumulates while somebody is labeling and needs a class.

    404 `SCHEMA_DRAFT_NOT_FOUND` means nobody has started one, which is the
    ordinary state of most projects. It is deliberately not the same refusal as
    an unknown project, which is 404 `PROJECT_NOT_FOUND`: the codes are what tell
    "there is nothing written yet" from "there is no such project".
    """
    draft = SchemaDraftService(workspace).get(project_id, kind)
    if draft is None:
        raise SchemaDraftNotFound(f"project {project_id} has no {kind.value} schema draft")
    return SchemaDraftOut.of(draft)


@router.put("/drafts/{kind}", responses=documented(404, 409))
def save_schema_draft(
    workspace: WorkspaceDep, project_id: UUID, kind: KindPath, body: SchemaDraftBody
) -> SchemaDraftOut:
    """Write the whole draft, creating it if there is none.

    The body is the entire draft; there is no partial edit, for the reason there
    is none of a version. Classes here are **not** validated as a contract would
    be: a class with no name and no geometry is stored exactly as sent, which is
    what lets somebody put the work down mid-sentence.

    `revision` is the revision this write was decided against, and omitting it
    asks to create. Either one refused answers 409 `STALE_WRITE`, which means
    somebody else wrote the draft first and this write was judged against an
    answer that had expired. Read it again and resubmit — nothing is merged, and
    nothing is overwritten.

    The response carries the new `revision`, which is what the next write and the
    publish must name.
    """
    saved = SchemaDraftService(workspace).save(
        project_id,
        kind,
        classes=[declared.to_domain() for declared in body.classes],
        note=body.note,
        based_on=body.based_on,
        expected_revision=body.revision,
    )
    return SchemaDraftOut.of(saved)


@router.delete("/drafts/{kind}", status_code=status.HTTP_204_NO_CONTENT, responses=documented(404))
def discard_schema_draft(workspace: WorkspaceDep, project_id: UUID, kind: KindPath) -> None:
    """Throw the draft away.

    Unconditional and revisionless, unlike every other write here: discarding is
    what somebody does having decided the work is not wanted, and making them
    read it first would be a round trip whose only purpose is to delete what it
    fetched. Discarding a draft that is not there is a 204 as well — the state
    afterwards is the state that was asked for.
    """
    SchemaDraftService(workspace).discard(project_id, kind)


@router.post(
    "/drafts/{kind}/publish",
    status_code=status.HTTP_201_CREATED,
    responses=documented(404, 409, 422),
)
def publish_schema_draft(
    workspace: WorkspaceDep,
    project_id: UUID,
    kind: KindPath,
    body: SchemaDraftPublish,
    allow_destructive: DestructiveQuery = False,
) -> SchemaPublicationOut:
    """Turn the draft into the next schema version, and clear it.

    The classes are the draft's, so nothing is sent here but the revision — which
    is what makes it impossible to publish something other than what the draft
    holds. The draft's note becomes the version's commit message and its kind
    becomes the version's `provenance`.

    Every refusal `POST /versions` can give, this can give, for the same reasons
    and with the same overrides: 409 `DESTRUCTIVE_SCHEMA_CHANGE` until
    `allow_destructive=true`, and 409 `SCHEMA_CHANGE_WOULD_ORPHAN` with no
    override at all. One more is its own: 422 `INVALID_SCHEMA` when a class in
    the draft is not finished — a blank name, no geometry, a select with no
    options — naming it by position, `classes.3`. A draft is allowed to hold
    those; a version is not.

    409 `STALE_WRITE` means the draft moved since `revision` was read, and no
    version was created. 409 `SCHEMA_VERSION_CONFLICT` means something else
    published while this call was deciding the next version number; that one is
    worth resending unchanged, since the retry re-reads the maximum.

    The draft is gone afterwards even when nothing was written: publishing the
    contract already in force answers with the version already in force, and the
    draft that proposed it has nothing left to say.
    """
    published = SchemaDraftService(workspace).publish(
        project_id,
        kind,
        expected_revision=body.revision,
        allow_destructive=allow_destructive,
    )
    return SchemaPublicationOut.of(published)
