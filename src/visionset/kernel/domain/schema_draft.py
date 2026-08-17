# usage: from visionset.kernel.domain import SchemaDraft, DraftLabelClass, DraftAttribute
"""A schema version somebody is still writing.

The mutable half of the ontology, and the only one. ``domain/schema.py`` is frozen
end to end because a published version is a contract; this is the work in front of
that contract, and work in progress is incomplete by definition.

**Every field is optional and no cross-field rule is enforced here.** A class with
no name yet, a select with no options yet, an attribute whose kind nobody has
chosen — each is an ordinary moment in composing a schema, and each is something
``LabelClass`` refuses to be constructed as. Storing a draft as published models
would therefore discard exactly the half-finished work a draft exists to hold.

Validation is not weakened; it moves. :meth:`DraftLabelClass.to_label_class` is
the one crossing, and every rule ``domain/schema.py`` states fires there, at
publish, which is where it already fired. What changed is that a person can put
the editor down before it does.

Both conversions raise ``ValueError`` — directly, or as pydantic's
``ValidationError``, which is a subclass of it — so one ``except ValueError``
catches the whole family and no caller has to know which of the two rules refused.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

from visionset.kernel.domain.schema import (
    Attribute,
    AttributeValue,
    GeometryType,
    LabelClass,
    SchemaProvenance,
)


class DraftAttribute(BaseModel):
    """A typed attribute, before it is necessarily typed.

    ``kind`` is nullable here and is not on :class:`Attribute`, and that single
    difference is what lets somebody add an attribute row and name it before
    deciding what it holds.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = ""
    kind: Literal["string", "number", "boolean", "select"] | None = None
    required: bool = False
    options: tuple[str, ...] | None = None
    default: AttributeValue | None = None

    def to_attribute(self) -> Attribute:
        """This attribute as the published contract would have it.

        Raises:
            ValueError: it is not finished, or the finished form is invalid —
                a select with no options, a default its kind rejects.
        """
        if self.kind is None:
            raise ValueError(f"attribute {self.name!r} has no kind yet")
        return Attribute(
            name=self.name,
            kind=self.kind,
            required=self.required,
            options=self.options,
            default=self.default,
        )


class DraftLabelClass(BaseModel):
    """One class being written: a name that may be blank, shapes that may be none."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = ""
    geometries: tuple[GeometryType, ...] = ()
    color: str | None = None
    attributes: tuple[DraftAttribute, ...] = ()

    def to_label_class(self) -> LabelClass:
        """This class as the published contract would have it.

        Raises:
            ValueError: a blank name, no geometry, or any attribute that will
                not convert.
        """
        return LabelClass(
            name=self.name,
            geometries=self.geometries,
            color=self.color,
            attributes=tuple(attribute.to_attribute() for attribute in self.attributes),
        )


class SchemaDraft(BaseModel):
    """The next version of one project's schema, as far as anyone has got.

    **One per project per kind**, which the store enforces with a unique index on
    ``(project_id, kind)``. There is no name and no author: the workspace has no
    identities to attribute one to, so a draft belongs to the project and to
    everybody holding a credential to it.

    ``kind`` is a :class:`SchemaProvenance` rather than an enum of its own. The
    two would have the same members and answer the same question, and this
    draft's kind is literally the provenance the version it publishes will carry
    — so a second enum would be a second spelling free to drift. It is non-null
    here, unlike on a version, where null means "nobody said".

    ``based_on`` is the version this was seeded from, and it is how a surface
    knows a version arrived underneath: a draft whose ``based_on`` is behind the
    active version was written against a contract that has since moved. Null for
    a draft started on a project with no schema at all.

    ``revision`` counts writes and exists to refuse them. A write naming a
    revision that is no longer stored was decided against an answer that had
    expired, and applying it would land on top of somebody else's — see
    ``SchemaDraftService.save``.

    Frozen, like the published models, and edited the way ``Batch`` is: whole-row
    replacement fed by ``model_copy(update=...)``. Immutability of the *value*
    costs nothing here and rules out a service mutating a draft it only read.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    kind: SchemaProvenance
    classes: tuple[DraftLabelClass, ...] = ()
    #: The version message, as typed so far. Empty is ordinary — an empty commit
    #: message is legal, and most drafts have none until the moment of publishing.
    note: str = ""
    based_on: int | None = Field(default=None, ge=1)
    revision: int = Field(default=1, ge=1)
    updated_at: datetime

    @field_validator("updated_at")
    @classmethod
    def _timezone_aware(cls, value: datetime) -> datetime:
        """The convention every timestamp in the domain follows.

        A naive datetime is rejected rather than assumed to be UTC: the store
        keeps ISO-8601 text, so an unqualified value read back would be
        indistinguishable from a qualified one and quietly wrong by the writer's
        offset from UTC.
        """
        if value.tzinfo is None:
            raise ValueError("updated_at must be timezone-aware (UTC)")
        return value
