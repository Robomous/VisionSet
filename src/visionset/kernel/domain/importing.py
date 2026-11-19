# usage: from visionset.kernel.domain import ImportedDataset, ImportConsent
"""What an importer reads out of an external dataset, and what an import did.

An importer never yields ``Annotation`` rows: it cannot know an ``asset_id``
before the assets exist. It yields this value instead, keyed by image paths
relative to the source, plus a report of everything it could not represent. See
``docs/content/architecture/decisions/an-import-is-a-labeled-batch.md``.
"""

from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum
from pathlib import PurePosixPath, PureWindowsPath
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from visionset.kernel.domain.geometry import Geometry
from visionset.kernel.domain.schema import GeometryType


class ImportLossKind(StrEnum):
    """What an import would drop. Consent is given per kind."""

    CLASS = "class"
    GEOMETRY = "geometry"
    LABEL = "label"
    IMAGE = "image"
    ATTRIBUTE = "attribute"


def require_relative_path(value: PurePosixPath | str) -> PurePosixPath:
    """The path, refused unless it names something strictly inside the source.

    Raises:
        ValueError: the path is empty, absolute, Windows-shaped or climbs out.
    """
    text = str(value)
    if not text or "\\" in text or "\x00" in text:
        raise ValueError(f"image path {text!r} is not a relative POSIX path")
    path = PurePosixPath(text)
    if path.is_absolute() or PureWindowsPath(text).drive:
        raise ValueError(f"image path {text!r} is absolute; it must be relative to the source")
    if ".." in path.parts or path == PurePosixPath("."):
        raise ValueError(f"image path {text!r} leaves the source directory")
    return path


def _class_name(value: str) -> str:
    # Stripped exactly as ``LabelClass.name`` is, so a label still names its class.
    stripped = value.strip()
    if not stripped:
        raise ValueError("a class name must contain at least one non-blank character")
    return stripped


class ImportedClass(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    geometries: tuple[GeometryType, ...] = Field(min_length=1)

    _named = field_validator("name")(_class_name)

    @field_validator("geometries")
    @classmethod
    def _a_set_in_a_fixed_order(cls, value: tuple[GeometryType, ...]) -> tuple[GeometryType, ...]:
        return tuple(sorted(set(value), key=lambda geometry: geometry.value))


class ImportedLabel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    class_name: str
    geometry: Geometry
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)

    _named = field_validator("class_name")(_class_name)


class ImportedImage(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    path: PurePosixPath
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    labels: tuple[ImportedLabel, ...] = ()

    @field_validator("path", mode="before")
    @classmethod
    def _inside_the_source(cls, value: object) -> PurePosixPath:
        if not isinstance(value, PurePosixPath | str):
            raise ValueError("image path must be a string or a PurePosixPath")
        return require_relative_path(value)


class ImportLoss(BaseModel):
    """One thing the import cannot carry, counted, with the reason in words."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: ImportLossKind
    subject: str
    count: int = Field(ge=1)
    reason: str


class ImportedDataset(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    classes: tuple[ImportedClass, ...]
    images: tuple[ImportedImage, ...]
    losses: tuple[ImportLoss, ...] = ()

    @model_validator(mode="after")
    def _consistent(self) -> ImportedDataset:
        declared: dict[str, ImportedClass] = {}
        for imported in self.classes:
            if imported.name in declared:
                raise ValueError(f"class {imported.name!r} is declared twice")
            declared[imported.name] = imported
        seen: set[PurePosixPath] = set()
        for image in self.images:
            if image.path in seen:
                raise ValueError(f"image {str(image.path)!r} is listed twice")
            seen.add(image.path)
            for label in image.labels:
                owner = declared.get(label.class_name)
                if owner is None:
                    raise ValueError(
                        f"image {str(image.path)!r} has a label of undeclared class "
                        f"{label.class_name!r}"
                    )
                if label.geometry.type not in owner.geometries:
                    raise ValueError(
                        f"class {owner.name!r} does not declare {label.geometry.type.value}, "
                        f"but image {str(image.path)!r} has one"
                    )
        return self


def loss_kinds(losses: Iterable[ImportLoss]) -> frozenset[ImportLossKind]:
    return frozenset(loss.kind for loss in losses)


class ImportConsent(BaseModel):
    """The loss kinds a caller has agreed to. Empty means nothing may be dropped."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kinds: frozenset[ImportLossKind] = frozenset()

    def uncovered(self, losses: Iterable[ImportLoss]) -> frozenset[ImportLossKind]:
        return loss_kinds(losses) - self.kinds


class ImportPlan(BaseModel):
    """What committing the same source would do, computed without writing.

    ``losses`` is the importer's report plus what only the workspace can tell:
    images the source names but does not hold, images whose bytes repeat an
    earlier listed image (the first path in sorted order wins and the later
    ones' labels are dropped), and labels wholly outside their decoded image.
    ``images`` is what a commit would import, those drops already applied.

    ``conflicts`` are refusals a commit would raise even with full consent: a
    label the active schema cannot accept, classes that cannot form a schema,
    or a label that would land on an asset another batch or the trunk holds.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    project_id: UUID
    format_name: str
    dataset: ImportedDataset
    images: tuple[ImportedImage, ...]
    losses: tuple[ImportLoss, ...]
    missing_images: tuple[PurePosixPath, ...]
    conflicts: tuple[str, ...]
    creates_schema: bool
    new_assets: int = Field(ge=0)
    new_annotations: int = Field(ge=0)
    annotations_already_present: int = Field(ge=0)


class ImportRun(BaseModel):
    """What a committed import wrote.

    ``batch_id`` is ``None`` when the run wrote nothing: no asset was new and
    every label was already on its asset. That is what a second run of the same
    source answers while its first batch is untouched, and also after that
    batch was deleted. A re-run is not a re-sync: once a reviewer has changed
    a label, the source's version of it is new again and lands on an asset a
    batch holds, so the commit refuses with ``AssetNotWritable``.

    ``schema_version`` is ``None`` only when nothing was written and the
    project has no schema.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    project_id: UUID
    format_name: str
    batch_id: UUID | None
    schema_version: int | None = Field(default=None, ge=1)
    created_asset_ids: tuple[UUID, ...]
    asset_ids: tuple[UUID, ...]
    annotations_written: int = Field(ge=0)
    annotations_already_present: int = Field(ge=0)
    losses: tuple[ImportLoss, ...]
