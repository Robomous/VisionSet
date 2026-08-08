"""Tripwires on the seam between a wire model and the domain it mirrors.

No HTTP here. These are the assertions that catch a wire model drifting away
from the kernel it publishes — which the route tests would not, because they
only ever send shapes both sides already agree on.
"""

from datetime import UTC, datetime
from typing import get_args
from uuid import uuid4

import pytest
from tests.fixtures import samples

from visionset import wire
from visionset.kernel.domain import (
    Annotation,
    Asset,
    AssetProgress,
    Attribute,
    BatchState,
    BboxGeometry,
    ClassCount,
    ClassificationGeometry,
    DatasetChange,
    DatasetStats,
    Geometry,
    GeometryType,
    LabelClass,
    Partition,
    PolygonGeometry,
    Release,
    ReleaseVerification,
    SplitRecipe,
)
from visionset.server.models import (
    AnnotationCreate,
    AnnotationOut,
    AssetOut,
    AttributeBody,
    BatchAssetOut,
    BatchOut,
    ClassCountOut,
    DatasetChangeOut,
    DatasetStatsOut,
    GeometryBody,
    LabelClassBody,
    PartitionBody,
    ProgressCounts,
    ReleaseOut,
    ReleaseVerificationOut,
    SplitRecipeBody,
    geometry_of,
)


def test_the_wire_attribute_kinds_are_the_domains_own_four() -> None:
    """`AttributeBody.kind` restates the domain's `Literal` and nothing ties them.

    It is spelled inline rather than shared through an alias, because a PEP 695
    `type` alias emits a *named* schema into `components` — so the price of
    keeping the contract clean is this test. A fifth kind added to the domain
    fails here until somebody publishes it deliberately.
    """
    domain = get_args(Attribute.model_fields["kind"].annotation)
    wire = get_args(AttributeBody.model_fields["kind"].annotation)

    assert wire == domain
    assert set(wire) == {"string", "number", "boolean", "select"}


def test_the_wire_geometry_is_the_domains_own_enum() -> None:
    """Reused rather than restated, so the eight members cannot drift apart."""
    assert LabelClassBody.model_fields["geometry"].annotation is GeometryType


def test_a_label_class_round_trips_through_the_domain_and_back() -> None:
    """`of` and `to_domain` are inverses, so nothing is lost on the way out."""
    original = LabelClassBody(
        name="sign",
        geometry=GeometryType.BBOX,
        color="#ff0000",
        attributes=(
            AttributeBody(
                name="weather",
                kind="select",
                required=True,
                options=("sun", "rain"),
                default="sun",
            ),
        ),
    )

    assert LabelClassBody.of(original.to_domain()) == original


def test_a_domain_label_class_survives_being_published() -> None:
    """The other direction: a stored class comes back identical."""
    label_class = LabelClass(name="lane", geometry=GeometryType.POLYGON)

    assert LabelClassBody.of(label_class).to_domain() == label_class


def test_a_wire_label_class_is_refused_by_the_domains_own_rules() -> None:
    """The refusal happens at *construction*, which is why it becomes a 422.

    If this ever stops raising, the conversion has moved out of the validator
    and a malformed payload is answering 500 again.
    """
    with pytest.raises(ValueError, match="at least one non-blank character"):
        LabelClassBody(name="  ", geometry=GeometryType.BBOX)

    with pytest.raises(ValueError, match="needs at least one option"):
        AttributeBody(name="weather", kind="select")


def test_the_progress_counts_are_the_domains_own_states() -> None:
    """Five explicit fields rather than a dict, so this is the tie that holds them.

    A sixth `AssetProgress` member fails here until somebody publishes it — which
    is the point, because a client charting progress would otherwise silently
    stop seeing a state that exists.
    """
    fields = set(ProgressCounts.model_fields) - {"total"}

    assert fields == {progress.value for progress in AssetProgress}


def test_the_wire_geometries_are_the_domains_implemented_ones() -> None:
    """Re-spelled rather than reused — the domain docstrings carry RST markup —
    so nothing structural keeps the two unions in step except this."""
    domain = {variant.model_fields["type"].default for variant in get_args(get_args(Geometry)[0])}
    wire = {
        get_args(variant.model_fields["type"].annotation)[0]
        for variant in get_args(get_args(GeometryBody)[0])
    }

    assert wire == domain


def test_the_wire_partitions_are_the_domains_own_strategies() -> None:
    domain = {variant.model_fields["kind"].default for variant in get_args(get_args(Partition)[0])}
    wire = {
        get_args(variant.model_fields["kind"].annotation)[0]
        for variant in get_args(get_args(PartitionBody)[0])
    }

    assert wire == domain


def test_the_wire_provenances_are_the_domains_own_three() -> None:
    """Spelled inline for reason 2 in `models.py`, which is why this exists."""
    domain = get_args(Annotation.model_fields["provenance"].annotation)

    for model in (AnnotationCreate, AnnotationOut):
        assert get_args(model.model_fields["provenance"].annotation) == domain


@pytest.mark.parametrize(
    "geometry",
    [
        BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
        PolygonGeometry(points=[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]),
        ClassificationGeometry(),
    ],
)
def test_a_geometry_round_trips_through_the_wire_and_back(geometry: Geometry) -> None:
    """`geometry_of` and `to_domain` are inverses for every implemented variant."""
    assert geometry_of(geometry).to_domain() == geometry


def test_an_annotation_the_domain_cannot_hold_is_refused_at_construction() -> None:
    """If this stops raising, the conversion has left the validator and a
    malformed payload is answering 500 again."""
    box = {"type": "bbox", "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}

    with pytest.raises(ValueError, match="model_ref"):
        AnnotationCreate(asset_id=uuid4(), label_class="sign", geometry=box, provenance="model")

    with pytest.raises(ValueError, match="less than or equal to 1"):
        AnnotationCreate(
            asset_id=uuid4(),
            label_class="sign",
            geometry=box,
            provenance="human",
            confidence=2.0,
        )


def test_the_split_recipe_body_carries_every_field_the_domain_has() -> None:
    """A recipe missing a field would publish an incomplete cut as a complete one."""
    assert set(SplitRecipeBody.model_fields) == set(SplitRecipe.model_fields)


def test_a_split_recipe_the_domain_refuses_is_refused_at_construction() -> None:
    """#27's trap again: without the validator this is a 500, not a 422.

    The fractions rule lives in ``SplitRecipe`` and is not restated on the wire,
    so what this really asserts is that the wire model still asks the domain.
    """
    with pytest.raises(ValueError, match="1.0"):
        SplitRecipeBody(train=0.5, val=0.2, test=0.2)


def test_a_split_recipe_round_trips_through_the_wire_and_back() -> None:
    recipe = SplitRecipe(train=0.6, val=0.2, test=0.2, seed=42)

    assert SplitRecipeBody(**recipe.model_dump()).to_domain() == recipe


def test_the_verification_out_publishes_every_field_and_the_derived_verdict() -> None:
    """``ok`` is a property on the domain model, and a client must not re-derive it."""
    verification = ReleaseVerification(
        release_id=uuid4(),
        manifest_hash="a" * 64,
        manifest_intact=True,
        checked=3,
    )

    published = ReleaseVerificationOut.of(verification)

    assert set(ReleaseVerificationOut.model_fields) == set(ReleaseVerification.model_fields) | {
        "ok"
    }
    assert published.ok is verification.ok


def test_a_damaged_release_publishes_its_two_lists_apart() -> None:
    """Merging them would hide which fault a caller is actually looking at."""
    published = ReleaseVerificationOut.of(
        ReleaseVerification(
            release_id=uuid4(),
            manifest_hash="a" * 64,
            manifest_intact=True,
            checked=2,
            missing=("b" * 64,),
            corrupt=("c" * 64,),
        )
    )

    assert published.ok is False
    assert published.missing == ["b" * 64]
    assert published.corrupt == ["c" * 64]


def test_the_stats_out_names_every_number_the_domain_counted() -> None:
    stats = DatasetStats(
        dataset_id=uuid4(),
        asset_count=3,
        annotated_asset_count=2,
        annotation_count=5,
        per_class=(ClassCount(label_class="sign", annotations=5, assets=2),),
    )

    published = DatasetStatsOut.of(stats)

    assert (published.asset_count, published.annotated_asset_count) == (3, 2)
    assert published.annotation_count == 5
    assert published.classes == [ClassCountOut(label_class="sign", annotations=5, assets=2)]


def test_per_class_counts_are_ordered_by_the_domain_and_not_by_the_caller() -> None:
    """Canonical ordering belongs to the artifact — the ``Manifest`` rule."""
    stats = DatasetStats(
        dataset_id=uuid4(),
        asset_count=1,
        annotated_asset_count=1,
        annotation_count=2,
        per_class=(
            ClassCount(label_class="zebra", annotations=1, assets=1),
            ClassCount(label_class="alpha", annotations=1, assets=1),
        ),
    )

    assert [row.label_class for row in DatasetStatsOut.of(stats).classes] == ["alpha", "zebra"]


def test_the_class_counts_are_rows_rather_than_an_open_mapping() -> None:
    """``dict[str, int]`` would generate as ``Record<string, number>`` for #32's client."""
    assert DatasetStatsOut.model_fields["classes"].annotation == list[ClassCountOut]


def test_the_change_log_entry_keeps_operation_open() -> None:
    """An entry naming an operation this build never heard of must still be readable.

    The domain makes the same call for the same reason; typing it as an enum on
    the wire would put the narrowing back one layer up.
    """
    assert DatasetChangeOut.model_fields["operation"].annotation is str
    assert DatasetChange.model_fields["operation"].annotation is str


def test_a_release_without_a_recipe_publishes_a_null_split() -> None:
    release = Release(
        dataset_id=uuid4(),
        tag="v1",
        manifest_hash="a" * 64,
        schema_version=1,
        asset_count=1,
        annotation_count=0,
    )

    assert ReleaseOut.of(release).split is None


def test_a_release_with_a_recipe_publishes_it_unchanged() -> None:
    recipe = SplitRecipe(train=0.6, val=0.2, test=0.2, seed=7)
    release = Release(
        dataset_id=uuid4(),
        tag="v1",
        manifest_hash="a" * 64,
        schema_version=1,
        asset_count=1,
        annotation_count=0,
        split=recipe,
    )

    published = ReleaseOut.of(release)

    assert published.split is not None
    assert published.split.to_domain() == recipe


# --- Asset.ingested_at (#283) ------------------------------------------------
#
# The field existed in the domain since #216 and reached no client at all: not
# `AssetOut`, not `BatchAssetOut`, and nothing in `visionset.wire`. Only the
# project-level aggregate on `ProjectStatsOut` ever crossed the boundary, so a
# batch's age was derivable in principle and unreachable in practice.


def test_an_assets_arrival_is_published() -> None:
    arrived = datetime(2026, 8, 3, 12, 30, 45, tzinfo=UTC)
    asset = Asset(project_id=uuid4(), content_hash="a" * 64, uri="/blobs/a", ingested_at=arrived)

    assert AssetOut.of(asset).ingested_at == arrived


def test_an_unstamped_asset_publishes_null_rather_than_a_guess() -> None:
    """Null means *unknown*, not "never" — a row written before #216 is legitimately bare.

    Substituting any other moment here would make an age a client renders look
    like a fact, which is the one thing a nullable timestamp exists to avoid.
    """
    asset = Asset(project_id=uuid4(), content_hash="a" * 64, uri="/blobs/a")

    assert AssetOut.of(asset).ingested_at is None


def test_the_batch_vantage_point_carries_the_arrival_too() -> None:
    """`BatchAssetOut` inherits `AssetOut`, which is what makes this free.

    Asserted anyway: the inheritance is the design decision (they are the same
    asset from a different vantage point), and a future hand-written `in_batch`
    that stopped spreading `AssetOut.of` would drop the field silently.
    """
    arrived = datetime(2026, 8, 3, 12, 30, 45, tzinfo=UTC)
    asset = Asset(project_id=uuid4(), content_hash="a" * 64, uri="/blobs/a", ingested_at=arrived)

    published = BatchAssetOut.in_batch(
        asset, job_id=None, job_state=None, progress=None, batch_state=BatchState.DRAFT
    )

    assert published.ingested_at == arrived


def test_the_two_surfaces_encode_an_arrival_identically() -> None:
    """The parity gate compares key sets; only a round trip catches a format.

    `_output.moment()` is the human spelling (seconds, no microseconds) and
    `wire._moment()` is pydantic's. Sharing the wrong one passes every key-set
    assertion in `test_json_contract.py` and fails only here.
    """
    arrived = datetime(2026, 8, 3, 12, 30, 45, 123456, tzinfo=UTC)
    asset = Asset(project_id=uuid4(), content_hash="a" * 64, uri="/blobs/a", ingested_at=arrived)

    assert (
        wire.asset(asset)["ingested_at"]
        == AssetOut.of(asset).model_dump(mode="json")["ingested_at"]
    )


# --- the two correction-batch prerequisites on the wire (audit G3, G4) --------


def test_a_batch_publishes_its_lineage() -> None:
    """`parent_batch_id` travels, and null means *not a correction of anything*."""
    parent = uuid4()
    child = samples.BATCH.model_copy(update={"parent_batch_id": parent})
    orphan = samples.BATCH.model_copy(update={"parent_batch_id": None})

    assert BatchOut.of(child, samples.COUNTS, promoted=frozenset()).parent_batch_id == parent
    assert BatchOut.of(orphan, samples.COUNTS, promoted=frozenset()).parent_batch_id is None


def test_an_annotation_publishes_the_round_that_produced_it() -> None:
    """`job_id`, and null means genuinely unknown rather than "not applicable".

    The distinction matters to a reader: a batch either was cut from another or
    was not, so `parent_batch_id: null` is a complete answer — while a label
    written before the column existed may simply be unattributable.
    """
    job = uuid4()

    assert AnnotationOut.of(samples.ANNOTATION.model_copy(update={"job_id": job})).job_id == job
    assert AnnotationOut.of(samples.ANNOTATION.model_copy(update={"job_id": None})).job_id is None


def test_neither_field_is_something_a_client_can_set() -> None:
    """Both are stamped by the service, so neither appears on an input model.

    The `schema_version` rule, applied twice: a field a caller could set and
    never observe is a lie in the schema.
    """
    assert "job_id" not in AnnotationCreate.model_fields
