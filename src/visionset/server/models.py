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

from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal, Self
from uuid import UUID

from fastapi import Query
from pydantic import BaseModel, ConfigDict, model_validator

from visionset.kernel.domain import (
    AnnotationSchema,
    Asset,
    Attribute,
    GeometryType,
    ImageFormat,
    IngestFailure,
    IngestFailureKind,
    IngestJob,
    IngestState,
    LabelClass,
    Project,
    Source,
    SourceKind,
    VideoProvenance,
)

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
# it. There are no paging parameters yet — the kernel has no windowed read, and a
# ``limit`` implemented by slicing a full read is a window that lies about its
# cost. ``total`` already means "matching the query" rather than "in this page",
# so #29 adds ``limit``/``offset`` beside it without a breaking change.
#
# This class is never a response model itself; a concrete subclass is. FastAPI
# names a parametrised generic ``Page_ProjectOut_`` in the spec, which is not a
# name to hand a client generator. The PEP 695 syntax is required rather than
# preferred: ruff's UP046 rejects ``Generic[T]`` as a base.
class Page[T](BaseModel):
    """One page of a collection."""

    items: list[T]
    total: int


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

    @classmethod
    def of(cls, schema: AnnotationSchema) -> Self:
        return cls(
            project_id=schema.project_id,
            version=schema.version,
            classes=tuple(LabelClassBody.of(c) for c in schema.classes),
        )


class SchemaVersionPage(Page[SchemaVersionOut]):
    """A page of schema versions."""


class SchemaVersionCreate(BaseModel):
    """The whole proposed version. There is no partial edit of a schema."""

    model_config = ConfigDict(extra="forbid")

    classes: tuple[LabelClassBody, ...] = ()


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
            name=Path(source.path).name,
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


# Targeting an existing draft batch by id is deliberately not here. Batches have
# no endpoints until #29, so there is nothing for a client to name — and leaving
# it out is what keeps this launch free of any refusal that would leave the
# caller a 202 pointing at a job row that was never written.
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

    batch_name: str | None = None


# --- assets ------------------------------------------------------------------


# ``Asset.uri`` is absent for the reason ``Source.path`` is: it is a server-side
# path, and for a frame it is that path plus ``#frame=N``. Reaching the bytes is
# #30's blob download, keyed by the hashes already on this model.
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
        )


class AssetPage(Page[AssetOut]):
    """A page of assets."""
