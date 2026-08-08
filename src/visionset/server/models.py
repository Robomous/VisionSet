# usage: from visionset.server.models import ProjectOut, ProjectPage
"""The shapes this API speaks: every request body, every response body.

One module rather than one per router, because these are the contract's *nouns*
— the things that become TypeScript types in ``frontend/ui-core`` — and one file
answers "what does this API speak?" without opening ten routers.
``LabelClassBody`` is already shared by two routers today. When this outgrows one
screen per resource it becomes ``server/models/`` with a module per resource, and
the import path ``visionset.server.models`` does not change.

**Every class docstring in here is one short, plain sentence**, for the reason
``ErrorBody``'s already says: a model's docstring is copied verbatim into
``openapi.json``, so RST markup ships as literal backticks to every consumer and
a paragraph of design reasoning ships as API documentation. The reasoning lives
in comments, which do not travel.

**A wire model is not a domain model, and the separation is deliberate.** Three
things go wrong when a route returns a ``kernel.domain`` class directly:

1. **Docstrings ship verbatim** — see above. ``AnnotationSchema``'s own are
   written for a reader of the kernel, and rewriting them for a server reason is
   the tail wagging the dog.
2. **Domain-internal aliases become public components.** A PEP 695
   ``type X = ...`` alias emits a *named* schema into ``components``; the domain's
   ``AttributeValue`` would land there. Spelling a union inline emits an
   anonymous one on the field instead. This bites inside this module too, which
   is why ``AttributeBody.kind`` carries no alias.
3. **Defaults make response fields optional.** ``AnnotationSchema.classes`` has a
   default, so a generated client would type it ``classes?: LabelClass[]`` for a
   field that is always present. A response model with no defaults says what it
   means.

So a field reaches a client because somebody put it here, never because somebody
added it to an entity. That is the ``visionset token list`` rule — name the
columns one at a time — applied to the wire.
"""

from __future__ import annotations

from collections.abc import Set as AbstractSet
from datetime import datetime
from typing import Annotated, Literal, Self
from uuid import UUID, uuid4

from fastapi import Query
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationJobState,
    AnnotationSchema,
    Asset,
    AssetAction,
    AssetProgress,
    Attribute,
    BackgroundJob,
    BackgroundJobState,
    Batch,
    BatchAction,
    BatchState,
    BboxGeometry,
    BySegments,
    BySize,
    ChangeKind,
    ClassCompatibility,
    ClassCount,
    ClassExportStatus,
    ClassificationGeometry,
    ConnectionAction,
    ConnectionSetupState,
    ConnectionType,
    Dataset,
    DatasetChange,
    DatasetStats,
    ExportCompatibility,
    Geometry,
    GeometryType,
    ImageFormat,
    InferenceConnection,
    IngestFailure,
    IngestFailureKind,
    IngestJob,
    IngestState,
    ItemFailure,
    JobAction,
    LabelClass,
    MembershipChange,
    Partition,
    PolygonGeometry,
    PolylineGeometry,
    Project,
    ProjectStats,
    Release,
    ReleaseVerification,
    SchemaChange,
    SchemaDiff,
    SchemaProvenance,
    SingleJob,
    Source,
    SourceKind,
    SplitAssignment,
    SplitRecipe,
    VideoProvenance,
    asset_actions,
    batch_actions,
    connection_actions,
    job_actions,
)
from visionset.kernel.ports import Exporter

# A gate is a query parameter and never a body field, so a client that gets a 409
# resubmits the *identical* request with one extra parameter — which is what
# ``docs/api.md``'s retry table promises. The route passes it straight to the
# service: the refusal belongs to the kernel, and a pre-check here would be a
# second copy of a rule that already has an owner.
ConfirmQuery = Annotated[
    bool,
    Query(description="Required to destroy data. The kernel refuses the request without it."),
]

DestructiveQuery = Annotated[
    bool,
    Query(description="Required when the new version narrows the labeling contract."),
]


# Every collection answers with this envelope rather than a bare JSON array,
# because an array cannot grow a field without breaking every client that parsed
# it. ``total`` means "matching the query" rather than "in this page", which is
# exactly what let #29 add ``limit``/``offset`` to one route without moving the
# shape a client already parsed.
#
# This class is never a response model itself; a concrete subclass is. FastAPI
# names a parametrised generic ``Page_ProjectOut_`` in the spec, which is not a
# name to hand a client generator. The PEP 695 syntax is required rather than
# preferred: ruff's UP046 rejects ``Generic[T]`` as a base.
class Page[T](BaseModel):
    """One page of a collection."""

    items: list[T]
    total: int


# Paging is on the batch asset listing and nowhere else, because that is the one
# collection that can hold fifty thousand frames — M5's gallery is the caller.
# The others are small by construction and get these when a caller appears.
#
# Say the honest thing out loud: **this bounds the response, not the read.** The
# kernel has no windowed read, so ``window`` slices a full list and ``total`` is
# the full count. That is worth doing anyway — a gallery must not be sent every
# frame at once — but it is not a cheap query, and pretending otherwise is what
# ``docs/api.md`` warned against. When the *read* starts to cost, ``window`` is
# replaced by a port method and none of this moves.
LimitQuery = Annotated[
    int | None,
    Query(ge=1, description="How many items to return. Everything from `offset` on by default."),
]

OffsetQuery = Annotated[
    int,
    Query(ge=0, description="How many items to skip. Counts from the start of the collection."),
]


def window[T](items: list[T], *, limit: int | None, offset: int) -> list[T]:
    """The slice ``limit`` and ``offset`` ask for, out of everything that matched.

    An offset past the end is an empty window, never an error: a client walking
    a collection that shrank under it should stop, not fail.
    """
    return items[offset:] if limit is None else items[offset : offset + limit]


# --- projects ----------------------------------------------------------------


# ``workspace_id`` is deliberately absent: the server serves exactly one
# workspace, so it would be the same constant on every response ever sent.
class ProjectOut(BaseModel):
    """A project."""

    id: UUID
    name: str
    description: str | None

    @classmethod
    def of(cls, project: Project) -> Self:
        # Field by field, never ``model_validate(project, from_attributes=True)``:
        # a field added to ``Project`` must not widen the public contract by
        # accident. Publishing one is an edit here.
        return cls(id=project.id, name=project.name, description=project.description)


class ProjectPage(Page[ProjectOut]):
    """A page of projects."""


class ProjectCreate(BaseModel):
    """What creating a project needs."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str | None = None


# The description is not here because ``ProjectService`` has no way to update it.
# The API does not grow a field the SDK cannot honour.
class ProjectRename(BaseModel):
    """The one field of a project that moves."""

    model_config = ConfigDict(extra="forbid")

    name: str


# --- annotation schemas ------------------------------------------------------


# Request *and* response, because an attribute is a pure value object whose wire
# form does not differ by direction. FastAPI emits one component for it, so a
# client generator produces one type rather than an -Input/-Output pair. A
# ``@computed_field`` added here would split it in two, which makes adding one a
# contract event rather than a refactor.
class AttributeBody(BaseModel):
    """A typed attribute on a label class."""

    model_config = ConfigDict(extra="forbid")

    name: str
    # Spelled inline rather than through an alias — reason 2 in the module
    # docstring, biting in this very module. A module-level
    # ``type AttributeKind = ...`` emits a named ``AttributeKind`` schema into
    # ``components``; an inline ``Literal`` emits an anonymous enum on the field.
    # ``tests/server/test_wire_models.py`` asserts these are still the domain's
    # own four, since nothing structural ties the two lists together.
    kind: Literal["string", "number", "boolean", "select"]
    required: bool = False
    options: tuple[str, ...] | None = None
    default: bool | float | str | None = None

    @model_validator(mode="after")
    def _the_domain_accepts_it(self) -> Self:
        # Load-bearing. A ``select`` with no options, a repeated option, a default
        # of the wrong kind — every one is refused by ``Attribute``'s own
        # validators, and a ``pydantic.ValidationError`` raised from a route
        # *body* is neither a ``VisionSetError`` nor a ``RequestValidationError``:
        # it reaches the catch-all handler and answers 500 INTERNAL_ERROR to a
        # plainly malformed payload. Converting during parsing makes it a 422
        # VALIDATION_ERROR carrying the domain's own message and the offending
        # field's ``loc``. No rule is restated; the domain stays their only home.
        self.to_domain()
        return self

    def to_domain(self) -> Attribute:
        return Attribute(
            name=self.name,
            kind=self.kind,
            required=self.required,
            options=self.options,
            default=self.default,
        )

    @classmethod
    def of(cls, attribute: Attribute) -> Self:
        return cls(
            name=attribute.name,
            kind=attribute.kind,
            required=attribute.required,
            options=attribute.options,
            default=attribute.default,
        )


# Request and response, for the reason above ``AttributeBody``.
class LabelClassBody(BaseModel):
    """One labelable class, bound to a geometry."""

    model_config = ConfigDict(extra="forbid")

    name: str
    # All eight members, including the five with no implementation yet. They are
    # the domain's vocabulary, and naming one produces a precise 422
    # UNSUPPORTED_GEOMETRY from ``SchemaService``. Narrowing the enum here would
    # be a second list to keep in step with ``IMPLEMENTED_GEOMETRIES`` — which is
    # derived off the ``Geometry`` union precisely so no second list exists.
    geometry: GeometryType
    color: str | None = None
    attributes: tuple[AttributeBody, ...] = ()

    @model_validator(mode="after")
    def _the_domain_accepts_it(self) -> Self:
        # Parsing-time construction, for the reason in ``AttributeBody``.
        self.to_domain()
        return self

    def to_domain(self) -> LabelClass:
        return LabelClass(
            name=self.name,
            geometry=self.geometry,
            color=self.color,
            attributes=tuple(attribute.to_domain() for attribute in self.attributes),
        )

    @classmethod
    def of(cls, label_class: LabelClass) -> Self:
        return cls(
            name=label_class.name,
            geometry=label_class.geometry,
            color=label_class.color,
            attributes=tuple(AttributeBody.of(a) for a in label_class.attributes),
        )


# The version's ``id`` is deliberately absent. A schema version is addressed by
# (project, version) everywhere it matters — the path, ``Annotation.schema_version``,
# the pin a batch takes at approval — so a UUID no route accepts would be
# contract surface that could never be removed.
class SchemaVersionOut(BaseModel):
    """One version of a project's labeling contract."""

    project_id: UUID
    version: int
    classes: tuple[LabelClassBody, ...]
    # Both are null for a version published before they existed, and nothing
    # backfills either — see ``docs/schemas.md``. Declared with defaults so the
    # field is emitted as optional, which is what a client reading an old
    # workspace actually meets.
    description: str | None = None
    created_at: datetime | None = None
    # Null for a version published before this existed and for any writer with no
    # opinion, so a client groups null with `curated` rather than treating it as a
    # third kind. Used directly, the `GeometryType` precedent: a `StrEnum` the
    # kernel branches on, no writer outside this build produces one, and the set
    # grows deliberately.
    provenance: SchemaProvenance | None = None

    @classmethod
    def of(cls, schema: AnnotationSchema) -> Self:
        return cls(
            project_id=schema.project_id,
            version=schema.version,
            classes=tuple(LabelClassBody.of(c) for c in schema.classes),
            description=schema.description,
            created_at=schema.created_at,
            provenance=schema.provenance,
        )


class SchemaVersionPage(Page[SchemaVersionOut]):
    """A page of schema versions."""


# ``ChangeKind`` is used directly, the ``GeometryType`` precedent: it is a
# ``StrEnum`` the kernel branches on, no writer outside this build produces one,
# and the set grows deliberately. Restating it here would be a second spelling of
# the same two words.
class SchemaChangeOut(BaseModel):
    """One difference between two schema versions, already judged."""

    kind: ChangeKind
    label_class: str
    attribute: str | None
    detail: str

    @classmethod
    def of(cls, change: SchemaChange) -> Self:
        return cls(
            kind=change.kind,
            label_class=change.label_class,
            attribute=change.attribute,
            detail=change.detail,
        )


class SchemaDiffOut(BaseModel):
    """Every difference between two schema versions, and the verdict on them."""

    # Both are domain ``@property`` values materialized here, the way
    # ``ReleaseVerification.ok`` is: a client deciding whether it needs
    # ``allow_destructive`` must not re-derive the answer from ``changes`` and get
    # it subtly wrong. That derivation is ``domain/schema_diff.py``'s one job.
    is_destructive: bool
    destructive_classes: tuple[str, ...]
    changes: tuple[SchemaChangeOut, ...]

    @classmethod
    def of(cls, diff: SchemaDiff) -> Self:
        return cls(
            is_destructive=diff.is_destructive,
            destructive_classes=tuple(sorted(diff.destructive_classes)),
            changes=tuple(SchemaChangeOut.of(change) for change in diff.changes),
        )


class SchemaVersionCreate(BaseModel):
    """The whole proposed version. There is no partial edit of a schema."""

    model_config = ConfigDict(extra="forbid")

    classes: tuple[LabelClassBody, ...] = ()
    # The version's commit message, written once here. There is no route that
    # edits one afterwards, because there is no service method that does.
    description: str | None = None
    # Which kind of work is publishing this. Optional because a client with no
    # opinion should say nothing rather than pick a side; stored verbatim, never
    # inferred from the request.
    provenance: SchemaProvenance | None = None


# --- sources -----------------------------------------------------------------


# Flattened rather than nesting the domain's own ``VideoMetadata``, which would
# publish a kernel model under its kernel docstring — the module rule above. The
# two rates are the reason this type exists at all: ``fps`` is what the file was
# *shot* at and ``extraction_fps`` is what we chose to *cut* it at, and a client
# that confuses them decomposes at the wrong rate. See ``docs/sources.md``.
class VideoProvenanceOut(BaseModel):
    """What a clip turned out to be, and the rate it is decomposed at."""

    width: int
    height: int
    fps: float
    duration_seconds: float
    codec: str
    extraction_fps: float

    @classmethod
    def of(cls, provenance: VideoProvenance) -> Self:
        return cls(
            width=provenance.metadata.width,
            height=provenance.metadata.height,
            fps=provenance.metadata.fps,
            duration_seconds=provenance.metadata.duration_seconds,
            codec=provenance.metadata.codec,
            extraction_fps=provenance.extraction_fps,
        )


# ``Source.path`` is deliberately absent, and this is the one omission worth
# stating twice. It is an absolute path on the server's own filesystem, inside
# the workspace's staging area — a client can do nothing with it, and publishing
# it hands every token holder the layout of the machine. ``name`` is the part a
# client recognises: the filename it uploaded.
class SourceOut(BaseModel):
    """A registered origin: a folder of stills, or a clip."""

    id: UUID
    project_id: UUID
    kind: SourceKind
    name: str
    registered_at: datetime
    video: VideoProvenanceOut | None

    @classmethod
    def of(cls, source: Source) -> Self:
        return cls(
            id=source.id,
            project_id=source.project_id,
            kind=source.kind,
            # The domain's one spelling of "what to call this source" (#245):
            # the stated display name, else the path's last segment. Deriving
            # from ``path`` here again is how this and ``visionset.wire`` would
            # eventually answer differently.
            name=source.name,
            registered_at=source.registered_at,
            video=None if source.video is None else VideoProvenanceOut.of(source.video),
        )


class SourcePage(Page[SourceOut]):
    """A page of sources."""


# --- ingest ------------------------------------------------------------------


class IngestFailureOut(BaseModel):
    """One item a run could not read, and why."""

    name: str
    kind: IngestFailureKind
    reason: str

    @classmethod
    def of(cls, failure: IngestFailure) -> Self:
        return cls(name=failure.name, kind=failure.kind, reason=failure.reason)


# The polling contract. ``processed``/``total``/``failures`` are written to the
# row as the run goes, so this says where a run *is* rather than where it ended;
# ``total`` is null for a clip, because ``VideoMetadata`` carries no frame count
# by design and a guess is worse than an honest absence. ``error`` is the fatal
# cause and is a different field from ``failures`` on purpose — one broken
# machine is not five thousand broken files.
class IngestJobOut(BaseModel):
    """One run of one source, and how far it has got."""

    id: UUID
    source_id: UUID
    state: IngestState
    error: str | None
    batch_id: UUID | None
    batch_name: str | None
    processed: int
    total: int | None
    failures: tuple[IngestFailureOut, ...]

    @classmethod
    def of(cls, job: IngestJob) -> Self:
        return cls(
            id=job.id,
            source_id=job.source_id,
            state=job.state,
            error=job.error,
            batch_id=job.batch_id,
            batch_name=job.batch_name,
            processed=job.processed,
            total=job.total,
            failures=tuple(IngestFailureOut.of(failure) for failure in job.failures),
        )


class IngestJobPage(Page[IngestJobOut]):
    """A page of ingest jobs."""


# ``batch_id`` waited for #29 and arrives with it. The objection was never the
# feature: it was that a refusal must not leave a caller holding a 202 that
# points at a job row nobody wrote. It does not. ``IngestService.enqueue`` checks
# the batch in the same transaction that inserts the job, so an unknown batch is
# a 404 and a batch past ``draft`` is a 409 — both *before* the row, both
# answered on the request that asked for them.
#
# And there is deliberately **no** ``_the_domain_accepts_it`` validator, which is
# the interesting half. ``LabelClassBody`` needs one because ``LabelClass``
# refuses with a *pydantic* ``ValidationError``, which is neither a
# ``VisionSetError`` nor a ``RequestValidationError`` and so answers 500. A blank
# batch name refuses with ``InvalidName`` — a domain error, already in
# ``ERROR_RULES`` at 422 ``INVALID_NAME`` — so the kernel's own refusal arrives
# correctly on its own and a validator here would only restate it, less precisely.
class IngestStart(BaseModel):
    """What launching a run needs, which is almost nothing."""

    model_config = ConfigDict(extra="forbid")

    batch_id: UUID | None = None
    batch_name: str | None = None


# --- background jobs ----------------------------------------------------------


class ItemFailureOut(BaseModel):
    """One item a job could not process, and why."""

    name: str
    reason: str

    @classmethod
    def of(cls, failure: ItemFailure) -> Self:
        return cls(name=failure.name, reason=failure.reason)


# The generic polling contract, and the deliberate twin of ``IngestJobOut``.
#
# **They are two shapes because they describe two things**, and merging them
# would make both worse. An ingest job knows what it is about — a source, a batch
# — and publishes those as named fields a client can navigate. A background job
# is about whatever its ``payload`` says, so it publishes ``type`` and ``result``
# instead: opaque to this model, meaningful to whoever queued it. What they share
# — ``processed``/``total``/``failures``/``error`` — they share by convention, so
# a progress bar written against one renders the other unchanged.
#
# ``payload`` is **absent**. It is an internal contract between a surface and a
# handler, it can name a path, and nothing on the client side has any business
# reading it — the rule that keeps ``Source.path`` and ``Asset.uri`` off the wire.
# ``result`` is present because it is the answer: it is how a caller learns an
# export finished and where the archive is.
class BackgroundJobOut(BaseModel):
    """One unit of background work, and how far it has got."""

    id: UUID
    type: str
    state: BackgroundJobState
    processed: int
    total: int | None
    failures: tuple[ItemFailureOut, ...]
    error: str | None
    result: dict[str, JsonValue]
    cancel_requested: bool
    attempt: int
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    @classmethod
    def of(cls, job: BackgroundJob) -> Self:
        return cls(
            id=job.id,
            type=job.type,
            state=job.state,
            processed=job.processed,
            total=job.total,
            failures=tuple(ItemFailureOut.of(failure) for failure in job.failures),
            error=job.error,
            result=job.result,
            cancel_requested=job.cancel_requested,
            attempt=job.attempt,
            created_at=job.created_at,
            started_at=job.started_at,
            finished_at=job.finished_at,
        )


class BackgroundJobPage(Page[BackgroundJobOut]):
    """A page of background jobs."""


# --- assets ------------------------------------------------------------------


# ``Asset.uri`` is absent for the reason ``Source.path`` is: it is a server-side
# path, and for a frame it is that path plus ``#frame=N``. The bytes are reached
# through the download routes instead, which address an asset by *id* and carry
# the hashes below as their ``ETag`` — a hash names bytes and not a media type,
# and resolving one back to its asset would need a query the persistence port
# deliberately does not have.
class AssetOut(BaseModel):
    """One ingested item."""

    id: UUID
    project_id: UUID
    modality: Literal["image"]
    content_hash: str
    width: int | None
    height: int | None
    format: ImageFormat | None
    source_id: UUID | None
    frame_index: int | None
    frame_timestamp: float | None
    thumbnail_hash: str | None
    # When this asset arrived (#216, published by #283). **Null means unknown,
    # not "never"**: the column is nullable because rows written before it
    # existed are legitimately unstamped, and `ProjectStats.last_ingest_at`
    # already makes the same distinction one level up. A client deriving an age
    # from it has to render that third state rather than treating null as zero.
    ingested_at: datetime | None

    @classmethod
    def of(cls, asset: Asset) -> Self:
        return cls(
            id=asset.id,
            project_id=asset.project_id,
            modality=asset.modality,
            content_hash=asset.content_hash,
            width=asset.width,
            height=asset.height,
            format=asset.format,
            source_id=asset.source_id,
            frame_index=asset.frame_index,
            frame_timestamp=asset.frame_timestamp,
            thumbnail_hash=asset.thumbnail_hash,
            ingested_at=asset.ingested_at,
        )


class AssetPage(Page[AssetOut]):
    """A page of assets."""


# --- batches -----------------------------------------------------------------


# Five explicit fields rather than ``dict[AssetProgress, int]``, which would emit
# an open object and generate as a ``Record<string, number>`` — a type that
# cannot tell a client which keys it will actually find. ``JobService`` already
# guarantees every state is present, so the fields are honest, and the price is
# ``test_wire_models.py`` asserting they are still the enum's own members.
class ProgressCounts(BaseModel):
    """How many assets sit in each annotation state."""

    unannotated: int
    annotated: int
    skipped: int
    review_pending: int
    accepted: int
    total: int

    @classmethod
    def of(cls, counts: dict[AssetProgress, int]) -> Self:
        return cls(
            unannotated=counts[AssetProgress.UNANNOTATED],
            annotated=counts[AssetProgress.ANNOTATED],
            skipped=counts[AssetProgress.SKIPPED],
            review_pending=counts[AssetProgress.REVIEW_PENDING],
            accepted=counts[AssetProgress.ACCEPTED],
            total=sum(counts.values()),
        )


# ``asset_ids`` is deliberately absent: membership is the paged listing's job,
# and a batch of fifty thousand frames would otherwise ship its whole roll call
# on every read of its name. ``schema_version`` is null exactly while the batch
# is a draft — approval is what pins one, and after that it moves only
# through an explicit re-pin.
#
# ``promoted_asset_count`` is how many of this batch's assets are in the trunk
# **right now**, and it exists because promotion was otherwise unobservable.
# Promoting is not a transition — the batch stays ``completed`` — and no read
# model recorded that it had happened, so a client could not tell "promoted 3 of
# 48" from "promoted nothing because it was already done" from "the press did
# nothing at all". Every one of those looked identical, which is what made a
# working call read as a broken button.
#
# Current membership rather than a promotion log: a curator removing an asset
# takes it back out, and "how much of this batch is in the dataset" is the
# question anybody looking at a batch is actually asking. It is derived per call
# and never stored — ``Release.asset_count`` is the frozen counterpart, and it
# belongs to the release.
#
# ``promoted`` is passed in rather than read here, and that is the cost model:
# the caller reads the trunk's membership **once per request** and every batch in
# a listing tests against the same set, so a page of twenty batches is one extra
# query rather than twenty. ``batch.asset_ids`` is already in memory — it is what
# ``asset_count`` counts.
class BatchOut(BaseModel):
    """A curated slice of a project's assets that moves through annotation together."""

    id: UUID
    project_id: UUID
    name: str
    state: BatchState
    schema_version: int | None
    asset_count: int
    progress: ProgressCounts
    allowed_actions: list[BatchAction]
    promoted_asset_count: int
    # The batch this one was cut from, when it is a correction of another. Null
    # means *not a correction of anything*, which is complete rather than
    # unknown — every batch that exists today answers null.
    parent_batch_id: UUID | None

    @classmethod
    def of(
        cls,
        batch: Batch,
        counts: dict[AssetProgress, int],
        *,
        promoted: AbstractSet[UUID],
    ) -> Self:
        return cls(
            id=batch.id,
            project_id=batch.project_id,
            name=batch.name,
            state=batch.state,
            schema_version=batch.schema_version,
            asset_count=len(batch.asset_ids),
            progress=ProgressCounts.of(counts),
            allowed_actions=batch_actions(batch.state),
            promoted_asset_count=sum(1 for one in batch.asset_ids if one in promoted),
            parent_batch_id=batch.parent_batch_id,
        )


class BatchPage(Page[BatchOut]):
    """A page of batches."""


# The three partition strategies are re-spelled rather than reused, for the
# reason at the top of this module: ``BySize``'s docstring carries RST
# double-backticks and ``BySegments``' carries a ``:func:`` role, and both would
# ship verbatim into the contract. The discriminator values are the domain's own,
# so a payload that parses here parses there.
#
# **The discriminator carries no default**, unlike the domain models these
# mirror, and that is deliberate: pydantic reads the tag out of the *input* to
# pick a variant, so a payload omitting it is refused however the field is
# declared. A default would emit ``kind`` as optional in the contract while the
# parser still required it — a schema that says a client may leave out the one
# field it must send.
class SingleJobBody(BaseModel):
    """One job for the whole batch."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["single"]

    def to_domain(self) -> SingleJob:
        return SingleJob()


class BySizeBody(BaseModel):
    """Jobs of a fixed number of assets each; the last one takes the remainder."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["by_size"]
    size: int

    def to_domain(self) -> BySize:
        return BySize(size=self.size)


class BySegmentsBody(BaseModel):
    """Exactly these segments, which must reproduce the batch with nothing over."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["by_segments"]
    segments: tuple[tuple[UUID, ...], ...]

    def to_domain(self) -> BySegments:
        return BySegments(segments=self.segments)


# A plain assignment, not a PEP 695 ``type`` alias — the latter emits a named
# component, which is reason 2 in this module's docstring.
PartitionBody = Annotated[SingleJobBody | BySizeBody | BySegmentsBody, Field(discriminator="kind")]


class BatchCreate(BaseModel):
    """A new draft batch: a name, and the assets to start it with."""

    model_config = ConfigDict(extra="forbid")

    name: str
    # Empty is legitimate — a batch nobody has filled yet is an intermediate
    # state, and `EmptyBatch` is what refuses *approving* one. The kernel refuses
    # an id outside the project with `AssetNotFound`, so nothing is restated here.
    asset_ids: list[UUID] = Field(default_factory=list)


class BatchMembership(BaseModel):
    """Which assets to put in, or take out of, a draft batch."""

    model_config = ConfigDict(extra="forbid")

    # Required, unlike `BatchCreate.asset_ids`: creating an empty batch is a
    # legitimate intermediate state, but *editing* membership without naming a
    # single asset is a request that means nothing, and a default would turn it
    # into a silent 200 that did nothing.
    asset_ids: list[UUID] = Field(min_length=1)


class BatchMembershipOut(BaseModel):
    """A membership edit's outcome: the batch afterwards, and what actually moved."""

    # Two facts rather than one, because the batch alone cannot answer the
    # question a bulk edit raises. `changed` is what *this call* wrote — every id
    # it was given minus the ones the batch already agreed about — so "removed 3"
    # can be told from "3 were already gone". An idempotent operation that
    # reports only the final state loses exactly that distinction, and #305's
    # third banned pattern is a surface with no way to tell "did N" from "nothing
    # to do".
    batch: BatchOut
    changed: list[UUID]

    @classmethod
    def of(
        cls,
        change: MembershipChange,
        counts: dict[AssetProgress, int],
        *,
        promoted: AbstractSet[UUID],
    ) -> Self:
        return cls(
            batch=BatchOut.of(change.batch, counts, promoted=promoted),
            changed=list(change.changed),
        )


class BatchCorrection(BaseModel):
    """A correction of a completed batch: a name, and optionally a subset."""

    model_config = ConfigDict(extra="forbid")

    name: str
    # Empty means **the parent's whole membership**, which is why this cannot be
    # folded into `BatchCreate`: there the same value means "no assets", and one
    # field meaning two opposite things across two routes is worse than two
    # models. The kernel refuses an id the parent never carried.
    asset_ids: list[UUID] = Field(default_factory=list)


class BatchApprove(BaseModel):
    """How to cut the batch into jobs. One job for the whole batch by default."""

    model_config = ConfigDict(extra="forbid")

    partition: PartitionBody | None = None

    @model_validator(mode="after")
    def _the_domain_accepts_it(self) -> Self:
        # Parsing-time construction, for the reason in ``AttributeBody``: a
        # ``by_size`` of 0 is refused by ``BySize``'s own ``gt=0``, and a
        # pydantic ``ValidationError`` raised from a route body answers 500.
        self.to_domain()
        return self

    def to_domain(self) -> Partition | None:
        return None if self.partition is None else self.partition.to_domain()


# --- jobs --------------------------------------------------------------------


# ``task_group_id`` is absent: no route reaches a task group, so publishing the
# id would be contract surface that could never be removed — the rule that keeps
# a schema version's own UUID off ``SchemaVersionOut``. ``batch_id`` is here
# instead, because it is the handle a client actually needs: it leads to the
# pinned schema its work is judged against. The per-asset progress map is absent
# too; a job of fifty thousand assets must not ship one on every read, and the
# paged batch listing is where per-asset detail lives.
class JobOut(BaseModel):
    """One annotator's unit of work over a segment of a batch."""

    id: UUID
    batch_id: UUID
    state: AnnotationJobState
    asset_count: int
    allowed_actions: list[JobAction]

    # ``batch`` whole rather than an id: both actions need the batch open, which
    # is the dimension a client re-deriving these rules dropped. The per-asset map
    # stays unpublished and is still read here, because ``complete`` is refined by
    # whether every asset has settled — a refinement that costs no extra read.
    @classmethod
    def of(cls, job: AnnotationJob, *, batch: Batch) -> Self:
        return cls(
            id=job.id,
            batch_id=batch.id,
            state=job.state,
            asset_count=len(job.progress),
            allowed_actions=job_actions(
                job.state, batch_state=batch.state, progress=job.progress.values()
            ),
        )


class JobPage(Page[JobOut]):
    """A page of annotation jobs."""


# Inherits rather than repeats ``AssetOut``'s eleven fields, so a field published
# there is published here too — the one place in this module where a widening
# should propagate, because these are the same asset seen from inside a batch.
class BatchAssetOut(AssetOut):
    """One item of a batch, with the job that carries it and where it has got to."""

    job_id: UUID | None
    progress: AssetProgress | None
    allowed_actions: list[AssetAction]

    @classmethod
    def in_batch(
        cls,
        asset: Asset,
        *,
        job_id: UUID | None,
        job_state: AnnotationJobState | None,
        progress: AssetProgress | None,
        batch_state: BatchState,
    ) -> Self:
        # ``job_id``, ``job_state`` and ``progress`` are null together and exactly
        # while the batch is a draft, which is honest rather than lossy: a draft
        # has no jobs, so no asset in it has any of the three. ``batch_state`` and
        # ``job_state`` are arguments and not fields — each belongs to the
        # resource that publishes it — but nothing can be said about what this
        # asset allows without both.
        return cls(
            **AssetOut.of(asset).model_dump(),
            job_id=job_id,
            progress=progress,
            allowed_actions=asset_actions(progress, batch_state=batch_state, job_state=job_state),
        )


class BatchAssetPage(Page[BatchAssetOut]):
    """A page of the assets in a batch."""


class AssetProgressOut(BaseModel):
    """Where one asset of a job has got to."""

    asset_id: UUID
    progress: AssetProgress


class AssetProgressSet(BaseModel):
    """The state to record for one asset."""

    model_config = ConfigDict(extra="forbid")

    progress: AssetProgress


# --- annotations -------------------------------------------------------------


# Re-spelled rather than reused, like the partition bodies above and for the same
# reason: every domain geometry docstring carries RST markup. The ``type`` values
# are ``GeometryType`` members, exactly as in the domain, so the discriminator is
# one vocabulary and not two parallel lists of strings.
#
# None of the domain's own bounds are restated here — a zero-width box, a polygon
# of two points, a confidence of 2.0. They are refused by the domain models when
# ``to_domain()`` runs inside the validator below, which is what carries the
# kernel's own wording into the 422. Restating them would be a second copy of a
# rule that already has an owner.
class BboxBody(BaseModel):
    """An axis-aligned rectangle: top-left corner plus size, in asset pixels."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[GeometryType.BBOX]
    x: float
    y: float
    width: float
    height: float

    def to_domain(self) -> BboxGeometry:
        return BboxGeometry(x=self.x, y=self.y, width=self.width, height=self.height)

    @classmethod
    def of(cls, geometry: BboxGeometry) -> Self:
        return cls(
            type=GeometryType.BBOX,
            x=geometry.x,
            y=geometry.y,
            width=geometry.width,
            height=geometry.height,
        )


class PolygonBody(BaseModel):
    """A closed polygon of at least three points. The closing edge is implicit."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[GeometryType.POLYGON]
    points: list[tuple[float, float]]

    def to_domain(self) -> PolygonGeometry:
        return PolygonGeometry(points=self.points)

    @classmethod
    def of(cls, geometry: PolygonGeometry) -> Self:
        return cls(type=GeometryType.POLYGON, points=list(geometry.points))


class PolylineBody(BaseModel):
    """An open path of at least two points, in order. Nothing joins the ends."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[GeometryType.POLYLINE]
    points: list[tuple[float, float]]

    def to_domain(self) -> PolylineGeometry:
        return PolylineGeometry(points=self.points)

    @classmethod
    def of(cls, geometry: PolylineGeometry) -> Self:
        return cls(type=GeometryType.POLYLINE, points=list(geometry.points))


class ClassificationBody(BaseModel):
    """A whole-asset tag: a class with no coordinates."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[GeometryType.CLASSIFICATION_TAG]

    def to_domain(self) -> ClassificationGeometry:
        return ClassificationGeometry()

    @classmethod
    def of(cls, geometry: ClassificationGeometry) -> Self:
        return cls(type=GeometryType.CLASSIFICATION_TAG)


GeometryBody = Annotated[
    BboxBody | PolygonBody | PolylineBody | ClassificationBody, Field(discriminator="type")
]


def geometry_of(geometry: Geometry) -> BboxBody | PolygonBody | PolylineBody | ClassificationBody:
    """The wire form of a stored geometry, matched on the same discriminator."""
    match geometry:
        case BboxGeometry():
            return BboxBody.of(geometry)
        case PolygonGeometry():
            return PolygonBody.of(geometry)
        case PolylineGeometry():
            return PolylineBody.of(geometry)
        case ClassificationGeometry():
            return ClassificationBody.of(geometry)


# ``schema_version`` is deliberately not on either request: ``AnnotationService``
# stamps the version its batch pinned over whatever a caller passes, so a field
# here would be one a client could set and never observe. ``to_domain`` passes 1
# as the placeholder the SDK docs already use.
#
# ``attributes`` is spelled inline rather than through the domain's
# ``AttributeValue``, which is a PEP 695 alias and would land in ``components``.
class AnnotationCreate(BaseModel):
    """One annotation to store, judged against the version its batch pinned."""

    model_config = ConfigDict(extra="forbid")

    asset_id: UUID
    label_class: str
    geometry: GeometryBody
    attributes: dict[str, bool | float | str] = {}
    provenance: Literal["human", "model", "import"]
    model_ref: str | None = None
    confidence: float | None = None

    @model_validator(mode="after")
    def _the_domain_accepts_it(self) -> Self:
        # Load-bearing, and the same trap ``AttributeBody`` documents.
        # ``provenance='model'`` with no ``model_ref``, a confidence outside
        # [0, 1] and a zero-area box are all refused by ``Annotation`` and its
        # geometries with a *pydantic* ``ValidationError`` — which is neither a
        # ``VisionSetError`` nor a ``RequestValidationError``, so without this it
        # reaches the catch-all handler and answers 500 to a malformed payload.
        self.to_domain()
        return self

    def to_domain(self) -> Annotation:
        return Annotation(
            asset_id=self.asset_id,
            label_class=self.label_class,
            schema_version=1,
            geometry=self.geometry.to_domain(),
            attributes=dict(self.attributes),
            provenance=self.provenance,
            model_ref=self.model_ref,
            confidence=self.confidence,
        )


# Addressed by ``id`` and by nothing else — annotations are never reached by
# index or position. ``asset_id`` is absent because the stored one wins: moving a
# label to another asset is a delete and an add, not an edit, and the SDK would
# silently discard the field anyway.
class AnnotationUpdate(BaseModel):
    """One stored annotation, replaced whole."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    label_class: str
    geometry: GeometryBody
    attributes: dict[str, bool | float | str] = {}
    provenance: Literal["human", "model", "import"]
    model_ref: str | None = None
    confidence: float | None = None

    @model_validator(mode="after")
    def _the_domain_accepts_it(self) -> Self:
        self.to_domain()
        return self

    def to_domain(self) -> Annotation:
        # ``asset_id`` is a throwaway. ``Annotation`` requires one and the payload
        # has none, and ``AnnotationService.update`` overwrites whatever it is
        # given with the *stored* asset — which is the rule this body exists to
        # honour, not a detail to work around. Generating one here rather than
        # taking a parameter keeps every caller from having to invent a value
        # whose only property is that it is discarded.
        return Annotation(
            id=self.id,
            asset_id=uuid4(),
            label_class=self.label_class,
            schema_version=1,
            geometry=self.geometry.to_domain(),
            attributes=dict(self.attributes),
            provenance=self.provenance,
            model_ref=self.model_ref,
            confidence=self.confidence,
        )


class AnnotationOut(BaseModel):
    """One stored annotation, in the asset's own pixel frame."""

    id: UUID
    asset_id: UUID
    label_class: str
    schema_version: int
    geometry: GeometryBody
    attributes: dict[str, bool | float | str]
    provenance: Literal["human", "model", "import"]
    model_ref: str | None
    confidence: float | None
    # Which round of work produced this label. Null means genuinely unknown: a
    # label written before the column existed whose asset belonged to more than
    # one job, so nothing could attribute it. Not to be confused with
    # ``provenance``, which says what *kind of thing* made it.
    job_id: UUID | None

    @classmethod
    def of(cls, annotation: Annotation) -> Self:
        return cls(
            id=annotation.id,
            asset_id=annotation.asset_id,
            label_class=annotation.label_class,
            schema_version=annotation.schema_version,
            geometry=geometry_of(annotation.geometry),
            attributes=dict(annotation.attributes),
            provenance=annotation.provenance,
            model_ref=annotation.model_ref,
            confidence=annotation.confidence,
            job_id=annotation.job_id,
        )


class AnnotationPage(Page[AnnotationOut]):
    """A page of annotations."""


# --- datasets ----------------------------------------------------------------


# ``project_id`` is here where ``ProjectOut.workspace_id`` was left out, and the
# difference is that a project genuinely has many datasets' worth of siblings on
# this server while a workspace has exactly one value. It is also the only way
# back up: a client that got here through ``/datasets/{id}`` has no other route
# to the project the trunk belongs to.
class DatasetOut(BaseModel):
    """A project's curated trunk of training data."""

    id: UUID
    project_id: UUID
    name: str
    description: str | None

    @classmethod
    def of(cls, dataset: Dataset) -> Self:
        return cls(
            id=dataset.id,
            project_id=dataset.project_id,
            name=dataset.name,
            description=dataset.description,
        )


class ClassCountOut(BaseModel):
    """How much of one label class the trunk holds."""

    label_class: str
    annotations: int
    assets: int

    @classmethod
    def of(cls, count: ClassCount) -> Self:
        return cls(
            label_class=count.label_class,
            annotations=count.annotations,
            assets=count.assets,
        )


# A list of objects rather than ``dict[str, int]``, for ``ProgressCounts``' reason
# — an open object generates as ``Record<string, number>``, which tells a client
# nothing about what it will find. The fixed-field trick ``ProgressCounts`` uses
# is unavailable here because the classes come from a schema somebody authored,
# so the shape that stays honest is a row per class.
class DatasetStatsOut(BaseModel):
    """What the trunk currently holds, counted."""

    dataset_id: UUID
    asset_count: int
    annotated_asset_count: int
    annotation_count: int
    classes: list[ClassCountOut]

    @classmethod
    def of(cls, stats: DatasetStats) -> Self:
        return cls(
            dataset_id=stats.dataset_id,
            asset_count=stats.asset_count,
            annotated_asset_count=stats.annotated_asset_count,
            annotation_count=stats.annotation_count,
            classes=[ClassCountOut.of(count) for count in stats.per_class],
        )


# Declared here, beside its sibling, rather than up with the other project models
# — it is built out of ``ClassCountOut``, which the trunk's stats introduced, and
# a shared component belongs after the thing that defines it. Reading the two
# stats shapes next to each other is also the point: they differ in exactly two
# fields, and both of those differences are load-bearing.
class ProjectStatsOut(BaseModel):
    """What the project holds, counted — everything ingested, not only the trunk."""

    project_id: UUID
    asset_count: int
    annotated_asset_count: int
    annotation_count: int
    # The trunk's stats carry no equivalent, because which classes a schema
    # declares is a question about the project and not about a curated subset.
    class_count: int
    # Derived on the domain model and published rather than left to the client:
    # zero assets is 0.0 and not a division by zero, and that rule is worth
    # having in one place instead of in every caller.
    annotated_pct: float
    classes: list[ClassCountOut]
    # Nullable, and null does not mean "never". It means no asset in this
    # project records an arrival — which is every asset ingested before v0.1.0,
    # since the column cannot be backfilled. Clients render nothing rather than
    # a stand-in date.
    last_ingest_at: datetime | None = Field(
        default=None,
        description=(
            "Timestamp of the most recent asset ingest. Null when unknown "
            "(assets ingested before v0.1.0)."
        ),
    )

    @classmethod
    def of(cls, stats: ProjectStats) -> Self:
        return cls(
            project_id=stats.project_id,
            asset_count=stats.asset_count,
            annotated_asset_count=stats.annotated_asset_count,
            annotation_count=stats.annotation_count,
            class_count=stats.class_count,
            annotated_pct=stats.annotated_fraction * 100,
            classes=[ClassCountOut.of(count) for count in stats.per_class],
            last_ingest_at=stats.last_ingest_at,
        )


# ``operation`` is a plain ``str`` here for the same reason it is one on the
# domain model: a log outlives the build that wrote it, and an entry naming an
# operation this build has never heard of must still be readable. Typing it as an
# enum would make a client refuse a line it could simply have shown.
class DatasetChangeOut(BaseModel):
    """One entry in the trunk's append-only log."""

    id: UUID
    dataset_id: UUID
    operation: str
    subject_ids: list[UUID]
    actor: str | None
    occurred_at: datetime

    @classmethod
    def of(cls, change: DatasetChange) -> Self:
        return cls(
            id=change.id,
            dataset_id=change.dataset_id,
            operation=change.operation,
            subject_ids=list(change.subject_ids),
            actor=change.actor,
            occurred_at=change.occurred_at,
        )


class DatasetChangePage(Page[DatasetChangeOut]):
    """A page of change-log entries."""


# --- releases ----------------------------------------------------------------


# The one place a fractions-must-sum-to-one rule could reach a route body, so it
# carries the validator #27 found the need for: ``SplitRecipe`` refuses with a
# pydantic ``ValidationError``, which from a request body is neither a
# ``VisionSetError`` nor a ``RequestValidationError`` and answers **500** to a
# plainly wrong payload. Converting during parsing makes it a 422 carrying the
# domain's own message. The bounds are not restated here; the domain keeps them.
class SplitRecipeBody(BaseModel):
    """Train/val/test fractions and the seed that makes the cut reproducible."""

    model_config = ConfigDict(extra="forbid")

    train: float
    val: float
    test: float
    seed: int = 0

    @model_validator(mode="after")
    def _the_domain_accepts_it(self) -> Self:
        self.to_domain()
        return self

    def to_domain(self) -> SplitRecipe:
        return SplitRecipe(train=self.train, val=self.val, test=self.test, seed=self.seed)


class ReleaseCreate(BaseModel):
    """What publishing a release needs."""

    model_config = ConfigDict(extra="forbid")

    tag: str
    split: SplitRecipeBody | None = None


# ``manifest_hash`` is published rather than hidden: it is how a client knows two
# releases froze identical content, and it is the ``ETag`` the manifest download
# answers with. The counts beside it are the release row's read cache, and
# ``GET /releases/{id}/verify`` is what cross-checks them against the document.
class ReleaseOut(BaseModel):
    """An immutable, exportable snapshot of a dataset."""

    id: UUID
    dataset_id: UUID
    tag: str
    manifest_hash: str
    schema_version: int
    asset_count: int
    annotation_count: int
    split: SplitRecipeBody | None
    created_at: datetime
    visionset_version: str

    @classmethod
    def of(cls, release: Release) -> Self:
        return cls(
            id=release.id,
            dataset_id=release.dataset_id,
            tag=release.tag,
            manifest_hash=release.manifest_hash,
            schema_version=release.schema_version,
            asset_count=release.asset_count,
            annotation_count=release.annotation_count,
            split=None
            if release.split is None
            else SplitRecipeBody(
                train=release.split.train,
                val=release.split.val,
                test=release.split.test,
                seed=release.split.seed,
            ),
            created_at=release.created_at,
            visionset_version=release.visionset_version,
        )


class ReleasePage(Page[ReleaseOut]):
    """A page of releases."""


# ``ok`` is a computed property on the domain model and is published as a plain
# field, because a client should not have to re-derive "is anything wrong" from
# four collections and get the conjunction subtly different from ours.
class ReleaseVerificationOut(BaseModel):
    """What re-hashing everything a release names turned up."""

    release_id: UUID
    manifest_hash: str
    manifest_intact: bool
    ok: bool
    checked: int
    missing: list[str]
    corrupt: list[str]
    cache_mismatches: list[str]

    @classmethod
    def of(cls, verification: ReleaseVerification) -> Self:
        return cls(
            release_id=verification.release_id,
            manifest_hash=verification.manifest_hash,
            manifest_intact=verification.manifest_intact,
            ok=verification.ok,
            checked=verification.checked,
            missing=list(verification.missing),
            corrupt=list(verification.corrupt),
            cache_mismatches=list(verification.cache_mismatches),
        )


# ``reason`` is filled only where ``supported`` is false, and is published rather
# than derived from the two fields beside it: which capability a format is missing
# is the format's own wording, and a client re-deriving "polygon is unsupported"
# from a geometry name would be spelling it a second time.
class ClassCompatibilityOut(BaseModel):
    """One class of a release, judged against one format's capabilities."""

    label_class: str
    geometry: GeometryType
    # Three-valued since #158, replacing `supported: bool`. `supported` answered
    # "written intact?" where `_compatibility` set it and was read as "written at
    # all?" everywhere else, so a polygon in a YOLO export was reported absent and
    # written as a box. `dropped` is absent, `degraded` is present and reduced.
    status: ClassExportStatus
    annotations: int
    assets: int
    reason: str | None = None

    @classmethod
    def of(cls, compatibility: ClassCompatibility) -> Self:
        return cls(
            label_class=compatibility.label_class,
            geometry=compatibility.geometry,
            status=compatibility.status,
            annotations=compatibility.annotations,
            assets=compatibility.assets,
            reason=compatibility.reason,
        )


# Key-for-key the document the kernel writes into an export directory and the one
# ``visionset.wire`` gives the CLI and MCP. That is #65's first acceptance
# criterion — the report is user-facing on three surfaces, so there is one
# spelling of it and not three — and ``format`` rather than ``format_name`` is
# the wire's word, matching the query parameter a caller just sent.
class ExportCompatibilityOut(BaseModel):
    """What one format would drop from one release, worked out before writing."""

    release_id: UUID
    format: str
    compatible: bool
    format_is_lossy: bool
    # Dropped only. The count that used to fold degraded annotations in is #158.
    excluded_annotations: int
    excluded_assets: int
    degraded_annotations: int
    degraded_assets: int
    classes: list[ClassCompatibilityOut]

    @classmethod
    def of(cls, compatibility: ExportCompatibility) -> Self:
        return cls(
            release_id=compatibility.release_id,
            format=compatibility.format_name,
            compatible=compatibility.compatible,
            format_is_lossy=compatibility.format_is_lossy,
            excluded_annotations=compatibility.excluded_annotations,
            excluded_assets=compatibility.excluded_assets,
            degraded_annotations=compatibility.degraded_annotations,
            degraded_assets=compatibility.degraded_assets,
            classes=[ClassCompatibilityOut.of(one) for one in compatibility.classes],
        )


class SplitAssignmentOut(BaseModel):
    """The folds a release's recipe produces over its frozen asset set."""

    train: list[UUID]
    val: list[UUID]
    test: list[UUID]

    @classmethod
    def of(cls, assignment: SplitAssignment) -> Self:
        return cls(
            train=list(assignment.train),
            val=list(assignment.val),
            test=list(assignment.test),
        )


# --- formats -----------------------------------------------------------------


# Discoverable rather than documented, because what is installed is a property of
# this deployment: a distribution registering into the ``visionset.formats``
# entry-point group adds a row here and no line to any contract.
class FormatOut(BaseModel):
    """An installed export format, and what it can express."""

    name: str
    # Whether the format drops information the kernel can represent — attributes,
    # confidence, provenance included. A property of the format, never of a
    # release.
    lossy: bool
    # The checkable half of `lossy`, added by #65. Sorted, because a set has no
    # order and a wire shape must: two calls to one build have to agree.
    geometries: list[str] = []
    # Geometries this format writes in a reduced form — a polygon arriving as its
    # bounding box. #158: `geometries` alone reads as the whole answer, and for
    # `yolo` the whole answer left out that a polygon is written at all.
    degraded_geometries: list[str] = []
    modalities: list[str] = []

    @classmethod
    def of(cls, exporter: Exporter) -> Self:
        return cls(
            name=exporter.format_name,
            lossy=exporter.lossy,
            geometries=sorted(one.value for one in exporter.supported_geometries),
            degraded_geometries=sorted(one.value for one in exporter.degraded_geometries),
            modalities=sorted(exporter.supported_modalities),
        )


class FormatPage(Page[FormatOut]):
    """A page of export formats."""


# --- inference connections ----------------------------------------------------


# No credential field, and its absence is a decision rather than an oversight:
# where an HTTP connection's secret lives is open (`cf. #421`), and a nullable
# field added here "for later" would answer it by publishing a shape. A wire
# model is the hardest thing in this repo to take back.
class ConnectionOut(BaseModel):
    """One configured place a model can be asked to predict."""

    id: UUID
    name: str
    connection_type: ConnectionType
    model_id: str
    model_revision: str
    device: str | None
    precision: str | None
    endpoint_url: str | None
    setup_state: ConnectionSetupState
    allowed_actions: list[ConnectionAction]
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(cls, connection: InferenceConnection) -> Self:
        return cls(
            id=connection.id,
            name=connection.name,
            connection_type=connection.connection_type,
            model_id=connection.model_id,
            model_revision=connection.model_revision,
            device=connection.device,
            precision=connection.precision,
            endpoint_url=connection.endpoint_url,
            setup_state=connection.setup_state,
            allowed_actions=connection_actions(
                connection.setup_state, connection_type=connection.connection_type
            ),
            created_at=connection.created_at,
            updated_at=connection.updated_at,
        )


class ConnectionPage(Page[ConnectionOut]):
    """A page of inference connections."""


class ConnectionCreate(BaseModel):
    """What a caller supplies to configure a connection.

    ``setup_state`` is absent on purpose: it is derived from the kind by the
    service, because it says what the kind still needs rather than what the
    caller wants. Accepting it would let a client declare weights present that
    were never fetched.
    """

    name: str
    connection_type: ConnectionType
    model_id: str
    model_revision: str
    device: str | None = None
    precision: str | None = None
    endpoint_url: str | None = None


class ConnectionUpdate(BaseModel):
    """A partial edit. Every field omitted or null means *leave this alone*.

    ``connection_type`` is absent because the kind is not editable — see
    ``InferenceConnectionService.update``. A field cannot be *cleared* through
    this shape, which is the honest consequence of null meaning "unchanged": the
    parameters that could be cleared are exactly the ones the kind requires, so
    clearing one would produce a row the domain refuses anyway.
    """

    name: str | None = None
    model_id: str | None = None
    model_revision: str | None = None
    device: str | None = None
    precision: str | None = None
    endpoint_url: str | None = None


class SuggestPoint(BaseModel):
    """One click, in the asset's own pixel coordinates.

    An object rather than a two-element array because a JSON ``[x, y]`` is a
    shape a generated client types as ``number[]`` and a reader has to guess the
    order of. The domain's own tuples are fine — Python has positional meaning —
    but the wire is read by people.
    """

    x: float
    y: float


class SuggestRequest(BaseModel):
    """Where somebody clicked, on what, through which connection.

    Everything travels in the body rather than in the path: the call names an
    asset *and* a connection, and neither owns the other. Putting one in the path
    would make it look like the parent of the request, which is how a URL is
    read.
    """

    project_id: UUID
    asset_id: UUID
    connection_id: UUID
    #: At least one point that says *this*. A gesture with only negative points
    #: is not a refinement of anything.
    positive: list[SuggestPoint] = Field(min_length=1)
    #: Points that say *not that* — how somebody carves a hole out of an
    #: over-eager first answer without starting the gesture over.
    negative: list[SuggestPoint] = Field(default_factory=list)
    #: The geometry kinds the active class admits. The server produces one of
    #: these or nothing at all; it never answers in a kind the schema would go on
    #: to refuse. Sent by the caller because the class is the caller's state —
    #: the server would otherwise be guessing which class a click was meant for.
    allowed_geometries: list[GeometryType] = Field(min_length=1)
    #: How much detail to keep when an outline becomes a polygon, as a fraction
    #: of the region's own size. Null takes the server's default, which is what
    #: every ordinary caller sends.
    detail: float | None = Field(default=None, gt=0.0, le=1.0)


class SuggestedRegion(BaseModel):
    """One proposed shape and how sure the model is of it."""

    geometry: Geometry
    confidence: float = Field(ge=0.0, le=1.0)


class SuggestionOut(BaseModel):
    """What the model proposes, or an honest nothing.

    ``region`` is null when there is no suggestion, and that is an ordinary
    answer rather than an error: a click can land on sky, the model can be less
    sure than the caller asked for, and the shape found can be one this class
    cannot hold. A 404 or a 409 for any of those would be telling the caller they
    did something wrong when they did not.

    ``model_ref`` is echoed on every answer, including the empty one, because it
    is what an accepted suggestion has to carry into its annotation — and a
    caller that had to remember which connection it asked would be keeping a
    second copy of something the response can simply state.
    """

    model_ref: str
    region: SuggestedRegion | None = None
