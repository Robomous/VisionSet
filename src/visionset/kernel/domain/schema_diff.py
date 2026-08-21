# usage: from visionset.kernel.domain import diff_classes, SchemaDiff, ChangeKind
"""Classifying what one schema version does to the version before it.

Two kinds of change, and the line between them is drawn from one question: *does
an annotation that was valid under the old version stay valid under the new
one?*

- **Additive** — it does. New classes, new optional attributes, a wider ``select``.
  Nothing already labeled stops meaning what it meant.
- **Destructive** — it does not. Removing a class, taking a geometry away from
  one, adding a required attribute, narrowing a ``select``. Existing annotations
  are left referring to something the contract no longer describes.

Matching is by **exact class name and exact attribute name**. That makes a rename
read as a removal plus an addition, which looks lossy until you remember that
``Annotation.label_class`` is matched by exact string too: a rename really does
orphan every annotation under the old name. The kernel cannot see intent, and
guessing at it would be guessing with someone's labels.

One rename is not a guess: ``car`` to ``Car``. A version cannot hold both — class
names are unique within a version ignoring case — so a name that leaves as
another casing arrives is a re-casing and nothing else. The verdict does not
move (the labels still carry ``car``), but the change says what it is, so a
surface can explain the cost instead of reporting a removal nobody made.

This module is pure — no ports, no store, no workspace. The judging functions
take two class lists and return a verdict; the report models beside them carry
entities and ids a service has already read, because a caller told *this is
refused* has to be able to reach what refused it. Nothing here reads them. So
``SchemaService`` can gate on it, a delivery surface can preview with it, and
neither has to reach for the other.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from visionset.kernel.domain.annotation import Annotation
from visionset.kernel.domain.asset import Asset
from visionset.kernel.domain.dataset import ClassCount
from visionset.kernel.domain.schema import Attribute, GeometryType, LabelClass


class ChangeKind(StrEnum):
    """Whether a change preserves the meaning of existing annotations."""

    ADDITIVE = "additive"
    DESTRUCTIVE = "destructive"


class OrphanGuard(BaseModel):
    """Which annotations of one class a destructive change leaves orphaned.

    The grain the orphan gate matches on, and the module's one question asked
    the way an annotation can answer it: an annotation carries one class, one
    shape and a map of attribute values, so a change dooms it by naming the
    class and, when the change is narrower than the class, the shape or the
    attribute it is about. Every field after ``label_class`` narrows the set;
    a guard with none of them is the whole class.

    ``attribute`` picks the annotations that **carry** the key, unless ``unset``
    picks the ones that do not; ``option`` narrows the carriers to the one
    value that is going away. A ``select``'s options are strings, so the value
    compared is one.

    Both the SQL predicate a guarded write evaluates and :meth:`matches` spell
    this, and they must agree: the write decides, and the Python walk is what
    reports what it decided over.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    label_class: str
    geometry: GeometryType | None = None
    attribute: str | None = None
    option: str | None = None
    unset: bool = False

    def matches(self, annotation: Annotation) -> bool:
        if annotation.label_class != self.label_class:
            return False
        if self.geometry is not None and annotation.geometry.type is not self.geometry:
            return False
        if self.attribute is None:
            return True
        if self.unset:
            return self.attribute not in annotation.attributes
        if self.attribute not in annotation.attributes:
            return False
        return self.option is None or annotation.attributes[self.attribute] == self.option


class SchemaChange(BaseModel):
    """One difference between two versions, already judged."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: ChangeKind
    label_class: str
    attribute: str | None = None
    orphans: OrphanGuard | None = None
    """Exactly which annotations this change strands — set on every destructive one.

    A destructive change is the only thing that knows its own grain: a shape
    removed is about one shape, an attribute removed is about the annotations
    carrying it, a required attribute added is about every annotation of the
    class. Carrying that here is what lets the orphan gate be exact without
    re-deriving the diff or parsing ``detail``. ``None`` on an additive change,
    which orphans nothing by definition.
    """
    detail: str
    """Human-readable, and used verbatim in the errors ``SchemaService`` raises."""

    @model_validator(mode="after")
    def _destructive_iff_guarded(self) -> SchemaChange:
        """A destructive change that names no guard would narrow the contract and refuse nothing."""
        if (self.kind is ChangeKind.DESTRUCTIVE) != (self.orphans is not None):
            raise ValueError(
                f"a {self.kind.value} change must "
                f"{'say' if self.orphans is None else 'not say'} what it orphans"
            )
        return self


class SchemaDiff(BaseModel):
    """Every difference between two versions, in the order they were found."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    changes: tuple[SchemaChange, ...] = ()

    @property
    def is_destructive(self) -> bool:
        return any(change.kind is ChangeKind.DESTRUCTIVE for change in self.changes)

    @property
    def destructive_classes(self) -> frozenset[str]:
        """The classes a destructive change touches — the ones that can orphan labels."""
        return frozenset(
            change.label_class for change in self.changes if change.kind is ChangeKind.DESTRUCTIVE
        )

    @property
    def guards(self) -> frozenset[OrphanGuard]:
        """Exactly which annotations this diff would leave orphaned, as predicates.

        What a guarded write matches on and what the refusal counts over: one
        :class:`OrphanGuard` per destructive change, at that change's own grain.
        Empty for an additive diff, and an empty guard refuses nothing.
        """
        return frozenset(change.orphans for change in self.changes if change.orphans is not None)

    def describe(self, kind: ChangeKind) -> str:
        """The details of one kind, joined for an error message."""
        return "; ".join(change.detail for change in self.changes if change.kind is kind)


class SchemaChangePreview(BaseModel):
    """A proposed version's verdict, and what stands in the way of publishing it.

    :class:`SchemaDiff` answers whether the change narrows the contract, which is
    a question about two class lists and nothing else. This adds the half no
    caller can compute for itself — which of the classes being dropped already
    carry labels, and how many — so a surface can say *this will be refused, over
    these* **before** it asks rather than after. That is what
    ``SchemaService.preview`` has promised since it was written and what nothing
    on the wire could answer.

    ``blockers`` is the same report :class:`SchemaChangeWouldOrphan` carries, and
    deliberately so: one shape for the warning and for the refusal means a client
    renders both with one piece of code, and the two cannot drift into
    disagreeing about a question they are both answering.

    Empty ``blockers`` under a destructive ``diff`` is the ordinary safe
    narrowing — the change removes something nobody has used — and is exactly the
    case ``allow_destructive`` exists to confirm rather than refuse.

    Sorted by class name in a validator, on ``Manifest``'s terms: a report two
    callers may compare has one order, and it is not the order a dict happened to
    iterate in.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    diff: SchemaDiff
    blockers: tuple[ClassCount, ...] = ()

    @field_validator("blockers")
    @classmethod
    def _ordered(cls, value: tuple[ClassCount, ...]) -> tuple[ClassCount, ...]:
        return tuple(sorted(value, key=lambda count: count.label_class))

    @property
    def is_refused(self) -> bool:
        """Whether ``create_version`` would refuse this outright, flag or no flag.

        Published rather than left to the caller, for the reason ``is_destructive``
        is: a client deciding whether to offer a way forward must not re-derive
        the rule from ``blockers`` and get it subtly wrong — that is the
        hand-mirrored table the ``ui-capabilities`` contract bans, in miniature.
        """
        return bool(self.blockers)


class BlockingAsset(BaseModel):
    """One asset standing in the way of a narrowing, and where to reach it.

    :class:`SchemaChangePreview` counts a class; this names the frames behind the
    count, at the same grain the guard matches on, so a listing and a count of
    the same narrowing cannot disagree.

    ``batches`` is every batch holding the asset rather than one, because an asset
    put in a batch and later in a correction of it is in both, and there is no
    stored fact that would make one of them the answer.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset: Asset
    #: The blocking classes this asset carries, sorted.
    label_classes: tuple[str, ...]
    #: How many of its annotations the guard would orphan.
    annotations: int = Field(ge=1)
    batches: tuple[UUID, ...]


def diff_classes(previous: Sequence[LabelClass], proposed: Sequence[LabelClass]) -> SchemaDiff:
    """Judge what ``proposed`` does to ``previous``.

    ``previous`` empty is the version-1 base case: everything is additive, because
    there are no annotations under a version that never existed.
    """
    return SchemaDiff(changes=tuple(_changes(previous, proposed)))


def _changes(
    previous: Sequence[LabelClass], proposed: Sequence[LabelClass]
) -> Iterator[SchemaChange]:
    before = {label_class.name: label_class for label_class in previous}
    after = {label_class.name: label_class for label_class in proposed}
    arrived = {name.casefold(): name for name in after if name not in before}

    for name, label_class in after.items():
        if name not in before:
            yield SchemaChange(
                kind=ChangeKind.ADDITIVE,
                label_class=name,
                detail=f"class {name!r} added",
            )
        else:
            yield from _class_changes(before[name], label_class)

    for name in before:
        if name in after:
            continue
        recased = arrived.get(name.casefold())
        detail = f"class {name!r} removed"
        if recased is not None and not any(_class_changes(before[name], after[recased])):
            detail += (
                f"; {recased!r} differs only in its casing, and annotations match their "
                f"class by exact name, so a re-casing is a rename and orphans the labels "
                f"under {name!r}"
            )
        yield SchemaChange(
            kind=ChangeKind.DESTRUCTIVE,
            label_class=name,
            orphans=OrphanGuard(label_class=name),
            detail=detail,
        )


def _class_changes(before: LabelClass, after: LabelClass) -> Iterator[SchemaChange]:
    """What changed within one class that kept its name.

    ``color`` is deliberately absent: it is how a class is drawn, not what it
    means, and reporting it would put cosmetic edits behind a destructive gate.
    """
    # The same shape as a ``select``'s options below, for the same reason: a class
    # that gains a geometry invalidates nothing already drawn, and one that loses
    # a geometry orphans every annotation carrying it. Answering the module's one
    # question per geometry is what makes widening an ordinary save — the whole
    # point of a class holding a set — while narrowing stays behind the flag.
    old_geometries = set(before.geometries)
    new_geometries = set(after.geometries)
    for geometry in sorted(new_geometries - old_geometries):
        yield SchemaChange(
            kind=ChangeKind.ADDITIVE,
            label_class=after.name,
            detail=f"geometry {geometry.value!r} added to class {after.name!r}",
        )
    for geometry in sorted(old_geometries - new_geometries):
        yield SchemaChange(
            kind=ChangeKind.DESTRUCTIVE,
            label_class=after.name,
            orphans=OrphanGuard(label_class=after.name, geometry=geometry),
            detail=f"geometry {geometry.value!r} removed from class {after.name!r}",
        )

    old = {attribute.name: attribute for attribute in before.attributes}
    new = {attribute.name: attribute for attribute in after.attributes}

    for name, attribute in new.items():
        if name not in old:
            # A required attribute nobody has filled in is a hole in every
            # annotation that already exists, which is what makes it destructive
            # — and of the whole class, since none could carry a key the version
            # it was written under did not declare.
            yield SchemaChange(
                kind=(ChangeKind.DESTRUCTIVE if attribute.required else ChangeKind.ADDITIVE),
                label_class=after.name,
                attribute=name,
                orphans=OrphanGuard(label_class=after.name) if attribute.required else None,
                detail=(
                    f"{'required' if attribute.required else 'optional'} attribute {name!r} "
                    f"added to class {after.name!r}"
                ),
            )
        else:
            yield from _attribute_changes(after.name, old[name], attribute)

    for name in old:
        if name not in new:
            yield SchemaChange(
                kind=ChangeKind.DESTRUCTIVE,
                label_class=after.name,
                attribute=name,
                orphans=OrphanGuard(label_class=after.name, attribute=name),
                detail=f"attribute {name!r} removed from class {after.name!r}",
            )


def _attribute_changes(
    label_class: str, before: Attribute, after: Attribute
) -> Iterator[SchemaChange]:
    """What changed within one attribute that kept its name.

    Order is not semantic, so a reordered attribute list yields nothing. A
    changed ``default`` is additive: it decides what a surface offers next, and
    revalidates nothing already stored.
    """
    if before.kind != after.kind:
        yield SchemaChange(
            kind=ChangeKind.DESTRUCTIVE,
            label_class=label_class,
            attribute=after.name,
            orphans=OrphanGuard(label_class=label_class, attribute=after.name),
            detail=(
                f"attribute {after.name!r} on class {label_class!r} changed kind from "
                f"{before.kind!r} to {after.kind!r}"
            ),
        )
        # Its options and default are read against a type that no longer applies,
        # so comparing them further would only add noise to the same verdict.
        return

    if before.required != after.required:
        # Becoming required strands the annotations that never set it; the ones
        # that did are as valid as they were.
        yield SchemaChange(
            kind=(ChangeKind.DESTRUCTIVE if after.required else ChangeKind.ADDITIVE),
            label_class=label_class,
            attribute=after.name,
            orphans=(
                OrphanGuard(label_class=label_class, attribute=after.name, unset=True)
                if after.required
                else None
            ),
            detail=(
                f"attribute {after.name!r} on class {label_class!r} became "
                f"{'required' if after.required else 'optional'}"
            ),
        )

    old_options = set(before.options or ())
    new_options = set(after.options or ())
    for option in sorted(new_options - old_options):
        yield SchemaChange(
            kind=ChangeKind.ADDITIVE,
            label_class=label_class,
            attribute=after.name,
            detail=f"option {option!r} added to attribute {after.name!r} on class {label_class!r}",
        )
    for option in sorted(old_options - new_options):
        yield SchemaChange(
            kind=ChangeKind.DESTRUCTIVE,
            label_class=label_class,
            attribute=after.name,
            orphans=OrphanGuard(label_class=label_class, attribute=after.name, option=option),
            detail=(
                f"option {option!r} removed from attribute {after.name!r} on class {label_class!r}"
            ),
        )

    if before.default != after.default:
        yield SchemaChange(
            kind=ChangeKind.ADDITIVE,
            label_class=label_class,
            attribute=after.name,
            detail=(
                f"attribute {after.name!r} on class {label_class!r} changed its default from "
                f"{before.default!r} to {after.default!r}"
            ),
        )
