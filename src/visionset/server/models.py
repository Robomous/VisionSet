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

from visionset.inference import capabilities_of
from visionset.kernel.domain import (
    DEFAULT_DETAIL,
    DEFAULT_FILL_HOLES,
    DEFAULT_FRAGMENTS,
    ActivityEntry,
    ActivityKind,
    Annotation,
    AnnotationJob,
    AnnotationJobState,
    AnnotationSchema,
    Asset,
    AssetAction,
    AssetProgress,
    AttentionItem,
    AttentionKind,
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
    Detail,
    DownloadSize,
    ExportCompatibility,
    Fragments,
    Geometry,
    GeometryType,
    ImageFormat,
    InferenceConnection,
    IngestFailure,
    IngestFailureKind,
    IngestJob,
    IngestState,
    IntegrityCheck,
    ItemFailure,
    JobAction,
    LabelClass,
    MembershipChange,
    ModelCapability,
    Partition,
    PolygonGeometry,
    PolylineGeometry,
    Precision,
    Project,
    ProjectStats,
    ProjectSummary,
    Release,
    ReleaseVerification,
    ResumeTarget,
    SchemaChange,
    SchemaDiff,
    SchemaProvenance,
    SingleJob,
    Source,
    SourceKind,
    SplitAssignment,
    SplitRecipe,
    SuggestParameter,
    VideoProvenance,
    WeightDownload,
    WorkspaceSummary,
    WorkspaceTotals,
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
# what lets ``limit``/``offset`` be added to a route without moving the shape a
# client already parsed.
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
            # The domain's one spelling of "what to call this source": the
            # stated display name, else the path's last segment. Deriving
            # from ``path`` here again is how this and ``visionset.wire`` would
            # eventually answer differently.
            name=source.name,
            registered_at=source.registered_at,
            video=None if source.video is None else VideoProvenanceOut.of(source.video),
        )


class SourcePage(Page[SourceOut]):
    """A page of sources."""


# --- ingest ------------------------------------------------------------------


# ``partial`` is the kind that is not a total loss: the clip was read as far as
# its bytes went and those frames are in the batch, so the two counts travel with
# it. They are null on every other kind, which the domain enforces rather than
# merely intends — see ``IngestFailure``.
class IngestFailureOut(BaseModel):
    """What became of one item the run could not simply read."""

    name: str
    kind: IngestFailureKind
    reason: str
    frames_produced: int | None
    frames_expected_estimate: int | None

    @classmethod
    def of(cls, failure: IngestFailure) -> Self:
        return cls(
            name=failure.name,
            kind=failure.kind,
            reason=failure.reason,
            frames_produced=failure.frames_produced,
            frames_expected_estimate=failure.frames_expected_estimate,
        )


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


# ``batch_id`` never leaves a caller holding a 202 that points at a job row
# nobody wrote: ``IngestService.enqueue`` checks the batch in the same
# transaction that inserts the job, so an unknown batch is a 404 and a batch past
# ``draft`` is a 409 — both *before* the row, both answered on the request that
# asked for them.
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
    # When this asset arrived. **Null means unknown, not "never"**: the column is
    # nullable because rows written before it
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
    # can be told from "3 were already gone". An idempotent operation that reports
    # only the final state loses exactly that distinction, which leaves a surface
    # unable to tell "did N" from "nothing to do".
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
# carries a validator: ``SplitRecipe`` refuses with a
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
    # Three-valued rather than a `supported: bool`, which answers "written
    # intact?" where `_compatibility` sets it and reads as "written at all?"
    # everywhere else — so a polygon in a YOLO export is reported absent and
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
# ``visionset.wire`` gives the CLI and MCP: the report is user-facing on three
# surfaces, so there is one spelling of it and not three. ``format`` rather than
# ``format_name`` is the wire's word, matching the query parameter a caller just
# sent.
class ExportCompatibilityOut(BaseModel):
    """What one format would drop from one release, worked out before writing."""

    release_id: UUID
    format: str
    compatible: bool
    format_is_lossy: bool
    # Dropped only; degraded annotations are counted separately below.
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
    # The checkable half of `lossy`. Sorted, because a set has no order and a wire
    # shape must: two calls to one build have to agree.
    geometries: list[str] = []
    # Geometries this format writes in a reduced form — a polygon arriving as its
    # bounding box. Without it `geometries` reads as the whole answer, and for
    # `yolo` that answer leaves out that a polygon is written at all.
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
# where an HTTP connection's secret lives is still open, and a nullable field
# added here "for later" would answer it by publishing a shape. A wire model is
# the hardest thing in this repo to take back.
class WeightDownloadOut(BaseModel):
    """A connection's weight transfer: which job, how far it has got, how it ended.

    Present whenever a download has ever been asked for on this connection, and
    describing the most recent one. It is how a client shows a transfer it did not
    itself start: a download outlives the request that launched it and the page
    that asked, so a reload, a second tab or another machine all read the same
    progress from here rather than from a job id somebody happened to keep.

    Polling this — through the connection or through
    `GET /background-jobs/{job_id}` — never affects the run. The job is dispatched
    to a worker process the server owns; no client disconnect cancels or pauses
    it, and closing the browser during a download is not a way to stop one.

    **It is not a setup state.** `setup_state` says whether the weights are
    *here*; this says whether something is currently fetching them. The two are
    separate on purpose: a connection is `ready` only once a snapshot is complete,
    so there is no moment at which one is half set up.
    """

    job_id: UUID
    state: BackgroundJobState
    #: Bytes that have arrived. Monotonic, and never above `bytes_total`.
    bytes_done: int
    #: Every byte the revision comes to, or `null` where the size could not be
    #: read. Null is a real answer and not a failure: the size is read from the
    #: publishing hub's file listing, which can fail while the transfer itself
    #: runs perfectly — so it means *render this bar as indeterminate*, never
    #: *something is wrong*.
    bytes_total: int | None
    #: Why it failed, in the handler's own sentence. `null` unless `state` is
    #: `failed`.
    error: str | None

    @classmethod
    def of(cls, download: WeightDownload) -> Self:
        return cls(
            job_id=download.job_id,
            state=download.state,
            bytes_done=download.bytes_done,
            bytes_total=download.bytes_total,
            error=download.error,
        )


class IntegrityCheckOut(BaseModel):
    """A connection's snapshot re-read: which job, how far, and how it ended.

    `WeightDownloadOut`'s sibling over the same files, and present on the same
    terms: whenever a check has ever been asked for on this connection, describing
    the most recent one. It is how a client shows a run it did not itself start —
    a reload, a second tab, another machine, or `visionset inference
    check-integrity` in a terminal — rather than a job id somebody happened to
    keep.

    Polling it never affects the run. The job is dispatched to a worker process
    the server owns; no client disconnect cancels or pauses it.

    **Files, where a download counts bytes.** A check owns its loop and knows how
    many files the revision names before it opens the first one, so it reports
    what it actually counts. Neither borrows the other's name.

    **The verdict is not here.** A pass leaves `setup_state` at `ready`; a failure
    has already purged the damaged files and stood the connection down by the time
    `state` says `failed`. So what a reader acts on is the connection's own state
    and the actions it now declares, and what this adds is the sentence saying
    why.
    """

    job_id: UUID
    state: BackgroundJobState
    #: Files re-read and compared so far.
    files_read: int
    #: How many the revision names, or `null` before the run has read the hub's
    #: listing. A check learns its total almost immediately, so the null window is
    #: the moment between the job being claimed and the first digest arriving.
    files_total: int | None
    #: Why it failed, in the handler's own sentence. `null` unless `state` is
    #: `failed`. A check that could not reach the hub fails here and changes
    #: nothing: no verdict, no purge, no state change.
    error: str | None

    @classmethod
    def of(cls, check: IntegrityCheck) -> Self:
        return cls(
            job_id=check.job_id,
            state=check.state,
            files_read=check.files_read,
            files_total=check.files_total,
            error=check.error,
        )


class ConnectionOut(BaseModel):
    """One configured place a model can be asked to predict."""

    id: UUID
    name: str
    connection_type: ConnectionType
    model_id: str
    model_revision: str
    #: Two closed vocabularies published two ways, because one of them has a
    #: member that is not a fixed word: ``cuda:N`` addresses the second GPU on a
    #: machine that has one, so ``device`` travels as a string the kernel refuses
    #: when it is outside ``DEVICE_PATTERN``, while ``precision`` is an enum a
    #: client can enumerate. Which precisions a device honours is the kernel's
    #: cross-field rule, not a shape either type can carry.
    device: str | None
    precision: Precision | None
    endpoint_url: str | None
    setup_state: ConnectionSetupState
    allowed_actions: list[ConnectionAction]
    #: What this connection's model can be asked for, and empty where nothing is
    #: known yet: a connection whose weights have never been fetched, one whose
    #: config declared no model type, one of a type this build cannot run, and an
    #: ``http`` connection — which declares nothing until the remote contract
    #: says how an endpoint states what it can do.
    #:
    #: **Not the same question as ``allowed_actions``, and both are needed.** An
    #: action is something to do *to* this connection and is decided by its state;
    #: a capability is what its model answers and is decided by the weights. A
    #: client offering a tool wants a connection that is ``ready`` **and**
    #: declares the capability the tool needs — being ready says the files are
    #: here, not that they are the right kind of model.
    #:
    #: Empty is not a refusal to act on. It says only that this connection cannot
    #: be relied on for a particular tool; the server still judges every request
    #: on its own.
    capabilities: list[ModelCapability]
    #: The most recent weight download asked for on this connection, or `null`
    #: where none ever was.
    #:
    #: **This is what makes a transfer observable from anywhere**, and it is why
    #: it hangs off the connection rather than being something a client keeps: a
    #: download runs in a worker the server owns and outlives the request that
    #: started it, so the only way a fresh page can show one is for the resource
    #: it lists to say so. A client that remembered a job id would lose the
    #: download to the first navigation.
    #:
    #: The *latest* rather than only a live one, because both questions get asked:
    #: *is something running now* and *what happened last time*. Dropping it the
    #: moment it settles would leave a connection that failed while nobody was
    #: watching sitting at `not_set_up` with nothing saying why.
    download: WeightDownloadOut | None
    #: The most recent integrity check asked for on this connection, or `null`
    #: where none ever was. Carried for `download`'s reason and read the same way:
    #: a run outlives the request that started it, so a client that remembered a
    #: job id would lose it to the first navigation.
    integrity_check: IntegrityCheckOut | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(
        cls,
        connection: InferenceConnection,
        *,
        download: WeightDownload | None = None,
        integrity_check: IntegrityCheck | None = None,
    ) -> Self:
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
            capabilities=capabilities_of(connection.model_family),
            download=None if download is None else WeightDownloadOut.of(download),
            integrity_check=(
                None if integrity_check is None else IntegrityCheckOut.of(integrity_check)
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
    were never fetched, so supplying it is refused along with any other field
    this shape does not declare.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    connection_type: ConnectionType
    model_id: str
    model_revision: str
    device: str | None = None
    precision: Precision | None = None
    endpoint_url: str | None = None


class ConnectionUpdate(BaseModel):
    """A partial edit. Every field omitted or null means *leave this alone*.

    ``connection_type`` is absent because the kind is not editable — see
    ``InferenceConnectionService.update``. A field cannot be *cleared* through
    this shape, which is the honest consequence of null meaning "unchanged": the
    parameters that could be cleared are exactly the ones the kind requires, so
    clearing one would produce a row the domain refuses anyway.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    model_id: str | None = None
    model_revision: str | None = None
    device: str | None = None
    precision: Precision | None = None
    endpoint_url: str | None = None


class DownloadSizeOut(BaseModel):
    """What fetching a model's weights would cost, before anybody fetches them.

    Answered from the publishing hub's file listing, so asking costs a metadata
    request and never a download. The pair is echoed back for ``SuggestionOut``'s
    reason: a form that had to remember which model it asked about would be
    keeping a second copy of something the response can simply state.
    """

    model_id: str
    model_revision: str
    #: Every file in the revision, because the download fetches every file in the
    #: revision. Bytes rather than a formatted string: how to say "2.3 GB" is a
    #: question about a locale and a screen width, and neither is the server's.
    total_bytes: int
    file_count: int

    @classmethod
    def of(cls, size: DownloadSize) -> Self:
        return cls(
            model_id=size.model_id,
            model_revision=size.model_revision,
            total_bytes=size.total_bytes,
            file_count=size.file_count,
        )


class SuggestPoint(BaseModel):
    """One click, in the asset's own pixel coordinates.

    An object rather than a two-element array because a JSON ``[x, y]`` is a
    shape a generated client types as ``number[]`` and a reader has to guess the
    order of. The domain's own tuples are fine — Python has positional meaning —
    but the wire is read by people.

    Must be on the asset: `x` in `[0, width]` and `y` in `[0, height]`, both
    ends included. The bounds cannot be stated as field constraints, because
    they belong to the asset the request names rather than to the point, so a
    coordinate off the picture is refused by the route with
    `PROMPT_POINT_OUT_OF_BOUNDS` rather than by this schema.
    """

    model_config = ConfigDict(extra="forbid")

    x: float
    y: float


class SuggestRequest(BaseModel):
    """Where somebody clicked, on what, through which connection.

    Everything travels in the body rather than in the path: the call names an
    asset *and* a connection, and neither owns the other. Putting one in the path
    would make it look like the parent of the request, which is how a URL is
    read.
    """

    model_config = ConfigDict(extra="forbid")

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
    #: How much of an outline survives simplification. Omitted means `balanced`,
    #: which is what every suggestion used before there was a choice.
    detail: Detail = DEFAULT_DETAIL
    #: The largest gap closed in the model's mask, as a share of the piece's own
    #: area. Zero closes nothing.
    fill_holes: float = Field(DEFAULT_FILL_HOLES, ge=0.0, le=1.0)
    #: Whether the piece under the click is the answer, or every piece big enough
    #: to be worth proposing.
    fragments: Fragments = DEFAULT_FRAGMENTS


class SuggestedRegion(BaseModel):
    """One proposed shape, and the contour it was reduced from."""

    geometry: Geometry
    #: The unsimplified outline, in the asset's own pixels — what lets a client
    #: re-run `detail` locally instead of asking again. Empty for a box, which is
    #: an extent rather than something reduced from anything.
    #:
    #: Required rather than defaulted: it is on every answer, and a field a
    #: client has to check for is one it will eventually forget to check for.
    contour: list[tuple[float, float]]


class AppliedParameters(BaseModel):
    """The parameter values this answer was actually produced with."""

    detail: Detail
    fill_holes: float
    fragments: Fragments


class SuggestionOut(BaseModel):
    """What the model proposes, or an honest nothing.

    `regions` is empty when there is no suggestion, and that is an ordinary
    answer rather than an error: a click can land on sky, the model can be less
    sure than the caller asked for, the shape found can be one this class cannot
    hold, and the parameters as set can leave nothing. A 404 or a 409 for any of
    those would be telling the caller they did something wrong when they did not.

    `model_ref` is echoed on every answer, including the empty one, because it
    is what an accepted suggestion has to carry into its annotation — and a
    caller that had to remember which connection it asked would be keeping a
    second copy of something the response can simply state. `confidence` is the
    same: one number for the answer, because the model scored one mask and the
    pieces cut out of it are that same claim seen in parts.

    `parameters` names which settings have any effect on the kind of shape this
    request will come back in, so a client renders exactly those and works none
    of it out for itself. It is present on an empty answer too, which is what
    lets somebody who adjusted their way into nothing adjust their way back out.
    """

    model_ref: str
    confidence: float = Field(ge=0.0, le=1.0)
    regions: list[SuggestedRegion]
    applied: AppliedParameters
    parameters: list[SuggestParameter]


# --- the workspace's front page --------------------------------------------
#
# One composed response rather than a resource, and the whole group is read-only.
# Nothing here carries ``allowed_actions``: an action belongs to the resource it
# acts on, and every row below is a *pointer* at one whose own shape already
# declares what may be done to it. Publishing a second copy of those declarations
# here would be the hand-mirrored table the capabilities contract exists to
# forbid, one layer up.
#
# The two feed shapes are flat rows carrying a ``kind`` rather than discriminated
# unions. They differ in which optional fields they fill, not in shape, and the
# union machinery — a component per variant, a generated runtime check per
# variant, a fixture per variant — would buy nothing a reader or a client can
# observe. ``GeometryOut`` is a union because its variants carry genuinely
# different data; these do not.
class WorkspaceTotalsOut(BaseModel):
    """Four counts over the whole workspace."""

    projects: int
    assets: int
    annotations: int
    releases: int

    @classmethod
    def of(cls, totals: WorkspaceTotals) -> Self:
        return cls(
            projects=totals.projects,
            assets=totals.assets,
            annotations=totals.annotations,
            releases=totals.releases,
        )


class ResumeTargetOut(BaseModel):
    """The batch to carry on with, and where inside it to land."""

    project_id: UUID
    project_name: str
    batch_id: UUID
    batch_name: str
    job_id: UUID
    # NULL when nothing in the batch is unannotated. The batch is still the one
    # to open; a client sends somebody to its gallery instead of into the editor
    # and says so on the control, rather than offering a link to no frame.
    next_asset_id: UUID | None
    annotated: int
    total: int
    thumbnail_asset_id: UUID | None

    @classmethod
    def of(cls, resume: ResumeTarget) -> Self:
        return cls(
            project_id=resume.project_id,
            project_name=resume.project_name,
            batch_id=resume.batch_id,
            batch_name=resume.batch_name,
            job_id=resume.job_id,
            next_asset_id=resume.next_asset_id,
            annotated=resume.annotated,
            total=resume.total,
            thumbnail_asset_id=resume.thumbnail_asset_id,
        )


class AttentionItemOut(BaseModel):
    """One thing in the workspace that is waiting on somebody."""

    kind: AttentionKind
    subject_id: UUID
    # NULL on a background-job row, which names an ingest job or a release in its
    # payload and never a project. Such a row is rendered without a link.
    project_id: UUID | None
    project_name: str | None
    label: str
    count: int | None
    processed: int | None
    total: int | None
    detail: str | None

    @classmethod
    def of(cls, item: AttentionItem) -> Self:
        return cls(
            kind=item.kind,
            subject_id=item.subject_id,
            project_id=item.project_id,
            project_name=item.project_name,
            label=item.label,
            count=item.count,
            processed=item.processed,
            total=item.total,
            detail=item.detail,
        )


class ProjectSummaryOut(BaseModel):
    """One project, as a shortcut rather than as the project list."""

    project_id: UUID
    name: str
    asset_count: int
    # A share in 0..1, and zero over an empty project rather than absent — the
    # rule ``DESIGN.md`` states for a percentage over a zero denominator.
    annotated_fraction: float

    @classmethod
    def of(cls, summary: ProjectSummary) -> Self:
        return cls(
            project_id=summary.project_id,
            name=summary.name,
            asset_count=summary.asset_count,
            annotated_fraction=summary.annotated_fraction,
        )


class ActivityEntryOut(BaseModel):
    """One thing that happened, derived from a timestamp that already existed."""

    kind: ActivityKind
    occurred_at: datetime
    project_id: UUID
    project_name: str
    subject_id: UUID
    label: str | None
    count: int | None

    @classmethod
    def of(cls, entry: ActivityEntry) -> Self:
        return cls(
            kind=entry.kind,
            occurred_at=entry.occurred_at,
            project_id=entry.project_id,
            project_name=entry.project_name,
            subject_id=entry.subject_id,
            label=entry.label,
            count=entry.count,
        )


class HomeOut(BaseModel):
    """Everything the workspace's front page asks for, in one answer."""

    totals: WorkspaceTotalsOut
    resume: ResumeTargetOut | None
    attention: list[AttentionItemOut]
    projects: list[ProjectSummaryOut]
    activity: list[ActivityEntryOut]

    @classmethod
    def of(cls, summary: WorkspaceSummary) -> Self:
        return cls(
            totals=WorkspaceTotalsOut.of(summary.totals),
            resume=None if summary.resume is None else ResumeTargetOut.of(summary.resume),
            attention=[AttentionItemOut.of(item) for item in summary.attention],
            projects=[ProjectSummaryOut.of(row) for row in summary.projects],
            activity=[ActivityEntryOut.of(entry) for entry in summary.activity],
        )
