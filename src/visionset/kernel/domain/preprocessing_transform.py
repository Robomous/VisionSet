# usage: from visionset.kernel.domain import transform_manifest, plugin_manifest
"""What a recipe does to a manifest's geometry, worked out without a pixel.

The kernel owns every coordinate an export writes: the pixel driver moves
bytes, this module moves annotations, and the two agree because both read the
same arithmetic — :func:`letterbox_fit` is the single spelling of where
letterboxed content lands, and the per-variant draws come from
:mod:`visionset.kernel.domain.preprocessing`. :func:`transform_manifest`
produces a :class:`TransformedView`: one entry per file the export will write,
with the transformed size, the transformed labels, and where the bytes come
from. It is a view over the manifest, never a manifest — the manifest's shape
is a hash-pinned contract and this document is derived and transient.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.domain.annotation import Provenance
from visionset.kernel.domain.export_target import ResizeStrategy
from visionset.kernel.domain.geometry import (
    BboxGeometry,
    ClassificationGeometry,
    Geometry,
    PolygonGeometry,
    PolylineGeometry,
)
from visionset.kernel.domain.preprocessing import (
    AugmentOp,
    AugmentStep,
    RecipeSpec,
    ResizeStep,
    hflip_applied,
    recipe_hash,
    rot90_quarter_turns,
    variant_seed,
)
from visionset.kernel.domain.release import (
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    SplitAssignment,
)
from visionset.kernel.domain.schema import AttributeValue
from visionset.kernel.errors import (
    AugmentationRequiresSplit,
    ExportSourceUnreadable,
    PreprocessingStepUnsupportedGeometry,
)

Fold = Literal["train", "val", "test"]

#: What separates a source content hash from a variant index in the key an
#: augmented file is read and named under: ``<hash>-aug<k>``. A content hash
#: is hexadecimal, so the marker cannot occur inside one.
VARIANT_MARKER: Final = "-aug"

#: The namespace a variant's annotation id is derived in. A manifest annotation
#: id is a UUID, and ``"{id}-aug{k}"`` is not one, so the manifest handed to a
#: plugin carries ``uuid5(namespace, "{id}-aug{k}")`` — derived, not drawn, so
#: two exports of one release agree on every id.
VARIANT_ID_NAMESPACE: Final = uuid5(NAMESPACE_URL, "visionset:preprocessing:variant")


class LetterboxFit(BaseModel):
    """Where letterboxed content lands on the padded canvas.

    The reference arithmetic for both sides of the export seam: the geometry
    transform reads it to place annotations and the pixel driver reads the
    same values to place pixels, so neither can be half a pixel off the other.
    ``scale`` is ``min(W'/W, H'/H)``; the content is ``round(W·scale)`` by
    ``round(H·scale)``; each offset is the integer-floored half of the margin.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    scale: float = Field(gt=0.0)
    content_width: int = Field(ge=0)
    content_height: int = Field(ge=0)
    offset_x: int = Field(ge=0)
    offset_y: int = Field(ge=0)


def letterbox_fit(
    width: int, height: int, *, target_width: int, target_height: int
) -> LetterboxFit:
    """Fit ``width × height`` content onto a ``target`` canvas, aspect kept."""
    scale = min(target_width / width, target_height / height)
    content_width = round(width * scale)
    content_height = round(height * scale)
    return LetterboxFit(
        scale=scale,
        content_width=content_width,
        content_height=content_height,
        offset_x=(target_width - content_width) // 2,
        offset_y=(target_height - content_height) // 2,
    )


class TransformedAnnotation(BaseModel):
    """One label as an export writes it, placed on the transformed image.

    A ``ManifestAnnotation`` with its geometry moved and its identity widened:
    variant 0 keeps the annotation's own id, and variant ``k`` carries
    ``"{id}-aug{k}"``, so every label in the output traces to the manifest
    annotation it came from. Class, attributes, provenance, model reference
    and confidence are copied as they stood.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    label_class: str
    schema_version: int = Field(ge=1)
    geometry: Geometry
    attributes: dict[str, AttributeValue] = Field(default_factory=dict)
    provenance: Provenance
    model_ref: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class TransformedFile(BaseModel):
    """One image an export will write, and everything to write on and about it.

    ``content_hash`` stays the *source* image's: the transformed bytes do not
    exist yet, and this row is the instruction the pixel driver produces them
    from. ``variant`` 0 is the base image; augmented variants count from 1.
    ``width`` and ``height`` are the transformed size — ``None`` only where
    the manifest never recorded a size and no resize step decides one.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset_id: UUID
    content_hash: str
    variant: int = Field(ge=0)
    fold: Fold | None
    width: int | None
    height: int | None
    annotations: tuple[TransformedAnnotation, ...] = ()


class TransformedView(BaseModel):
    """What one recipe does to one manifest, per file the export will write.

    Files keep the manifest's canonical asset order, each asset's base image
    first and its variants after it in ascending ``variant`` — so the view is
    as deterministic as the manifest it was derived from.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    files: tuple[TransformedFile, ...] = ()

    @property
    def source_file_count(self) -> int:
        """How many base images the export writes — one per manifest asset."""
        return sum(1 for file in self.files if file.variant == 0)

    @property
    def augmented_file_count(self) -> int:
        """How many augmented variants the export writes, across all assets."""
        return sum(1 for file in self.files if file.variant > 0)


def transform_manifest(
    manifest: Manifest, spec: RecipeSpec, folds: SplitAssignment | None
) -> TransformedView:
    """Every file one recipe makes of one manifest, geometry included.

    Augmented variants are generated for ``train``-fold assets only — a model
    must never validate on a variant of an image it trained on — so a spec
    that augments requires ``folds``. Base images are emitted for every asset
    whatever its fold, resized when the spec says so.

    Raises:
        AugmentationRequiresSplit: the spec asks for variants and ``folds`` is
            ``None`` — the release was published without a split recipe.
        PreprocessingStepUnsupportedGeometry: a step met a geometry it cannot
            transform; today that is ``rot90`` over a polyline, whose point
            order carries meaning relative to the frame's axes.
        ExportSourceUnreadable: a step needs the source image's dimensions and
            the manifest never recorded them.
    """
    if spec.variants_per_asset >= 1 and folds is None:
        raise AugmentationRequiresSplit(
            f"the recipe asks for {spec.variants_per_asset} augmented variant(s) per asset "
            "and this release has no split recipe, so there is no train fold to augment; "
            "publish a release with a split recipe, or export with a recipe that does not "
            "augment"
        )
    fold_of = _fold_of(folds)
    spec_hash = recipe_hash(spec)
    resize = next((step for step in spec.steps if isinstance(step, ResizeStep)), None)
    augments = tuple(step for step in spec.steps if isinstance(step, AugmentStep))
    files: list[TransformedFile] = []
    for asset in manifest.assets:
        fold = fold_of.get(asset.asset_id)
        files.append(_base_file(asset, resize, fold))
        if fold != "train":
            continue
        for k in range(1, spec.variants_per_asset + 1):
            seed = variant_seed(spec_hash, asset.content_hash, k)
            files.append(_variant_file(asset, resize, augments, variant=k, seed=seed))
    return TransformedView(files=tuple(files))


def _fold_of(folds: SplitAssignment | None) -> dict[UUID, Fold]:
    if folds is None:
        return {}
    by_asset: dict[UUID, Fold] = {}
    for asset_id in folds.train:
        by_asset[asset_id] = "train"
    for asset_id in folds.val:
        by_asset[asset_id] = "val"
    for asset_id in folds.test:
        by_asset[asset_id] = "test"
    return by_asset


def _base_file(
    asset: ManifestAsset, resize: ResizeStep | None, fold: Fold | None
) -> TransformedFile:
    geometries = [annotation.geometry for annotation in asset.annotations]
    width, height = asset.width, asset.height
    if resize is not None:
        geometries, width, height = _resized(asset, resize, geometries)
    return TransformedFile(
        asset_id=asset.asset_id,
        content_hash=asset.content_hash,
        variant=0,
        fold=fold,
        width=width,
        height=height,
        annotations=tuple(
            _copied(annotation, geometry, str(annotation.id))
            for annotation, geometry in zip(asset.annotations, geometries, strict=True)
        ),
    )


def _variant_file(
    asset: ManifestAsset,
    resize: ResizeStep | None,
    augments: tuple[AugmentStep, ...],
    *,
    variant: int,
    seed: bytes,
) -> TransformedFile:
    geometries = [annotation.geometry for annotation in asset.annotations]
    width, height = asset.width, asset.height
    if resize is not None:
        geometries, width, height = _resized(asset, resize, geometries)
    for step in augments:
        if step.op is AugmentOp.HFLIP:
            if hflip_applied(seed) and _any_coordinates(geometries):
                mirror_width = float(_known_width(width, asset, step.op.value))
                geometries = [_mirrored(geometry, mirror_width) for geometry in geometries]
        elif step.op is AugmentOp.ROT90:
            _refuse_polylines(asset, geometries)
            for _ in range(rot90_quarter_turns(seed)):
                if _any_coordinates(geometries):
                    turn_width = float(_known_width(width, asset, step.op.value))
                    geometries = [_rotated_once(geometry, turn_width) for geometry in geometries]
                width, height = height, width
    return TransformedFile(
        asset_id=asset.asset_id,
        content_hash=asset.content_hash,
        variant=variant,
        fold="train",
        width=width,
        height=height,
        annotations=tuple(
            _copied(annotation, geometry, f"{annotation.id}-aug{variant}")
            for annotation, geometry in zip(asset.annotations, geometries, strict=True)
        ),
    )


def _resized(
    asset: ManifestAsset, step: ResizeStep, geometries: list[Geometry]
) -> tuple[list[Geometry], int, int]:
    if _any_coordinates(geometries):
        source_width, source_height = _dimensions(asset, step.kind)
        if step.strategy is ResizeStrategy.STRETCH:
            scale_x = step.width / source_width
            scale_y = step.height / source_height
            offset_x = offset_y = 0.0
        else:
            fit = letterbox_fit(
                source_width,
                source_height,
                target_width=step.width,
                target_height=step.height,
            )
            scale_x = scale_y = fit.scale
            offset_x, offset_y = float(fit.offset_x), float(fit.offset_y)
        geometries = [
            _scaled(geometry, scale_x, scale_y, offset_x, offset_y) for geometry in geometries
        ]
    return geometries, step.width, step.height


def _copied(
    annotation: ManifestAnnotation, geometry: Geometry, identifier: str
) -> TransformedAnnotation:
    return TransformedAnnotation(
        id=identifier,
        label_class=annotation.label_class,
        schema_version=annotation.schema_version,
        geometry=geometry,
        attributes=dict(annotation.attributes),
        provenance=annotation.provenance,
        model_ref=annotation.model_ref,
        confidence=annotation.confidence,
    )


def _refuse_polylines(asset: ManifestAsset, geometries: Sequence[Geometry]) -> None:
    if any(isinstance(geometry, PolylineGeometry) for geometry in geometries):
        raise PreprocessingStepUnsupportedGeometry(
            f"the 'rot90' step cannot transform a polyline (asset {asset.asset_id} carries "
            "one): the path's point order carries meaning relative to the frame's axes, and "
            "a quarter turn re-axes the frame under it. Remove the step, or export a release "
            "without polylines",
            step=AugmentOp.ROT90.value,
            geometry="polyline",
            asset_id=str(asset.asset_id),
        )


def _dimensions(asset: ManifestAsset, step: str) -> tuple[int, int]:
    if asset.width is None or asset.height is None:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} (content {asset.content_hash}) records no pixel "
            f"dimensions, and the {step!r} step cannot place its annotations without them; "
            "re-ingest the asset and publish a new release"
        )
    return asset.width, asset.height


def _known_width(width: int | None, asset: ManifestAsset, step: str) -> int:
    if width is None:
        return _dimensions(asset, step)[0]
    return width


def _any_coordinates(geometries: Sequence[Geometry]) -> bool:
    return any(not isinstance(geometry, ClassificationGeometry) for geometry in geometries)


def _scaled(
    geometry: Geometry, scale_x: float, scale_y: float, offset_x: float, offset_y: float
) -> Geometry:
    if isinstance(geometry, ClassificationGeometry):
        return geometry
    if isinstance(geometry, BboxGeometry):
        return BboxGeometry(
            x=geometry.x * scale_x + offset_x,
            y=geometry.y * scale_y + offset_y,
            width=geometry.width * scale_x,
            height=geometry.height * scale_y,
        )
    points = [(x * scale_x + offset_x, y * scale_y + offset_y) for x, y in geometry.points]
    if isinstance(geometry, PolygonGeometry):
        return PolygonGeometry(points=points)
    return PolylineGeometry(points=points)


def _mirrored(geometry: Geometry, width: float) -> Geometry:
    if isinstance(geometry, ClassificationGeometry):
        return geometry
    if isinstance(geometry, BboxGeometry):
        return BboxGeometry(
            x=width - geometry.x - geometry.width,
            y=geometry.y,
            width=geometry.width,
            height=geometry.height,
        )
    points = [(width - x, y) for x, y in geometry.points]
    if isinstance(geometry, PolygonGeometry):
        return PolygonGeometry(points=points)
    return PolylineGeometry(points=points)


def _rotated_once(geometry: Geometry, width: float) -> Geometry:
    """One counter-clockwise quarter turn: ``(x, y)`` lands at ``(y, W - x)``.

    Counter-clockwise because that is what the pixel side's ``ROTATE_90``
    means, and the two must turn the same way. A box's corners rotate and the
    result is rebuilt axis-aligned, which is exact at a quarter turn.
    """
    if isinstance(geometry, ClassificationGeometry):
        return geometry
    if isinstance(geometry, BboxGeometry):
        return BboxGeometry(
            x=geometry.y,
            y=width - geometry.x - geometry.width,
            width=geometry.height,
            height=geometry.width,
        )
    points = [(y, width - x) for x, y in geometry.points]
    if isinstance(geometry, PolygonGeometry):
        return PolygonGeometry(points=points)
    return PolylineGeometry(points=points)


def variant_content_hash(content_hash: str, variant: int) -> str:
    """The key an exported file is read and named under.

    Variant 0 is the source hash itself, so a base image keeps its
    original-hash-derived name; variant ``k`` is ``"{hash}-aug{k}"``, which is
    both the name on disk and what the export's content reader resolves.
    """
    return content_hash if variant == 0 else f"{content_hash}{VARIANT_MARKER}{variant}"


def source_of_content_hash(key: str) -> tuple[str, int]:
    """The source hash and variant index a content key was built from."""
    head, marker, tail = key.rpartition(VARIANT_MARKER)
    if marker and tail.isdigit():
        return head, int(tail)
    return key, 0


def plugin_manifest(manifest: Manifest, view: TransformedView) -> Manifest:
    """The view as the manifest a plugin is handed: one asset per file to write.

    The port speaks manifests and content hashes and has no word for a variant,
    so each transformed file becomes a manifest asset. Its ``asset_id`` stays
    the source's — which is what keeps a variant in its source's fold when the
    plugin recomputes folds — and its ``content_hash`` is
    :func:`variant_content_hash`, distinct per variant so the plugin names and
    reads each file on its own. ``uri`` is copied from the source; ``width``
    and ``height`` are the transformed size. Classes stay the manifest's.
    """
    sources = {asset.asset_id: asset for asset in manifest.assets}
    return manifest.model_copy(
        update={
            "assets": tuple(
                ManifestAsset(
                    asset_id=file.asset_id,
                    content_hash=variant_content_hash(file.content_hash, file.variant),
                    uri=sources[file.asset_id].uri,
                    width=file.width,
                    height=file.height,
                    annotations=tuple(
                        _manifest_annotation(annotation, file.variant)
                        for annotation in file.annotations
                    ),
                )
                for file in view.files
            )
        }
    )


def _manifest_annotation(annotation: TransformedAnnotation, variant: int) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=UUID(annotation.id) if variant == 0 else uuid5(VARIANT_ID_NAMESPACE, annotation.id),
        label_class=annotation.label_class,
        schema_version=annotation.schema_version,
        geometry=annotation.geometry,
        attributes=dict(annotation.attributes),
        provenance=annotation.provenance,
        model_ref=annotation.model_ref,
        confidence=annotation.confidence,
    )


def fit_within(file: TransformedFile, max_edge: int) -> TransformedFile:
    """The file scaled so its longer edge is at most ``max_edge``, aspect kept.

    A preview's size cap, applied as the stretch arithmetic the export uses so
    the annotations land where a resize driver asked for the same size would
    put the pixels. A file already within the cap, or one with no recorded
    size, is returned as it is.
    """
    if file.width is None or file.height is None or max(file.width, file.height) <= max_edge:
        return file
    scale = max_edge / max(file.width, file.height)
    width, height = max(1, round(file.width * scale)), max(1, round(file.height * scale))
    return file.model_copy(
        update={
            "width": width,
            "height": height,
            "annotations": tuple(
                annotation.model_copy(
                    update={
                        "geometry": _scaled(
                            annotation.geometry, width / file.width, height / file.height, 0.0, 0.0
                        )
                    }
                )
                for annotation in file.annotations
            ),
        }
    )
