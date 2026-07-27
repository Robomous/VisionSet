"""The release artifact itself: canonical bytes, and the split recipe over them.

Nothing here touches a workspace. Both things being checked are pure — a manifest
serializes the same way twice or it does not, and a recipe cuts a set the same way
twice or it does not — so they are tested where they live rather than through a
service that would only add ceremony.
"""

from __future__ import annotations

import json
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from visionset.kernel import UnserializableManifest
from visionset.kernel.domain import (
    MANIFEST_VERSION,
    BboxGeometry,
    GeometryType,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    SplitRecipe,
    assign_split,
    canonical_bytes,
    sha256_hex,
)

SIGN = LabelClass(name="sign", geometry=GeometryType.BBOX)
BOX = BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0)


def _annotation(**overrides: object) -> ManifestAnnotation:
    fields: dict[str, object] = {
        "id": uuid4(),
        "label_class": "sign",
        "schema_version": 1,
        "geometry": BOX,
        "provenance": "human",
    }
    return ManifestAnnotation.model_validate(fields | overrides)


def _asset(seed: str, *, annotations: tuple[ManifestAnnotation, ...] = ()) -> ManifestAsset:
    return ManifestAsset(
        asset_id=uuid4(),
        content_hash=sha256_hex(seed.encode()),
        uri=f"/tmp/{seed}.png",
        annotations=annotations,
    )


def _manifest(*assets: ManifestAsset) -> Manifest:
    return Manifest(schema_version=1, classes=(SIGN,), assets=assets)


# --- what the bytes are, and what they are not --------------------------------


def test_two_manifests_built_from_the_same_content_serialize_to_the_same_bytes() -> None:
    assets = tuple(_asset(f"a{index}") for index in range(4))
    assert canonical_bytes(_manifest(*assets)) == canonical_bytes(_manifest(*assets))


def test_the_manifest_bytes_do_not_depend_on_the_order_the_assets_are_given_in() -> None:
    """Which batch an asset arrived in must not decide the artifact's identity."""
    assets = tuple(_asset(f"a{index}") for index in range(4))
    assert canonical_bytes(_manifest(*assets)) == canonical_bytes(_manifest(*reversed(assets)))


def test_a_manifest_puts_its_assets_in_content_order_whatever_it_was_handed() -> None:
    assets = tuple(_asset(f"a{index}") for index in range(6))
    manifest = _manifest(*reversed(assets))
    assert [asset.content_hash for asset in manifest.assets] == sorted(
        asset.content_hash for asset in assets
    )


def test_an_assets_labels_are_ordered_by_id_whatever_they_were_handed_in() -> None:
    labels = tuple(_annotation() for _ in range(5))
    asset = _asset("a", annotations=tuple(reversed(labels)))
    assert [str(a.id) for a in asset.annotations] == sorted(str(a.id) for a in labels)


def test_a_manifest_round_trips_through_its_own_canonical_bytes() -> None:
    manifest = _manifest(_asset("a", annotations=(_annotation(),)))
    rehydrated = Manifest.model_validate(json.loads(canonical_bytes(manifest)))
    assert rehydrated == manifest
    assert canonical_bytes(rehydrated) == canonical_bytes(manifest)


def test_a_manifest_carries_no_timestamp_no_tag_and_no_release_id() -> None:
    """This is the whole reason two publishes agree; it is worth pinning."""
    document = json.loads(canonical_bytes(_manifest(_asset("a"))))
    assert set(document) == {"manifest_version", "schema_version", "classes", "assets"}


def test_a_manifest_says_which_format_it_is_in() -> None:
    document = json.loads(canonical_bytes(_manifest(_asset("a"))))
    assert document["manifest_version"] == MANIFEST_VERSION


def test_a_manifest_refuses_a_field_it_does_not_declare() -> None:
    with pytest.raises(ValidationError):
        Manifest.model_validate({"schema_version": 1, "published_at": "2026-07-27"})


def test_a_manifest_counts_the_labels_across_all_of_its_assets() -> None:
    manifest = _manifest(
        _asset("a", annotations=(_annotation(), _annotation())),
        _asset("b", annotations=(_annotation(),)),
        _asset("c"),
    )
    assert manifest.annotation_count == 3


def test_a_not_a_number_coordinate_is_refused_rather_than_written_as_invalid_json() -> None:
    """``json`` would emit the bare token ``NaN``, which no other tool can read."""
    nan_box = BboxGeometry(x=float("nan"), y=2.0, width=3.0, height=4.0)
    manifest = _manifest(_asset("a", annotations=(_annotation(geometry=nan_box),)))
    with pytest.raises(UnserializableManifest, match="NaN or infinity"):
        canonical_bytes(manifest)


def test_attribute_values_are_ordered_by_key_and_not_by_insertion() -> None:
    """``sort_keys`` recurses, and ``attributes`` is the one dict in the document."""
    asset = _asset("a")
    ordered = _annotation(attributes={"alpha": "x", "beta": "y"})
    shuffled = _annotation(id=ordered.id, attributes={"beta": "y", "alpha": "x"})
    assert canonical_bytes(
        _manifest(asset.model_copy(update={"annotations": (ordered,)}))
    ) == canonical_bytes(_manifest(asset.model_copy(update={"annotations": (shuffled,)})))


def test_the_bytes_are_utf_eight_with_no_incidental_whitespace() -> None:
    manifest = Manifest(
        schema_version=1, classes=(LabelClass(name="señal", geometry=SIGN.geometry),)
    )
    raw = canonical_bytes(manifest)
    assert b"se\xc3\xb1al" in raw
    assert b", " not in raw and b": " not in raw


# --- the split recipe ---------------------------------------------------------


def test_a_split_recipe_whose_fractions_do_not_reach_one_is_refused() -> None:
    with pytest.raises(ValidationError, match="add up to 1.0"):
        SplitRecipe(train=0.5, val=0.2, test=0.2)


def test_a_seventy_fifteen_fifteen_recipe_is_accepted_despite_binary_floating_point() -> None:
    """``0.7 + 0.15 + 0.15`` is ``0.9999999999999999``; an equality test would fail."""
    assert SplitRecipe(train=0.7, val=0.15, test=0.15).train == 0.7


def test_a_recipe_seeds_itself_when_nobody_says_otherwise() -> None:
    assert SplitRecipe(train=1.0, val=0.0, test=0.0).seed == 0


def test_the_same_seed_assigns_the_same_split_twice() -> None:
    recipe = SplitRecipe(train=0.6, val=0.2, test=0.2, seed=42)
    assets = [_asset(f"a{index}") for index in range(10)]
    assert assign_split(recipe, assets) == assign_split(recipe, assets)


def test_a_different_seed_assigns_a_different_split() -> None:
    assets = [_asset(f"a{index}") for index in range(20)]
    first = assign_split(SplitRecipe(train=0.6, val=0.2, test=0.2, seed=1), assets)
    second = assign_split(SplitRecipe(train=0.6, val=0.2, test=0.2, seed=2), assets)
    assert first != second


def test_the_split_does_not_depend_on_the_order_the_assets_are_passed_in() -> None:
    recipe = SplitRecipe(train=0.6, val=0.2, test=0.2, seed=42)
    assets = [_asset(f"a{index}") for index in range(10)]
    assert assign_split(recipe, assets) == assign_split(recipe, list(reversed(assets)))


def test_the_split_counts_always_add_up_to_the_assets_it_was_given() -> None:
    recipe = SplitRecipe(train=0.7, val=0.15, test=0.15, seed=3)
    for size in range(0, 25):
        assets = [_asset(f"a{index}") for index in range(size)]
        folds = assign_split(recipe, assets)
        assert len(folds.train) + len(folds.val) + len(folds.test) == size


def test_no_asset_ever_lands_in_two_folds() -> None:
    recipe = SplitRecipe(train=0.5, val=0.25, test=0.25, seed=9)
    assets = [_asset(f"a{index}") for index in range(17)]
    folds = assign_split(recipe, assets)
    everywhere = [*folds.train, *folds.val, *folds.test]
    assert len(set(everywhere)) == len(everywhere) == len(assets)


def test_the_split_of_a_single_asset_puts_it_where_the_largest_fraction_is() -> None:
    """Flooring alone would give 0/0/0 and lose it."""
    (asset,) = assets = [_asset("only")]
    folds = assign_split(SplitRecipe(train=0.8, val=0.1, test=0.1), assets)
    assert folds.train == (asset.asset_id,)
    assert folds.val == () and folds.test == ()


def test_a_recipe_that_is_all_train_leaves_validation_and_test_empty() -> None:
    assets = [_asset(f"a{index}") for index in range(6)]
    folds = assign_split(SplitRecipe(train=1.0, val=0.0, test=0.0), assets)
    assert len(folds.train) == 6
    assert folds.val == () and folds.test == ()


def test_splitting_nothing_yields_three_empty_folds() -> None:
    folds = assign_split(SplitRecipe(train=0.8, val=0.1, test=0.1), [])
    assert folds.train == () and folds.val == () and folds.test == ()


def test_two_assets_with_the_same_content_land_next_to_each_other() -> None:
    """Duplicate bytes on both sides of a fold is the classic train/test leak.

    Keying on the content hash rather than the asset id is what stops it, and
    what that buys is stated exactly: the twins are *adjacent* in the ordering,
    so the only thing that can separate them is a fold boundary landing precisely
    between them. Asserting the adjacency is asserting the guarantee; asserting
    that they usually share a fold would be asserting a coin toss.
    """
    shared = sha256_hex(b"the same picture twice")
    twins = [
        ManifestAsset(asset_id=uuid4(), content_hash=shared, uri="/tmp/one.png"),
        ManifestAsset(asset_id=uuid4(), content_hash=shared, uri="/tmp/two.png"),
    ]
    assets = [*twins, *(_asset(f"a{index}") for index in range(8))]
    for seed in range(20):
        folds = assign_split(SplitRecipe(train=0.6, val=0.2, test=0.2, seed=seed), assets)
        ordering = [*folds.train, *folds.val, *folds.test]
        positions = sorted(ordering.index(twin.asset_id) for twin in twins)
        assert positions[1] - positions[0] == 1


def test_the_split_is_over_ids_the_manifest_actually_carries() -> None:
    assets = [_asset(f"a{index}") for index in range(5)]
    folds = assign_split(SplitRecipe(train=0.6, val=0.2, test=0.2), assets)
    assert set([*folds.train, *folds.val, *folds.test]) == {a.asset_id for a in assets}


def test_a_split_assignment_is_uuids_and_nothing_else() -> None:
    assets = [_asset("a")]
    folds = assign_split(SplitRecipe(train=1.0, val=0.0, test=0.0), assets)
    assert all(isinstance(value, UUID) for value in folds.train)
