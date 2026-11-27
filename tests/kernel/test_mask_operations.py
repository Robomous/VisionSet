"""Every existing geometry operation either carries a mask exactly or refuses it by name."""

from __future__ import annotations

import json
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from visionset.inference.nms import extent_of
from visionset.kernel.domain import (
    MASK_MANIFEST_VERSION,
    SEQUENCED_MANIFEST_VERSION,
    AugmentOp,
    AugmentStep,
    BboxGeometry,
    Geometry,
    GeometryType,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    MaskGeometry,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    SplitAssignment,
    TransformedFile,
    canonical_bytes,
    fit_within,
    geometry_fits_modality,
    geometry_needs_calibration,
    manifest_version_for,
    mask_from_rows,
    mask_mirrored,
    mask_rotated_once,
    mask_rows,
    recipe_hash,
    rot90_quarter_turns,
    transform_manifest,
    variant_seed,
)
from visionset.kernel.errors import PreprocessingStepUnsupportedGeometry
from visionset.server.models import GeometryBody, MaskBody, geometry_of
from visionset.wire import geometry as wire_geometry

body_adapter: TypeAdapter[GeometryBody] = TypeAdapter(GeometryBody)

WIDTH, HEIGHT = 5, 3
MASK = mask_from_rows(
    [
        [1, 1, 0, 0, 0],
        [1, 0, 0, 0, 1],
        [0, 0, 0, 1, 1],
    ]
)


def _annotation(geometry: Geometry) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=uuid4(), label_class="road", schema_version=1, geometry=geometry, provenance="human"
    )


def _asset(*geometries: Geometry, width: int = WIDTH, height: int = HEIGHT) -> ManifestAsset:
    return ManifestAsset(
        asset_id=uuid4(),
        content_hash="ab",
        uri="/img/ab.jpg",
        width=width,
        height=height,
        annotations=tuple(_annotation(geometry) for geometry in geometries),
    )


def _spec(*steps: ResizeStep | AugmentStep, variants: int = 0) -> RecipeSpec:
    return RecipeSpec(target=None, steps=steps, variants_per_asset=variants)


def _only_mask(file: TransformedFile) -> MaskGeometry:
    (geometry,) = [one.geometry for one in file.annotations]
    assert isinstance(geometry, MaskGeometry)
    return geometry


# --- the surfaces ------------------------------------------------------------------------


def test_rest_and_the_wire_carry_size_and_counts_unchanged() -> None:
    body = body_adapter.validate_python(
        {"type": "mask", "size": [HEIGHT, WIDTH], "counts": MASK.counts}
    )
    stored = body.to_domain()

    assert stored == MASK
    assert geometry_of(stored) == MaskBody.of(stored)
    assert wire_geometry(stored) == {
        "type": "mask",
        "size": [HEIGHT, WIDTH],
        "counts": MASK.counts,
    }


def test_rest_stores_a_non_canonical_spelling_canonical() -> None:
    body = body_adapter.validate_python({"type": "mask", "size": [5, 1], "counts": "302"})
    assert body.to_domain().counts == "5"


def test_a_scan_refuses_a_mask_and_an_image_needs_no_calibration_for_one() -> None:
    assert geometry_fits_modality(MASK, modality="image") is True
    assert geometry_fits_modality(MASK, modality="point_cloud") is False
    assert geometry_needs_calibration(MASK, modality="image") is False


def test_nms_compares_a_mask_by_the_box_around_its_pixels() -> None:
    assert extent_of(MASK) == BboxGeometry(x=0.0, y=0.0, width=5.0, height=3.0)
    empty = mask_from_rows([[0, 0], [0, 0]])
    assert extent_of(empty) is None


# --- the manifest ------------------------------------------------------------------------


def test_a_release_holding_a_mask_is_written_at_version_10() -> None:
    plain = _asset(BboxGeometry(x=1.0, y=1.0, width=2.0, height=2.0))
    masked = _asset(MASK)

    assert MASK_MANIFEST_VERSION == SEQUENCED_MANIFEST_VERSION + 1 == 10
    assert manifest_version_for([plain]) == 3
    assert manifest_version_for([plain, masked]) == MASK_MANIFEST_VERSION


def test_an_earlier_manifest_version_cannot_carry_a_mask() -> None:
    classes = (LabelClass(name="road", geometries=(GeometryType.MASK,)),)
    with pytest.raises(ValidationError, match="a mask label needs version 10"):
        Manifest(manifest_version=9, schema_version=1, classes=classes, assets=(_asset(MASK),))


def test_a_mask_round_trips_through_the_canonical_manifest_bytes() -> None:
    classes = (LabelClass(name="road", geometries=(GeometryType.MASK,)),)
    manifest = Manifest(
        manifest_version=MASK_MANIFEST_VERSION,
        schema_version=1,
        classes=classes,
        assets=(_asset(MASK),),
    )
    written = canonical_bytes(manifest)
    again = Manifest.model_validate(json.loads(written))

    assert again == manifest
    assert canonical_bytes(again) == written
    assert b'"counts":"' + MASK.counts.encode() + b'"' in written


# --- pre-processing ----------------------------------------------------------------------


@pytest.mark.parametrize("strategy", list(ResizeStrategy))
def test_every_resize_refuses_a_mask(strategy: ResizeStrategy) -> None:
    step = ResizeStep(strategy=strategy, width=64, height=96)
    asset = _asset(MASK)
    with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
        transform_manifest(Manifest(schema_version=1, assets=(asset,)), _spec(step), None)
    assert (caught.value.step, caught.value.geometry) == ("resize", "mask")
    assert caught.value.asset_id == str(asset.asset_id)


def test_hflip_and_rot90_variants_move_the_mask_exactly() -> None:
    asset = _asset(MASK)
    for op in (AugmentOp.HFLIP, AugmentOp.ROT90, AugmentOp.BRIGHTNESS_CONTRAST):
        spec = _spec(AugmentStep(op=op), variants=1)
        view = transform_manifest(
            Manifest(schema_version=1, assets=(asset,)),
            spec,
            SplitAssignment(train=(asset.asset_id,)),
        )
        (base,) = [file for file in view.files if file.variant == 0]
        (variant,) = [file for file in view.files if file.variant == 1]
        assert _only_mask(base) == MASK
        moved = _only_mask(variant)
        expected = MASK
        if op is AugmentOp.HFLIP:
            expected = mask_mirrored(MASK)
            assert mask_rows(moved)[0] == bytes([0, 0, 0, 1, 1])
        elif op is AugmentOp.ROT90:
            turns = rot90_quarter_turns(variant_seed(recipe_hash(spec), asset.content_hash, 1))
            for _ in range(turns):
                expected = mask_rotated_once(expected)
        assert moved == expected
        assert moved.size == (variant.height, variant.width)


def test_the_preview_cap_resamples_a_mask_to_the_capped_size() -> None:
    wide = mask_from_rows([[1] * 500 + [0] * 500 for _ in range(10)])
    view = transform_manifest(
        Manifest(schema_version=1, assets=(_asset(wide, width=1000, height=10),)), _spec(), None
    )
    (file,) = view.files
    capped = fit_within(file, 100)

    assert (capped.width, capped.height) == (100, 1)
    resampled = _only_mask(capped)
    assert resampled.size == (1, 100)
    assert mask_rows(resampled) == [bytes([1] * 50 + [0] * 50)]
