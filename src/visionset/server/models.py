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

from typing import Annotated, Literal, Self
from uuid import UUID

from fastapi import Query
from pydantic import BaseModel, ConfigDict, model_validator

from visionset.kernel.domain import (
    AnnotationSchema,
    Attribute,
    GeometryType,
    LabelClass,
    Project,
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
