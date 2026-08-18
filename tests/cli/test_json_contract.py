"""``visionset.wire`` and the REST API publish the same shape for the same concept.

``visionset.wire`` is what ``--json`` prints and what an MCP tool returns; the
server publishes the same concepts as pydantic models, because ``openapi.json``
is generated from them and a dict cannot generate a schema. Two spellings, and
nothing inside ``src/`` can enforce the agreement — import-linter's independence
contract keeps the surfaces siblings. A test can: ``tests/`` is outside the
``visionset`` package, so this module imports both ``visionset.wire`` and
``visionset.server.models`` and asserts, per pair:

1. the projection's keys are exactly the wire model's fields;
2. the wire model *validates* the projection — which catches encoding drift a
   key-set comparison cannot see, chiefly a timestamp in the wrong format or a
   UUID handed over as an object;
3. the projection is JSON-serializable with no ``default=``, so a leaf somebody
   forgot to encode is a ``TypeError`` here rather than a silent ``str()``.

Three projections are deliberately ungated, and named at the bottom: a surface
defines those shapes first, because no route publishes them.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import pytest
from pydantic import BaseModel
from tests.fixtures.samples import (
    ANNOTATION,
    ASSET,
    BATCH,
    BBOX,
    CLASSIFICATION,
    COUNTS,
    DATASET,
    DATASET_STATS,
    EXPORT_COMPATIBILITY,
    EXPORT_RESULT,
    INFERENCE_CONNECTION,
    INGEST_FAILURE,
    INGEST_JOB,
    JOB,
    PARTIAL_EXTRACTION,
    POLYGON,
    PROJECT,
    RELEASE,
    SCHEMA_CHANGE_PREVIEW,
    SCHEMA_DIFF,
    SCHEMA_DRAFT,
    SCHEMA_PUBLICATION,
    SCHEMA_VERSION,
    SOURCE,
    SPLIT,
    THUMBNAIL_BACKFILL,
    VERIFICATION,
)

from visionset import wire
from visionset.formats._dummy import DummyExporter
from visionset.kernel.domain import AssetProgress, BackgroundJobState, PreLabelRun
from visionset.server import models

# One row per pair: a label, the projected payload, and the wire model it must
# agree with. Built eagerly — every projection runs at import, so a leaf that
# does not encode fails collection rather than one parametrized case.
PAIRS: list[tuple[str, dict[str, Any], type[BaseModel]]] = [
    ("project", wire.project(PROJECT), models.ProjectOut),
    ("connection", wire.connection(INFERENCE_CONNECTION), models.ConnectionOut),
    ("dataset", wire.dataset(DATASET), models.DatasetOut),
    ("schema_version", wire.schema_version(SCHEMA_VERSION), models.SchemaVersionOut),
    (
        "schema_publication",
        wire.schema_publication(SCHEMA_PUBLICATION),
        models.SchemaPublicationOut,
    ),
    ("schema_diff", wire.schema_diff(SCHEMA_DIFF), models.SchemaDiffOut),
    (
        "schema_change_preview",
        wire.schema_change_preview(SCHEMA_CHANGE_PREVIEW),
        models.SchemaChangePreviewOut,
    ),
    # ``changes[1]`` rather than ``[0]``: it is the one carrying a non-null
    # ``attribute``, and a sample holding ``None`` there would leave that half of
    # the projection unchecked. The diff pair above covers both, since it
    # projects every change.
    ("schema_change", wire.schema_change(SCHEMA_DIFF.changes[1]), models.SchemaChangeOut),
    ("label_class", wire.label_class(SCHEMA_VERSION.classes[0]), models.LabelClassBody),
    (
        "attribute",
        wire.attribute(SCHEMA_VERSION.classes[0].attributes[0]),
        models.AttributeBody,
    ),
    ("schema_draft", wire.schema_draft(SCHEMA_DRAFT), models.SchemaDraftOut),
    (
        "draft_label_class",
        wire.draft_label_class(SCHEMA_DRAFT.classes[0]),
        models.DraftLabelClassBody,
    ),
    (
        "draft_attribute",
        wire.draft_attribute(SCHEMA_DRAFT.classes[0].attributes[0]),
        models.DraftAttributeBody,
    ),
    ("source", wire.source(SOURCE), models.SourceOut),
    ("video_provenance", wire.video_provenance(SOURCE.require_video()), models.VideoProvenanceOut),
    ("ingest_job", wire.ingest_job(INGEST_JOB), models.IngestJobOut),
    ("ingest_failure", wire.ingest_failure(INGEST_FAILURE), models.IngestFailureOut),
    # The partial shape as well, and for the reason the sample module states: the
    # two counts are null on every other kind, so the entry above would leave that
    # half of the projection unchecked.
    (
        "ingest_failure_partial",
        wire.ingest_failure(PARTIAL_EXTRACTION),
        models.IngestFailureOut,
    ),
    ("asset", wire.asset(ASSET), models.AssetOut),
    (
        "batch_asset",
        wire.batch_asset(
            ASSET,
            job_id=JOB.id,
            job_state=JOB.state,
            progress=AssetProgress.ANNOTATED,
            batch_state=BATCH.state,
        ),
        models.BatchAssetOut,
    ),
    ("progress_counts", wire.progress_counts(COUNTS), models.ProgressCounts),
    # A promoted set that actually intersects: a count of zero would agree with
    # itself even if the intersection were wrong, and this pair exists to catch
    # exactly the projection that drifted from its model.
    ("batch", wire.batch(BATCH, COUNTS, promoted=frozenset(BATCH.asset_ids[:1])), models.BatchOut),
    ("job", wire.job(JOB, batch_id=BATCH.id, batch_state=BATCH.state), models.JobOut),
    (
        "asset_progress",
        wire.asset_progress(ASSET.id, AssetProgress.SKIPPED),
        models.AssetProgressOut,
    ),
    ("annotation", wire.annotation(ANNOTATION), models.AnnotationOut),
    ("geometry_bbox", wire.geometry(BBOX), models.BboxBody),
    ("geometry_polygon", wire.geometry(POLYGON), models.PolygonBody),
    ("geometry_classification", wire.geometry(CLASSIFICATION), models.ClassificationBody),
    ("dataset_stats", wire.dataset_stats(DATASET_STATS), models.DatasetStatsOut),
    ("class_count", wire.class_count(DATASET_STATS.per_class[0]), models.ClassCountOut),
    ("release", wire.release(RELEASE), models.ReleaseOut),
    ("split_recipe", wire.split_recipe(SPLIT), models.SplitRecipeBody),
    (
        "release_verification",
        wire.release_verification(VERIFICATION),
        models.ReleaseVerificationOut,
    ),
    ("export_format", wire.export_format(DummyExporter()), models.FormatOut),
    # The compatibility report is published by all three surfaces, so it is gated like every
    # other shared shape — and the on-disk copy is checked against the wire
    # projection in `tests/kernel/test_release_service.py`, which closes the loop.
    (
        "export_compatibility",
        wire.export_compatibility(EXPORT_COMPATIBILITY),
        models.ExportCompatibilityOut,
    ),
    (
        "class_compatibility",
        wire.class_compatibility(EXPORT_COMPATIBILITY.classes[0]),
        models.ClassCompatibilityOut,
    ),
]

IDS = [label for label, _, _ in PAIRS]


# --- parity with the wire models ---------------------------------------------


@pytest.mark.parametrize(("payload", "wire"), [(p, w) for _, p, w in PAIRS], ids=IDS)
def test_the_projection_publishes_exactly_the_fields_the_wire_model_does(
    payload: dict[str, Any], wire: type[BaseModel]
) -> None:
    assert set(payload) == set(wire.model_fields)


@pytest.mark.parametrize(("payload", "wire"), [(p, w) for _, p, w in PAIRS], ids=IDS)
def test_the_wire_model_accepts_the_projection_verbatim(
    payload: dict[str, Any], wire: type[BaseModel]
) -> None:
    # Stronger than key-set parity and one line: it is what proves a UUID left as
    # a string, an enum left as its value, and a timestamp in pydantic's own
    # format rather than the human one the columns use.
    wire.model_validate(payload)


@pytest.mark.parametrize("payload", [p for _, p, _ in PAIRS], ids=IDS)
def test_the_projection_serializes_with_no_default_encoder(payload: dict[str, Any]) -> None:
    json.dumps(payload)


# --- the envelope ------------------------------------------------------------


def test_a_listing_is_an_object_with_items_and_a_total() -> None:
    assert wire.page([{"id": "a"}, {"id": "b"}]) == {
        "items": [{"id": "a"}, {"id": "b"}],
        "total": 2,
    }


def test_an_empty_listing_is_still_an_object() -> None:
    # Never a bare array, and never a 404's moral equivalent: an empty collection
    # is a collection.
    assert wire.page([]) == {"items": [], "total": 0}


def test_a_settled_pre_label_run_has_wire_parity_when_nested_in_a_batch() -> None:
    run = PreLabelRun(
        batch_id=BATCH.id,
        job_id=uuid4(),
        state=BackgroundJobState.SUCCEEDED,
        assets_processed=2,
        assets_total=2,
        stopped_early=False,
        assets_labeled=1,
        regions_discarded=2,
        regions_out_of_bounds=3,
    )

    projected = wire.batch(BATCH, COUNTS, promoted=frozenset(), pre_labeled=run)

    assert set(projected["pre_label_run"] or {}) == set(models.PreLabelRunOut.model_fields)
    models.BatchOut.model_validate(projected)
    json.dumps(projected)


# --- the timestamp format the parity gate depends on -------------------------


def test_a_timestamp_keeps_its_microseconds_and_ends_in_z() -> None:
    # Deliberately *not* ``_output.moment``'s format, which stops at seconds. A
    # single shared helper would pass every key-set assertion above and fail the
    # round-trip one.
    when = datetime(2026, 7, 28, 12, 34, 56, 789012, tzinfo=UTC)
    assert wire._moment(when) == "2026-07-28T12:34:56.789012Z"


# --- the three shapes with no wire partner -----------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        wire.export_result(EXPORT_RESULT),
        wire.thumbnail_backfill(THUMBNAIL_BACKFILL),
        wire.schema_diff(SCHEMA_DIFF),
    ],
    ids=["export_result", "thumbnail_backfill", "schema_diff"],
)
def test_a_surface_defined_shape_still_serializes(payload: dict[str, Any]) -> None:
    # No route publishes any of the three, so there is nothing to be parity-gated
    # against. What still has to hold is that every leaf is encoded — which is the
    # failure they would otherwise be free to have.
    json.dumps(payload)
