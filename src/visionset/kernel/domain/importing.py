# usage: from visionset.kernel.domain import ImportedDataset, ImportConsent
"""What an importer reads out of an external dataset, and what an import did.

An importer never yields ``Annotation`` rows: it cannot know an ``asset_id``
before the assets exist. It yields this value instead, keyed by image or scan
paths relative to the source, plus a report of everything it could not
represent. See ``docs/content/architecture/decisions/an-import-is-a-labeled-batch.md``.
"""

from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum
from pathlib import PurePosixPath, PureWindowsPath
from typing import Final, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from visionset.kernel.domain.asset import GroupLabel
from visionset.kernel.domain.calibration import (
    ScanFrame,
    geometry_fits_modality,
    geometry_reference,
)
from visionset.kernel.domain.geometry import Geometry
from visionset.kernel.domain.names import normalize_name
from visionset.kernel.domain.schema import GeometryType
from visionset.kernel.errors import InvalidName


class ImportLossKind(StrEnum):
    """What an import would drop. Consent is given per kind."""

    CLASS = "class"
    GEOMETRY = "geometry"
    LABEL = "label"
    IMAGE = "image"
    SCAN = "scan"
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
    """One label. ``track`` is the identity the dataset gives its object within a sequence."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    class_name: str
    geometry: Geometry
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    track: str | None = None

    _named = field_validator("class_name")(_class_name)

    @field_validator("track")
    @classmethod
    def _track_is_not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("a track id must contain at least one non-blank character")
        return value


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


#: A field of a headerless scan record: a coordinate, the intensity, or ``_``
#: for one the import skips.
ScanRecordField = Literal["x", "y", "z", "intensity", "_"]

_SCAN_VALUE_BYTES: Final = 4


class ScanLayout(BaseModel):
    """How a headerless scan file's bytes are points: little-endian float32 records.

    A KITTI ``.bin`` is ``("x", "y", "z", "intensity")``. The import reads the
    file whole and writes it as a binary PCD carrying exactly these fields, so
    the bytes are kept as they are and only a header is added.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    fields: tuple[ScanRecordField, ...]

    @field_validator("fields")
    @classmethod
    def _named_once(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        for name in ("x", "y", "z"):
            if value.count(name) != 1:
                raise ValueError(f"a scan record holds {name} exactly once")
        if value.count("intensity") > 1:
            raise ValueError("a scan record holds intensity at most once")
        return value

    @property
    def record_size(self) -> int:
        return _SCAN_VALUE_BYTES * len(self.fields)

    def pcd_header(self, points: int) -> bytes:
        """The header that makes ``points`` records of this layout a binary PCD."""
        if points < 1:
            raise ValueError("a scan holds at least one point")
        count = len(self.fields)
        return (
            "VERSION 0.7\n"
            f"FIELDS {' '.join(self.fields)}\n"
            f"SIZE {' '.join([str(_SCAN_VALUE_BYTES)] * count)}\n"
            f"TYPE {' '.join(['F'] * count)}\n"
            f"COUNT {' '.join(['1'] * count)}\n"
            f"WIDTH {points}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\n"
            f"POINTS {points}\nDATA binary\n"
        ).encode("ascii")


class ImportedScan(BaseModel):
    """One point-cloud scan by its path in the source, and its labels in the dataset's frame.

    ``group_label`` names the set the source says the scan belongs to — a
    nuScenes scene — and becomes the new asset's ``group_label``.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    path: PurePosixPath
    layout: ScanLayout
    labels: tuple[ImportedLabel, ...] = ()
    group_label: GroupLabel | None = None

    @field_validator("path", mode="before")
    @classmethod
    def _inside_the_source(cls, value: object) -> PurePosixPath:
        if not isinstance(value, PurePosixPath | str):
            raise ValueError("scan path must be a string or a PurePosixPath")
        return require_relative_path(value)


class ImportedFrame(BaseModel):
    """One still of a sequence, and its time since the sequence's first frame.

    ``timestamp`` is ``None`` when the dataset records no timing for it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    path: PurePosixPath
    timestamp: float | None = Field(ge=0)

    @field_validator("path", mode="before")
    @classmethod
    def _inside_the_source(cls, value: object) -> PurePosixPath:
        if not isinstance(value, PurePosixPath | str):
            raise ValueError("frame path must be a string or a PurePosixPath")
        return require_relative_path(value)


class ImportedSequence(BaseModel):
    """Stills the dataset itself orders, such as one OpenLane segment.

    A frame's position is its index in ``frames``, so a frame the source names
    but does not hold leaves its position empty rather than shifting the rest.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    frames: tuple[ImportedFrame, ...] = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def _a_source_name(cls, value: str) -> str:
        try:
            return normalize_name(value, what="source name")
        except InvalidName as refusal:
            raise ValueError(str(refusal)) from None

    @model_validator(mode="after")
    def _ordered(self) -> ImportedSequence:
        if len({frame.path for frame in self.frames}) != len(self.frames):
            raise ValueError(f"sequence {self.name!r} lists a frame twice")
        times = [frame.timestamp for frame in self.frames if frame.timestamp is not None]
        if times and len(times) != len(self.frames):
            raise ValueError(f"sequence {self.name!r} times some frames and not others")
        if times != sorted(times):
            raise ValueError(f"sequence {self.name!r} is not in time order")
        return self


class ImportLoss(BaseModel):
    """One thing the import cannot carry, counted, with the reason in words."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: ImportLossKind
    subject: str
    count: int = Field(ge=1)
    reason: str


class ImportedDataset(BaseModel):
    """A dataset of images, or of scans in one declared ``frame``, never both.

    ``frame`` is the scan frame every scan and every scan label is written in,
    and it is set exactly when the dataset is one of scans, even an empty one.

    ``sequences`` order some of the images; an image is in at most one, and only
    a label on one may name a ``track``, which must be 2D.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    classes: tuple[ImportedClass, ...]
    images: tuple[ImportedImage, ...] = ()
    scans: tuple[ImportedScan, ...] = ()
    frame: ScanFrame | None = None
    losses: tuple[ImportLoss, ...] = ()
    sequences: tuple[ImportedSequence, ...] = ()

    @model_validator(mode="after")
    def _consistent(self) -> ImportedDataset:
        if self.images and self.scans:
            raise ValueError("a dataset holds images or scans, not both")
        if self.scans and self.frame is None:
            raise ValueError("a dataset of scans declares the frame they are written in")
        if self.images and self.frame is not None:
            raise ValueError("a dataset of images declares no scan frame")
        declared: dict[str, ImportedClass] = {}
        for imported in self.classes:
            if imported.name in declared:
                raise ValueError(f"class {imported.name!r} is declared twice")
            declared[imported.name] = imported
        what = "image" if self.frame is None else "scan"
        seen: set[PurePosixPath] = set()
        items: tuple[ImportedImage | ImportedScan, ...] = (*self.images, *self.scans)
        for item in items:
            if item.path in seen:
                raise ValueError(f"{what} {str(item.path)!r} is listed twice")
            seen.add(item.path)
            for label in item.labels:
                owner = declared.get(label.class_name)
                if owner is None:
                    raise ValueError(
                        f"{what} {str(item.path)!r} has a label of undeclared class "
                        f"{label.class_name!r}"
                    )
                if label.geometry.type not in owner.geometries:
                    raise ValueError(
                        f"class {owner.name!r} does not declare {label.geometry.type.value}, "
                        f"but {what} {str(item.path)!r} has one"
                    )
                if what == "scan" and not geometry_fits_modality(
                    label.geometry, modality="point_cloud"
                ):
                    raise ValueError(
                        f"scan {str(item.path)!r} has a {label.geometry.type.value}, "
                        "which a scan has no pixels for"
                    )
        self._sequences_consistent()
        return self

    def _sequences_consistent(self) -> None:
        listed = {image.path for image in self.images}
        sequenced: set[PurePosixPath] = set()
        for sequence in self.sequences:
            for frame in sequence.frames:
                if frame.path not in listed:
                    raise ValueError(
                        f"sequence {sequence.name!r} names {str(frame.path)!r}, "
                        "which is not a listed image"
                    )
                if frame.path in sequenced:
                    raise ValueError(f"image {str(frame.path)!r} is in two sequences")
                sequenced.add(frame.path)
        for image in self.images:
            for label in image.labels:
                if label.track is None:
                    continue
                if image.path not in sequenced:
                    raise ValueError(
                        f"image {str(image.path)!r} names a track but is in no sequence"
                    )
                if geometry_reference(label.geometry, modality="image") is not None:
                    raise ValueError(
                        f"image {str(image.path)!r} names a track on a "
                        f"{label.geometry.type.value}; a track follows 2D geometry only"
                    )


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
    images the source names but does not hold, images outside any sequence whose
    bytes repeat an earlier listed image (the first in listing order wins, a
    sequence's frames in the sequence's own order, and the later ones' labels
    are dropped), and labels wholly outside their decoded image. ``images`` is
    what a commit would import, those drops already applied. ``repeats`` are the
    sequence frames whose bytes repeat an image in ``images``: each is an
    occurrence of that image's asset, and its labels land there. ``scans`` and
    ``missing_scans`` are the same for a dataset of scans, whose labels have no
    image to fall outside of.

    ``annotations_already_present`` counts the labels a commit would not write
    because their asset carries an equal one already, including an untracked
    label at a repeat whose equal an earlier occurrence of the same bytes writes.

    ``sequences`` counts the sequences a commit would write, those holding an
    asset it creates or labels, and ``tracks`` the tracks over them, one per
    sequence and track id among the labels it would write. A label whose id
    repeats within a frame, or names a track of another class, is kept
    untracked and reported as an ``attribute`` loss.

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
    scans: tuple[ImportedScan, ...] = ()
    missing_scans: tuple[PurePosixPath, ...] = ()
    repeats: tuple[ImportedImage, ...] = ()
    creates_schema: bool
    new_assets: int = Field(ge=0)
    new_annotations: int = Field(ge=0)
    annotations_already_present: int = Field(ge=0)
    sequences: int = Field(default=0, ge=0)
    tracks: int = Field(default=0, ge=0)


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

    ``source_ids`` are the image-sequence sources the run wrote, one per
    sequence holding an asset it created or labelled; ``tracks_written`` counts
    the tracks over them. A label already on its asset is not written again, so
    it is not observed again either.
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
    source_ids: tuple[UUID, ...] = ()
    tracks_written: int = Field(default=0, ge=0)
