# usage: from visionset.kernel.domain import AnnotationSchema, LabelClass, GeometryType
"""The labeling contract: what a project may label, and in what shape.

Every model here is **frozen**, and every collection on them is a tuple. That is
the immutability of a schema version expressed in the type rather than in a
comment: a rehydrated version cannot be edited in place, so the only way to
change what a project labels is to create the next version — which is
``SchemaService``'s job, and nothing else's.

``Attribute.kind`` names four types: ``string``, ``number``, ``boolean`` and
``select``. The roadmap sometimes calls the last one "enum", which is the same
thing under a different word.

Per-value validity — a ``select`` without options, a default that does not match
its kind, two attributes on one class sharing a name — is enforced here, so an
invalid ``LabelClass`` cannot be built at all. Rules that span *classes*
(duplicate class names, a geometry with no implementation) belong to
``SchemaService``: they need the whole proposed version, and one of them needs
``Geometry``, which imports this module.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping
from datetime import datetime
from enum import StrEnum
from typing import Final, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class GeometryType(StrEnum):
    """Every geometry the domain can address.

    3D values exist today even though unimplemented: the domain never assumes
    "image" anywhere — that is the Physical AI roadmap encoded as a type.
    """

    BBOX = "bbox"
    POLYGON = "polygon"
    MASK = "mask"
    POLYLINE = "polyline"
    KEYPOINTS = "keypoints"
    CUBOID_3D = "cuboid_3d"
    POLYLINE_3D = "polyline_3d"
    CLASSIFICATION_TAG = "classification_tag"


# This enum travels on the wire as itself (the ``GeometryType`` precedent), and a
# domain docstring is copied verbatim into ``openapi.json`` as the schema's
# description — so the docstring below is written for a client reading the
# contract, and the reasoning that is nobody else's business lives here:
#
# * **The name collides, and the collision is only in the word.** ``Provenance``
#   in ``domain/annotation.py`` asks whether a *label* was drawn, predicted or
#   imported. This asks whether a *version* was designed or fell out of somebody
#   needing a class mid-job. Different entity, different question — docs must
#   disambiguate the two wherever both appear.
# * **Nothing infers it and nothing backfills it.** The only thing that knows
#   which kind of work is happening is the surface the person is using, so the
#   value is recorded verbatim from the caller. A version published before this
#   column existed stays NULL, because the alternative is a guess — and a history
#   that groups on a guess is confidently wrong about exactly the milestones a
#   reader opened it to find.
# * **NULL is not a third kind.** It means "nobody said", and a reader groups it
#   with ``CURATED`` rather than with ``ANNOTATION`` — showing a version that
#   deserved collapsing is a smaller error than hiding one that did not.
class SchemaProvenance(StrEnum):
    """Which kind of work a schema version came from.

    `curated` is a version authored deliberately — somebody sat down and decided
    what the project labels. `annotation` is one that fell out of adding a class
    part-way through labeling an asset. It gates nothing and is part of no
    contract comparison; a version history uses it to tell the milestones apart
    from the incidental runs between them.

    The same two words also say which kind of work a *draft* belongs to, and a
    draft publishes under its own kind — so a project holds at most one draft of
    each, and the two never publish each other's classes.
    """

    CURATED = "curated"
    ANNOTATION = "annotation"


#: What ``Attribute.default`` may hold, in the order pydantic's smart union tries.
#:
#: ``bool`` first is not cosmetic: ``True`` is an ``int`` to Python, so a laxer
#: order would quietly store ``1.0`` as a boolean default.
type AttributeValue = bool | float | str


#: The type each ``Attribute.kind`` accepts, as ``isinstance`` sees it.
#:
#: ``number`` maps to ``float`` alone, and that is the same care the union above
#: takes: ``True`` is an ``int`` to Python but never a ``float``, so a boolean
#: cannot pass itself off as a number here either.
_KIND_TYPES: Final[Mapping[str, type]] = {
    "string": str,
    "number": float,
    "boolean": bool,
    "select": str,
}


class Attribute(BaseModel):
    """A typed attribute attached to a LabelClass (e.g. occlusion, color).

    ``required`` says an annotation must carry a value; ``default`` says which
    value a surface should offer when it does not. They are independent — a
    required attribute with a default is an ordinary, useful thing.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    kind: Literal["string", "number", "boolean", "select"]
    required: bool = False
    options: tuple[str, ...] | None = None
    default: AttributeValue | None = None

    @field_validator("name")
    @classmethod
    def _named(cls, value: str) -> str:
        """Stripped, and never blank.

        Stored stripped because annotations will carry attribute values keyed by
        this exact string: a trailing space is a second attribute nobody can see.
        """
        stripped = value.strip()
        if not stripped:
            raise ValueError("an attribute name must contain at least one non-blank character")
        return stripped

    @model_validator(mode="after")
    def _options_match_kind(self) -> Attribute:
        if self.kind == "select":
            if not self.options:
                raise ValueError(
                    f"attribute {self.name!r} is a select and needs at least one option"
                )
            if len(set(self.options)) != len(self.options):
                raise ValueError(f"attribute {self.name!r} repeats an option")
        elif self.options is not None:
            raise ValueError(f"attribute {self.name!r} is a {self.kind} and cannot carry options")
        return self

    @model_validator(mode="after")
    def _default_matches_kind(self) -> Attribute:
        """A default its own kind would reject is a bug, not a preference."""
        if self.default is not None and (reason := self.rejects(self.default)) is not None:
            raise ValueError(f"attribute {self.name!r} (as a default) {reason}")
        return self

    def rejects(self, value: AttributeValue) -> str | None:
        """Why this attribute will not take ``value``, or ``None`` if it will.

        The single place "does this attribute accept this value" is decided.
        The validator above asks it of this attribute's own ``default``, and
        ``AnnotationService`` asks it of the values an annotation carries — so
        a default and a label can never be judged by two rules that drifted.

        The answer is a *reason fragment* rather than a whole sentence, so each
        caller can name its own subject: "attribute 'weather' <reason>".
        """
        if not isinstance(value, _KIND_TYPES[self.kind]):
            return f"is a {self.kind} but got {type(value).__name__}"
        if self.kind == "select" and value not in (self.options or ()):
            allowed = ", ".join(repr(option) for option in self.options or ())
            return f"is a select and {value!r} is not one of its options ({allowed})"
        return None


class LabelClass(BaseModel):
    """One labelable class in a schema, and the geometries it may be drawn as.

    ``geometries`` is a set in meaning and a **sorted tuple** in representation.
    A class labelled as a box on some frames and as a polygon on others is one
    class; splitting it in two would make every consumer downstream re-unify
    them. Which of the allowed shapes a given label carries is the annotation's
    own business, and ``AnnotationService`` tests it for membership here.

    Sorted, deduplicated, and a tuple rather than a ``frozenset``, because
    ``release.canonical_bytes`` hashes ``model_dump(mode='json')``: a set's
    iteration order is not stable across processes, so a set-valued field would
    make a release hash irreproducible. Sorting also means the order carries no
    meaning and nobody can read one into it — unlike ``AnnotationSchema.classes``,
    which is authored.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    geometries: tuple[GeometryType, ...] = Field(min_length=1)
    color: str | None = None
    attributes: tuple[Attribute, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def _one_geometry_is_a_set_of_one(cls, data: object) -> object:
        """Read a pre-#584 document, which spelled this ``geometry`` and singular.

        The single back-compatibility point, and it serves three readers at once:
        schema rows (``annotation_schema.classes`` is a JSON column), release
        manifests (``Manifest.classes`` carries these verbatim, and an existing
        release must stay verifiable), and MCP, which takes this model directly
        as a tool parameter — so an agent written against either spelling works.

        Deliberately *not* mirrored on ``LabelClassBody``: a REST client sending
        the old key should get a clean refusal naming the field, not a silent
        reinterpretation of what it asked for.
        """
        if not isinstance(data, Mapping) or "geometry" not in data:
            return data
        if "geometries" in data:
            # A document carrying both is not one this ever wrote. Leave it be and
            # let ``extra='forbid'`` refuse the stray key, which names it.
            return data
        rest = {key: value for key, value in data.items() if key != "geometry"}
        return rest | {"geometries": (data["geometry"],)}

    @field_validator("name")
    @classmethod
    def _named(cls, value: str) -> str:
        """Stripped, and never blank — ``Annotation.label_class`` matches it exactly."""
        stripped = value.strip()
        if not stripped:
            raise ValueError("a class name must contain at least one non-blank character")
        return stripped

    @field_validator("geometries")
    @classmethod
    def _a_set_in_a_fixed_order(cls, value: tuple[GeometryType, ...]) -> tuple[GeometryType, ...]:
        """Deduplicated and sorted, so two ways of writing one set are one value."""
        return tuple(sorted(set(value), key=lambda geometry: geometry.value))

    @model_validator(mode="after")
    def _attribute_names_unique(self) -> LabelClass:
        names = [attribute.name.casefold() for attribute in self.attributes]
        if len(set(names)) != len(names):
            raise ValueError(f"class {self.name!r} has two attributes with the same name")
        return self


class AnnotationSchema(BaseModel):
    """The labeling contract for a Project, at one point in its history.

    ``version`` is monotonic (>= 1) and a version is never edited: every
    Annotation records the ``schema_version`` it was created under, so schema
    evolution never orphans existing labels. See ``SchemaService`` for how the
    next version is assigned and which changes it refuses.

    ``description`` is the **commit message** for the version: written once, at
    publish, and never updated — which is the immutability rule this model
    already lives under rather than a new one. Ongoing editable discussion about
    a version is a different feature and does not belong on a frozen artifact.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    version: int = Field(ge=1)
    classes: tuple[LabelClass, ...] = ()

    #: Why this version exists, in the author's own words. Optional: an empty
    #: commit message is legal, and a version published before the field existed
    #: has none.
    description: str | None = None

    #: When the version was published, UTC. Stamped by ``SchemaService``, in
    #: ``Asset.ingested_at``'s shape rather than the ``default_factory`` the
    #: non-nullable timestamps use — a factory would make every
    #: ``AnnotationSchema(...)`` built anywhere claim a moment. Nothing
    #: backfills one either: the only honest source is the service that
    #: publishes the version, and it stamps this at that moment.
    created_at: datetime | None = None

    #: Which kind of work published this version — see ``SchemaProvenance``.
    #: Recorded verbatim from the caller rather than inferred, because the only
    #: thing that knows whether a class was designed or needed-right-now is the
    #: surface the person was using. Null for a version published before this
    #: existed, and for any writer that declines to say.
    provenance: SchemaProvenance | None = None

    @field_validator("description")
    @classmethod
    def _tidied(cls, value: str | None) -> str | None:
        """``normalize_name``'s temperament, with the refusal removed.

        NFC and stripped for the reason every name in this domain is: two
        spellings that render identically must not be two different strings. But
        blank becomes ``None`` instead of raising, because "no description" is an
        ordinary thing to publish and a whitespace-only one says the same.

        In the type rather than in the service, so a description cannot arrive
        untidied through any door — the same argument that makes this model
        frozen.
        """
        if value is None:
            return None
        tidied = unicodedata.normalize("NFC", value).strip()
        return tidied or None

    @field_validator("created_at")
    @classmethod
    def _created_at_is_timezone_aware(cls, value: datetime | None) -> datetime | None:
        """The convention every timestamp in the domain follows.

        A naive datetime is rejected rather than assumed to be UTC: the store
        keeps ISO-8601 text, so an unqualified value read back would be
        indistinguishable from a qualified one and quietly wrong by the writer's
        offset from UTC.
        """
        if value is not None and value.tzinfo is None:
            raise ValueError("created_at must be timezone-aware (UTC)")
        return value


class SchemaPublication(BaseModel):
    """What one call to ``SchemaService.create_version`` did.

    Two facts, because publishing is now two facts. The version is the contract
    that was written; ``advanced_batches`` names the open batches whose pin moved
    onto it in the same transaction.

    The second one exists because a publish that silently moved three batches is a
    thing somebody needs told. It is also the only way a caller can *tell the
    cases apart*: an additive version with two open batches, an additive version
    with none, and a narrowing version that deliberately moved nothing all return
    a version and differ only here.

    Empty is the ordinary answer and never an error. It means the project had no
    batch in a state that takes a pin, or the change narrowed the contract and so
    was not allowed to follow — see :data:`REPINNABLE_STATES` and
    ``SchemaService.create_version``.

    A tuple in the order the batches were created, which is ``Repository.list``'s
    own order. Nothing sorts it: there is no ranking between batches, and imposing
    one would invent a meaning the caller would then read into it.

    ``published`` rather than ``schema``, which is the obvious name and is taken:
    pydantic warns that a field called ``schema`` shadows ``BaseModel.schema``.
    It also reads correctly on the one path where nothing was written — a publish
    of the contract already in force returns the version in force, which #583
    made the same answer on purpose.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    published: AnnotationSchema
    advanced_batches: tuple[UUID, ...] = ()
