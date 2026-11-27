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
from math import pi
from typing import Final, Literal, NamedTuple, assert_never
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.domain.annotation import Provenance
from visionset.kernel.domain.calibration import geometry_needs_calibration
from visionset.kernel.domain.export_target import ResizeStrategy
from visionset.kernel.domain.geometry import (
    BboxGeometry,
    ClassificationGeometry,
    Cuboid3DGeometry,
    Geometry,
    MaskGeometry,
    ObbGeometry,
    PolygonGeometry,
    Polyline3DGeometry,
    PolylineGeometry,
)
from visionset.kernel.domain.preprocessing import (
    CROPPING_STRATEGIES,
    SHOWCASE_SEED,
    THREE_D,
    AugmentOp,
    AugmentStep,
    RecipeSpec,
    ResizeStep,
    recipe_hash,
    rot90_quarter_turns,
    variant_seed,
)
from visionset.kernel.domain.raster_mask import mask_mirrored, mask_resampled, mask_rotated_once
from visionset.kernel.domain.release import (
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    SplitAssignment,
    manifest_within,
)
from visionset.kernel.domain.schema import AttributeValue, GeometryType
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


#: The share of a label's area a crop must leave for the label to be kept.
#: Measured against the label as scaled onto the canvas, before the crop;
#: below it the label is dropped rather than written as a sliver.
CROP_KEEP_FRACTION: Final = 0.5

# Below this many square pixels a clipped polygon piece is a line or a point.
_DEGENERATE_AREA: Final = 1e-9

# A coordinate this close to a crop edge is on it, so float noise from the
# scale never marks an untouched label as clipped.
_EDGE_TOLERANCE: Final = 1e-9

Point = tuple[float, float]


class CanvasFit(BaseModel):
    """Where uniformly scaled content lands on a fixed-size canvas.

    The reference arithmetic for both sides of the export seam, for every
    strategy that keeps the aspect ratio: the geometry transform reads it to
    place annotations and the pixel driver reads the same values to place
    pixels, so neither can be half a pixel off the other. ``scale`` is
    ``min(W'/W, H'/H)`` for ``letterbox``, ``max(W'/W, H'/H)`` for ``fill`` and
    ``1`` for ``center_crop``; the content is ``round(W·scale)`` by
    ``round(H·scale)``; each offset is the integer-floored half of
    ``target − content``. An offset is negative where the content overflows
    the canvas, and what lies outside the canvas is cropped away.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    scale: float = Field(gt=0.0)
    content_width: int = Field(ge=0)
    content_height: int = Field(ge=0)
    offset_x: int
    offset_y: int


LetterboxFit = CanvasFit
"""The name :func:`letterbox_fit` answered with before ``fill`` and ``center_crop``."""


def canvas_fit(
    width: int,
    height: int,
    *,
    strategy: ResizeStrategy,
    target_width: int,
    target_height: int,
) -> CanvasFit:
    """Place ``width × height`` content on a ``target`` canvas by one strategy.

    Raises:
        ValueError: ``stretch``, which scales each axis on its own and so has
            no single fit.
    """
    match strategy:
        case ResizeStrategy.LETTERBOX:
            scale = min(target_width / width, target_height / height)
        case ResizeStrategy.FILL:
            scale = max(target_width / width, target_height / height)
        case ResizeStrategy.CENTER_CROP:
            scale = 1.0
        case ResizeStrategy.STRETCH:
            raise ValueError("stretch scales each axis on its own and has no canvas fit")
        case _:
            assert_never(strategy)
    content_width = round(width * scale)
    content_height = round(height * scale)
    return CanvasFit(
        scale=scale,
        content_width=content_width,
        content_height=content_height,
        offset_x=(target_width - content_width) // 2,
        offset_y=(target_height - content_height) // 2,
    )


def letterbox_fit(width: int, height: int, *, target_width: int, target_height: int) -> CanvasFit:
    """Fit ``width × height`` content onto a ``target`` canvas, aspect kept."""
    return canvas_fit(
        width,
        height,
        strategy=ResizeStrategy.LETTERBOX,
        target_width=target_width,
        target_height=target_height,
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

    ``dropped`` names the manifest annotations a cropping resize cut away —
    nothing, or less than :data:`CROP_KEEP_FRACTION` of the label, was left on
    the canvas — and ``clipped`` the ones it cut down and kept; a dropped
    label is absent from ``annotations``.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset_id: UUID
    content_hash: str
    variant: int = Field(ge=0)
    fold: Fold | None
    width: int | None
    height: int | None
    annotations: tuple[TransformedAnnotation, ...] = ()
    dropped: tuple[UUID, ...] = ()
    clipped: tuple[UUID, ...] = ()


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

    @property
    def dropped_count(self) -> int:
        """How many of the release's own labels a cropping resize cut away."""
        return sum(len(file.dropped) for file in self.files if file.variant == 0)

    @property
    def clipped_count(self) -> int:
        """How many of the release's own labels a cropping resize cut down and kept."""
        return sum(len(file.clipped) for file in self.files if file.variant == 0)


class PreprocessingPreview(BaseModel):
    """One asset through a recipe, rendered for a person to look at.

    ``image`` is the transformed bytes — the same bytes an export would write
    for that variant, capped to a preview size — and ``annotations`` are placed
    on them. ``media_type`` says what the bytes are encoded as.

    ``width``/``height`` are the rendered size; ``original_width``/
    ``original_height`` are the size the asset recorded, null when it recorded
    none. ``frame_index`` and ``source_name`` say where the sample came from —
    a frame of a clip, from a named source — and are null for a still or an
    asset that predates source tracking.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset_id: UUID
    variant: int = Field(ge=0)
    width: int | None
    height: int | None
    original_width: int | None = None
    original_height: int | None = None
    frame_index: int | None = Field(default=None, ge=0)
    source_name: str | None = None
    annotations: tuple[TransformedAnnotation, ...] = ()
    image: bytes
    media_type: str


def transform_manifest(
    manifest: Manifest,
    spec: RecipeSpec,
    folds: SplitAssignment | None,
    *,
    showcase: bool = False,
) -> TransformedView:
    """Every file one recipe makes of one manifest, geometry included.

    Augmented variants are generated for ``train``-fold assets only — a model
    must never validate on a variant of an image it trained on — so a spec
    that augments requires ``folds``. Base images are emitted for every asset
    whatever its fold, resized when the spec says so.

    ``showcase`` replaces every variant's seed with :data:`SHOWCASE_SEED`, so
    each augmentation lands at its declared strength rather than one draw of
    it — a preview's way of showing what a step does. An export never sets it.

    Raises:
        AugmentationRequiresSplit: the spec asks for variants and ``folds`` is
            ``None`` — the release was published without a split recipe.
        PreprocessingStepUnsupportedGeometry: a step met a geometry outside
            its ``supported_geometries`` — ``rot90`` over a polyline, whose
            point order carries meaning relative to the frame's axes, or any
            pixel-moving step over a 3D label.
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
            seed = SHOWCASE_SEED if showcase else variant_seed(spec_hash, asset.content_hash, k)
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


class _Placed(NamedTuple):
    labels: list[tuple[ManifestAnnotation, Geometry]]
    width: int | None
    height: int | None
    dropped: tuple[UUID, ...] = ()
    clipped: tuple[UUID, ...] = ()


def _placed(asset: ManifestAsset, resize: ResizeStep | None) -> _Placed:
    labels = [(annotation, annotation.geometry) for annotation in asset.annotations]
    if resize is None:
        return _Placed(labels, asset.width, asset.height)
    return _resized(asset, resize, labels)


def _base_file(
    asset: ManifestAsset, resize: ResizeStep | None, fold: Fold | None
) -> TransformedFile:
    placed = _placed(asset, resize)
    return TransformedFile(
        asset_id=asset.asset_id,
        content_hash=asset.content_hash,
        variant=0,
        fold=fold,
        width=placed.width,
        height=placed.height,
        annotations=tuple(
            _copied(annotation, geometry, str(annotation.id))
            for annotation, geometry in placed.labels
        ),
        dropped=placed.dropped,
        clipped=placed.clipped,
    )


def _variant_file(
    asset: ManifestAsset,
    resize: ResizeStep | None,
    augments: tuple[AugmentStep, ...],
    *,
    variant: int,
    seed: bytes,
) -> TransformedFile:
    placed = _placed(asset, resize)
    annotations = [annotation for annotation, _ in placed.labels]
    geometries = [geometry for _, geometry in placed.labels]
    width, height = placed.width, placed.height
    for step in augments:
        _refuse_unsupported(asset, step, geometries)
        if step.op is AugmentOp.HFLIP:
            if _any_coordinates(geometries):
                mirror_width = float(_known_width(width, asset, step.name))
                geometries = [_mirrored(geometry, mirror_width) for geometry in geometries]
        elif step.op is AugmentOp.ROT90:
            for _ in range(rot90_quarter_turns(seed)):
                if _any_coordinates(geometries):
                    turn_width = float(_known_width(width, asset, step.name))
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
            for annotation, geometry in zip(annotations, geometries, strict=True)
        ),
        dropped=placed.dropped,
        clipped=placed.clipped,
    )


def _resized(
    asset: ManifestAsset, step: ResizeStep, labels: list[tuple[ManifestAnnotation, Geometry]]
) -> _Placed:
    _refuse_unsupported(asset, step, [geometry for _, geometry in labels])
    if not _any_coordinates([geometry for _, geometry in labels]):
        return _Placed(labels, step.width, step.height)
    source_width, source_height = _dimensions(asset, step.kind)
    if step.strategy is ResizeStrategy.STRETCH:
        scale_x = step.width / source_width
        scale_y = step.height / source_height
        offset_x = offset_y = 0.0
    else:
        fit = canvas_fit(
            source_width,
            source_height,
            strategy=step.strategy,
            target_width=step.width,
            target_height=step.height,
        )
        scale_x = scale_y = fit.scale
        offset_x, offset_y = float(fit.offset_x), float(fit.offset_y)
    moved = [
        (annotation, _scaled(geometry, scale_x, scale_y, offset_x, offset_y))
        for annotation, geometry in labels
    ]
    if step.strategy not in CROPPING_STRATEGIES:
        return _Placed(moved, step.width, step.height)
    kept: list[tuple[ManifestAnnotation, Geometry]] = []
    dropped: list[UUID] = []
    clipped: list[UUID] = []
    for annotation, geometry in moved:
        cut, was_clipped = _cropped(geometry, float(step.width), float(step.height))
        if cut is None:
            dropped.append(annotation.id)
            continue
        if was_clipped:
            clipped.append(annotation.id)
        kept.append((annotation, cut))
    return _Placed(kept, step.width, step.height, tuple(dropped), tuple(clipped))


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


def _refuse_unsupported(
    asset: ManifestAsset, step: ResizeStep | AugmentStep, geometries: Sequence[Geometry]
) -> None:
    for geometry in geometries:
        if geometry.type not in step.supported_geometries:
            raise PreprocessingStepUnsupportedGeometry(
                f"the {step.name!r} step cannot transform a {geometry.type.value} (asset "
                f"{asset.asset_id} carries one). Remove the step, or export a release "
                f"without {geometry.type.value} labels",
                step=step.name,
                geometry=geometry.type.value,
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
    match geometry:
        case ClassificationGeometry():
            return geometry
        case BboxGeometry():
            return BboxGeometry(
                x=geometry.x * scale_x + offset_x,
                y=geometry.y * scale_y + offset_y,
                width=geometry.width * scale_x,
                height=geometry.height * scale_y,
            )
        case ObbGeometry():
            if scale_x != scale_y:
                raise AssertionError("no step scales a rotated box's axes apart")
            return ObbGeometry(
                cx=geometry.cx * scale_x + offset_x,
                cy=geometry.cy * scale_y + offset_y,
                width=geometry.width * scale_x,
                height=geometry.height * scale_x,
                angle=geometry.angle,
            )
        case PolygonGeometry():
            return PolygonGeometry(
                points=[
                    (x * scale_x + offset_x, y * scale_y + offset_y) for x, y in geometry.points
                ]
            )
        case PolylineGeometry():
            return geometry.through(
                [(x * scale_x + offset_x, y * scale_y + offset_y) for x, y in geometry.points]
            )
        case Polyline3DGeometry() | Cuboid3DGeometry():
            raise _unreachable_3d(geometry)
        case MaskGeometry():
            raise AssertionError("no resize step transforms a mask")
        case _:
            assert_never(geometry)


def _cropped(geometry: Geometry, width: float, height: float) -> tuple[Geometry | None, bool]:
    """The label as the ``width × height`` canvas keeps it, and whether it was cut.

    A box is clipped to the canvas. A polygon is clipped to it too, and when
    the cut leaves several separate pieces only the largest by area is kept.
    Either is dropped — ``None`` — when nothing is left on the canvas or what
    is left is less than :data:`CROP_KEEP_FRACTION` of its area before the cut.
    A label wholly on the canvas comes back as it was, uncut. Classification
    has no coordinates and always passes; every other geometry is refused by
    the cropping strategies' ``supported_geometries`` before it gets here.
    """
    match geometry:
        case ClassificationGeometry():
            return geometry, False
        case BboxGeometry():
            return _cropped_box(geometry, width, height)
        case PolygonGeometry():
            return _cropped_polygon(geometry, width, height)
        case (
            ObbGeometry()
            | PolylineGeometry()
            | Polyline3DGeometry()
            | Cuboid3DGeometry()
            | MaskGeometry()
        ):
            raise AssertionError(f"no cropping resize transforms a {geometry.type.value}")
        case _:
            assert_never(geometry)


def _on_canvas(x: float, y: float, width: float, height: float) -> bool:
    return (
        -_EDGE_TOLERANCE <= x <= width + _EDGE_TOLERANCE
        and -_EDGE_TOLERANCE <= y <= height + _EDGE_TOLERANCE
    )


def _cropped_box(
    box: BboxGeometry, width: float, height: float
) -> tuple[BboxGeometry | None, bool]:
    right, bottom = box.x + box.width, box.y + box.height
    if _on_canvas(box.x, box.y, width, height) and _on_canvas(right, bottom, width, height):
        return box, False
    left, top = max(box.x, 0.0), max(box.y, 0.0)
    right, bottom = min(right, width), min(bottom, height)
    if right <= left or bottom <= top:
        return None, True
    if (right - left) * (bottom - top) < CROP_KEEP_FRACTION * box.width * box.height:
        return None, True
    return BboxGeometry(x=left, y=top, width=right - left, height=bottom - top), True


def _cropped_polygon(
    polygon: PolygonGeometry, width: float, height: float
) -> tuple[PolygonGeometry | None, bool]:
    if all(_on_canvas(x, y, width, height) for x, y in polygon.points):
        return polygon, False
    pieces = [
        piece
        for piece in _clip_ring(list(polygon.points), width, height)
        if abs(_ring_area(piece)) > _DEGENERATE_AREA
    ]
    if not pieces:
        return None, True
    largest = max(pieces, key=lambda piece: abs(_ring_area(piece)))
    if abs(_ring_area(largest)) < CROP_KEEP_FRACTION * abs(_ring_area(polygon.points)):
        return None, True
    return PolygonGeometry(points=largest), True


def _ring_area(points: Sequence[Point]) -> float:
    """The signed shoelace area of a ring: positive when counter-clockwise in y-up axes."""
    return 0.5 * sum(
        x0 * y1 - x1 * y0
        for (x0, y0), (x1, y1) in zip(points, [*points[1:], points[0]], strict=True)
    )


def _clip_ring(points: list[Point], width: float, height: float) -> list[list[Point]]:
    """The separate pieces of a ring that lie on the ``width × height`` canvas.

    The ring is split against each canvas edge in turn. Each split pairs the
    places the ring crosses that edge in order along it, which is what keeps
    two pieces of a concave ring apart rather than joining them along the
    edge the way a single Sutherland–Hodgman pass does. A run of vertices
    along a canvas edge is reduced to its two ends, which removes the zero-area
    spike a source edge lying on the canvas edge would leave. Pieces without
    three distinct points are left out.
    """
    rings = [points]
    edges = ((0, 0.0, True), (0, width, False), (1, 0.0, True), (1, height, False))
    for axis, bound, keep_above in edges:
        rings = [piece for ring in rings for piece in _split(ring, axis, bound, keep_above)]
    pieces = (_edge_runs_ended(_distinct(ring), edges) for ring in rings)
    return [ring for ring in pieces if len(ring) >= 3]


def _edge_runs_ended(ring: list[Point], edges: Sequence[tuple[int, float, bool]]) -> list[Point]:
    """The ring without any vertex whose neighbours lie on the same canvas edge with it."""
    ring = list(ring)
    removed = True
    while removed and len(ring) >= 3:
        removed = False
        for index, point in enumerate(ring):
            before, after = ring[index - 1], ring[(index + 1) % len(ring)]
            if any(before[axis] == point[axis] == after[axis] == bound for axis, bound, _ in edges):
                del ring[index]
                removed = True
                break
    return _distinct(ring)


def _split(ring: list[Point], axis: int, bound: float, keep_above: bool) -> list[list[Point]]:
    def inside(point: Point) -> float:
        distance = point[axis] - bound
        return distance if keep_above else -distance

    values = [inside(point) for point in ring]
    if all(value >= 0 for value in values):
        return [ring]
    if all(value <= 0 for value in values):
        return []
    start = next(index for index, value in enumerate(values) if value < 0)
    ring = ring[start:] + ring[:start]
    values = values[start:] + values[:start]

    def crossing(p: Point, q: Point, vp: float, vq: float) -> Point:
        if vp == 0:
            return p
        if vq == 0:
            return q
        t = vp / (vp - vq)
        along = p[1 - axis] + t * (q[1 - axis] - p[1 - axis])
        return (bound, along) if axis == 0 else (along, bound)

    chains: list[list[Point]] = []
    current: list[Point] = []
    for index, (p, vp) in enumerate(zip(ring, values, strict=True)):
        q, vq = ring[(index + 1) % len(ring)], values[(index + 1) % len(ring)]
        if vp < 0:
            if vq >= 0:
                current = [crossing(p, q, vp, vq)]
            continue
        current.append(p)
        if vq < 0:
            current.append(crossing(p, q, vp, vq))
            chains.append(current)
    # A chain that only touches the edge encloses nothing on this side of it.
    chains = [chain for chain in chains if any(inside(point) > 0 for point in chain)]
    if not chains:
        return []
    return _joined(chains, axis) or [[point for chain in chains for point in chain]]


def _joined(chains: list[list[Point]], axis: int) -> list[list[Point]] | None:
    """Close each chain onto the next along the edge, or ``None`` if they do not pair.

    Along the edge, the ring's entries and exits alternate in a fixed order
    for a simple ring, and each consecutive (entry, exit) pair bounds one
    stretch of the edge inside the ring; a chain's exit joins the entry it is
    paired with. A ring that touches itself on the edge, or crosses itself,
    can break that order, and the caller then falls back to one ring.
    """
    events = sorted(
        [(chain[0][1 - axis], 0, index) for index, chain in enumerate(chains)]
        + [(chain[-1][1 - axis], 1, index) for index, chain in enumerate(chains)],
        key=lambda event: event[0],
    )
    ordered: list[tuple[float, int, int]] = []
    expected = events[0][1]
    while events:
        tied = [event for event in events if event[0] == events[0][0]]
        chosen = next((event for event in tied if event[1] == expected), tied[0])
        events.remove(chosen)
        ordered.append(chosen)
        expected = 1 - chosen[1]
    following: dict[int, int] = {}
    for opening, closing in zip(ordered[::2], ordered[1::2], strict=True):
        if opening[1] == closing[1]:
            return None
        exit_event, entry_event = (opening, closing) if opening[1] == 1 else (closing, opening)
        following[exit_event[2]] = entry_event[2]
    rings: list[list[Point]] = []
    seen: set[int] = set()
    for first in range(len(chains)):
        if first in seen:
            continue
        ring: list[Point] = []
        index = first
        while index not in seen:
            seen.add(index)
            ring.extend(chains[index])
            index = following[index]
        if index != first:
            return None
        rings.append(ring)
    return rings


def _distinct(ring: list[Point]) -> list[Point]:
    kept: list[Point] = []
    for point in ring:
        if not kept or point != kept[-1]:
            kept.append(point)
    while len(kept) > 1 and kept[0] == kept[-1]:
        kept.pop()
    return kept


def _mirrored(geometry: Geometry, width: float) -> Geometry:
    match geometry:
        case ClassificationGeometry():
            return geometry
        case BboxGeometry():
            return BboxGeometry(
                x=width - geometry.x - geometry.width,
                y=geometry.y,
                width=geometry.width,
                height=geometry.height,
            )
        case ObbGeometry():
            return ObbGeometry(
                cx=width - geometry.cx,
                cy=geometry.cy,
                width=geometry.width,
                height=geometry.height,
                angle=-geometry.angle,
            )
        case PolygonGeometry():
            return PolygonGeometry(points=[(width - x, y) for x, y in geometry.points])
        case PolylineGeometry():
            return geometry.through([(width - x, y) for x, y in geometry.points])
        case MaskGeometry():
            return mask_mirrored(geometry)
        case Polyline3DGeometry() | Cuboid3DGeometry():
            raise _unreachable_3d(geometry)
        case _:
            assert_never(geometry)


def _rotated_once(geometry: Geometry, width: float) -> Geometry:
    """One counter-clockwise quarter turn: ``(x, y)`` lands at ``(y, W - x)``.

    Counter-clockwise because that is what the pixel side's ``ROTATE_90``
    means, and the two must turn the same way. A box's corners rotate and the
    result is rebuilt axis-aligned, which is exact at a quarter turn. A rotated
    box's centre moves the same way and its width side turns from ``angle`` to
    ``angle - pi/2``. A mask's pixels turn the same way, exactly, and its size
    swaps.
    """
    match geometry:
        case ClassificationGeometry():
            return geometry
        case BboxGeometry():
            return BboxGeometry(
                x=geometry.y,
                y=width - geometry.x - geometry.width,
                width=geometry.height,
                height=geometry.width,
            )
        case ObbGeometry():
            return ObbGeometry(
                cx=geometry.cy,
                cy=width - geometry.cx,
                width=geometry.width,
                height=geometry.height,
                angle=geometry.angle - pi / 2,
            )
        case PolygonGeometry():
            return PolygonGeometry(points=[(y, width - x) for x, y in geometry.points])
        case PolylineGeometry():
            return geometry.through([(y, width - x) for x, y in geometry.points])
        case MaskGeometry():
            return mask_rotated_once(geometry)
        case Polyline3DGeometry() | Cuboid3DGeometry():
            raise _unreachable_3d(geometry)
        case _:
            assert_never(geometry)


def _unreachable_3d(geometry: Polyline3DGeometry | Cuboid3DGeometry) -> AssertionError:
    # The step tables keep every 3D type out of a pixel-moving step and
    # `fit_within` passes them by, so reaching this means a caller and the
    # arithmetic disagree about which coordinates are pixels.
    return AssertionError(f"no pixel-moving step transforms a {geometry.type.value}")


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
    reads each file on its own. ``uri`` and ``group_label`` are copied from the
    source; ``width`` and ``height`` are the transformed size. Classes stay the manifest's. A file
    still carrying a 3D label carries its source's calibration, which only a
    step that leaves the pixels where they are lets through. Tracks keep only
    the observations whose annotation a variant-0 file still carries, and sources
    the occurrences of the assets it still holds.
    """
    sources = {asset.asset_id: asset for asset in manifest.assets}
    assets = tuple(
        ManifestAsset(
            asset_id=file.asset_id,
            content_hash=variant_content_hash(file.content_hash, file.variant),
            uri=sources[file.asset_id].uri,
            width=file.width,
            height=file.height,
            annotations=tuple(
                _manifest_annotation(annotation, file.variant) for annotation in file.annotations
            ),
            calibration=(
                sources[file.asset_id].calibration
                if any(
                    geometry_needs_calibration(a.geometry, modality=sources[file.asset_id].modality)
                    for a in file.annotations
                )
                else None
            ),
            group_label=sources[file.asset_id].group_label,
        )
        for file in view.files
    )
    return manifest_within(manifest, assets)


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
    size, is returned as it is. A 3D label is in metres, not pixels, so the
    cap leaves it as it is too. A rotated box is scaled by the cap's one
    ratio on both axes, so it stays a rectangle; the rounding of the capped
    size can leave it under half a pixel from the pixels on the short axis. A
    mask is resampled to the capped size nearest-neighbour, which is lossy and
    is why no export resize carries one.
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
                annotation
                if GeometryType(annotation.geometry.type) in THREE_D
                else annotation.model_copy(
                    update={
                        "geometry": mask_resampled(annotation.geometry, height=height, width=width)
                        if isinstance(annotation.geometry, MaskGeometry)
                        else _scaled(annotation.geometry, scale, scale, 0.0, 0.0)
                        if isinstance(annotation.geometry, ObbGeometry)
                        else _scaled(
                            annotation.geometry, width / file.width, height / file.height, 0.0, 0.0
                        )
                    }
                )
                for annotation in file.annotations
            ),
        }
    )
