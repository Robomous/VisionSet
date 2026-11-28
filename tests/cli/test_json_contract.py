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

Some projections are deliberately ungated, and named at the bottom: a surface
defines those shapes first, because no route publishes them.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

import pytest
from pydantic import BaseModel, TypeAdapter
from tests.fixtures.calibration import calibration
from tests.fixtures.samples import (
    ANNOTATION,
    ASSET,
    BATCH,
    BBOX,
    BLOCKING_ASSET,
    CLASSIFICATION,
    CORRUPT_FAILURE,
    COUNTS,
    DATASET,
    DATASET_STATS,
    DRAFT_KEYPOINT_CLASS,
    EXPORT_COMPATIBILITY,
    EXPORT_RESULT,
    EXPORT_RESULT_WITH_RECIPE,
    INFERENCE_CONNECTION,
    INGEST_FAILURE,
    INGEST_JOB,
    JOB,
    KEYPOINT_CLASS,
    KEYPOINT_SPEC,
    KEYPOINTS,
    POLYGON,
    POLYLINE,
    POLYLINE_WITH_VISIBILITY,
    PREPROCESSING_PREVIEW,
    PREPROCESSING_RECIPE,
    PROJECT,
    PROJECT_PREVIEW,
    RECIPE_USAGE,
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
from visionset_test_formats import DummyExporter

from visionset import wire
from visionset.formats.matrix import build as build_matrix
from visionset.formats.registry import exporters, importers
from visionset.formats.ultralytics import UltralyticsExporter
from visionset.inference import (
    PreLabelExcludedClass,
    PreLabelExclusionReason,
    PreLabelPlan,
    registered,
)
from visionset.kernel.domain import (
    AnnotationSummary,
    AssetCalibration,
    AssetProgress,
    BackgroundJobState,
    DraftLabelClass,
    ExecutorStatus,
    ExecutorVariable,
    FrameOccurrence,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLoss,
    ImportLossKind,
    ImportPlan,
    ImportRun,
    LabelClass,
    ObservedFrame,
    ObservedLabel,
    PolylineGeometry,
    PreLabelRun,
    Track,
    TrackDetail,
    TrackingAuth,
    TrackingServer,
    TrackingStatus,
    TrackStatus,
    WorkspaceSettings,
)
from visionset.server import models
from visionset.wire import shapes

#: A plan with both halves populated and one class carrying both reasons at
#: once, so neither list nor either reason goes unprojected. It is derived from
#: a schema rather than stored, which is why it is built here rather than in the
#: domain samples.
PRE_LABEL_PLAN = PreLabelPlan(
    schema_version=SCHEMA_VERSION.version,
    asked=("sign",),
    produces=frozenset({GeometryType.BBOX}),
    excluded=(
        PreLabelExcludedClass(
            name="crossing",
            reasons=(
                PreLabelExclusionReason.NO_PRODUCIBLE_GEOMETRY,
                PreLabelExclusionReason.REQUIRED_ATTRIBUTE,
            ),
        ),
    ),
)

OCCURRENCE = FrameOccurrence(source_id=SOURCE.id, position=3, timestamp=1.5, asset_id=ASSET.id)
#: Two observations, so the position order and the per-frame encoding are both exercised.
TRACK = TrackDetail(
    track=Track(source_id=SOURCE.id, label_class="sign", external_id="instance-7"),
    observations=(
        ObservedFrame(
            occurrence_id=uuid4(),
            position=1,
            timestamp=0.5,
            asset_id=ASSET.id,
            annotation_id=uuid4(),
        ),
        ObservedFrame(
            occurrence_id=OCCURRENCE.id,
            position=3,
            timestamp=1.5,
            asset_id=ASSET.id,
            annotation_id=ANNOTATION.id,
        ),
    ),
)
UNNAMED_TRACK = TrackDetail(track=Track(source_id=SOURCE.id, label_class="sign"), observations=())
TRACK_STATUS = TrackStatus(
    track_id=TRACK.track.id,
    batch_id=BATCH.id,
    progress={**dict.fromkeys(AssetProgress, 0), AssetProgress.ANNOTATED: 2},
    outside=1,
)

_EXECUTOR = ExecutorStatus(
    variables=(
        ExecutorVariable(name="VISIONSET_JOB_WORKERS", value=2, default=1),
        ExecutorVariable(name="VISIONSET_JOB_POLL_INTERVAL_S", value=0.5, default=0.5),
    ),
    problem=None,
)
#: Every nullable leaf populated, so no half of the tracking projection goes unchecked.
SETTINGS_TRACKED = WorkspaceSettings(
    version="1.2.3",
    tracking=TrackingStatus(
        enabled=True,
        experiment="visionset",
        server=TrackingServer(scheme="https", host="tracking.example", port=8443),
        auth=TrackingAuth.TOKEN,
        ca_bundle_configured=True,
        client_certificate_configured=False,
        client_installed=False,
        problem="install the client",
    ),
    executor=_EXECUTOR,
)
SETTINGS_OFF = WorkspaceSettings(
    version="1.2.3",
    tracking=TrackingStatus(
        enabled=False,
        experiment=None,
        server=None,
        auth=None,
        ca_bundle_configured=False,
        client_certificate_configured=False,
        client_installed=True,
        problem=None,
    ),
    executor=ExecutorStatus(
        variables=(ExecutorVariable(name="VISIONSET_JOB_WORKERS", value=None, default=1),),
        problem="VISIONSET_JOB_WORKERS is not a valid value",
    ),
)

MATRIX = build_matrix(exporters(), importers())
COCO_EXPORT, COCO_IMPORT = (row for row in MATRIX.rows if row.format == "coco")

# One row per pair: a label, the projected payload, and the wire model it must
# agree with. Built eagerly — every projection runs at import, so a leaf that
# does not encode fails collection rather than one parametrized case.
PAIRS: list[tuple[str, Mapping[str, Any], type[BaseModel]]] = [
    ("project", wire.project(PROJECT, PROJECT_PREVIEW), models.ProjectOut),
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
    ("blocking_asset", wire.blocking_asset(BLOCKING_ASSET), models.BlockingAssetOut),
    # ``changes[1]`` rather than ``[0]``: it is the one carrying a non-null
    # ``attribute``, and a sample holding ``None`` there would leave that half of
    # the projection unchecked. The diff pair above covers both, since it
    # projects every change.
    ("schema_change", wire.schema_change(SCHEMA_DIFF.changes[1]), models.SchemaChangeOut),
    ("label_class", wire.label_class(SCHEMA_VERSION.classes[0]), models.LabelClassBody),
    # The sample class above carries no spec, so this one proves the populated half.
    ("label_class_keypoints", wire.label_class(KEYPOINT_CLASS), models.LabelClassBody),
    ("keypoint_spec", wire.keypoint_spec(KEYPOINT_SPEC), models.KeypointSpecBody),
    (
        "attribute",
        wire.attribute(SCHEMA_VERSION.classes[0].attributes[0]),
        models.AttributeBody,
    ),
    ("schema_draft", wire.schema_draft(SCHEMA_DRAFT), models.SchemaDraftOut),
    (
        "preprocessing_recipe",
        wire.preprocessing_recipe(PREPROCESSING_RECIPE, used_by=None),
        models.PreprocessingRecipeOut,
    ),
    (
        "preprocessing_recipe_used",
        wire.preprocessing_recipe(PREPROCESSING_RECIPE, used_by=RECIPE_USAGE),
        models.PreprocessingRecipeOut,
    ),
    ("recipe_usage", wire.recipe_usage(RECIPE_USAGE), models.RecipeUsageOut),
    (
        "preprocessing_preview",
        wire.preprocessing_preview(PREPROCESSING_PREVIEW),
        models.PreprocessingPreviewOut,
    ),
    (
        "draft_label_class",
        wire.draft_label_class(SCHEMA_DRAFT.classes[0]),
        models.DraftLabelClassBody,
    ),
    (
        "draft_label_class_keypoints",
        wire.draft_label_class(DRAFT_KEYPOINT_CLASS),
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
    # Both kinds, so a projection cannot pass by hardcoding one of them.
    ("ingest_failure_corrupt", wire.ingest_failure(CORRUPT_FAILURE), models.IngestFailureOut),
    ("asset", wire.asset(ASSET), models.AssetOut),
    ("calibration", wire.calibration(calibration()), models.CalibrationOut),
    (
        "calibration_undistorted",
        wire.calibration(calibration(distortion=False)),
        models.CalibrationOut,
    ),
    (
        "source_calibration",
        wire.source_calibration(SOURCE.id, calibration()),
        models.SourceCalibrationOut,
    ),
    (
        "source_calibration_none",
        wire.source_calibration(SOURCE.id, None),
        models.SourceCalibrationOut,
    ),
    (
        "asset_calibration",
        wire.asset_calibration(
            AssetCalibration(asset_id=ASSET.id, override=None, effective=calibration())
        ),
        models.AssetCalibrationOut,
    ),
    (
        "batch_asset",
        wire.batch_asset(
            ASSET,
            job_id=JOB.id,
            job_state=JOB.state,
            progress=AssetProgress.ANNOTATED,
            batch_state=BATCH.state,
            summary=AnnotationSummary(count=2, min_model_confidence=0.4),
            observed=(),
        ),
        models.BatchAssetOut,
    ),
    (
        "batch_asset_pre_labeled",
        wire.batch_asset(
            ASSET,
            job_id=JOB.id,
            job_state=JOB.state,
            progress=AssetProgress.PRE_LABELED,
            batch_state=BATCH.state,
            summary=AnnotationSummary(count=1, min_model_confidence=0.4),
            observed=(ObservedLabel(annotation_id=uuid4(), track_id=uuid4(), label_class="car"),),
        ),
        models.BatchAssetOut,
    ),
    ("progress_counts", wire.progress_counts(COUNTS), models.ProgressCounts),
    # A promoted set that actually intersects: a count of zero would agree with
    # itself even if the intersection were wrong, and this pair exists to catch
    # exactly the projection that drifted from its model.
    (
        "batch",
        wire.batch(BATCH, COUNTS, promoted=frozenset(BATCH.asset_ids[:1]), modalities=("image",)),
        models.BatchOut,
    ),
    ("job", wire.job(JOB, batch_id=BATCH.id, batch_state=BATCH.state), models.JobOut),
    (
        "asset_progress",
        wire.asset_progress(ASSET.id, AssetProgress.SKIPPED),
        models.AssetProgressOut,
    ),
    ("annotation", wire.annotation(ANNOTATION), models.AnnotationOut),
    ("geometry_bbox", wire.geometry(BBOX), models.BboxBody),
    ("geometry_polygon", wire.geometry(POLYGON), models.PolygonBody),
    # With visibility, so the key-set parity below sees every field; the polyline
    # that omits it is pinned by its own test.
    ("geometry_polyline", wire.geometry(POLYLINE_WITH_VISIBILITY), models.PolylineBody),
    ("geometry_classification", wire.geometry(CLASSIFICATION), models.ClassificationBody),
    ("geometry_keypoints", wire.geometry(KEYPOINTS), models.KeypointsBody),
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
    # Every installed plugin, so both directions, an external and a test-local
    # reader, and the third-party `dummy` with no evidence at all are all present.
    ("format_matrix", wire.format_matrix(MATRIX), models.FormatMatrixOut),
    ("format_matrix_row_export", wire.format_matrix_row(COCO_EXPORT), models.FormatMatrixRowOut),
    ("format_matrix_row_import", wire.format_matrix_row(COCO_IMPORT), models.FormatMatrixRowOut),
    ("format_evidence", wire.format_evidence(COCO_EXPORT.evidence[-1]), models.FormatEvidenceOut),
    ("provider", wire.provider(registered().providers["sam"]), models.ProviderOut),
    (
        "export_target",
        wire.export_target(next(iter(DummyExporter().targets)), DummyExporter()),
        models.ExportTargetOut,
    ),
    # Both halves of the hints: the self-target's, where nothing is recommended,
    # and a trainer's, where a size and a strategy are.
    (
        "preprocessing_hints_empty",
        wire.preprocessing_hints(next(iter(DummyExporter().targets)).hints),
        models.PreprocessingHintsOut,
    ),
    (
        "preprocessing_hints_populated",
        wire.preprocessing_hints(next(iter(UltralyticsExporter().targets)).hints),
        models.PreprocessingHintsOut,
    ),
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
    ("pre_label_plan", wire.pre_label_plan(PRE_LABEL_PLAN), models.PreLabelPlanOut),
    ("frame_occurrence", wire.frame_occurrence(OCCURRENCE), models.FrameOccurrenceOut),
    (
        "track_observation",
        wire.track_observation(TRACK.observations[0]),
        models.TrackObservationOut,
    ),
    ("track", wire.track(TRACK), models.TrackOut),
    # A null external id and no observations: the other half of each nullable leaf.
    ("track_unnamed", wire.track(UNNAMED_TRACK), models.TrackOut),
    ("track_status", wire.track_status(TRACK_STATUS), models.TrackStatusOut),
    ("track_split", wire.track_split(TRACK, UNNAMED_TRACK), models.TrackSplitOut),
    (
        "workspace_settings_tracked",
        wire.workspace_settings(SETTINGS_TRACKED),
        models.WorkspaceSettingsOut,
    ),
    ("workspace_settings_off", wire.workspace_settings(SETTINGS_OFF), models.WorkspaceSettingsOut),
]

IDS = [label for label, _, _ in PAIRS]


# --- parity with the wire models ---------------------------------------------


@pytest.mark.parametrize(("payload", "wire"), [(p, w) for _, p, w in PAIRS], ids=IDS)
def test_the_projection_publishes_exactly_the_fields_the_wire_model_does(
    payload: Mapping[str, Any], wire: type[BaseModel]
) -> None:
    assert set(payload) == set(wire.model_fields)


@pytest.mark.parametrize(("payload", "wire"), [(p, w) for _, p, w in PAIRS], ids=IDS)
def test_the_wire_model_accepts_the_projection_verbatim(
    payload: Mapping[str, Any], wire: type[BaseModel]
) -> None:
    # Stronger than key-set parity and one line: it is what proves a UUID left as
    # a string, an enum left as its value, and a timestamp in pydantic's own
    # format rather than the human one the columns use.
    wire.model_validate(payload)


@pytest.mark.parametrize("payload", [p for _, p, _ in PAIRS], ids=IDS)
def test_the_projection_serializes_with_no_default_encoder(payload: Mapping[str, Any]) -> None:
    json.dumps(payload)


@pytest.mark.parametrize("geometry", [POLYLINE, POLYLINE_WITH_VISIBILITY])
def test_a_polyline_projects_exactly_as_the_wire_model_serializes_it(
    geometry: PolylineGeometry,
) -> None:
    assert wire.geometry(geometry) == models.PolylineBody.of(geometry).model_dump(mode="json")


@pytest.mark.parametrize("progress", list(AssetProgress), ids=str)
def test_a_batch_asset_projects_its_withheld_actions_as_the_wire_model_does(
    progress: AssetProgress,
) -> None:
    arguments: dict[str, Any] = {
        "job_id": JOB.id,
        "job_state": JOB.state,
        "progress": progress,
        "batch_state": BATCH.state,
        "summary": AnnotationSummary(count=1, min_model_confidence=0.4),
        "observed": (ObservedLabel(annotation_id=uuid4(), track_id=uuid4(), label_class="car"),),
    }
    projected = wire.batch_asset(ASSET, **arguments)
    assert projected == models.BatchAssetOut.in_batch(ASSET, **arguments).model_dump(mode="json")
    expected = (
        [{"code": "ASSET_NOT_JUDGED", "actions": ["observe"]}]
        if progress is AssetProgress.PRE_LABELED
        else []
    )
    assert projected["withheld_actions"] == expected
    (label,) = arguments["observed"]
    assert projected["observed"] == [
        {
            "annotation_id": str(label.annotation_id),
            "track_id": str(label.track_id),
            "label_class": "car",
        }
    ]


@pytest.mark.parametrize(
    "label_class", [SCHEMA_VERSION.classes[0], KEYPOINT_CLASS], ids=["no-spec", "spec"]
)
def test_a_label_class_projects_exactly_as_the_wire_model_serializes_it(
    label_class: LabelClass,
) -> None:
    assert wire.label_class(label_class) == models.LabelClassBody.of(label_class).model_dump(
        mode="json"
    )


@pytest.mark.parametrize(
    "declared", [SCHEMA_DRAFT.classes[0], DRAFT_KEYPOINT_CLASS], ids=["no-spec", "spec"]
)
def test_a_draft_label_class_projects_exactly_as_the_wire_model_serializes_it(
    declared: DraftLabelClass,
) -> None:
    assert wire.draft_label_class(declared) == models.DraftLabelClassBody.of(declared).model_dump(
        mode="json"
    )


def test_a_keypoints_geometry_projects_exactly_as_the_wire_model_serializes_it() -> None:
    assert wire.geometry(KEYPOINTS) == models.KeypointsBody.of(KEYPOINTS).model_dump(mode="json")


def test_unknown_visibility_is_absent_from_the_projection_not_null() -> None:
    assert "visibility" not in wire.geometry(POLYLINE)
    TypeAdapter(shapes.Geometry).validate_python(wire.geometry(POLYLINE))
    assert wire.geometry(POLYLINE_WITH_VISIBILITY)["visibility"] == [2, 1, 0]  # type: ignore[typeddict-item]


# --- the envelope ------------------------------------------------------------


def test_a_listing_is_an_object_with_items_and_a_total() -> None:
    assert wire.page([{"id": "a"}, {"id": "b"}]) == {
        "items": [{"id": "a"}, {"id": "b"}],
        "total": 2,
    }


def test_a_blocking_asset_page_validates_against_the_rest_page() -> None:
    page = {"items": [wire.blocking_asset(BLOCKING_ASSET)], "total": 7}
    assert models.BlockingAssetPage.model_validate(page).total == 7


def test_an_empty_listing_is_still_an_object() -> None:
    # Never a bare array, and never a 404's moral equivalent: an empty collection
    # is a collection.
    assert wire.page([]) == {"items": [], "total": 0}


def test_a_settled_pre_label_run_has_wire_parity_when_nested_in_a_batch() -> None:
    run = PreLabelRun(
        batch_id=BATCH.id,
        annotation_job_id=JOB.id,
        job_id=uuid4(),
        state=BackgroundJobState.SUCCEEDED,
        assets_processed=2,
        assets_total=2,
        stopped_early=False,
        assets_labeled=1,
        regions_discarded=2,
        regions_out_of_bounds=3,
        annotations_replaced=4,
        assets_protected=5,
    )

    projected = wire.batch(
        BATCH, COUNTS, promoted=frozenset(), pre_labeled=run, modalities=("image",)
    )

    assert set(projected["pre_label_run"] or {}) == set(models.PreLabelRunOut.model_fields)
    models.BatchOut.model_validate(projected)
    json.dumps(projected)


def test_the_compatibility_report_agrees_value_for_value_with_the_rest_model() -> None:
    rest = models.ExportCompatibilityOut.of(EXPORT_COMPATIBILITY).model_dump(mode="json")

    assert rest == wire.export_compatibility(EXPORT_COMPATIBILITY)
    assert rest["untagged_assets"] == EXPORT_COMPATIBILITY.untagged_assets != 0


# --- the timestamp format the parity gate depends on -------------------------


@pytest.mark.parametrize("settings", [SETTINGS_TRACKED, SETTINGS_OFF], ids=["tracked", "off"])
def test_the_settings_projection_agrees_value_for_value_with_the_rest_model(
    settings: WorkspaceSettings,
) -> None:
    rest = models.WorkspaceSettingsOut.of(settings).model_dump(mode="json")
    assert wire.workspace_settings(settings) == rest


def test_a_timestamp_keeps_its_microseconds_and_ends_in_z() -> None:
    # Deliberately *not* ``_output.moment``'s format, which stops at seconds. A
    # single shared helper would pass every key-set assertion above and fail the
    # round-trip one.
    when = datetime(2026, 7, 28, 12, 34, 56, 789012, tzinfo=UTC)
    assert wire._moment(when) == "2026-07-28T12:34:56.789012Z"


# --- the shapes with no wire partner ------------------------------------------

_LOSS = ImportLoss(kind=ImportLossKind.LABEL, subject="car", count=2, reason="RLE masks")
_IMAGE = ImportedImage(
    path="images/a.png",
    labels=(ImportedLabel(class_name="car", geometry=BBOX),),
)
IMPORT_PLAN = ImportPlan(
    project_id=uuid4(),
    format_name="coco",
    dataset=ImportedDataset(
        classes=(ImportedClass(name="car", geometries=(GeometryType.BBOX,)),),
        images=(_IMAGE, ImportedImage(path="images/b.png")),
    ),
    images=(_IMAGE,),
    losses=(_LOSS,),
    missing_images=(PurePosixPath("images/b.png"),),
    conflicts=("a conflict",),
    creates_schema=True,
    new_assets=1,
    new_annotations=1,
    annotations_already_present=0,
)
IMPORT_RUN = ImportRun(
    project_id=uuid4(),
    format_name="coco",
    batch_id=uuid4(),
    schema_version=1,
    created_asset_ids=(uuid4(),),
    asset_ids=(uuid4(),),
    annotations_written=1,
    annotations_already_present=0,
    losses=(_LOSS,),
)


SURFACE_DEFINED: list[tuple[str, Mapping[str, Any]]] = [
    ("export_result", wire.export_result(EXPORT_RESULT)),
    ("export_result_with_recipe", wire.export_result(EXPORT_RESULT_WITH_RECIPE)),
    ("thumbnail_backfill", wire.thumbnail_backfill(THUMBNAIL_BACKFILL)),
    ("schema_diff", wire.schema_diff(SCHEMA_DIFF)),
    ("import_plan", wire.import_plan(IMPORT_PLAN)),
    ("import_run", wire.import_run(IMPORT_RUN)),
    ("track_deletion", wire.track_deletion(TRACK.track.id, 2)),
]


@pytest.mark.parametrize(
    "payload", [p for _, p in SURFACE_DEFINED], ids=[n for n, _ in SURFACE_DEFINED]
)
def test_a_surface_defined_shape_still_serializes(payload: Mapping[str, Any]) -> None:
    # No route publishes any of these, so there is nothing to be parity-gated
    # against. What still has to hold is that every leaf is encoded — which is the
    # failure they would otherwise be free to have.
    json.dumps(payload)


SHAPES: dict[str, Any] = {
    "project": shapes.Project,
    "connection": shapes.Connection,
    "dataset": shapes.Dataset,
    "schema_version": shapes.SchemaVersion,
    "schema_publication": shapes.SchemaPublication,
    "schema_diff": shapes.SchemaDiff,
    "schema_change_preview": shapes.SchemaChangePreview,
    "blocking_asset": shapes.BlockingAsset,
    "schema_change": shapes.SchemaChange,
    "label_class": shapes.LabelClass,
    "label_class_keypoints": shapes.LabelClass,
    "keypoint_spec": shapes.KeypointSpec,
    "attribute": shapes.Attribute,
    "schema_draft": shapes.SchemaDraft,
    "preprocessing_recipe": shapes.PreprocessingRecipe,
    "preprocessing_recipe_used": shapes.PreprocessingRecipe,
    "recipe_usage": shapes.RecipeUsage,
    "preprocessing_preview": shapes.PreprocessingPreview,
    "draft_label_class": shapes.DraftLabelClass,
    "draft_label_class_keypoints": shapes.DraftLabelClass,
    "draft_attribute": shapes.DraftAttribute,
    "source": shapes.Source,
    "video_provenance": shapes.VideoProvenance,
    "ingest_job": shapes.IngestJob,
    "ingest_failure": shapes.IngestFailure,
    "ingest_failure_corrupt": shapes.IngestFailure,
    "asset": shapes.Asset,
    "calibration": shapes.Calibration,
    "calibration_undistorted": shapes.Calibration,
    "source_calibration": shapes.SourceCalibration,
    "source_calibration_none": shapes.SourceCalibration,
    "asset_calibration": shapes.AssetCalibration,
    "batch_asset": shapes.BatchAsset,
    "batch_asset_pre_labeled": shapes.BatchAsset,
    "progress_counts": shapes.ProgressCounts,
    "batch": shapes.Batch,
    "job": shapes.Job,
    "asset_progress": shapes.AssetProgress,
    "annotation": shapes.Annotation,
    "geometry_bbox": shapes.Geometry,
    "geometry_polygon": shapes.Geometry,
    "geometry_polyline": shapes.Geometry,
    "geometry_classification": shapes.Geometry,
    "geometry_keypoints": shapes.Geometry,
    "dataset_stats": shapes.DatasetStats,
    "class_count": shapes.ClassCount,
    "release": shapes.Release,
    "split_recipe": shapes.SplitRecipe,
    "release_verification": shapes.ReleaseVerification,
    "export_format": shapes.ExportFormat,
    "format_matrix": shapes.FormatMatrix,
    "format_matrix_row_export": shapes.FormatMatrixRow,
    "format_matrix_row_import": shapes.FormatMatrixRow,
    "format_evidence": shapes.FormatEvidence,
    "provider": shapes.Provider,
    "export_target": shapes.ExportTarget,
    "preprocessing_hints_empty": shapes.PreprocessingHints,
    "preprocessing_hints_populated": shapes.PreprocessingHints,
    "export_compatibility": shapes.ExportCompatibility,
    "class_compatibility": shapes.ClassCompatibility,
    "pre_label_plan": shapes.PreLabelPlan,
    "frame_occurrence": shapes.FrameOccurrence,
    "track_observation": shapes.TrackObservation,
    "track": shapes.Track,
    "track_unnamed": shapes.Track,
    "track_status": shapes.TrackStatus,
    "track_split": shapes.TrackSplit,
    "workspace_settings_tracked": shapes.WorkspaceSettings,
    "workspace_settings_off": shapes.WorkspaceSettings,
    "track_deletion": shapes.TrackDeletion,
    "export_result": shapes.ExportResult,
    "export_result_with_recipe": shapes.ExportResult,
    "thumbnail_backfill": shapes.ThumbnailBackfill,
    "import_plan": shapes.ImportPlan,
    "import_run": shapes.ImportRun,
}

EVERY_PAYLOAD = [(label, payload) for label, payload, _ in PAIRS] + SURFACE_DEFINED


@pytest.mark.parametrize(
    ("label", "payload"), EVERY_PAYLOAD, ids=[label for label, _ in EVERY_PAYLOAD]
)
def test_the_projection_validates_against_its_typed_shape(
    label: str, payload: Mapping[str, Any]
) -> None:
    TypeAdapter(SHAPES[label]).validate_python(payload)
