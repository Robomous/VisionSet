"""Legacy recipe behaviour, captured before the augmentation registry existed.

``augmentation_goldens.json`` beside this module was written by running it on
the checkout *before* #1238 changed anything: the canonical bytes and hash of
every legacy recipe document, every variant seed and draw, the geometry view
over every geometry type, and the Pillow drivers' output for one fixed image.
``tests/preprocessing/test_legacy_goldens.py`` recomputes all of it and
compares. A golden that has to change is a broken promise to every export
already written, not a fixture to refresh.

    uv run python -m tests.fixtures.augmentation_goldens   # rewrite the JSON
"""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from typing import Any
from uuid import UUID

from PIL import Image
from tests.fixtures.calibration import calibration

from visionset.kernel.domain import (
    SHOWCASE_SEED,
    AugmentOp,
    AugmentStep,
    BboxGeometry,
    ClassificationGeometry,
    Cuboid3DGeometry,
    Geometry,
    GeometryType,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    ObbGeometry,
    PolygonGeometry,
    Polyline3DGeometry,
    PolylineGeometry,
    RecipeSpec,
    SplitAssignment,
    brightness_contrast_factors,
    canonical_bytes,
    mask_from_bitmap,
    recipe_hash,
    rot90_quarter_turns,
    transform_manifest,
    variant_seed,
)
from visionset.kernel.errors import VisionSetError
from visionset.kernel.services.release_service import transformed_bytes
from visionset.preprocessing.pillow import PillowAugmentDriver, PillowResizeDriver
from visionset.server.models import RecipeSpecBody

GOLDENS = Path(__file__).with_name("augmentation_goldens.json")

CONTENT_HASHES = ("0" * 64, "3f" * 32)

IMAGE_HASH = "c0ffee" + "0" * 58

DRIVERS = {"resize": PillowResizeDriver(), "augment": PillowAugmentDriver()}

GEOMETRY_WIDTH, GEOMETRY_HEIGHT = 40, 30


def _augment(op: str, amount: float | None = None) -> dict[str, Any]:
    step: dict[str, Any] = {"kind": "augment", "op": op}
    if amount is not None:
        step["amount"] = amount
    return step


def _resize(
    strategy: str, width: int = 64, height: int = 48, pad: int | None = None
) -> dict[str, Any]:
    step: dict[str, Any] = {
        "kind": "resize",
        "strategy": strategy,
        "width": width,
        "height": height,
    }
    if pad is not None:
        step["pad_value"] = pad
    return step


def _doc(*steps: dict[str, Any], variants: int = 0, target: str | None = None) -> dict[str, Any]:
    return {"target": target, "steps": list(steps), "variants_per_asset": variants}


def recipe_documents() -> dict[str, dict[str, Any]]:
    """Every legacy recipe the goldens cover, as a stored document would spell it."""
    documents: dict[str, dict[str, Any]] = {
        "empty": _doc(),
        "hflip": _doc(_augment("hflip"), variants=1),
        "hflip-amount": _doc(_augment("hflip", 0.45), variants=2),
        "rot90": _doc(_augment("rot90"), variants=3),
        "rot90-amount": _doc(_augment("rot90", 0.1), variants=1),
        "hflip-rot90": _doc(_augment("hflip"), _augment("rot90"), variants=4),
        "rot90-hflip": _doc(_augment("rot90"), _augment("hflip"), variants=4),
        "bc-rot90": _doc(_augment("brightness_contrast", 0.3), _augment("rot90"), variants=2),
        "target-yolo": _doc(_augment("hflip"), variants=1, target="ultralytics"),
        "target-coco-resize": _doc(_resize("letterbox", 640, 640), target="coco"),
    }
    for amount in (0.05, 0.2, 0.25, 0.333, 0.5):
        documents[f"bc-{amount}"] = _doc(_augment("brightness_contrast", amount), variants=2)
    documents["bc-default"] = _doc(_augment("brightness_contrast"), variants=2)
    for variants in range(1, 9):
        documents[f"all-v{variants}"] = _doc(
            _augment("hflip"),
            _augment("brightness_contrast", 0.2),
            _augment("rot90"),
            variants=variants,
        )
    for strategy in ("stretch", "letterbox", "fill", "center_crop"):
        documents[f"resize-{strategy}"] = _doc(_resize(strategy))
        documents[f"resize-{strategy}-all"] = _doc(
            _resize(strategy, 48, 64, pad=7),
            _augment("rot90"),
            _augment("brightness_contrast", 0.4),
            _augment("hflip"),
            variants=2,
            target="ultralytics",
        )
    return documents


def _annotation(index: int, geometry: Geometry, label: str) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=UUID(int=0xA000 + index),
        label_class=label,
        schema_version=1,
        geometry=geometry,
        attributes={"colour": "red"},
        provenance="model",
        model_ref="detector:1",
        confidence=0.75,
    )


def _mask() -> Geometry:
    bitmap = bytearray(GEOMETRY_WIDTH * GEOMETRY_HEIGHT)
    for x in range(3, 17):
        for y in range(2, 11):
            bitmap[x * GEOMETRY_HEIGHT + y] = 1
    bitmap[25 * GEOMETRY_HEIGHT + 20] = 1
    return mask_from_bitmap(bitmap, height=GEOMETRY_HEIGHT, width=GEOMETRY_WIDTH)


def geometry_samples() -> dict[GeometryType, Geometry]:
    """One label of every geometry type, placed so each transform moves it visibly."""
    return {
        GeometryType.BBOX: BboxGeometry(x=4.0, y=3.0, width=12.5, height=9.0),
        GeometryType.POLYGON: PolygonGeometry(points=[(2.0, 2.0), (30.0, 5.0), (12.0, 27.0)]),
        GeometryType.POLYLINE: PolylineGeometry(points=[(1.0, 1.0), (20.0, 15.0), (39.0, 2.0)]),
        GeometryType.CLASSIFICATION_TAG: ClassificationGeometry(),
        GeometryType.OBB: ObbGeometry(cx=20.0, cy=14.0, width=16.0, height=6.0, angle=0.3),
        GeometryType.MASK: _mask(),
        GeometryType.CUBOID_3D: Cuboid3DGeometry(
            center=(-4.0, 0.8, 9.5), size=(4.5, 1.9, 1.6), yaw=-2.75
        ),
        GeometryType.POLYLINE_3D: Polyline3DGeometry(points=[(-4.0, 1.5, 6.0), (-3.0, 1.5, 12.0)]),
    }


def _manifest(geometry_type: GeometryType, geometry: Geometry) -> Manifest:
    three_d = geometry_type in (GeometryType.CUBOID_3D, GeometryType.POLYLINE_3D)
    asset = ManifestAsset(
        asset_id=UUID(int=0xB000 + list(GeometryType).index(geometry_type)),
        content_hash=CONTENT_HASHES[1],
        uri="/img/a.png",
        width=GEOMETRY_WIDTH,
        height=GEOMETRY_HEIGHT,
        annotations=(_annotation(1, geometry, "thing"),),
        calibration=(
            calibration(width=GEOMETRY_WIDTH, height=GEOMETRY_HEIGHT) if three_d else None
        ),
    )
    classes = (LabelClass(name="thing", geometries=(geometry_type,)),)
    return Manifest(schema_version=1, classes=classes, assets=(asset,))


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _refusal(exc: VisionSetError) -> str:
    return f"refused {type(exc).__name__}: {exc}"


def _views(spec: RecipeSpec, *, showcase: bool) -> dict[str, str]:
    views: dict[str, str] = {}
    for geometry_type, geometry in geometry_samples().items():
        manifest = _manifest(geometry_type, geometry)
        folds = SplitAssignment(train=(manifest.assets[0].asset_id,))
        try:
            view = transform_manifest(manifest, spec, folds, showcase=showcase)
        except VisionSetError as exc:
            views[geometry_type.value] = _refusal(exc)
            continue
        views[geometry_type.value] = _digest(canonical_bytes(view))
    return views


def source_image() -> bytes:
    """A 37 by 23 RGB gradient: odd on both axes, every pixel distinct enough to show a move."""
    image = Image.new("RGB", (37, 23))
    image.putdata(
        [
            ((x * 7) % 256, (y * 11) % 256, (x * y * 3 + 17) % 256)
            for y in range(23)
            for x in range(37)
        ]
    )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _pixels(data: bytes) -> str:
    with Image.open(io.BytesIO(data)) as opened:
        opened.load()
        header = f"{opened.format}:{opened.mode}:{opened.width}x{opened.height}:"
        return header + _digest(opened.tobytes())


def _pixel_outputs(spec: RecipeSpec, image: bytes) -> dict[str, str]:
    outputs: dict[str, str] = {}
    for k in range(spec.variants_per_asset + 1):
        result = transformed_bytes(spec, DRIVERS, image, content_hash=IMAGE_HASH, variant=k)
        outputs[str(k)] = _pixels(result)
    if spec.variants_per_asset:
        showcase = transformed_bytes(
            spec, DRIVERS, image, content_hash=IMAGE_HASH, variant=1, showcase=True
        )
        outputs["showcase"] = _pixels(showcase)
    return outputs


def _draws(spec: RecipeSpec, spec_hash: str) -> list[dict[str, Any]]:
    amounts = [
        step.amount
        for step in spec.steps
        if isinstance(step, AugmentStep) and step.op is AugmentOp.BRIGHTNESS_CONTRAST
    ]
    draws: list[dict[str, Any]] = []
    for content_hash in CONTENT_HASHES:
        for k in range(1, spec.variants_per_asset + 1):
            seed = variant_seed(spec_hash, content_hash, k)
            entry: dict[str, Any] = {
                "content_hash": content_hash,
                "k": k,
                "seed": seed.hex(),
                "rot90": rot90_quarter_turns(seed),
            }
            if amounts:
                entry["brightness_contrast"] = [
                    factor.hex() for factor in brightness_contrast_factors(seed, amounts[0])
                ]
            draws.append(entry)
    return draws


def compute() -> dict[str, Any]:
    image = source_image()
    recipes: dict[str, Any] = {}
    for name, document in recipe_documents().items():
        spec = RecipeSpec.model_validate(document)
        spec_hash = recipe_hash(spec)
        recipes[name] = {
            "document": document,
            "canonical": canonical_bytes(spec).decode(),
            "hash": spec_hash,
            "wire": json.dumps(RecipeSpecBody.of(spec).model_dump(mode="json"), sort_keys=True),
            "draws": _draws(spec, spec_hash),
            "geometry": _views(spec, showcase=False),
            "geometry_showcase": _views(spec, showcase=True) if spec.variants_per_asset else {},
            "pixels": _pixel_outputs(spec, image),
        }
    showcase = {
        "rot90": rot90_quarter_turns(SHOWCASE_SEED),
        "brightness_contrast": {
            str(amount): [
                factor.hex() for factor in brightness_contrast_factors(SHOWCASE_SEED, amount)
            ]
            for amount in (0.05, 0.2, 0.5)
        },
    }
    return {"source_image": _pixels(image), "showcase": showcase, "recipes": recipes}


def main() -> None:
    GOLDENS.write_text(json.dumps(compute(), indent=1, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
