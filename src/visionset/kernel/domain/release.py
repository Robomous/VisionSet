# usage: from visionset.kernel.domain import Manifest, Release, SplitRecipe
"""The Release: the one artifact in VisionSet that never changes.

Everything else here is alive. A Dataset gains assets and loses them, a schema
grows a version, a batch moves through its states. A Release is the opposite
kind of thing — the answer to "which bytes and which labels did we train on?",
fixed at the moment it was published and never revisited. An error in a release
is fixed by publishing another one, never by editing it.

Three decisions shape this module, and they are worth reading before changing
anything in it.

- **The manifest is a pure function of content.** Nothing time-, machine- or
  identity-specific goes inside it: no timestamp, no release id, no tag. That is
  what makes "publish twice from an unchanged dataset and the bytes agree" a
  property of the design rather than something to engineer, and it is why the
  generation metadata lives on :class:`Release` instead. A second consequence
  falls out for free: two releases with identical content name the same manifest
  blob, because a content-addressed store deduplicates them.
- **The manifest copies the labels, it does not point at them.** A
  :class:`ManifestAnnotation` carries the geometry and the attribute values as
  they were. Deleting the live ``Annotation`` afterwards cannot reach backwards
  into a published release.
- **Ordering is canonical, not historical.** Assets sort by content hash, labels
  by id. The order assets happened to be promoted in — which batch, which day —
  is an accident of how the trunk was built and has no business deciding what
  the artifact's bytes are.

The split recipe is stored, not materialized: ``{train, val, test, seed}`` is
three fractions and a number, plus an optional ``group_by``, and
:func:`assign_split` turns it into folds on demand. Keeping the recipe rather
than the assignment is what lets a release stay small and an export stay
reproducible from it.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Sequence
from datetime import UTC, datetime
from enum import StrEnum
from typing import BinaryIO
from uuid import UUID, uuid4

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from visionset.kernel.domain.annotation import Provenance
from visionset.kernel.domain.asset import GroupLabel
from visionset.kernel.domain.calibration import (
    Calibration,
    Modality,
    ScanFrame,
    geometry_fits_modality,
    geometry_needs_calibration,
)
from visionset.kernel.domain.export_target import ResizeStrategy
from visionset.kernel.domain.geometry import Geometry
from visionset.kernel.domain.media import PointCloudMetadata
from visionset.kernel.domain.schema import AttributeValue, GeometryType, LabelClass
from visionset.kernel.errors import UnserializableManifest

#: The format of the manifest document itself — independent of ``FORMAT_VERSION``
#: (the workspace database) and of the package version (which build made it).
#:
#: A manifest is read with ``extra='forbid'``, so a document written by a later
#: VisionSet fails to load. That is deliberate, and the opposite of the call
#: ``DatasetChange.operation`` makes, where forward-compatibility wins because a
#: log is advisory. Here the document is hash-pinned evidence, and
#: half-understanding one is worse than refusing it. This field is what lets the
#: refusal say "format 3, and this build reads 2" rather than complain about an
#: unrecognised key.
#:
#: **2** since #584, which made ``LabelClass.geometries`` plural and so changed
#: the shape of ``classes`` here. A version-1 document still loads — ``LabelClass``
#: reads the old singular key — so every release published before that stays
#: verifiable, with its bytes and its hash untouched.
#:
#: **3** since #352, which let a polyline carry ``visibility``, one state per
#: vertex. The key is omitted when unknown, so a polyline without it serializes
#: to the bytes it did under 2, and a version-2 document loads and verifies with
#: its hash untouched. A document that does carry it is one a version-2 build
#: refuses, which is what the bump announces.
#:
#: **4** since #1038, which added ``polyline_3d`` to the geometry union and a
#: ``calibration`` to :class:`ManifestAsset`, embedded only on an asset carrying
#: a 3D label and omitted otherwise. A release is written at the lowest version
#: that can express it (:func:`manifest_version_for`), so a 2D release is still
#: a version-3 document with the bytes and the hash it had before, and only a
#: release holding a 3D label is one a version-3 build refuses. ``cuboid_3d``
#: (#1045) joined the union under the same version before any build wrote 4,
#: and is held to the same rule: a cuboid needs a calibration, and a
#: calibration needs version 4.
#:
#: **5** since #1046, which added the point-cloud modality: a
#: :class:`ManifestAsset` may carry ``modality``, its ``point_cloud`` metadata
#: and the ``frame`` its labels are read against. ``modality`` is omitted when
#: it is ``image``, so an image-only release is still a version-3 or version-4
#: document with its bytes and its hash untouched, and only a release holding a
#: point cloud is one a version-4 build refuses.
#:
#: **6** since #1147, which let a :class:`ManifestAsset` carry the
#: ``group_label`` its importer gave it, so a split recipe with ``group_by`` is
#: cut from the document alone. The key is omitted when there is none, so a
#: release of unlabelled assets keeps the version, the bytes and the hash it had
#: before, and only a release holding a group label is one a version-5 build
#: refuses.
MANIFEST_VERSION: int = 6

CALIBRATED_MANIFEST_VERSION: int = 4
"""The first manifest version that can carry a calibration, and so a 3D label."""

MODALITY_MANIFEST_VERSION: int = 5
"""The first manifest version that can carry an asset that is not an image."""

GROUPED_MANIFEST_VERSION: int = 6
"""The first manifest version that can carry an asset's group label."""


class ManifestAnnotation(BaseModel):
    """One label, copied into a release as it stood at publication.

    Not a reference. The live ``Annotation`` this was taken from can be edited or
    deleted afterwards and this stays exactly as it is, which is the whole point
    of a release being a snapshot rather than a bookmark.

    ``schema_version`` is the annotation's own, stamped from the batch that
    pinned it. It can differ from :attr:`Manifest.schema_version`; see that field
    for why the mixture is safe.

    Frozen, like every value object in a contract — with one honest wart:
    ``attributes`` is a dict, so ``hash()`` of this model raises ``TypeError``.
    Nothing hashes it, and a tuple of pairs would make the JSON shape worse for
    every reader in exchange for a capability nobody wants.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID
    label_class: str
    schema_version: int = Field(ge=1)
    geometry: Geometry
    attributes: dict[str, AttributeValue] = Field(default_factory=dict)
    provenance: Provenance
    model_ref: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class ManifestAsset(BaseModel):
    """One asset in a release, with everything drawn on it.

    ``content_hash`` is the identity that matters: it names the blob, and
    ``ReleaseService.verify`` re-reads those bytes and re-hashes them. ``uri`` is
    kept because an exporter names its output files from it — but it is a
    workspace-local path, and that is exactly why a manifest hash is a *snapshot*
    identity rather than a universal content identity. The same images ingested
    on another machine produce a different manifest.

    ``calibration`` is a copy of the calibration that applied to the asset at
    publication, present exactly when the asset carries a 3D label — a 3D label
    is never read without it — and **omitted** otherwise, so a 2D asset
    serializes to the bytes it always did, whatever its source says.

    ``modality`` is omitted when it is ``image``, which is what keeps every
    image-only manifest at the bytes it had before point clouds existed. A
    ``point_cloud`` asset carries its scan metadata and the ``frame`` its
    source declared, in place of pixel dimensions and a calibration.

    ``group_label`` is the asset's own, copied whatever the release's split
    recipe says, because the document is a function of content and a recipe is
    not content. It is **omitted** when the asset has none.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset_id: UUID
    content_hash: str
    uri: str
    width: int | None = None
    height: int | None = None
    annotations: tuple[ManifestAnnotation, ...] = ()
    calibration: Calibration | None = Field(default=None, exclude_if=lambda value: value is None)
    modality: Modality = Field(default="image", exclude_if=lambda value: value == "image")
    point_cloud: PointCloudMetadata | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    frame: ScanFrame | None = Field(default=None, exclude_if=lambda value: value is None)
    group_label: GroupLabel | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def _three_d_labels_carry_their_calibration(self) -> ManifestAsset:
        if self.calibration is None and any(
            geometry_needs_calibration(annotation.geometry, modality=self.modality)
            for annotation in self.annotations
        ):
            raise ValueError(
                f"asset {self.asset_id} carries a 3D label and no calibration to read it against"
            )
        return self

    @model_validator(mode="after")
    def _scan_carries_its_metadata_and_frame(self) -> ManifestAsset:
        scan = self.modality == "point_cloud"
        if (self.point_cloud is not None) != scan or (self.frame is not None) != scan:
            raise ValueError(
                f"asset {self.asset_id}: point_cloud metadata and a frame are present "
                "exactly on a point_cloud asset"
            )
        if scan and (
            self.calibration is not None or self.width is not None or self.height is not None
        ):
            raise ValueError(
                f"point-cloud asset {self.asset_id} carries no calibration and no pixel size"
            )
        misfit = next(
            (
                one
                for one in self.annotations
                if not geometry_fits_modality(one.geometry, modality=self.modality)
            ),
            None,
        )
        if misfit is not None:
            raise ValueError(
                f"asset {self.asset_id} is a {self.modality} and cannot carry a "
                f"{misfit.geometry.type.value} label"
            )
        return self

    @field_validator("annotations")
    @classmethod
    def _in_canonical_order(
        cls, value: tuple[ManifestAnnotation, ...]
    ) -> tuple[ManifestAnnotation, ...]:
        """By id, whatever order the caller had them in. See :class:`Manifest`."""
        return tuple(sorted(value, key=lambda annotation: str(annotation.id)))


class Manifest(BaseModel):
    """The frozen inventory of a Release: the contract, the bytes, the labels.

    This is the document that lives in the blob store, and the thing
    ``Release.manifest_hash`` names. It deliberately carries no timestamp, no tag
    and no release id — see the module docstring.

    ``schema_version`` and ``classes`` are the project's *active* version at
    publication, while each :class:`ManifestAnnotation` keeps the version its own
    batch pinned. Batch writes validate against that pin; release publication
    validates every copied annotation against the active schema before creating a
    new manifest. Historic manifests remain readable, so exporters also defend
    against malformed external or legacy content that did not traverse that gate.

    **The assets sort themselves**, by content hash and then by id, and each
    asset's annotations sort by id. That belongs here rather than in the service
    that builds one, for the same reason immutability does: a rule the artifact
    depends on should be a property of the artifact, not a habit of its callers.
    Which batch an asset arrived in — and on which day — is an accident of how
    the trunk was built, and letting it reach the bytes would mean two identical
    datasets published two different manifests.

    ``classes`` is **not** sorted, unlike the two collections around it. A
    schema's class order is authored — it drives how a labeling surface lists
    them — so it is part of the frozen contract rather than incidental, and it
    round-trips stably through storage anyway.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    manifest_version: int = Field(default=MANIFEST_VERSION, ge=1)
    schema_version: int = Field(ge=1)
    classes: tuple[LabelClass, ...] = ()
    assets: tuple[ManifestAsset, ...] = ()

    @field_validator("assets")
    @classmethod
    def _in_canonical_order(cls, value: tuple[ManifestAsset, ...]) -> tuple[ManifestAsset, ...]:
        """By content, then by id — never by the order they were promoted in."""
        return tuple(sorted(value, key=lambda asset: (asset.content_hash, str(asset.asset_id))))

    @model_validator(mode="after")
    def _version_can_express_the_content(self) -> Manifest:
        if self.manifest_version < CALIBRATED_MANIFEST_VERSION and any(
            asset.calibration is not None for asset in self.assets
        ):
            raise ValueError(
                f"a version-{self.manifest_version} manifest cannot carry a calibration; "
                f"calibrated assets need version {CALIBRATED_MANIFEST_VERSION}"
            )
        if self.manifest_version < MODALITY_MANIFEST_VERSION and any(
            asset.modality != "image" for asset in self.assets
        ):
            raise ValueError(
                f"a version-{self.manifest_version} manifest holds images only; "
                f"a point-cloud asset needs version {MODALITY_MANIFEST_VERSION}"
            )
        if self.manifest_version < GROUPED_MANIFEST_VERSION and any(
            asset.group_label is not None for asset in self.assets
        ):
            raise ValueError(
                f"a version-{self.manifest_version} manifest carries no group labels; "
                f"a labelled asset needs version {GROUPED_MANIFEST_VERSION}"
            )
        return self

    @property
    def annotation_count(self) -> int:
        """How many labels this manifest carries, across every asset."""
        return sum(len(asset.annotations) for asset in self.assets)


def manifest_version_for(assets: Sequence[ManifestAsset]) -> int:
    """The lowest manifest version that can express these assets.

    Publishing writes this rather than :data:`MANIFEST_VERSION`, so content a
    version-3 build can read is still written as version 3 and keeps its hash.
    """
    if any(asset.group_label is not None for asset in assets):
        return GROUPED_MANIFEST_VERSION
    if any(asset.modality != "image" for asset in assets):
        return MODALITY_MANIFEST_VERSION
    if any(asset.calibration is not None for asset in assets):
        return CALIBRATED_MANIFEST_VERSION
    return 3


def canonical_bytes(model: BaseModel) -> bytes:
    """The one serialization of a hashed document, and the bytes its hash is over.

    Written for the :class:`Manifest` and shared by everything else whose hash
    is a contract — the pre-processing recipe hash is computed over exactly
    this encoding, because two spellings of "canonical" would eventually
    disagree.

    ``sort_keys`` recurses, so ``attributes`` — the only dict in the document —
    is ordered by this too rather than by whatever order it was written in.
    ``separators`` removes the whitespace ``json`` would otherwise vary.
    ``ensure_ascii=False`` keeps a non-ASCII class name as itself instead of as
    an escape sequence, which the UTF-8 encoding then makes deterministic.

    No ``exclude_*`` argument is passed, and that is a decision rather than an
    omission: ``exclude_unset`` and ``exclude_defaults`` depend on how a model was
    *constructed*, so a manifest built in memory and the same manifest rehydrated
    from these very bytes would not serialize alike — and the difference would be
    invisible in the models themselves.

    Raises:
        UnserializableManifest: a number in the document is NaN or infinite.
    """
    document = model.model_dump(mode="json")
    try:
        text = json.dumps(
            document,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except ValueError as exc:
        raise UnserializableManifest(
            "this release carries a number JSON cannot express (NaN or infinity). The only "
            "source is an annotation's geometry, whose coordinates are plain floats; fix the "
            f"annotation and publish again ({exc})"
        ) from exc
    return text.encode("utf-8")


def sha256_hex(data: bytes) -> str:
    """The digest of some bytes, spelled once.

    ``publish`` takes its hash from ``BlobStore.put`` and ``verify`` computes it
    from what it read back. Both have to mean the same thing, so neither of them
    writes ``hashlib`` itself.
    """
    return hashlib.sha256(data).hexdigest()


def sha256_hex_of_stream(stream: BinaryIO) -> str:
    """:func:`sha256_hex` over a stream, read in chunks rather than whole."""
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1 << 20), b""):
        digest.update(chunk)
    return digest.hexdigest()


class SplitGrouping(StrEnum):
    """What a split recipe may keep together in one fold.

    ``group_label`` is the label an importer wrote on each asset — a nuScenes
    scene's name — so every keyframe of one scene lands in one fold.
    """

    GROUP_LABEL = "group_label"


class SplitRecipe(BaseModel):
    """How to cut a release into train / validation / test, declaratively.

    Fractions, not counts: a recipe outlives the exact size of the thing it
    describes. They must add up to one — checked with a tolerance, because
    ``0.7 + 0.15 + 0.15`` is ``0.9999999999999999`` in binary floating point and
    an equality test would reject the most ordinary recipe there is.

    An all-train recipe (``1.0 / 0.0 / 0.0``) is legal and means what it says.

    ``group_by`` is opt-in and **omitted** from the serialized recipe when it is
    ``None``, so every recipe stored before it existed reads back, and
    serializes, exactly as it did. See :func:`assign_split` for what it changes.

    Like every per-value rule in the domain, an invalid recipe cannot be
    constructed at all: the refusal is pydantic's, not a service's.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    train: float = Field(ge=0.0, le=1.0)
    val: float = Field(ge=0.0, le=1.0)
    test: float = Field(ge=0.0, le=1.0)
    #: Fixed by default rather than random: a recipe nobody seeded should still
    #: reproduce, and a caller who wants a different cut says which one.
    seed: int = 0
    group_by: SplitGrouping | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def _fractions_add_up(self) -> SplitRecipe:
        total = self.train + self.val + self.test
        if not math.isclose(total, 1.0, abs_tol=1e-9):
            raise ValueError(
                "a split recipe's fractions must add up to 1.0, but "
                f"{self.train} + {self.val} + {self.test} is {total}"
            )
        return self


class SplitAssignment(BaseModel):
    """The folds one recipe produces over one exact set of assets."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    train: tuple[UUID, ...] = ()
    val: tuple[UUID, ...] = ()
    test: tuple[UUID, ...] = ()


def assign_split(recipe: SplitRecipe, assets: Sequence[ManifestAsset]) -> SplitAssignment:
    """Cut a manifest's assets into folds, the same way every time.

    Deterministic without a random number generator: each asset is keyed by
    ``sha256(seed:content_hash)`` and the assets are ordered by that key, so the
    result depends on the seed and on the set — never on the order they were
    passed in, on how many there are, or on the Python implementation. Seeding
    ``random`` and shuffling would give the first of those and none of the rest.

    The key is the **content hash**, not the asset id, and that is a training
    decision rather than a stylistic one. Two assets holding identical bytes are
    the classic train/test contamination, and nothing stops a project ingesting
    the same image twice; keying on content puts the duplicates next to each
    other, so at most one such pair can straddle a fold boundary. It also means a
    re-ingest into a fresh project reproduces the split, every id being new. The
    asset id breaks ties, so the ordering is total.

    Counts come from largest-remainder apportionment, which is the honest answer
    for a small dataset: three fractions of five assets do not land on integers,
    so each fold takes its floor and the leftovers go to whoever came closest,
    train first. One asset under a 0.8/0.1/0.1 recipe is one training asset, not
    a rounding error that loses it — and the last fold takes the tail of the
    ordering outright, so no asset can go missing to an argument about arithmetic.

    **With ``group_by``, the unit is a group, not an asset.** Every asset
    carrying one ``group_label`` is a single unit keyed by
    ``sha256(seed:group:label)``, and an asset with no label stays a unit of its
    own, keyed exactly as above. The units are ordered and apportioned as assets
    are without grouping, so the fractions apply to *groups*: a group never
    straddles a fold, and fold sizes in assets are only as close to the
    fractions as the groups are equal in size. A single group lands whole in one
    fold, the one with the largest fraction. Every other guarantee holds
    unchanged — no asset goes missing, and the result depends only on the seed
    and the set. Over assets that carry no label, a grouped recipe cuts exactly
    the folds an ungrouped one does.
    """
    grouped = recipe.group_by is not None
    groups: dict[str, list[ManifestAsset]] = {}
    units: list[tuple[tuple[str, int, str], tuple[ManifestAsset, ...]]] = []
    for asset in assets:
        if grouped and asset.group_label is not None:
            groups.setdefault(asset.group_label, []).append(asset)
        else:
            units.append((_asset_key(recipe.seed, asset), (asset,)))
    for label, members in groups.items():
        key = (sha256_hex(f"{recipe.seed}:group:{label}".encode()), 0, label)
        units.append((key, tuple(sorted(members, key=lambda one: _asset_key(recipe.seed, one)))))
    ordered = [members for _, members in sorted(units, key=lambda unit: unit[0])]
    train, val = _apportion(len(ordered), (recipe.train, recipe.val, recipe.test))

    def fold(chosen: Sequence[tuple[ManifestAsset, ...]]) -> tuple[UUID, ...]:
        return tuple(asset.asset_id for members in chosen for asset in members)

    return SplitAssignment(
        train=fold(ordered[:train]),
        val=fold(ordered[train : train + val]),
        test=fold(ordered[train + val :]),
    )


def _asset_key(seed: int, asset: ManifestAsset) -> tuple[str, int, str]:
    """An asset's place in the ordering: its content first, its id to break a tie.

    The ``1`` sorts an asset after a group whose key it could only equal by a
    SHA-256 collision, so the ordering stays total.
    """
    return sha256_hex(f"{seed}:{asset.content_hash}".encode()), 1, str(asset.asset_id)


def _apportion(total: int, fractions: tuple[float, float, float]) -> tuple[int, int]:
    """How many assets the first two folds take; the third gets what is left.

    Largest remainder: floor every share, then hand the shortfall out one at a
    time to the folds with the largest fractional parts, ties going to the
    earlier fold. Returning two numbers rather than three is the invariant, not a
    shortcut — a caller slicing ``[:a]``, ``[a:a + b]`` and ``[a + b:]`` cannot
    drop an asset whatever arithmetic produced ``a`` and ``b``.
    """
    exact = [total * fraction for fraction in fractions]
    counts = [math.floor(value) for value in exact]
    shortfall = max(0, total - sum(counts))
    closest = sorted(range(len(counts)), key=lambda fold: (counts[fold] - exact[fold], fold))
    for fold in closest[:shortfall]:
        counts[fold] += 1
    return counts[0], counts[1]


class Release(BaseModel):
    """An immutable, exportable snapshot of a Dataset.

    Frozen, so the refusal to mutate one belongs to the type rather than to a
    service: there is no ``ReleaseService.update`` needing a guard, and assigning
    to a field raises. The only thing that removes a release is deleting its
    project, whose cascade takes it — and even then the manifest blob survives,
    because blobs are never deleted.

    ``manifest_hash`` names the document in the blob store. ``schema_version``,
    ``asset_count`` and ``annotation_count`` are a **read cache** of facts that
    also live inside that document, kept out here so listing a dataset's releases
    does not have to open a blob per row. A cache can drift, so
    ``ReleaseService.verify`` cross-checks all three against the parsed manifest
    instead of trusting them.

    ``created_at`` and ``visionset_version`` are the generation metadata, and they
    live out here precisely because they must not be in the document — see the
    module docstring.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    dataset_id: UUID
    tag: str
    manifest_hash: str
    schema_version: int = Field(ge=1)
    asset_count: int = Field(ge=0)
    annotation_count: int = Field(ge=0)
    split: SplitRecipe | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    #: Which build published this. Stamped by ``ReleaseService`` from
    #: ``visionset.__version__``; the domain has no business knowing about
    #: packaging, so it holds the string and asks nothing about it.
    visionset_version: str = ""

    @field_validator("created_at")
    @classmethod
    def _created_at_is_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("created_at must be timezone-aware (UTC)")
        return value.astimezone(UTC)


class ReleaseVerification(BaseModel):
    """What ``ReleaseService.verify`` found, blob by blob.

    A report rather than a boolean, and rather than an exception: the question
    "is this release still intact?" has more than two useful answers, and someone
    looking at a damaged workspace needs the list, not the verdict.

    ``missing`` and ``corrupt`` are different faults with different remedies — a
    blob that is gone was never written or was deleted out from under us, while a
    blob whose bytes no longer hash to its own name was altered in place — so
    they are never merged into one list.

    ``manifest_intact`` is settled first, and when it is false ``checked`` is zero
    and every list is empty: a document that has been altered is not an inventory
    worth walking.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    release_id: UUID
    manifest_hash: str
    manifest_intact: bool
    checked: int = Field(default=0, ge=0)
    missing: tuple[str, ...] = ()
    corrupt: tuple[str, ...] = ()
    #: Where the release row disagrees with the document it names, if anywhere.
    #: Empty is the ordinary answer, and anything in here is a bug in this build
    #: rather than damage to the workspace — which is why it reads as a sentence.
    cache_mismatches: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        """Whether everything this release names is present and unaltered."""
        return (
            self.manifest_intact
            and not self.missing
            and not self.corrupt
            and not self.cache_mismatches
        )


# Three values because a boolean is two answers wearing one word.
# ``supported=false`` read as "absent from the output" where ``_compatibility``
# computed it and as "convert it to something I can write" where the YOLO and VOC
# exporters consumed it, so a user consenting to lose three annotations received
# two of them back as boxes under the polygon's own class name — output that was
# well-formed and not what the report had promised.
#
# A ``StrEnum`` for the reason ``SourceKind`` is one and ``DatasetChange``'s
# operation is not: the kernel branches on this value, no foreign writer produces
# one, and the set grows deliberately. The docstring is short because this enum
# reaches ``openapi.json`` verbatim and a bug narrative is not API documentation.
class ClassExportStatus(StrEnum):
    """What one format does with one class: writes it, reduces it, or drops it."""

    #: Written as it stands. The format declares this geometry in
    #: ``supported_geometries``.
    SUPPORTED = "supported"
    #: Written, but not as it stands — the format declares this geometry in
    #: ``degraded_geometries``, so an annotation of this class reaches the output
    #: having lost something the kernel could represent. A polygon written as its
    #: axis-aligned bounding box is the case this exists for.
    DEGRADED = "degraded"
    #: Not written at all. The format declares this geometry in neither set, so
    #: an annotation of this class is absent from the output.
    DROPPED = "dropped"


class ClassCompatibility(BaseModel):
    """One class and one of its geometries, judged against one format.

    A class accepts a *set* of geometries, and a format's answer can differ
    across that set — a class holding boxes and polygons is, to a boxes-only
    format, one half written whole and one half reduced. So the row is per
    ``(label_class, geometry)`` and a class contributes as many rows as it has
    geometries. One row per class could only report one of the two answers, and
    would describe the output wrongly whichever it picked.

    A cropping resize in the export's recipe is the one exception to one row
    per ``(label_class, geometry)``: the labels it cut away or cut down are
    counted in rows of their own, ``dropped`` and ``degraded``, with
    ``cropped_by`` naming the strategy, and the class's other row counts only
    what the crop left alone. Every row's count is then the labels that meet
    its status, so totals summed by status agree with the report's.

    Per class rather than per annotation, and the counts are what make it useful:
    "polygon is unsupported" is a fact about the schema, while "polygon is
    unsupported, 1,204 annotations across 310 assets" is the number somebody
    decides on. It is the same argument ``ClassCountOut`` makes for
    ``DatasetStats`` — a thousand labels over a thousand images and the same
    thousand over ten are the same total and a very different loss.

    ``reason`` is filled for anything other than :attr:`ClassExportStatus.SUPPORTED`,
    and it states what actually happens: a dropped class says it is not written,
    a degraded one says it *is* written and what it loses. A supported class has
    nothing to explain, and an empty string there would read as a reason nobody
    wrote down.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    label_class: str
    geometry: GeometryType
    #: The two questions a single ``supported: bool`` was being asked — "is this
    #: written?" and "is this written intact?" — are :attr:`carried` and
    #: :attr:`supported` below, and they are properties rather than stored fields
    #: so no report can carry a pair that disagree.
    status: ClassExportStatus
    #: Annotations of this class in the release. Zero is normal and is *not* a
    #: problem: a class the schema declares and nobody used excludes nothing, so
    #: it never makes a report incompatible however unsupported its geometry is.
    annotations: int = Field(ge=0)
    assets: int = Field(ge=0)
    reason: str | None = None
    cropped_by: ResizeStrategy | None = None

    @property
    def supported(self) -> bool:
        """Written with nothing lost. The narrow half of the old boolean."""
        return self.status is ClassExportStatus.SUPPORTED

    @property
    def carried(self) -> bool:
        """Present in the output at all, intact or reduced.

        The half a user weighing "what disappears?" is actually asking about,
        and the one the old boolean answered wrongly for a polygon in YOLO.
        """
        return self.status is not ClassExportStatus.DROPPED


class ModalityCompatibility(BaseModel):
    """The assets of one modality a format cannot write, and the labels they take with them.

    A row exists only for a modality the release holds and the format does not
    declare in ``supported_modalities``: those assets are absent from the output
    whole, so they are counted by asset, not by class.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    modality: Modality
    assets: int = Field(ge=1)
    annotations: int = Field(ge=0)
    reason: str


class ExportCompatibility(BaseModel):
    """What one format would lose from one release, worked out before writing.

    Deliberately **computed from the frozen manifest** rather than from live
    membership: an export describes a release, and a release is a snapshot. Two
    runs against one release therefore agree forever, which is what lets the same
    document be shown in a consent dialog, attached to a refusal and written into
    the output.

    ``compatible`` is the whole answer, and it is *not* the same question as
    ``Exporter.lossy``. That flag is the format's blanket statement about
    everything a capability list cannot see — attributes, confidence, provenance
    — and it is true or false for the format forever. This is about **this
    release**: a bbox-only format meeting a bbox-only release excludes nothing,
    and the report says so with numbers.

    Both are consulted, and consent is required if *either* says so: a lossy
    format always asks, and a format that declares itself lossless still cannot
    silently drop a geometry it never claimed to write.

    ``classes`` sorts by name. Canonical ordering belongs to the artifact rather
    than to whoever built it, which is the rule ``Manifest`` already follows and
    the reason this document is stable enough to hash, diff or attach.
    """

    # ``populate_by_name`` is what makes the alias below safe to round-trip: the
    # document written into an export directory has to parse back into this
    # model, and an alias with no way in would make the file write-only.
    model_config = ConfigDict(frozen=True, extra="forbid")

    release_id: UUID
    #: Serialized as ``format``, and the **only** aliased field in the domain.
    #: It is here because this one document is written to disk by the kernel and
    #: published by three surfaces, so their spellings have to agree exactly.
    #: ``visionset.wire`` and ``server/models.py`` say ``format`` for the same
    #: reason ``export_result`` does; the kernel says ``format_name`` because
    #: ``Exporter.format_name`` does. The alias is what lets both be true, and
    #: ``test_the_report_on_disk_is_the_document_the_surfaces_publish`` is what
    #: keeps it true. Both halves are spelled out — ``serialization_alias`` for
    #: the way out, ``validation_alias=AliasChoices(...)`` for the way back in —
    #: rather than one ``alias`` with ``populate_by_name``, because the pydantic
    #: mypy plugin builds ``__init__`` from ``alias`` alone and every keyword
    #: construction in the kernel would stop type-checking.
    format_name: str = Field(
        serialization_alias="format",
        validation_alias=AliasChoices("format", "format_name"),
    )
    #: The target the release was judged for, or ``None`` when it was judged
    #: against the format alone. A target can only take away, so a report
    #: carrying one may say dropped where the format's own report says carried;
    #: the name is what lets a reader of the file tell which question it answers.
    target: str | None = None
    #: Nothing in this release would be dropped **or reduced** by this format's
    #: capabilities. Still one word for the whole verdict, and still the gate on
    #: consent: a degraded annotation loses information, so it asks.
    compatible: bool
    #: The format's own blanket declaration, carried so a reader of the report
    #: alone can tell "this release is clean" from "this format loses nothing".
    format_is_lossy: bool
    #: Annotations that will be **absent** from the output.
    #:
    #: Dropped only. Counting degraded annotations here too would make it the
    #: number a user weighs while describing something else — three reported as
    #: excluded, two of them written as boxes. The number that disappears is the
    #: number worth having under this name.
    excluded_annotations: int = Field(default=0, ge=0)
    excluded_assets: int = Field(default=0, ge=0)
    #: Annotations that will be **present but reduced** — a polygon arriving as
    #: its bounding box. Beside the excluded counts rather than folded into them,
    #: because "gone" and "coarser" are different things to consent to.
    degraded_annotations: int = Field(default=0, ge=0)
    degraded_assets: int = Field(default=0, ge=0)
    classes: tuple[ClassCompatibility, ...] = ()
    #: Assets the format cannot open at all, one row per modality. Their labels
    #: are counted here and in ``excluded_annotations``, and not in ``classes``,
    #: which judge only what reaches the format.
    dropped_modalities: tuple[ModalityCompatibility, ...] = ()

    @field_validator("classes")
    @classmethod
    def _by_name(cls, value: tuple[ClassCompatibility, ...]) -> tuple[ClassCompatibility, ...]:
        return tuple(sorted(value, key=lambda one: one.label_class))

    @property
    def excluded(self) -> tuple[ClassCompatibility, ...]:
        """The classes that will not be in the output. Empty when nothing is dropped."""
        return tuple(
            one
            for one in self.classes
            if one.status is ClassExportStatus.DROPPED and one.annotations > 0
        )

    @property
    def degraded(self) -> tuple[ClassCompatibility, ...]:
        """The classes that will be in the output, reduced.

        Separate from :attr:`excluded` rather than a flag on it, so a surface
        listing "what you lose" cannot print a class under a heading that says it
        is not there. Both are empty when :attr:`compatible`.
        """
        return tuple(
            one
            for one in self.classes
            if one.status is ClassExportStatus.DEGRADED and one.annotations > 0
        )
