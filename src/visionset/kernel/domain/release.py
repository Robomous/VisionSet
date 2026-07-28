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
three fractions and a number, and :func:`assign_split` turns it into folds on
demand. Keeping the recipe rather than the assignment is what lets a release
stay small and an export stay reproducible from it.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from visionset.kernel.domain.annotation import Provenance
from visionset.kernel.domain.geometry import Geometry
from visionset.kernel.domain.schema import AttributeValue, LabelClass
from visionset.kernel.errors import UnserializableManifest

#: The format of the manifest document itself — independent of ``FORMAT_VERSION``
#: (the workspace database) and of the package version (which build made it).
#:
#: A manifest is read with ``extra='forbid'``, so a document written by a later
#: VisionSet fails to load. That is deliberate, and the opposite of the call
#: ``DatasetChange.operation`` makes, where forward-compatibility wins because a
#: log is advisory. Here the document is hash-pinned evidence, and
#: half-understanding one is worse than refusing it. This field is what lets the
#: refusal say "format 2, and this build reads 1" rather than complain about an
#: unrecognised key.
MANIFEST_VERSION: int = 1


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
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset_id: UUID
    content_hash: str
    uri: str
    width: int | None = None
    height: int | None = None
    annotations: tuple[ManifestAnnotation, ...] = ()

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
    batch pinned. Those can differ, because two batches can be approved against
    two versions and both promoted into one trunk. The mixture is safe rather
    than sloppy: ``SchemaChangeWouldOrphan`` refuses to remove a class that
    annotations still depend on, so every label in here is still described by the
    classes in here.

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

    @property
    def annotation_count(self) -> int:
        """How many labels this manifest carries, across every asset."""
        return sum(len(asset.annotations) for asset in self.assets)


def canonical_bytes(manifest: Manifest) -> bytes:
    """The one serialization of a manifest, and the bytes its hash is over.

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
    document = manifest.model_dump(mode="json")
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


class SplitRecipe(BaseModel):
    """How to cut a release into train / validation / test, declaratively.

    Fractions, not counts: a recipe outlives the exact size of the thing it
    describes. They must add up to one — checked with a tolerance, because
    ``0.7 + 0.15 + 0.15`` is ``0.9999999999999999`` in binary floating point and
    an equality test would reject the most ordinary recipe there is.

    An all-train recipe (``1.0 / 0.0 / 0.0``) is legal and means what it says.

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
    """
    ordered = sorted(
        assets, key=lambda asset: (_split_key(recipe.seed, asset), str(asset.asset_id))
    )
    train, val = _apportion(len(ordered), (recipe.train, recipe.val, recipe.test))
    return SplitAssignment(
        train=tuple(asset.asset_id for asset in ordered[:train]),
        val=tuple(asset.asset_id for asset in ordered[train : train + val]),
        test=tuple(asset.asset_id for asset in ordered[train + val :]),
    )


def _split_key(seed: int, asset: ManifestAsset) -> str:
    return sha256_hex(f"{seed}:{asset.content_hash}".encode())


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


class ExportResult(BaseModel):
    """What one run of an exporter left on disk.

    Small on purpose. The exporter writes a directory and returns nothing, so
    without this a caller has no answer at all — and a caller that reaches an
    export through something other than HTTP (the CLI, an MCP tool) needs one,
    because it never sees the bytes. The REST route hands back the files
    themselves and uses these numbers only to describe what it is sending.

    ``file_count`` and ``total_bytes`` are counted by walking ``directory``
    after the plugin returns rather than reported by the plugin itself: an
    exporter that miscounts its own output would then be trusted about it, and
    the whole point of the number is to be checkable. It also means a plugin
    that writes nothing — ``DummyExporter`` does exactly that — reports zero
    rather than lying.

    Not frozen for the usual immutability argument but for the same one every
    report here uses: this describes a moment that has already passed.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    release_id: UUID
    format_name: str
    #: Where the files were written. Absolute, and the caller's own choice —
    #: the kernel never picks a location.
    directory: Path
    file_count: int = Field(default=0, ge=0)
    total_bytes: int = Field(default=0, ge=0)
